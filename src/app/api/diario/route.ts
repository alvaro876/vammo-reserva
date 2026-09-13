// GET /api/diario?d=YYYY-MM-DD
//
// RELATÓRIO DIÁRIO: uma linha por moto que fez check-in no dia, com o que o RIVERS
// fez, a que horas, por qual regra — e, quando ele calou, POR QUE calou.
//
// Esta rota só faz três coisas: busca o estado no ClickHouse, busca o log do
// Supabase, e junta. O miolo (reconstruir o estado minuto a minuto, rodar as regras
// de novo e classificar o motivo) mora em @/lib/diario-replay, que não importa nada
// do Next e por isso roda em teste de linha de comando com dado real.
//
// ─────────────────────────────────────────────────────────────────────────────
// POR QUE O "POR QUE NÃO PEGOU" É RECONSTRUÍDO E NÃO LIDO DO LOG
//
// O log do Supabase guarda só o PRIMEIRO instante de cada decisão. Medido em
// 10/09: nas motos que não viraram reserva, o relógio mediano dessa linha é de
// 13 min. Ou seja, o log diz o que o motor viu quando a moto acabou de chegar, e
// não o que ele via às 2h — que é quando a pergunta interessa. As colunas
// `arrival_at` e `min_arrival_to_suggestion` da tabela estão 100% nulas desde
// 23/06 e não servem pra nada; o relógio sai de `features.min_desde_chegada`.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/clickhouse";
import { getSuggestionsWindow } from "@/lib/supabase";
import { basesTeste } from "@/lib/autonomia";
import { ALGO_VERSION } from "@/lib/algorithm";
import { REGRAS_SLA, REGRAS_ESTRUTURALMENTE_TARDIAS } from "@/lib/regras-sla";
import { MINUTOS_POR_PECA, TEMPO_FALLBACK_MIN } from "@/lib/tempo-pecas";
import { PECAS_UNICAS_SQL, CHAVE_PECA_SQL, FAMILIA_IDS_SQL } from "@/lib/pecas-unicas";
import { FIXACAO_IDS_SQL } from "@/lib/pecas-sql";
import {
  analisaOS, AvisoLog, LinhaCH, hhmmSP, MIN_DIAGNOSTICO,
} from "@/lib/diario-replay";

export const dynamic = "force-dynamic";

const TEMPO_IDS = Object.keys(MINUTOS_POR_PECA).join(",");
const TEMPO_MINS = Object.values(MINUTOS_POR_PECA).join(",");

