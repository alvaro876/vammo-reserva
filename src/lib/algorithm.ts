// Algoritmo de recomendação de reserva — camadas determinísticas
//
// Camada 4: capacidade da oficina — usa a curva de mecânicos ESPERADOS
// (base × dia-da-semana × hora, do histórico, injetada em route.ts) + a fila de
// trabalho esperando mecânico, pra estimar se a OS fica pronta em 3h.

import { Recomendacao, ReservaDecision } from "@/types";

// Versão da lógica — muda quando alteramos regras/thresholds (p/ comparar acurácia no log)
export const ALGO_VERSION = "0.8.0"; // 0.8.0 = peça segurando a moto: (a) AWAITING_PARTS/AWAITING_SERVICE
                                     // entram no radar (OSs travadas sumiam — furos 42908/43397/44130);
                                     // (b) regra nova C2_TRAVADA_SEM_PECA (93,7% no histórico 45d:
                                     // parada 30min+ & relógio 90-480min), pega até OS sem item
                                     // registrado; (c) C2_SEM_ESTOQUE só dispara com a moto parada
                                     // 30min+ fora de execução (leitura sozinha errou 9/9 na semana:
                                     // estoque vive sob grupo irmão ou fora do registro).
                                     // 0.7.0 = confiança na sugestão: projeção a <30min da linha das
                                     // 3h sai marcada "fronteira" (zona cara-ou-coroa — o encarregado
                                     // decide sabendo que é foto de chegada); demais saem "alta".
                                     // Exposta na API/Slack/log. Não muda O QUE dispara, muda como
                                     // a incerteza é comunicada.
                                     // 0.6.0 = ataque ao excesso das regras de tempo (semana 20-26:
                                     // 39 sugestões de piso ficaram prontas <3h): (a) C3_TEMPO_ALTO
                                     // sobe 120→140 (faixa 121-140 acertou 36%; 141+ acertou 100%);
                                     // (b) restante = estimativa − execução ACUMULADA (episódios
                                     // IN_PROGRESS somados; antes só o episódio atual descontava e
                                     // pause/retoma re-somava trabalho feito). Simulado na semana:
                                     // excesso C3 39→~6/sem, capturas 39/39 mantidas (5 ~15-50min
                                     // mais tarde via C3.5/C4 conforme o relógio acumula).
                                     // 0.5.1 = C1_ANOMALIA enxerga moto presa em OPEN que nunca
                                     // entrou na oficina (maxIf sem match virava epoch 1970 →
                                     // dateDiff negativo → regra cega; furo de dom 26/07, OS 44862).
                                     // 0.5.0 = fila do C4 conta só o trabalho de PISO à frente
                                     // (decomposição 20/07: piso fura a fila — espera real 4-5min;
                                     // a fila cheia superestimava e era a maior fonte de excesso).
                                     // 0.4.1 = fator por nº de peças na estimativa (recalibração
                                     // 20/07: aditivo superestimava OS de 1-3 peças; validado OOS)
                                     // + deleted_at filtrado nas peças do diagnóstico.
                                     // 0.4.0 = C2 só dispara p/ peça BLOQUEANTE + estoque conta
                                     // todos os depósitos da base (antes: cosmético disparava e
                                     // peça na bancada/recebimento contava como "sem estoque");
                                     // janela de OS avaliadas: 1 → 7 dias (causa dos furos).
                                     // 0.3.0 = estimativa de tempo calibrada (tempo-pecas.ts)

const THRESHOLDS = {
  anomalia_min: 240,         // C1: OS aberta há mais de 4h antes do diag fechar
  diversas_avarias: 9,       // C3: 9+ tipos de peça diferentes no diag
  tempo_estimado_max: 140,   // C3: tempo estimado total > 140 min (120→140 em 27/07: na semana
                             // 20-26 a faixa 121-140 acertou 36% no piso e 141+ acertou 100%;
                             // 121-140 continua coberta pelo C3.5 quando o relógio confirma)
  tempo_total_max: 180,      // C3.5 / C4: espera + execução > 180 min
  qa_min: 8,                 // C3.5 / C4: tempo médio de QA somado ao total (pedido da operação)
  espera_sem_diag_min: 150,  // C1: piso aberto há +2h30 sem diagnóstico → esperando demais
  fronteira_margem_min: 30,  // projeção a menos de 30min da linha das 3h = "fronteira"
                             // (zona cara-ou-coroa: variação natural do serviço decide o lado)
};

// Peças que sozinhas justificam reserva imediata
const PECAS_CRITICAS = new Set([
  257, 258, 259, 260,  // Motor
  184, 357,            // Balança
  250, 308, 340, 359,  // Caixa direção
  296,                 // Chassi
  240,                 // Garfo
]);

