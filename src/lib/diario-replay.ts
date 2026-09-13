// O MIOLO DO RELATÓRIO DIÁRIO: reconstrói o estado de uma OS minuto a minuto e roda
// as regras de novo em cima dele, pra responder "o RIVERS pegou? e se não, por quê?".
//
// Fica fora da rota de propósito: sem `next/server` e sem I/O, o que está aqui roda
// num teste de linha de comando com dado real (scripts/testa-diario-replay.mjs). O
// "por que não pegou" é a coluna mais cara do relatório; ela precisa ser testável.
//
// ─────────────────────────────────────────────────────────────────────────────
// DUAS DECISÕES QUE VALEM LER
//
// 1) O REPLAY CHAMA O `avaliarOS` DE VERDADE, não uma cópia das regras. Se alguém
//    mexer num limiar do algorithm.ts, este relatório muda junto. Reimplementar as
//    regras aqui seria garantia de divergir do motor em duas semanas.
//
// 2) O INSTANTE QUE DECIDE É O MINUTO 120, não o minuto do disparo. É o último
//    momento em que um aviso ainda teria 1h de antecedência, que é o mínimo pra
//    buscar e entregar uma reserva. A pergunta do relatório não é "quando o RIVERS
//    falou", é "dava pra falar a tempo".
// ─────────────────────────────────────────────────────────────────────────────

import { avaliarOS, AlgoritmoInput, THRESHOLDS, QA_STATUSES } from "@/lib/algorithm";
import { REGRAS_SLA, NOME_REGRA } from "@/lib/regras-sla";
import { TEMPO_BASE_MIN } from "@/lib/tempo-pecas";
import { fatorMultiPeca, SKILL_POR_PECA } from "@/lib/pecas-sql";

export const LIMITE_MIN = 180;        // a promessa das 3h
export const MIN_DIAGNOSTICO = 120;   // último minuto com 60 de antecedência
export const ANTECEDENCIA_MIN = 60;   // o que conta como "a tempo"
export const GRADE_MIN = 10;          // o cron roda de 10 em 10
export const CRON_INICIO_SP = 7;
export const CRON_FIM_SP = 21;
export const TETO_REPLAY_MIN = 300;   // até onde procurar o disparo tardio

// Statuses em que o motor avalia a OS (espelha STATUSES_AVALIAVEIS do rivers-engine).
const AVALIAVEIS = new Set([
  "OPEN", "IN_DIAGNOSIS", "AWAITING_MECHANIC", "IN_PROGRESS", "PAUSED", "AWAITING_VMGMT",
  "AWAITING_PARTS", "AWAITING_SERVICE", "AWAITING_QA", "IN_QA", "QA_REJECTED",
]);
const CRITICAS = new Set([257, 258, 259, 260, 184, 357, 250, 308, 340, 359, 296, 240]);
const DIRECAO = new Set([229, 240, 340, 359, 228]);
const MODELOS_FORA = ["S 60V45Ah", "T 74V28Ah"];

export const NOME_STATUS: Record<string, string> = {
  OPEN: "aberta, sem triagem", IN_DIAGNOSIS: "em diagnóstico",
  AWAITING_MECHANIC: "na fila da bancada", IN_PROGRESS: "em execução",
  PAUSED: "pausada", AWAITING_PARTS: "aguardando peça",
  AWAITING_SERVICE: "em serviço externo", AWAITING_VMGMT: "com gestão de frota",
  AWAITING_QA: "na fila do QA", IN_QA: "em conferência", QA_REJECTED: "reprovada no QA",
  AWAITING_CX: "pronta, esperando o cliente", "(sem OS)": "OS ainda não aberta",
};

// tuplas do ClickHouse chegam como array posicional
export type ItemTupla = [number, number, string, number, number, number, string, number];
//                       ts_add  ts_del  chave   conta_uma minutos qtd_eff nome    ig_id
export type EvTupla = [number, string];

export interface LinhaCH {
  os_id: number; placa: string; base: number; so_type: string; asset_model: string;
  asset_type: string; descricao_cx: string; guincho: number; imobilizada: number;
  acidente: number; troca_placa: number; checkin_status: string; n_checkins: number;
  service_conclusion: string; chegou_ts: number; chamado_ts: number; saiu_ts: number;
  aberta_ts: number; pronta_ts: number; exec1_ts: number; diag_ts: number;
  qa_rej_ts: number; status_final: string; evs: EvTupla[]; itens: ItemTupla[];
  ofertou: number; recusou: number; encerrou: number; chamou: number; motivo_cx: string;
  ofertou_ts: number; recusou_ts: number; t0: number; origem_relogio: string;
}