// ── A QUERY ───────────────────────────────────────────────────────────────────
// Devolve o ESTADO BRUTO por OS (linha do tempo + peças com carimbo de entrada e
// saída). Quem aplica as regras é o replay em TypeScript.
//
// Reaproveita: ck/os/ev do CAMPO_QUERY (api/kpi), pecas_tempo e a origem do relógio
// do rivers-engine, _evs/exec_acum do OS_QUERY.
const DIARIO_QUERY = (bases: number[], dia: string) => `
WITH
ck AS (
    -- AGREGADA POR OS. O /kpi não agrega, e OS com 2 check-ins conta 2x lá.
    -- Sentinela de saída 2099 (nunca 1970/1900): o menor carimbo que existir é a
    -- hora em que o cliente foi embora.
    SELECT toInt32(c.so_id)                                     AS os_id,
        min(c.created_at)                                       AS chegou_at,
        min(c.called_at)                                        AS chamado_at,
        min(least(coalesce(c.completed_at, toDateTime64('2099-01-01 00:00:00', 6)),
                  coalesce(c.concluded_at, toDateTime64('2099-01-01 00:00:00', 6)),
                  coalesce(c.no_show_at,   toDateTime64('2099-01-01 00:00:00', 6)),
                  coalesce(c.dropout_at,   toDateTime64('2099-01-01 00:00:00', 6)))) AS saiu_at,
        argMax(tuple(coalesce(c.service_conclusion, '')), c.created_at).1 AS service_conclusion,
        argMax(tuple(toString(c.status)), c.created_at).1       AS checkin_status,
        count()                                                 AS n_checkins
    FROM maestro_scheduler_r.checkin c FINAL
    WHERE c._peerdb_is_deleted = 0 AND c.so_id IS NOT NULL
      AND c.checkin_type = 'MAINTENANCE' AND c.status != 'DROPOUT'
      AND toDate(c.created_at, 'America/Sao_Paulo') = toDate('${dia}')
    GROUP BY c.so_id
),
os AS (
    -- A base vem SEMPRE do lado da OS. checkin.location_id é do IMS e nunca filtra base.
    SELECT so.id AS os_id, so.created_at AS aberta_at, so.location_id AS base,
        coalesce(so.asset_code, '') AS placa, so.so_type AS so_type,
        so.asset_model AS asset_model, so.asset_type AS asset_type,
        coalesce(so.so_description, '') AS descricao_cx,
        greatest(JSONExtractBool(so.maintenance_metadata, 'triage', 'incidents', 'towing'),
                 JSONExtractBool(so.maintenance_metadata, 'checklist_tags', 'towing'))       AS guincho,
        greatest(JSONExtractBool(so.maintenance_metadata, 'triage', 'incidents', 'immobilizing'),
                 JSONExtractBool(so.maintenance_metadata, 'checklist_tags', 'immobilizing')) AS imobilizada,
        greatest(JSONExtractBool(so.maintenance_metadata, 'triage', 'incidents', 'accident'),
                 JSONExtractBool(so.maintenance_metadata, 'checklist_tags', 'accident'))     AS acidente
    FROM oms_r.so FINAL
    WHERE so._peerdb_is_deleted = 0 AND so.deleted_at IS NULL
      AND so.location_id IN (${bases.join(",")})
      AND so.created_at >= toDate('${dia}') - 2 AND so.created_at < toDate('${dia}') + 2
),
placa_srv AS (
    SELECT DISTINCT sv.so_id AS os_id FROM oms_r.so_service sv FINAL
    WHERE sv._peerdb_is_deleted = 0 AND lower(sv.description) LIKE '%troca de placa%'
),
ev AS (
    SELECT ss.so_id AS os_id, toUnixTimestamp(ss.created_at) AS ts, toString(ss.status) AS status
    FROM oms_r.so_status ss FINAL
    WHERE ss._peerdb_is_deleted = 0 AND ss.created_at >= toDate('${dia}') - 3
),
tl AS (
    -- argMax embrulhado em tuple(): argMax pula NULL e devolve linha anterior sem avisar.
    SELECT e.os_id                                        AS os_id,
        arraySort(x -> x.1, groupArray((e.ts, e.status)))  AS evs,
        minIf(e.ts, e.status = 'AWAITING_CX')              AS t_pronta,
        minIf(e.ts, e.status = 'IN_PROGRESS')              AS t_exec1,
        minIf(e.ts, e.status = 'IN_DIAGNOSIS')             AS t_diag,
        minIf(e.ts, e.status = 'QA_REJECTED')              AS t_qa_rej,
        argMax(tuple(e.status), e.ts).1                    AS status_final
    FROM ev e GROUP BY e.os_id
),
pecas AS (
    -- NÃO filtrar deleted_at: a linha apagada às 15h estava visível às 14h, e o
    -- replay precisa saber disso. created_at = quando entrou, deleted_at = quando saiu.
    -- ims_r.item_group entra como SUBQUERY com FINAL dentro: "JOIN t FINAL" direto
    -- não deduplica e infla o tempo.
    SELECT si.so_id AS os_id,
        groupArray(( toUnixTimestamp(si.created_at),
                     if(si.deleted_at IS NULL, 4102444800, toUnixTimestamp(si.deleted_at)),
                     ${CHAVE_PECA_SQL},
                     if(si.item_group_id IN (${FAMILIA_IDS_SQL}) OR si.item_group_id IN (${PECAS_UNICAS_SQL}), 1, 0),
                     toFloat64(coalesce(nullIf(transform(si.item_group_id, [${TEMPO_IDS}], [${TEMPO_MINS}], 0), 0),
                                        nullIf(ig.time_target, 0), ${TEMPO_FALLBACK_MIN})),
                     toFloat64(if(si.item_group_id IN (${FIXACAO_IDS_SQL}), 1, si.quantity)),
                     coalesce(ig.name, concat('peça ', toString(si.item_group_id))),
                     toInt32(si.item_group_id) )) AS itens
    FROM oms_r.so_item si FINAL
    LEFT JOIN (SELECT id, name, time_target FROM ims_r.item_group FINAL WHERE _peerdb_is_deleted = 0) ig
           ON ig.id = si.item_group_id
    WHERE si._peerdb_is_deleted = 0 AND si.origin IN ('DIAGNOSIS', 'MECHANIC')
      AND si.quantity > 0 AND si.item_group_id > 0
      AND si.created_at >= toDate('${dia}') - 3
    GROUP BY si.so_id
),
evcx AS (
    -- Cancelamento tem dois sabores: OPERATOR = recusa; o resto = o OMS encerrando
    -- sozinho porque a moto ficou pronta (não é recusa).
    SELECT toInt32(so_id) AS os_id,
        maxIf(1, event_type = 'RESERVE_OFFERED')                            AS ofertou,
        maxIf(1, event_type = 'RESERVE_CANCELLED' AND source =  'OPERATOR') AS recusou,
        maxIf(1, event_type = 'RESERVE_CANCELLED' AND source != 'OPERATOR') AS encerrou,
        maxIf(1, event_type = 'CALL_FOR_RESERVE')                           AS chamou,
        argMaxIf(tuple(coalesce(reason, '')), created_at, event_type = 'RESERVE_OFFERED').1 AS motivo_cx,
        minIf(toUnixTimestamp(created_at), event_type = 'RESERVE_OFFERED')  AS ofertou_ts,
        minIf(toUnixTimestamp(created_at), event_type = 'RESERVE_CANCELLED' AND source = 'OPERATOR') AS recusou_ts
    FROM maestro_scheduler_r.checkin_event FINAL
    WHERE _peerdb_is_deleted = 0 AND so_id IS NOT NULL
      AND created_at >= toDate('${dia}') - 2
    GROUP BY so_id
)
SELECT
    ck.os_id                                                    AS os_id,
    os.placa                                                    AS placa,
    os.base                                                     AS base,
    os.so_type                                                  AS so_type,
    os.asset_model                                              AS asset_model,
    os.asset_type                                               AS asset_type,
    os.descricao_cx                                             AS descricao_cx,
    os.guincho                                                  AS guincho,
    os.imobilizada                                              AS imobilizada,
    os.acidente                                                 AS acidente,
    if(coalesce(pl.os_id, 0) > 0, 1, 0)                         AS troca_placa,
    ck.checkin_status                                           AS checkin_status,
    ck.n_checkins                                               AS n_checkins,
    ck.service_conclusion                                       AS service_conclusion,
    toUnixTimestamp(ck.chegou_at)                               AS chegou_ts,
    if(ck.chamado_at IS NULL, 0, toUnixTimestamp(ck.chamado_at)) AS chamado_ts,
    -- 0 = o cliente nao foi embora. A sentinela abaixo TEM que ser a mesma data usada no
    -- least() do CTE ck; comparar com outra constante faz toda moto sem carimbo de saida
    -- parecer que saiu no ano 2099 (bug de 11/09).
    if(ck.saiu_at >= toDateTime64('2099-01-01 00:00:00', 6), 0, toUnixTimestamp(ck.saiu_at)) AS saiu_ts,
    toUnixTimestamp(os.aberta_at)                               AS aberta_ts,
    coalesce(tl.t_pronta, 0)                                    AS pronta_ts,
    coalesce(tl.t_exec1, 0)                                     AS exec1_ts,
    coalesce(tl.t_diag, 0)                                      AS diag_ts,
    coalesce(tl.t_qa_rej, 0)                                    AS qa_rej_ts,
    coalesce(tl.status_final, '')                               AS status_final,
    coalesce(tl.evs, [])                                        AS evs,
    coalesce(p.itens, [])                                       AS itens,
    coalesce(e.ofertou, 0) AS ofertou, coalesce(e.recusou, 0) AS recusou,
    coalesce(e.encerrou, 0) AS encerrou, coalesce(e.chamou, 0) AS chamou,
    coalesce(e.motivo_cx, '') AS motivo_cx,
    coalesce(e.ofertou_ts, 0) AS ofertou_ts, coalesce(e.recusou_ts, 0) AS recusou_ts,
    -- ORIGEM DO RELÓGIO: exatamente a régua do min_desde_chegada do motor.
    if(toUnixTimestamp(ck.chegou_at) <= toUnixTimestamp(os.aberta_at)
       AND toUnixTimestamp(os.aberta_at) - toUnixTimestamp(ck.chegou_at) <= 14400,
       toUnixTimestamp(ck.chegou_at), toUnixTimestamp(os.aberta_at))       AS t0,
    if(toUnixTimestamp(ck.chegou_at) <= toUnixTimestamp(os.aberta_at)
       AND toUnixTimestamp(os.aberta_at) - toUnixTimestamp(ck.chegou_at) <= 14400,
       'checkin', 'os')                                                    AS origem_relogio
FROM ck
INNER JOIN os        ON os.os_id = ck.os_id
LEFT  JOIN tl        ON tl.os_id = ck.os_id
LEFT  JOIN pecas p   ON p.os_id  = ck.os_id
LEFT  JOIN placa_srv pl ON pl.os_id = ck.os_id
LEFT  JOIN evcx e    ON e.os_id  = ck.os_id
ORDER BY ck.os_id
`;

