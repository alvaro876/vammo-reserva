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
import { piorSintoma } from "@/lib/sintomas";
import { getAvisosCx, registrarAvisoCx } from "@/lib/supabase";

const BASES: Record<number, string> = { 1: "Mooca", 34: "Osasco", 166: "SBC" };
const SLA_MIN = 180;

// Cache do payload por isolate (13/08, erro 1102 na TV): no plano free do Workers o
// limite é ~10ms de CPU por request, e cada refresh da TV (45s) recalculava o motor
// inteiro (query grande no CH + avaliação + log no Supabase). O isolate sobrevive
// entre requests, então um cache global corta o recálculo pra ~1x/75s e os demais
// requests saem por micro-CPU. Efeito colateral desejado: se o motor falhar num
// tique, a TV segura a última foto boa em vez de mostrar erro.
let cxCache: { ts: number; payload: object } | null = null;
const CX_TTL_MS = 75_000;

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
  if (cxCache && Date.now() - cxCache.ts < CX_TTL_MS) {
    return NextResponse.json(cxCache.payload);
  }
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
          so_type: o.so_type,
          // contexto do incidente (não decide reserva — ver algorithm.ts; serve pra
          // conversa do CX com o cliente)
          guincho: o.guincho === 1,
          acidente: o.acidente === 1,
          imobilizada: o.imobilizada === 1,
          status_atual: o.status_atual,
          // "na base há X" = desde o CHECK-IN do cliente, igual ao Maestro (06/08).
          // Antes contava da abertura da OS e a tela divergia da tela da operação em
          // ~15min na mediana (caso TJC3C62: Maestro 3h15 × RIVERS 2h44).
          minutos_na_base: o.min_desde_chegada ?? o.min_desde_open,
          // negativo = já estourou o SLA
          minutos_pro_sla: SLA_MIN - (o.min_desde_chegada ?? o.min_desde_open),
          reservar: rec.decision === "RESERVA",
          regra: rec.rule_triggered,
          motivo: rec.motivo,
          confianca: rec.confianca ?? null,
          acao_automatica: o.acao_automatica,
          // SINTOMA relatado pelo cliente (Maestro, 05/08) — CONTEXTO, não decide nada.
          // Mostra o pior sintoma da OS com o histórico dele: existe desde a abertura,
          // antes de qualquer peça, que é onde a estimativa fica em branco.
          sintoma: (() => {
            const s = piorSintoma(o.sintoma_ids ?? []);
            return s ? { nome: s.nome, pct: s.pctEstouro, n: s.n } : null;
          })(),
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

    const payload = {
      atualizado_em: new Date().toISOString(),
      base: bases.map((b) => BASES[b] ?? String(b)).join(" · "),
      pressao_piso: pressao,
      total: clientes.length,
      clientes,
    };
    cxCache = { ts: Date.now(), payload };
    return NextResponse.json(payload);
  } catch (e) {
    console.error("[cx] erro:", e);
    // com cache velho na mão, servir a última foto boa vale mais que um erro na TV
    if (cxCache) return NextResponse.json(cxCache.payload);
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