export interface AvisoLog {
  ts: number; reason_code: string | null; status_atual: string | null;
  est_no_aviso: number | null; espera_no_aviso: number | null;
}

// ── A CONTA DE TEMPO, COMO ELA ERA NO INSTANTE T ─────────────────────────────
// Espelha a CTE pecas_tempo do motor: agrupa por chave, peça única/família conta só
// a variante mais demorada, o resto soma (fixação vale 1 por linha), e o total leva
// o fator multi-peça mais os 25 min de base.
//
// Sem peça visível devolve 0, e não os 25 de base: o motor faz coalesce do LEFT JOIN
// e enxerga 0. Devolver 25 aqui quebraria o C5_AGUARDA_DIAG no replay.
//
// Conferido contra o que o motor gravou (10/09, 151 decisões): 141 batem exatamente
// (93,4%). As 10 diferenças são todas no mesmo sentido — a reconstrução enxerga a
// peça alguns segundos antes do motor, porque usa o created_at da linha e o motor
// usa o que já tinha replicado quando leu. 8 das 10 em OS em diagnóstico, que é
// exatamente quando o mecânico está lançando peça.
export function estimativaEm(itens: ItemTupla[], T: number): { est: number; nChaves: number; nPecas: number } {
  const porChave = new Map<string, { unica: number; maiorVariante: number; soma: number }>();
  let nPecas = 0;
  for (const [tsAdd, tsDel, chave, contaUma, minutos, qtdEff] of itens) {
    if (!(tsAdd <= T && tsDel > T)) continue;
    nPecas++;
    const g = porChave.get(chave) ?? { unica: 0, maiorVariante: 0, soma: 0 };
    g.unica = Math.max(g.unica, contaUma);
    g.maiorVariante = Math.max(g.maiorVariante, minutos);
    g.soma += qtdEff * minutos;
    porChave.set(chave, g);
  }
  if (porChave.size === 0) return { est: 0, nChaves: 0, nPecas: 0 };
  let bruto = 0;
  for (const g of porChave.values()) bruto += g.unica === 1 ? g.maiorVariante : g.soma;
  return { est: Math.round(bruto * fatorMultiPeca(porChave.size) + TEMPO_BASE_MIN), nChaves: porChave.size, nPecas };
}

/** Quanto cada peça contribuiu na estimativa do instante T, da que mais puxa pra que menos. */
export function rankingPecas(itens: ItemTupla[], T: number): { nome: string; min: number; ig: number }[] {
  const porChave = new Map<string, { unica: number; maior: number; soma: number; nome: string; ig: number; peso: number }>();
  for (const [tsAdd, tsDel, chave, contaUma, minutos, qtdEff, nome, ig] of itens) {
    if (!(tsAdd <= T && tsDel > T)) continue;
    const g = porChave.get(chave) ?? { unica: 0, maior: 0, soma: 0, nome, ig, peso: -1 };
    g.unica = Math.max(g.unica, contaUma);
    g.maior = Math.max(g.maior, minutos);
    g.soma += qtdEff * minutos;
    const peso = contaUma === 1 ? minutos : qtdEff * minutos;
    if (peso > g.peso) { g.peso = peso; g.nome = nome; g.ig = ig; }
    porChave.set(chave, g);
  }
  const f = fatorMultiPeca(porChave.size);
  return [...porChave.values()]
    .map((g) => ({ nome: g.nome, ig: g.ig, min: Math.round((g.unica === 1 ? g.maior : g.soma) * f) }))
    .sort((a, b) => b.min - a.min);
}

export function statusEm(evs: EvTupla[], T: number): { status: string; desde: number } {
  let achou: EvTupla | null = null;
  for (const e of evs) { if (e[0] <= T) achou = e; else break; }
  return achou ? { status: achou[1], desde: achou[0] } : { status: "(sem OS)", desde: 0 };
}

export function execAcumEm(evs: EvTupla[], T: number): number {
  let seg = 0;
  for (let i = 0; i < evs.length; i++) {
    if (evs[i][1] !== "IN_PROGRESS") continue;
    const fim = i + 1 < evs.length ? evs[i + 1][0] : T;
    seg += Math.max(0, Math.min(fim, T) - evs[i][0]);
  }
  return Math.round(seg / 60);
}