export async function GET(req: NextRequest) {
  const bases = [...basesTeste()].sort((a, b) => a - b);
  const url = new URL(req.url);
  const agora = Math.floor(Date.now() / 1000);
  const hoje = new Date((agora - 3 * 3600) * 1000).toISOString().slice(0, 10);
  const pedido = url.searchParams.get("d") ?? "";
  const dia = /^\d{4}-\d{2}-\d{2}$/.test(pedido) ? pedido : hoje;
  const parcial = dia >= hoje;

  const linhas = await query<LinhaCH>(DIARIO_QUERY(bases, dia));

  // O ClickHouse manda na população; o log do Supabase só decora. Nenhuma sugestão
  // cria linha — se ela não tem desfecho no dia, vira contador no rodapé.
  const desde = `${dia}T00:00:00-03:00`;
  const ate = new Date(new Date(desde).getTime() + 48 * 3600 * 1000).toISOString();
  const log = await getSuggestionsWindow(desde, ate);

  const primeiroAviso = new Map<number, AvisoLog>();
  const pisoLogado = new Set<number>();
  const versoesNoLog = new Set<string>();
  for (const s of log) {
    if (s.algo_version) versoesNoLog.add(s.algo_version);
    if (s.is_piso) pisoLogado.add(s.os_id);
    if (s.decision !== "RESERVA") continue;
    if (!s.reason_code || !REGRAS_SLA.has(s.reason_code)) continue;
    // location_id nulo passa, igual ao /kpi: o log antigo não gravava a base
    if (s.location_id != null && !bases.includes(s.location_id)) continue;
    const ts = Math.floor(new Date(s.created_at).getTime() / 1000);
    const atual = primeiroAviso.get(s.os_id);
    if (atual && atual.ts <= ts) continue;
    const f = s.features ?? {};
    primeiroAviso.set(s.os_id, {
      ts, reason_code: s.reason_code, status_atual: s.status_atual,
      est_no_aviso: typeof f["tempo_estimado_min"] === "number" ? (f["tempo_estimado_min"] as number) : null,
      espera_no_aviso: typeof f["min_desde_chegada"] === "number" ? (f["min_desde_chegada"] as number) : null,
    });
  }

  const saida = linhas.map((r) =>
    analisaOS(r, primeiroAviso.get(r.os_id) ?? null, pisoLogado.has(r.os_id), agora));

  const naPopulacao = new Set(linhas.map((l) => l.os_id));
  const orfas = [...primeiroAviso.keys()].filter((id) => !naPopulacao.has(id)).length;

  // conferência do próprio relatório
  let divergenciaT0 = 0, replaySemLog = 0, logSemReplay = 0;
  for (const x of saida) {
    if (x.avisou_no_min !== null && x._espera_no_log !== null &&
        Math.abs(x._espera_no_log - x.avisou_no_min) > 3) divergenciaT0++;
    if (x._replay_a_tempo && !x.a_tempo) replaySemLog++;
    if (x.a_tempo && !x._replay_a_tempo) logSemReplay++;
  }

  const conta = (f: (x: (typeof saida)[number]) => boolean) => saida.filter(f).length;
  // DENOMINADOR = so o universo em que a reserva resolve (13/09). Fica de fora o guincho
  // e quem nao tem sinal de cliente na base. O alcance divide por isso, nao por tudo.
  const estouraram = conta((x) => x.estourou && x.no_universo);
  const estourosFora = conta((x) => x.estourou && !x.no_universo);
  const pegos = conta((x) => x.caixa === "A" && x.no_universo);
  const avisouFechado = conta((x) => x.a_tempo && !x.aberta && x.no_universo);
  const porMotivo = new Map<string, number>();
  for (const x of saida)
    if (x.caixa === "C" && x.no_universo)
      porMotivo.set(x.motivo_nao_pegou, (porMotivo.get(x.motivo_nao_pegou) ?? 0) + 1);

  return NextResponse.json({
    dia, bases, parcial, versao: ALGO_VERSION, gerado_em: hhmmSP(agora),
    resumo: {
      chegaram: saida.length,
      fechados: conta((x) => !x.aberta),
      ainda_na_oficina: conta((x) => x.aberta),
      estouraram,
      // a quebra que fecha: todo estouro cai em exatamente um destes tres
      estouros_ficou_na_mao: conta((x) => x.ficou_na_mao),
      estouros_saiu_de_reserva: conta((x) => x.estourou && x.no_universo && x.recebeu_reserva),
      estouros_fora_do_universo: estourosFora,
      estouros_total: conta((x) => x.estourou),
      avisou: conta((x) => x.avisou),
      avisou_a_tempo: conta((x) => x.a_tempo),
      avisou_em_cima_da_hora: conta((x) => x.avisou && !x.a_tempo),
      alcance: estouraram > 0 ? Math.round((1000 * pegos) / estouraram) / 10 : null,
      precisao: avisouFechado > 0 ? Math.round((1000 * pegos) / avisouFechado) / 10 : null,
    },
    caixas: {
      A: conta((x) => x.caixa === "A"), B: conta((x) => x.caixa === "B"),
      C: conta((x) => x.caixa === "C"), D: conta((x) => x.caixa === "D"),
      E: conta((x) => x.caixa === "E"),
    },
    fora_do_universo: Object.entries(
      saida.filter((x) => !x.no_universo).reduce<Record<string, number>>((a, x) => {
        a[x.fora_do_universo] = (a[x.fora_do_universo] ?? 0) + 1;
        return a;
      }, {})
    ).map(([motivo, n]) => ({ motivo, n })),
    porque_nao: [...porMotivo.entries()].sort((a, b) => b[1] - a[1]).map(([codigo, n]) => ({ codigo, n })),
    conferencia: {
      // O replay roda sempre com as regras de HOJE. Num dia em que o motor no ar era
      // outra versão, "o replay acha e o log não tem" não é bug: é o que as regras
      // novas teriam pego naquele dia. A tela precisa dessa distinção pra não gritar
      // alarme falso toda vez que alguém abrir um dia antigo.
      versoes_no_log: [...versoesNoLog].sort(),
      log_e_de_outra_versao: versoesNoLog.size > 0 && !versoesNoLog.has(ALGO_VERSION),
      divergencia_t0: divergenciaT0, replay_sem_log: replaySemLog, log_sem_replay: logSemReplay,
      avisos_sem_desfecho_no_dia: orfas, linhas_de_log: log.length,
      minuto_do_diagnostico: MIN_DIAGNOSTICO,
      regras_estruturalmente_tardias: REGRAS_ESTRUTURALMENTE_TARDIAS,
    },
    linhas: saida,
  });
}