export interface AlgoritmoInput {
  os_id: number;
  so_type: string;
  location_id: number;
  asset_model: string;
  placa: string;
  descricao_cx: string;
  status_atual: string;
  imobilizada: number;
  acidente: number;
  guincho: number;
  min_open_to_awaiting: number;
  n_pecas: number;
  tempo_estimado_min: number;
  complexidade_max: number;
  n_pecas_criticas: number;
  n_sem_estoque: number;
  pecas_sem_estoque: string;
  n_sem_estoque_bloq: number;      // só peças BLOQUEANTES (tração/freio/rodante) em falta
  pecas_sem_estoque_bloq: string;  // nomes das bloqueantes em falta
  pecas_criticas: string;
  is_piso: number;
  min_no_status: number;
  min_desde_open: number;
  exec_acum_min?: number;        // execução acumulada (todos os episódios IN_PROGRESS), em min
  capacidade_esperada?: number;  // nº esperado de mecânicos na base/hora atual (curva do histórico)
  fila_min?: number;             // soma do tempo estimado das OS esperando mecânico na base
}

export function avaliarOS(input: AlgoritmoInput): Recomendacao {
  const base = {
    os_id: input.os_id,
    tempo_previsto_min: input.tempo_estimado_min,
    mecanico_sugerido: null as string | null,
    tempo_para_inicio_min: null as number | null,
    metadata: {
      n_pecas_diag: input.n_pecas,
      complexidade_max: input.complexidade_max,
      tem_peca_critica: input.n_pecas_criticas > 0,
      estoque_ok: input.n_sem_estoque === 0,
    },
  };

  // ── CAMADA 1: Regras duras ─────────────────────────────────────────────

  if (input.imobilizada === 1) return reserva("C1_HARD", "moto imobilizada", base, "alta");
  if (input.acidente === 1)    return reserva("C1_HARD", "acidente", base, "alta");
  if (input.guincho === 1)     return reserva("C1_HARD", "veio de guincho", base, "alta");
  if (input.so_type === "INSURANCE_QUOTE") return reserva("C1_HARD", "vistoria de seguro", base, "alta");
  if (input.min_open_to_awaiting > THRESHOLDS.anomalia_min) {
    return reserva("C1_ANOMALIA", `moto não entrou na oficina há ${input.min_open_to_awaiting}min`, base, "alta");
  }

  // Piso esperando demais SEM diagnóstico: moto em piso, aberta há muito tempo, e o
  // diagnóstico nem começou (sem estimativa de tempo). Não vai ficar pronta no prazo
  // → reserva. (Sem essa regra, OS sem diagnóstico escapavam, pois não há tempo p/ estimar.)
  if (
    input.is_piso === 1 &&
    input.tempo_estimado_min === 0 &&
    input.min_desde_open > THRESHOLDS.espera_sem_diag_min
  ) {
    return reserva(
      "C1_ESPERA_SEM_DIAG",
      `em piso há ${input.min_desde_open}min e ainda sem diagnóstico — esperando demais`,
      base,
      "alta"
    );
  }

  // ── CAMADA 2: Peça segurando a moto ────────────────────────────────────

  // Moto TRAVADA aguardando peça (status AWAITING_PARTS) no fluxo do dia: validado no
  // histórico de 45d — parada 30min+ com relógio total 90min+ = 93,7% de estouro.
  // Cobre inclusive OS sem nenhum item registrado (o mecânico sabe da falta, o sistema não).
  if (
    input.status_atual === "AWAITING_PARTS" &&
    input.min_no_status >= 30 &&
    input.min_desde_open >= 90 &&
    input.min_desde_open <= 480
  ) {
    return reserva(
      "C2_TRAVADA_SEM_PECA",
      `parada aguardando peça há ${input.min_no_status}min (OS aberta há ${input.min_desde_open}min)`,
      base,
      "alta"
    );
  }

  // Leitura de estoque: peça BLOQUEANTE em falta só vale se a moto está de fato PARADA
  // (30min+ sem andar, fora de execução). Na semana 20-26 a leitura "estoque zero" sozinha
  // errou 9/9 no piso — a oficina resolvia mesmo assim (peça sob outro grupo, ex.
  // "Roda traseira Dual suspension" vs "_v1/_v2", ou estoque não registrado).
  if (
    input.n_sem_estoque_bloq > 0 &&
    ["OPEN", "IN_DIAGNOSIS", "AWAITING_MECHANIC", "PAUSED", "AWAITING_SERVICE"].includes(input.status_atual) &&
    input.min_no_status >= 30
  ) {
    return reserva(
      "C2_SEM_ESTOQUE",
      `peça bloqueante sem estoque na base (${input.pecas_sem_estoque_bloq}) e moto parada há ${input.min_no_status}min`,
      base
    );
  }

  // ── CAMADA 3: Complexidade ─────────────────────────────────────────────

  // Restante desconta a execução ACUMULADA (todos os episódios IN_PROGRESS): o
  // desconto antigo via min_no_status zerava a cada pausa/retomada e re-somava
  // trabalho já feito. Fallback pro comportamento antigo se o campo não vier.
  const execFeita = input.exec_acum_min ??
    (input.status_atual === "IN_PROGRESS" ? input.min_no_status : 0);
  const tempoRestanteC3 = Math.max(0, input.tempo_estimado_min - execFeita);
  const totalSemMec = input.min_desde_open + tempoRestanteC3 + THRESHOLDS.qa_min;
  // Projeção a menos de 30min da linha = fronteira: a sugestão sai marcada pro
  // encarregado saber que é decisão de foto de chegada, não de convicção.
  const confiancaTempo = (proj: number): "alta" | "fronteira" =>
    proj >= THRESHOLDS.tempo_total_max + THRESHOLDS.fronteira_margem_min ? "alta" : "fronteira";

  // Peça crítica e nº de peças foram REMOVIDOS como critério (decisão da operação):
  // ter um Motor ou muitas peças não significa, por si só, passar de 3h — quem decide
  // é o tempo. Quando a estimativa de tempo for recalibrada, ela já captura essas peças.
  if (input.tempo_estimado_min > THRESHOLDS.tempo_estimado_max) {
    // faixa 141+ mediu 100% na semana 20-26 → confiança alta por construção
    return reserva("C3_TEMPO_ALTO", `trabalho estimado em ${input.tempo_estimado_min}min`, base, "alta");
  }

  // ── CAMADA 3.5: Tempo total combinado (sem capacidade) ─────────────────
  // Se a soma do tempo já esperado + restante já passa de 3h, não adianta.
  if (input.tempo_estimado_min > 0 && input.min_desde_open < 480 && totalSemMec > THRESHOLDS.tempo_total_max) {
    return reserva(
      "C3_TEMPO_COMBINADO",
      `já esperou ${input.min_desde_open}min + restante ~${tempoRestanteC3}min + ${THRESHOLDS.qa_min}min QA = ${totalSemMec}min total`,
      base,
      confiancaTempo(totalSemMec)
    );
  }

  // ── CAMADA 4: Capacidade da oficina (modelo de presença) ───────────────
  // Usa a CAPACIDADE ESPERADA de mecânicos na base/hora (curva do histórico,
  // injetada em route.ts) + a fila de trabalho esperando mecânico, pra estimar
  // quanto tempo até esta OS ser atendida. Substitui o antigo proxy de "quem
  // está mexendo numa moto agora" (que despencava no almoço e na troca de turno).
  const cap = input.capacidade_esperada ?? 0;
  if (cap > 0 && input.tempo_estimado_min > 0) {
    const filaMin = input.fila_min ?? 0;
    const tempoEspera = Math.round(filaMin / cap);   // fila de serviço ÷ mecânicos em paralelo
    base.tempo_para_inicio_min = tempoEspera;
    const tempoTotal = input.min_desde_open + tempoEspera + tempoRestanteC3 + THRESHOLDS.qa_min;
    base.tempo_previsto_min = tempoTotal;

    if (input.tempo_estimado_min > 0 && tempoTotal > THRESHOLDS.tempo_total_max) {
      return reserva(
        "C4_CAPACIDADE",
        `oficina saturada: fila ~${tempoEspera}min (${filaMin}min de serviço ÷ ${cap} mec esperados) + ${tempoRestanteC3}min serviço + ${THRESHOLDS.qa_min}min QA, já esperou ${input.min_desde_open}min → ${tempoTotal}min`,
        base,
        confiancaTempo(tempoTotal)
      );
    }

    return {
      ...base,
      decision: "SEM_RESERVA" as ReservaDecision,
      rule_triggered: "C4_OK",
      motivo: `dentro do prazo: ~${tempoTotal}min (fila ~${tempoEspera}min com ${cap} mec esperados + ${tempoRestanteC3}min serviço + ${THRESHOLDS.qa_min}min QA)`,
    };
  }

  // ── Sem capacidade (curva indisponível) → decisão determinística ───────
  const semDiag = input.tempo_estimado_min === 0;
  return {
    ...base,
    decision: "SEM_RESERVA" as ReservaDecision,
    rule_triggered: semDiag ? "C5_AGUARDA_DIAG" : "C5_DENTRO_PRAZO",
    motivo: semDiag
      ? `aguardando diagnóstico (aberta há ${input.min_desde_open}min, sem estimativa de tempo ainda)`
      : `dentro do prazo: aberta há ${input.min_desde_open}min, estimado ${input.tempo_estimado_min}min`,
  };
}

function reserva(
  rule: string,
  motivo: string,
  base: Omit<Recomendacao, "decision" | "rule_triggered" | "motivo">,
  confianca?: "alta" | "fronteira"
): Recomendacao {
  return {
    ...base,
    decision: "RESERVA",
    rule_triggered: rule,
    motivo,
    confianca,
  };
}

export { THRESHOLDS, PECAS_CRITICAS };