/** Hora de parede em São Paulo (UTC-3, sem horário de verão no Brasil desde 2019). */
export function horaSP(ts: number): number {
  return new Date((ts - 3 * 3600) * 1000).getUTCHours();
}
/** Data de calendário em São Paulo, pra saber se a moto virou o dia. */
export function diaSP(ts: number): string {
  return new Date((ts - 3 * 3600) * 1000).toISOString().slice(0, 10);
}
export function hhmmSP(ts: number): string {
  const d = new Date((ts - 3 * 3600) * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

export interface Replay {
  disparos: { regra: string; min: number; sla: boolean }[];
  primeiroSla: { regra: string; min: number } | null;
  tiques: number; tiquesAte120: number;
  proj120: number | null; est120: number; exec120: number; status120: string; piso120: number;
  minContaFecha: number | null;
}

/** Roda o motor de verdade na grade do cron e guarda o 1º disparo de cada regra. */
export function replay(r: LinhaCH, tetoMin: number): Replay {
  const disparos: { regra: string; min: number; sla: boolean }[] = [];
  const vistos = new Set<string>();
  let tiques = 0, tiquesAte120 = 0;
  let proj120: number | null = null, est120 = 0, exec120 = 0, status120 = "(sem OS)", piso120 = 0;
  let minContaFecha: number | null = null;

  for (let m = 0; m <= tetoMin; m += GRADE_MIN) {
    const T = r.t0 + m * 60;
    if (r.pronta_ts > 0 && T > r.pronta_ts) break;
    const h = horaSP(T);
    const noHorario = h >= CRON_INICIO_SP && h < CRON_FIM_SP;

    const { status, desde } = statusEm(r.evs, T);
    const { est, nPecas } = estimativaEm(r.itens, T);
    const exec = execAcumEm(r.evs, T);
    const emQa = QA_STATUSES.has(status);
    const restante = emQa ? 0 : Math.max(0, est - exec);
    const proj = m + Math.round(restante * THRESHOLDS.fator_bancada) + THRESHOLDS.qa_min;
    const piso =
      r.chamado_ts > 0 && r.chamado_ts <= T && (r.saiu_ts === 0 || r.saiu_ts > T) &&
      !["NO_SHOW", "CANCELLED", "DROPOUT"].includes(r.checkin_status) &&
      r.so_type !== "RETURN_INSPECTION" ? 1 : 0;

    if (m <= MIN_DIAGNOSTICO) {
      proj120 = proj; est120 = est; exec120 = exec; status120 = status; piso120 = piso;
      if (noHorario && AVALIAVEIS.has(status)) tiquesAte120++;
    }
    if (minContaFecha === null && !emQa && proj > LIMITE_MIN + THRESHOLDS.conta_folga_min) minContaFecha = m;
    if (!noHorario || !AVALIAVEIS.has(status)) continue;
    tiques++;

    const criticas = r.itens.filter((i) => i[0] <= T && i[1] > T && CRITICAS.has(i[7]));
    const input: AlgoritmoInput = {
      os_id: r.os_id, so_type: r.so_type, location_id: r.base, asset_model: r.asset_model,
      placa: r.placa, descricao_cx: r.descricao_cx, status_atual: status,
      imobilizada: r.imobilizada, acidente: r.acidente, guincho: r.guincho,
      min_open_to_awaiting: status === "OPEN" ? Math.round((T - r.aberta_ts) / 60) : 0,
      n_pecas: nPecas, tempo_estimado_min: est,
      complexidade_max: r.itens.reduce((a, i) => (i[0] <= T && i[1] > T ? Math.max(a, SKILL_POR_PECA[i[7]] ?? 1) : a), 1),
      n_pecas_criticas: criticas.length,
      // a leitura de estoque está DESLIGADA em produção (0 acerto em 16 disparos);
      // o replay reproduz o motor como ele está, então entra zerada.
      n_sem_estoque: 0, pecas_sem_estoque: "", n_sem_estoque_bloq: 0, pecas_sem_estoque_bloq: "",
      pecas_criticas: criticas.map((c) => c[6]).join(", "),
      is_piso: piso, troca_placa: r.troca_placa,
      min_ate_rejeicao: r.qa_rej_ts > 0 && r.qa_rej_ts <= T ? Math.round((r.qa_rej_ts - r.aberta_ts) / 60) : -1,
      tem_direcao: r.itens.some((i) => i[0] <= T && i[1] > T && DIRECAO.has(i[7])) ? 1 : 0,
      min_no_status: desde > 0 ? Math.round((T - desde) / 60) : 0,
      min_desde_open: Math.round((T - r.aberta_ts) / 60),
      min_desde_chegada: m,
      exec_acum_min: exec,
      oferta_ativa: r.ofertou_ts > 0 && r.ofertou_ts <= T && !(r.recusou_ts > 0 && r.recusou_ts <= T) ? 1 : 0,
      oferta_recusada: r.recusou_ts > 0 && r.recusou_ts <= T ? 1 : 0,
      capacidade_esperada: 0, fila_min: 0,
    };
    const rec = avaliarOS(input);
    const regra = rec.rule_triggered ?? "";
    if (rec.decision === "RESERVA" && regra && !vistos.has(regra)) {
      vistos.add(regra);
      disparos.push({ regra, min: m, sla: REGRAS_SLA.has(regra) });
    }
  }
  const sla = disparos.filter((d) => d.sla).sort((a, b) => a.min - b.min);
  return {
    disparos, primeiroSla: sla[0] ? { regra: sla[0].regra, min: sla[0].min } : null,
    tiques, tiquesAte120, proj120, est120, exec120, status120, piso120, minContaFecha,
  };
}

// ── POR QUE NÃO PEGOU: um motivo primário por moto ───────────────────────────
// Precedência fixa, a primeira que aplicar vence. A ordem importa: uma moto que o
// motor nem chegou a olhar não deve ser classificada como "a conta não fechou".
export function porQueNaoPegou(r: LinhaCH, rp: Replay, ctx: {
  estFim: number; chegouTarde: number; pecasTarde: string[]; dur: number;
}): { motivo: string; detalhe: string } {
  const abertaNoMin = Math.round((r.aberta_ts - r.t0) / 60);
  const saiuNoMin = r.saiu_ts > 0 ? Math.round((r.saiu_ts - r.t0) / 60) : -1;
  const execNoMin = r.exec1_ts > 0 ? Math.round((r.exec1_ts - r.t0) / 60) : -1;
  const corte = LIMITE_MIN + THRESHOLDS.conta_folga_min;

  if (r.asset_type !== "BIKE" || MODELOS_FORA.includes(r.asset_model))
    return { motivo: "FORA_DO_ESCOPO", detalhe: `${r.asset_model || r.asset_type} não entra na avaliação do motor` };
  if (r.guincho === 1)
    return { motivo: "GUINCHO", detalhe: "moto de guincho: o motor foi mandado ignorar esses casos" };
  if (abertaNoMin > MIN_DIAGNOSTICO)
    return { motivo: "OS_ABERTA_DEPOIS", detalhe: `a OS só foi aberta ${abertaNoMin} min depois da chegada; no prazo de aviso ela não existia` };
  if (rp.tiquesAte120 === 0)
    return { motivo: "SEM_TIQUE", detalhe: `chegou ${hhmmSP(r.chegou_ts)}: o motor não olhou esta OS nenhuma vez dentro do prazo (ele roda das ${CRON_INICIO_SP}h às ${CRON_FIM_SP}h)` };
  if (saiuNoMin >= 0 && saiuNoMin < MIN_DIAGNOSTICO)
    return { motivo: "CLIENTE_JA_SAIU", detalhe: `atendimento encerrado aos ${saiuNoMin} min; pro motor o cliente já não estava na base` };
  if (rp.piso120 === 0)
    return { motivo: "NUNCA_FOI_PISO", detalhe: r.chamado_ts === 0
      ? "sem chamada no balcão: 9 das 10 regras exigem cliente esperando na base"
      : `${r.so_type}: fora da população de cliente esperando` };
  if (rp.est120 === 0)
    return { motivo: "SEM_DIAGNOSTICO", detalhe: `às 2h de casa nenhuma peça tinha sido lançada (a moto estava ${NOME_STATUS[rp.status120] ?? rp.status120})` };
  if (ctx.chegouTarde >= 30)
    return { motivo: "PECA_CHEGOU_TARDE", detalhe: `o diagnóstico cresceu +${ctx.chegouTarde} min depois do prazo de aviso: ${ctx.pecasTarde.slice(0, 2).join(", ")}` };
  if (rp.primeiroSla && rp.primeiroSla.min > MIN_DIAGNOSTICO)
    return { motivo: "SO_FECHOU_TARDE", detalhe: `${NOME_REGRA[rp.primeiroSla.regra] ?? rp.primeiroSla.regra} chegou a fechar, mas só aos ${rp.primeiroSla.min} min, ${rp.primeiroSla.min - MIN_DIAGNOSTICO} min tarde demais` };
  if (execNoMin >= 0 && execNoMin <= 90 && ctx.dur > 0 && ctx.dur > ctx.estFim)
    return { motivo: "COMECOU_RAPIDO", detalhe: `entrou em execução aos ${execNoMin} min e a bancada passou da estimativa (estimado ${ctx.estFim} min, real ${ctx.dur} min)` };
  if (rp.proj120 !== null)
    return { motivo: "CONTA_NAO_CHEGOU_LA", detalhe: `às 2h a conta dava ${rp.proj120} min, ${corte - rp.proj120} abaixo do corte de ${corte}` };
  return { motivo: "OUTRO", detalhe: "não classificado; vale abrir o caso" };
}

/** Junta tudo: uma linha do relatório a partir de uma OS e do que o log registrou. */
export function analisaOS(r: LinhaCH, aviso: AvisoLog | null, pisoNoLog: boolean, agora: number) {
  const dur = r.pronta_ts > 0 ? Math.round((r.pronta_ts - r.t0) / 60) : -1;
  const aberta = dur < 0;
  const estourou = dur > LIMITE_MIN;
  // O replay para onde a observação para. Para moto ainda na oficina isso é AGORA, não o
  // teto: rodar até o minuto 300 numa moto com 30 min de casa repete o último status
  // conhecido e inventa alertas que ainda nem tiveram chance de acontecer. Foi o que fez o
  // relatório de 11/09 acusar duas regras de não terem disparado em motos que ainda estavam
  // no minuto 30 (bug de 11/09).
  const decorrido = Math.max(0, Math.floor((agora - r.t0) / 60));
  const rp = replay(r, Math.min(TETO_REPLAY_MIN, dur > 0 ? dur : decorrido));

  const avisouNoMin = aviso ? Math.round((aviso.ts - r.t0) / 60) : null;
  const avisou = Boolean(aviso) && pisoNoLog;
  const folga = avisouNoMin === null ? null : LIMITE_MIN - avisouNoMin;
  const aTempo = avisou && folga !== null && folga >= ANTECEDENCIA_MIN;

  const tFim = r.pronta_ts > 0 ? r.pronta_ts : agora;
  const rank = rankingPecas(r.itens, tFim);
  const rank120 = rankingPecas(r.itens, r.t0 + MIN_DIAGNOSTICO * 60);
  const estFim = estimativaEm(r.itens, tFim).est;
  const chegouTarde = estFim - rp.est120;
  const pecasTarde = rank.filter((p) => !rank120.some((q) => q.ig === p.ig)).map((p) => p.nome);

  let motivo = "", detalhe = "";
  if (!aTempo && !aberta) {
    const d = porQueNaoPegou(r, rp, { estFim, chegouTarde, pecasTarde, dur });
    motivo = d.motivo;
    detalhe = avisou ? `avisou, mas em cima da hora (folga ${folga} min). ${d.detalhe}` : d.detalhe;
  }

  // ── O UNIVERSO DA RESERVA (13/09, pedido do Alvaro: "nao incluir esses caras") ──
  // Nem todo estouro e alvo de moto reserva. Sai do denominador quem o motor foi mandado
  // ignorar (guincho) e quem nao tem NENHUM sinal de que havia cliente na base.
  //
  // O que eu quase errei aqui, e que a medicao pegou: "sem chamada no balcao" NAO e sinal
  // de ausencia. No piloto, 18 das 26 OS sem `called_at` tiveram oferta de reserva e 10
  // receberam moto — havia cliente, faltava o carimbo. Usar ausencia de dado como ausencia
  // de cliente jogaria fora caso real. Por isso a evidencia e a UNIAO dos sinais.
  const evidenciaDeCliente =
    r.chamado_ts > 0 || r.ofertou === 1 || r.chamou === 1 ||
    ["RESERVE_DELIVERED", "BIKE_REPLACED"].includes(r.service_conclusion);
  const foraDoUniverso = r.guincho === 1
    ? "guincho, o motor foi mandado ignorar"
    : !evidenciaDeCliente
      ? "nenhum sinal de cliente na base"
      : "";
  const noUniverso = foraDoUniverso === "";

  // Dentro do universo, o estouro tem dois desfechos MUITO diferentes, e juntar os dois
  // esconde o que importa: metade dos 210 estouros do piloto (99) terminou com o cliente
  // indo embora de outra moto. Contar isso como "estouro que o RIVERS nao pegou" e contar
  // um acerto como erro.
  const recebeuReserva = ["RESERVE_DELIVERED", "BIKE_REPLACED"].includes(r.service_conclusion);
  const ficouNaMao = estourou && noUniverso && !recebeuReserva;

  const caixa = aberta ? "E" : estourou ? (aTempo ? "A" : "C") : (aTempo ? "B" : "D");
  // ESTOURO DA MOTO x ESTOURO DO CLIENTE. Quando o atendimento fecha antes das 3h e a
  // moto só fica pronta muito depois, quem passou das 3h foi a MOTO: o cliente já tinha
  // ido embora (a pé, de reserva, ou combinou de voltar). Medido no piloto: 67 dos 210
  // "estouros" são desse tipo. Contar os dois juntos faz o alcance do RIVERS parecer
  // pior do que é, então o relatório separa em vez de descartar.
  const saiuNoMin = r.saiu_ts > 0 ? Math.round((r.saiu_ts - r.t0) / 60) : -1;
  const clienteSaiuAntes = saiuNoMin >= 0 && dur > 0 && saiuNoMin < Math.min(dur, LIMITE_MIN);
  return {
    no_universo: noUniverso, fora_do_universo: foraDoUniverso,
    recebeu_reserva: recebeuReserva, ficou_na_mao: ficouNaMao,
    cliente_saiu_no_min: saiuNoMin, cliente_saiu_antes: clienteSaiuAntes,
    virou_o_dia: r.pronta_ts > 0 && diaSP(r.pronta_ts) !== diaSP(r.chegou_ts),
    os_id: r.os_id, placa: r.placa, base: r.base, so_type: r.so_type,
    chegou: hhmmSP(r.chegou_ts), pronta: r.pronta_ts > 0 ? hhmmSP(r.pronta_ts) : "",
    origem_relogio: r.origem_relogio, dur_min: dur, aberta, estourou,
    excesso: dur > 0 ? dur - LIMITE_MIN : 0,
    caixa, avisou, a_tempo: aTempo,
    regra: aviso?.reason_code ?? null,
    regra_nome: aviso?.reason_code ? (NOME_REGRA[aviso.reason_code] ?? aviso.reason_code) : null,
    submotivo: aviso?.status_atual ? (NOME_STATUS[aviso.status_atual] ?? aviso.status_atual) : null,
    avisou_hora: aviso ? hhmmSP(aviso.ts) : "", avisou_no_min: avisouNoMin, folga_min: folga,
    est_no_aviso: aviso?.est_no_aviso ?? null,
    motivo_nao_pegou: motivo, detalhe,
    status_120: NOME_STATUS[rp.status120] ?? rp.status120, est_120: rp.est120,
    exec_120: rp.exec120, proj_120: rp.proj120, piso_120: rp.piso120,
    min_conta_fecha: rp.minContaFecha, tiques: rp.tiques,
    replay_regra: rp.primeiroSla?.regra ?? null, replay_min: rp.primeiroSla?.min ?? null,
    est_fim: estFim, est_chegou_tarde: chegouTarde > 0 ? chegouTarde : 0,
    peca_que_puxou: rank[0]?.nome ?? "", peca_que_puxou_min: rank[0]?.min ?? 0,
    top_pecas: rank.slice(0, 3).map((p) => `${p.nome} (${p.min}min)`).join(" · "),
    pecas_depois_do_prazo: pecasTarde.slice(0, 3).join(" · "),
    guincho: r.guincho, troca_placa: r.troca_placa, n_checkins: r.n_checkins,
    ofertou: r.ofertou, recusou: r.recusou, encerrou: r.encerrou, motivo_cx: r.motivo_cx,
    ofertou_no_min: r.ofertou_ts > 0 ? Math.round((r.ofertou_ts - r.t0) / 60) : null,
    entregue: r.service_conclusion === "RESERVE_DELIVERED" ? 1 : 0,
    status_final: r.status_final,
    // conferência do próprio relatório
    _replay_a_tempo: rp.primeiroSla !== null && rp.primeiroSla.min <= MIN_DIAGNOSTICO,
    _espera_no_log: aviso?.espera_no_aviso ?? null,
  };
}

export type LinhaDiario = ReturnType<typeof analisaOS>;
