// GET  /api/cx  → fila de ação do CX Piso (bases do teste; hoje: Mooca)
// POST /api/cx  → registra "cliente avisado"
//
// Junta três coisas que hoje vivem separadas:
//   1. a decisão do RIVERS (runRivers, mesmo motor da tela do líder)
//   2. o estado real no Maestro — oferta/recusa/chamada de retirada e entrega
//      (fonte viva pós Check-in 2.0: maestro_scheduler_r.checkin_event; o campo
//       reserve_offered_at subconta desde 21/07)
//   3. quem o CX já avisou (rivers_cx_aviso) → métrica decisão → cliente sabendo

import { NextRequest, NextResponse } from "next/server";
import { runRivers } from "@/lib/rivers-engine";
import { query } from "@/lib/clickhouse";
import { basesTeste } from "@/lib/autonomia";
import { getAvisosCx, registrarAvisoCx } from "@/lib/supabase";

const BASES: Record<number, string> = { 1: "Mooca", 34: "Osasco", 166: "SBC" };
const SLA_MIN = 180;

interface ContextoCheckin {
  os_id: number;
  cliente: string;
  chegou_ts: number;
  ofertada_ts: number;
  ofertou: string;
  cancelada_ts: number;
  chamada_ts: number;
  entregue: number;
}

// Contexto do cliente na base: nome (o CX fala com a pessoa), horário de chegada
// e o estado da reserva no Maestro. Timestamps em epoch — 0 = não aconteceu
// (maxIf sobre DateTime devolveria 1970 e viraria data válida por engano).
const CTX_QUERY = (bases: number[]) => `
WITH ev AS (
    SELECT e.so_id AS os_id,
        maxIf(toUnixTimestamp(e.created_at), e.event_type = 'RESERVE_OFFERED') AS ofertada_ts,
        argMaxIf(coalesce(e.operator_user_name, ''), e.created_at, e.event_type = 'RESERVE_OFFERED') AS ofertou,
        maxIf(toUnixTimestamp(e.created_at), e.event_type = 'RESERVE_CANCELLED') AS cancelada_ts,
        maxIf(toUnixTimestamp(e.created_at), e.event_type = 'CALL_FOR_RESERVE') AS chamada_ts
    FROM maestro_scheduler_r.checkin_event e FINAL
    WHERE e._peerdb_is_deleted = 0
      AND e.so_id IS NOT NULL
      AND e.created_at >= now() - INTERVAL 3 DAY
    GROUP BY e.so_id
)
SELECT
    c.so_id AS os_id,
    coalesce(c.client_name, '') AS cliente,
    toUnixTimestamp(c.created_at) AS chegou_ts,
    coalesce(ev.ofertada_ts, 0) AS ofertada_ts,
    coalesce(ev.ofertou, '') AS ofertou,
    coalesce(ev.cancelada_ts, 0) AS cancelada_ts,
    coalesce(ev.chamada_ts, 0) AS chamada_ts,
    if(c.service_conclusion = 'RESERVE_DELIVERED', 1, 0) AS entregue
FROM maestro_scheduler_r.checkin c FINAL
LEFT JOIN ev ON ev.os_id = c.so_id
WHERE c._peerdb_is_deleted = 0
  AND c.checkin_type = 'MAINTENANCE'
  AND c.so_id IS NOT NULL
  AND c.location_id IN (${bases.join(",")})
  AND c.created_at >= now() - INTERVAL 3 DAY
`;

export async function GET() {
  try {
    const bases = [...basesTeste()];
    const [rows, ctxRows, avisos] = await Promise.all([
      runRivers(),
      query<ContextoCheckin>(CTX_QUERY(bases)),
      getAvisosCx(),
    ]);

    const ctx = new Map<number, ContextoCheckin>();
    for (const c of ctxRows) {
      const anterior = ctx.get(Number(c.os_id));
      // se houver mais de um check-in pra mesma OS, vale o mais recente
      if (!anterior || Number(c.chegou_ts) > Number(anterior.chegou_ts)) ctx.set(Number(c.os_id), c);
    }

    const clientes = rows
      .filter((o) => o.is_piso === 1 && bases.includes(o.location_id) && o.recomendacao)
      .map((o) => {
        const c = ctx.get(o.os_id);
        const rec = o.recomendacao!;
        return {
          os_id: o.os_id,
          placa: o.placa,
          cliente: c?.cliente || null,
          // quem está com a moto agora (último mecânico que pôs em execução)
          mecanico: o.mecanico_atual || null,
          asset_model: o.asset_model,
          status_atual: o.status_atual,
          minutos_na_base: o.min_desde_open,
          // negativo = já estourou o SLA
          minutos_pro_sla: SLA_MIN - o.min_desde_open,
          reservar: rec.decision === "RESERVA",
          regra: rec.rule_triggered,
          motivo: rec.motivo,
          confianca: rec.confianca ?? null,
          acao_automatica: o.acao_automatica,
          tempo_previsto_min: rec.tempo_previsto_min,
          // estado no Maestro (o que a oficina já fez)
          ofertada_em: c && Number(c.ofertada_ts) > 0 ? Number(c.ofertada_ts) * 1000 : null,
          ofertou: c?.ofertou || null,
          recusada: c ? Number(c.cancelada_ts) > Number(c.ofertada_ts) : false,
          chamada_retirada: c ? Number(c.chamada_ts) > 0 : false,
          entregue: c ? Number(c.entregue) === 1 : false,
          // registro do CX
          avisado_em: avisos.get(o.os_id)?.created_at ?? null,
          avisado_por: avisos.get(o.os_id)?.actor ?? null,
        };
      })
      // mais urgente primeiro (quem já estourou vem no topo)
      .sort((a, b) => a.minutos_pro_sla - b.minutos_pro_sla);

    const pressao = rows.find((o) => bases.includes(o.location_id))?.pressao_piso ?? 0;

    return NextResponse.json({
      atualizado_em: new Date().toISOString(),
      base: bases.map((b) => BASES[b] ?? String(b)).join(" · "),
      pressao_piso: pressao,
      total: clientes.length,
      clientes,
    });
  } catch (e) {
    console.error("[cx] erro:", e);
    return NextResponse.json({ error: "Erro ao montar a fila do CX" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    if (typeof body.os_id !== "number") {
      return NextResponse.json({ error: "os_id (number) é obrigatório" }, { status: 400 });
    }
    const r = await registrarAvisoCx({
      os_id: body.os_id,
      actor: body.actor ?? null,
      canal: body.canal ?? null,
      observacao: body.observacao ?? null,
    });
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 503 });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Erro ao registrar o aviso" }, { status: 500 });
  }
}
