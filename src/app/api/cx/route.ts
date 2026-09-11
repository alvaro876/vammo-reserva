// GET  /api/cx  → fila de ação do CX Piso (bases do teste; hoje: Mooca)
// POST /api/cx  → registra "cliente avisado"
//
// Junta três coisas que hoje vivem separadas:
//   1. a decisão do RIVERS (runRivers, mesmo motor da tela do líder)
//   2. o estado real no Maestro — oferta/recusa/chamada de retirada e entrega
//      (fonte viva pós Check-in 2.0: maestro_scheduler_r.checkin_event; o campo
//       reserve_offered_at subconta desde 21/07)
//   3. quem o CX já avisou (rivers_cx_aviso) → métrica decisão → cliente sabendo
//   4. (04/09) as RECUSAS de hoje e o motivo que o CX registrou (rivers_recusa_motivo)

import { NextRequest, NextResponse } from "next/server";
import { runRivers } from "@/lib/rivers-engine";
import { query } from "@/lib/clickhouse";
import { basesTeste } from "@/lib/autonomia";
import { restanteParaPronta, ALGO_VERSION } from "@/lib/algorithm";
import { piorSintoma, estimativaInicialPorSintomas } from "@/lib/sintomas";
import { getAvisosCx, registrarAvisoCx, getRecusaMotivos } from "@/lib/supabase";

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
  // base e placa vêm da OS (OMS) — o location_id do check-in não é confiável pós 2.0
  location_id: number;
  placa: string;
}

// Contexto do cliente na base: nome (o CX fala com a pessoa), horário de chegada
// e o estado da reserva no Maestro. Timestamps em epoch — 0 = não aconteceu
// (maxIf sobre DateTime devolveria 1970 e viraria data válida por engano).
const CTX_QUERY = (bases: number[]) => `
WITH ev AS (
    SELECT e.so_id AS os_id,
        maxIf(toUnixTimestamp(e.created_at), e.event_type = 'RESERVE_OFFERED') AS ofertada_ts,
        argMaxIf(coalesce(e.operator_user_name, ''), e.created_at, e.event_type = 'RESERVE_OFFERED') AS ofertou,
        -- só cancelamento de OPERADOR é recusa. O OMS cancela sozinho (source KAFKA_OMS)
        -- quando a moto fica pronta, e isso fazia a tela marcar "cliente recusou" pra
        -- quem só teve a moto liberada — 26 de 69 casos em 13 dias (corrigido 26/08).
        maxIf(toUnixTimestamp(e.created_at),
              e.event_type = 'RESERVE_CANCELLED' AND e.source = 'OPERATOR') AS cancelada_ts,
        maxIf(toUnixTimestamp(e.created_at), e.event_type = 'CALL_FOR_RESERVE') AS chamada_ts
    FROM maestro_scheduler_r.checkin_event e FINAL
    WHERE e._peerdb_is_deleted = 0
      AND e.so_id IS NOT NULL
      AND e.created_at >= now() - INTERVAL 3 DAY
    GROUP BY e.so_id
),
os_info AS (
    -- base e placa da OS: a lista de recusas de hoje precisa dos dois mesmo quando a
    -- OS já saiu do radar do motor (moto pronta e entregue no mesmo dia)
    SELECT id AS os_id, location_id,
           JSONExtractString(coalesce(maintenance_metadata, '{}'), 'license_plate') AS placa
    FROM oms_r.so FINAL
    WHERE _peerdb_is_deleted = 0
      -- 60 dias, não 7: OS antiga (aguardando peça, retorno) com check-in novo ficava sem
      -- base e a recusa sumia da lista em silêncio (revisão de 04/09)
      AND created_at >= now() - INTERVAL 60 DAY
)
SELECT
    c.so_id AS os_id,
    coalesce(c.client_name, '') AS cliente,
    toUnixTimestamp(c.created_at) AS chegou_ts,
    coalesce(ev.ofertada_ts, 0) AS ofertada_ts,
    coalesce(ev.ofertou, '') AS ofertou,
    coalesce(ev.cancelada_ts, 0) AS cancelada_ts,
    coalesce(ev.chamada_ts, 0) AS chamada_ts,
    if(c.service_conclusion = 'RESERVE_DELIVERED', 1, 0) AS entregue,
    coalesce(oi.location_id, 0) AS location_id,
    coalesce(oi.placa, '') AS placa
FROM maestro_scheduler_r.checkin c FINAL
LEFT JOIN ev ON ev.os_id = c.so_id
LEFT JOIN os_info oi ON oi.os_id = c.so_id
WHERE c._peerdb_is_deleted = 0
  AND c.checkin_type = 'MAINTENANCE'
  AND c.so_id IS NOT NULL
  -- SEM filtro de location aqui (17/08): o Check-in 2.0 trocou o espaço de IDs do
  -- location_id do check-in (apareceram 100/199; service_center usa 1-4) — filtrar
  -- pelo ID antigo apagaria o nome do cliente dos cards. O so_id já escopa: a lista
  -- de clientes é filtrada pela base da OS (OMS) no código.
  AND c.created_at >= now() - INTERVAL 3 DAY
`;

