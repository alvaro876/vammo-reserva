// Algoritmo de recomendação de reserva — camadas determinísticas
//
// Camada 4: capacidade da oficina — usa a curva de mecânicos ESPERADOS
// (base × dia-da-semana × hora, do histórico, injetada em route.ts) + a fila de
// trabalho esperando mecânico, pra estimar se a OS fica pronta em 3h.

import { Recomendacao, ReservaDecision } from "@/types";

// Versão da lógica — muda quando alteramos regras/thresholds (p/ comparar acurácia no log)
export const ALGO_VERSION = "0.3.0"; // 0.3.0 = estimativa de tempo calibrada (tempo-pecas.ts)

const THRESHOLDS = {
  anomalia_min: 240,         // C1: OS aberta há mais de 4h antes do diag fechar
  diversas_avarias: 9,       // C3: 9+ tipos de peça diferentes no diag
  tempo_estimado_max: 120,   // C3: tempo estimado total > 120 min
  tempo_total_max: 180,      // C3.5 / C4: espera + execução > 180 min
  qa_min: 8,                 // C3.5 / C4: tempo médio de QA somado ao total (pedido da operação)
  espera_sem_diag_min: 150,  // C1: piso aberto há +2h30 sem diagnóstico → esperando demais
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
  pecas_criticas: string;
  is_piso: number;
  min_no_status: number;
  min_desde_open: number;
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

  if (input.imobilizada === 1) return reserva("C1_HARD", "moto imobilizada", base);
  if (input.acidente === 1)    return reserva("C1_HARD", "acidente", base);
  if (input.guincho === 1)     return reserva("C1_HARD", "veio de guincho", base);
  if (input.so_type === "INSURANCE_QUOTE") return reserva("C1_HARD", "vistoria de seguro", base);
  if (input.min_open_to_awaiting > THRESHOLDS.anomalia_min) {
    return reserva("C1_ANOMALIA", `moto não entrou na oficina há ${input.min_open_to_awaiting}min`, base);
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
      base
    );
  }

  // ── CAMADA 2: Estoque ──────────────────────────────────────────────────

  if (input.n_sem_estoque > 0) {
    return reserva("C2_SEM_ESTOQUE", `sem estoque: ${input.pecas_sem_estoque}`, base);
  }

  // ── CAMADA 3: Complexidade ─────────────────────────────────────────────

  // Peça crítica e nº de peças foram REMOVIDOS como critério (decisão da operação):
  // ter um Motor ou muitas peças não significa, por si só, passar de 3h — quem decide
  // é o tempo. Quando a estimativa de tempo for recalibrada, ela já captura essas peças.
  if (input.tempo_estimado_min > THRESHOLDS.tempo_estimado_max) {
    return reserva("C3_TEMPO_ALTO", `trabalho estimado em ${input.tempo_estimado_min}min`, base);
  }

  // ── CAMADA 3.5: Tempo total combinado (sem capacidade) ─────────────────
  // Se a soma do tempo já esperado + restante já passa de 3h, não adianta.
  const tempoRestanteC3 = input.status_atual === "IN_PROGRESS"
    ? Math.max(0, input.tempo_estimado_min - input.min_no_status)
    : input.tempo_estimado_min;
  const totalSemMec = input.min_desde_open + tempoRestanteC3 + THRESHOLDS.qa_min;
  if (input.tempo_estimado_min > 0 && input.min_desde_open < 480 && totalSemMec > THRESHOLDS.tempo_total_max) {
    return reserva(
      "C3_TEMPO_COMBINADO",
      `já esperou ${input.min_desde_open}min + restante ~${tempoRestanteC3}min + ${THRESHOLDS.qa_min}min QA = ${totalSemMec}min total`,
      base
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
        base
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
  base: Omit<Recomendacao, "decision" | "rule_triggered" | "motivo">
): Recomendacao {
  return {
    ...base,
    decision: "RESERVA",
    rule_triggered: rule,
    motivo,
  };
}

export { THRESHOLDS, PECAS_CRITICAS };
