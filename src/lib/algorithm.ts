// Algoritmo de recomendação de reserva — Camadas 1 a 3
//
// Por que TypeScript e não SQL puro?
// A lógica de decisão fica legível, testável e editável sem mexer em SQL.
// O SQL só busca dados; o TypeScript decide o que fazer com eles.

import { Recomendacao, ReservaDecision } from "@/types";

// Thresholds calibrados em 11/05/2026 contra 865 OS reais
// Ficam aqui em um lugar só — fácil de ajustar com Billy/Chalela
const THRESHOLDS = {
  anomalia_min: 240,         // C1: OS aberta há mais de 4h antes do diag fechar = anomalia
  diversas_avarias: 9,       // C3: 9+ tipos de peça diferentes no diag
  tempo_estimado_max: 120,   // C3: tempo estimado total > 120 min (2h)
  tempo_total_max: 180,      // C5: espera + execução > 180 min = reserva
  backlog_mooca: 15,         // C6: backlog alto Mooca
  backlog_osasco: 8,         // C6: backlog alto Osasco
};

// IDs das peças que, sozinhas, justificam reserva imediata
// Motor (257-260), Balança (184,357), Caixa direção (250,308,340,359), Chassi (296), Garfo (240)
const PECAS_CRITICAS = new Set([
  257, 258, 259, 260,  // Motor
  184, 357,            // Balança
  250, 308, 340, 359,  // Caixa direção
  296,                 // Chassi
  240,                 // Garfo
]);

// O que o algoritmo recebe como input (vindo da query do ClickHouse)
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
  pecas_sem_estoque: string; // "Disco dianteiro, Motor"
  pecas_criticas: string;    // "Garfo, Caixa direção"
  is_piso: number;           // 1 = cliente fisicamente no piso, 0 = não
  min_no_status: number;     // minutos no status atual (para IN_PROGRESS: tempo já trabalhado)
  min_desde_open: number;    // minutos desde que a OS foi aberta
}

export function avaliarOS(input: AlgoritmoInput): Recomendacao {
  const base = {
    os_id: input.os_id,
    tempo_previsto_min: input.tempo_estimado_min,
    mecanico_sugerido: null,
    tempo_para_inicio_min: null,
    metadata: {
      n_pecas_diag: input.n_pecas,
      complexidade_max: input.complexidade_max,
      tem_peca_critica: input.n_pecas_criticas > 0,
      estoque_ok: input.n_sem_estoque === 0,
    },
  };

  // ── CAMADA 1: Regras duras ─────────────────────────────────────────────
  // Casos onde reserva é inegável, sem precisar avaliar complexidade ou fila

  if (input.imobilizada === 1) {
    return reserva("C1_HARD", "moto imobilizada", base);
  }
  if (input.acidente === 1) {
    return reserva("C1_HARD", "acidente", base);
  }
  if (input.guincho === 1) {
    return reserva("C1_HARD", "veio de guincho", base);
  }
  if (input.so_type === "INSURANCE_QUOTE") {
    return reserva("C1_HARD", "vistoria de seguro", base);
  }
  if (input.min_open_to_awaiting > THRESHOLDS.anomalia_min) {
    return reserva(
      "C1_ANOMALIA",
      `moto não entrou na oficina há ${input.min_open_to_awaiting}min`,
      base
    );
  }

  // ── CAMADA 2: Estoque ──────────────────────────────────────────────────
  // Se falta peça, o mecânico não consegue terminar de qualquer jeito

  if (input.n_sem_estoque > 0) {
    return reserva(
      "C2_SEM_ESTOQUE",
      `sem estoque: ${input.pecas_sem_estoque}`,
      base
    );
  }

  // ── CAMADA 3: Complexidade ─────────────────────────────────────────────
  // Trabalho pesado demais independente de quem estiver disponível

  if (input.n_pecas_criticas > 0) {
    return reserva(
      "C3_PECA_CRITICA",
      `peça crítica: ${input.pecas_criticas}`,
      base
    );
  }
  if (input.n_pecas >= THRESHOLDS.diversas_avarias) {
    return reserva(
      "C3_DIVERSAS_AVARIAS",
      `diversas avarias (${input.n_pecas} tipos de peça)`,
      base
    );
  }
  if (input.tempo_estimado_min > THRESHOLDS.tempo_estimado_max) {
    return reserva(
      "C3_TEMPO_ALTO",
      `trabalho estimado em ${input.tempo_estimado_min}min`,
      base
    );
  }

  // ── CAMADA 3.5: Tempo total combinado ────────────────────────────────────
  // Cliente já esperou X min + ainda tem Y min de trabalho = total > 3h.
  // Para IN_PROGRESS: mecânico já trabalhou min_no_status — usar só o restante.
  // Para outros: mecânico ainda não começou — usar estimado total.
  const tempoRestante = input.status_atual === "IN_PROGRESS"
    ? Math.max(0, input.tempo_estimado_min - input.min_no_status)
    : input.tempo_estimado_min;
  const tempoTotalSemMec = input.min_desde_open + tempoRestante;
  // Guard: OS > 8h são anomalias — C1_ANOMALIA é a regra certa pra elas
  if (input.tempo_estimado_min > 0 && input.min_desde_open < 480 && tempoTotalSemMec > THRESHOLDS.tempo_total_max) {
    return reserva(
      "C3_TEMPO_COMBINADO",
      `já esperou ${input.min_desde_open}min + restante ~${tempoRestante}min = ${tempoTotalSemMec}min total`,
      base
    );
  }

  // ── CAMADAS 4-6: precisam de dados de mecânicos (avaliados fora) ───────
  // Retorna "pendente" — a rota de API vai completar com dados do turno
  return {
    ...base,
    decision: "SEM_RESERVA" as ReservaDecision,
    rule_triggered: "C4_PENDING",
    motivo: `aberta há ${input.min_desde_open}min, estimado ${input.tempo_estimado_min}min — dentro do prazo, passa para avaliação de mecânicos`,
    motivo_claude: null,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────

function reserva(
  rule: string,
  motivo: string,
  base: Omit<Recomendacao, "decision" | "rule_triggered" | "motivo" | "motivo_claude">
): Recomendacao {
  return {
    ...base,
    decision: "RESERVA",
    rule_triggered: rule,
    motivo,
    motivo_claude: null, // preenchido depois pelo Claude API
  };
}

export { THRESHOLDS, PECAS_CRITICAS };