// Dia civil em São Paulo (AAAA-MM-DD) de um instante em ms — "recusas de HOJE".
const FMT_DIA_SP = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Sao_Paulo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const diaSP = (ms: number) => FMT_DIA_SP.format(new Date(ms));

export async function GET() {
  if (cxCache && Date.now() - cxCache.ts < CX_TTL_MS) {
    return NextResponse.json(cxCache.payload);
  }
  try {
    const bases = [...basesTeste()];
    const [rows, ctxRows, avisos, recusas] = await Promise.all([
      runRivers(),
      query<ContextoCheckin>(CTX_QUERY(bases)),
      getAvisosCx(),
      getRecusaMotivos(),
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
        // quanto falta pra pronta — guia a conversa do CX (reserva × "já vai sair")
        let pronta = restanteParaPronta(o.status_atual, o.tempo_estimado_min || 0, o.exec_acum_min);
        // SEM diagnóstico mas COM sintoma relatado (v0.32, 20/08): a mediana real do
        // perfil de sintomas vira estimativa inicial — o card deixa de dizer "sem
        // previsão" nos primeiros ~40min. Quando o diagnóstico chega, a conta real assume.
        if (pronta.tipo === "sem_diag" && (o.sintoma_ids?.length ?? 0) > 0) {
          const est = estimativaInicialPorSintomas(
            o.sintoma_ids ?? [],
            o.min_desde_chegada ?? o.min_desde_open
          );
          if (est !== null) pronta = { tipo: "sintoma", min: est };
        }
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
          pronta_em_min: pronta.min,
          pronta_tipo: pronta.tipo,
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

    // RECUSAS DE HOJE (04/09): quem recusou a reserva sai da fila de ação (ordem de
    // 20/08), mas a recusa é a maior lacuna de dado do piloto — 79 em 3 semanas, nenhum
    // motivo, porque o Maestro não pergunta. A tela lista as de hoje e pede o motivo.
    // Vem do contexto do check-in (não do motor): cliente que recusou e foi embora, ou
    // moto que ficou pronta e saiu, não estão mais em `rows`, e a recusa aconteceu.
    const placaPorOs = new Map(rows.map((o) => [o.os_id, o.placa]));
    const basePorOs = new Map(rows.map((o) => [o.os_id, o.location_id]));
    // base da OS: pelo OMS; se a OS não veio no os_info, pelo motor (que tem as ativas)
    const baseDe = (c: ContextoCheckin) => Number(c.location_id) || basePorOs.get(Number(c.os_id)) || 0;
    const hoje = diaSP(Date.now());
    const recusas_hoje = [...ctx.values()]
      .filter(
        (c) =>
          Number(c.ofertada_ts) > 0 &&
          Number(c.cancelada_ts) > Number(c.ofertada_ts) &&
          bases.includes(baseDe(c)) &&
          diaSP(Number(c.cancelada_ts) * 1000) === hoje
      )
      .map((c) => {
        const os_id = Number(c.os_id);
        const m = recusas.get(os_id);
        return {
          os_id,
          placa: c.placa || placaPorOs.get(os_id) || "",
          location_id: baseDe(c),
          cliente: c.cliente || null,
          ofertada_em: Number(c.ofertada_ts) * 1000,
          recusada_em: Number(c.cancelada_ts) * 1000,
          ofertou: c.ofertou || null,
          recusa_motivo: m
            ? { motivo: m.motivo, detalhe: m.detalhe, actor: m.actor, created_at: m.created_at }
            : null,
        };
      })
      .sort((a, b) => b.recusada_em - a.recusada_em);

    const pressao = rows.find((o) => bases.includes(o.location_id))?.pressao_piso ?? 0;

    // Identidade COMPLETA da versão: ALGO_VERSION + id do deploy do Worker (binding
    // CF_VERSION_METADATA). Só a ALGO_VERSION não basta: deploy de tela sem bump de
    // versão ficava invisível pras TVs abertas (TJN6F12 preso com cliente que recusou).
    let buildId = "";
    try {
      const { getCloudflareContext } = await import("@opennextjs/cloudflare");
      const env = getCloudflareContext().env as { CF_VERSION_METADATA?: { id?: string } };
      buildId = env.CF_VERSION_METADATA?.id?.slice(0, 8) ?? "";
    } catch {
      // fora do Workers (dev local), segue só com a ALGO_VERSION
    }

    const payload = {
      // versão do app: a TV compara a cada busca e se recarrega sozinha quando muda
      // (deploy não depende mais de alguém apertar F5 — caso TLT6B13, 20/08)
      versao: buildId ? `${ALGO_VERSION}+${buildId}` : ALGO_VERSION,
      atualizado_em: new Date().toISOString(),
      base: bases.map((b) => BASES[b] ?? String(b)).join(" · "),
      pressao_piso: pressao,
      total: clientes.length,
      clientes,
      recusas_hoje,
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
