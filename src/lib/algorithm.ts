// Algoritmo de recomendação de reserva — Camadas 1 a 4
//
// Camada 4 (DEV): mecânico disponível — verifica se há mecânico elegível,
// quanto tempo até ficar livre, e se o tempo total ainda cabe em 3h.
// Dados de mecânicos chegam computados em route.ts a partir das OS ativas.

import { Recomendacao, ReservaDecision } from "@/types";

const THRESHOLDS = {
  anomalia_min: 240,         // C1: OS aberta há mais de 4h antes do diag fechar
  diversas_avarias: 9,       // C3: 9+ tipos de peça diferentes no diag
  tempo_estimado_max: 120,   // C3: tempo estimado total > 120 min
  tempo_total_max: 180,      // C3.5 / C4: espera + execução > 180 min
  fila_max: 60,              // C4: próximo mecânico elegível só livre em >60min
};

// Peças que sozinhas justificam reserva imediata
const PECAS_CRITICAS = new Set([
  257, 258, 259, 260,  // Motor
  184, 357,            // Balança
  250, 308, 340, 359,  // Caixa direção
  296,                 // Chassi
  240,                 // Garfo
]);

// Estado atual de um mecânico (computado em route.ts a partir das OS ativas)
export interface MecanicoEstado {
  email: string;
  status_atual: string;   // IN_PROGRESS, AWAITING_QA, PAUSED, etc.
  location_id: number;
  min_restantes: number;  // 0 se livre, estimativa do que falta se IN_PROGRESS
  skill_level: number;    // 3 = MEC1, 5 = MEC2+, proxy da complexidade da OS atual
}

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
  mecanicos?: MecanicoEstado[];  // injetado em route.ts, opcional para retrocompatibilidade
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

  // ── CAMADA 2: Estoque ──────────────────────────────────────────────────

  if (input.n_sem_estoque > 0) {
    return reserva("C2_SEM_ESTOQUE", `sem estoque: ${input.pecas_sem_estoque}`, base);
  }

  // ── CAMADA 3: Complexidade ─────────────────────────────────────────────

  if (input.n_pecas_criticas > 0) {
    return reserva("C3_PECA_CRITICA", `peça crítica: ${input.pecas_criticas}`, base);
  }
  if (input.n_pecas >= THRESHOLDS.diversas_avarias) {
    return reserva("C3_DIVERSAS_AVARIAS", `diversas avarias (${input.n_pecas} tipos de peça)`, base);
  }
  if (input.tempo_estimado_min > THRESHOLDS.tempo_estimado_max) {
    return reserva("C3_TEMPO_ALTO", `trabalho estimado em ${input.tempo_estimado_min}min`, base);
  }

  // ── CAMADA 3.5: Tempo total combinado (sem dados de mecânico) ──────────
  // Se a soma do tempo já esperado + restante já passa de 3h, não adianta.
  const tempoRestanteC3 = input.status_atual === "IN_PROGRESS"
    ? Math.max(0, input.tempo_estimado_min - input.min_no_status)
    : input.tempo_estimado_min;
  const totalSemMec = input.min_desde_open + tempoRestanteC3;
  if (input.tempo_estimado_min > 0 && input.min_desde_open < 480 && totalSemMec > THRESHOLDS.tempo_total_max) {
    return reserva(
      "C3_TEMPO_COMBINADO",
      `já esperou ${input.min_desde_open}min + restante ~${tempoRestanteC3}min = ${totalSemMec}min total`,
      base
    );
  }

  // ── CAMADA 4: Mecânico disponível ─────────────────────────────────────
  // Só roda se temos dados de mecânicos (injetados em route.ts).
  // Verifica se existe mecânico com skill suficiente, quando fica livre,
  // e se o tempo total (espera + fila + serviço) ainda cabe em 3h.

  const mecanicos = input.mecanicos;
  if (mecanicos && mecanicos.length > 0) {
    // Skill mínimo necessário para esta OS
    // complexidade_max >= 5 → peça de MEC2 (balança, disco, chicote nível 5+)
    const skillNecessario = input.complexidade_max >= 5 ? 5 : 3;

    // Mecânicos elegíveis: mesma base + skill suficiente
    const elegiveis = mecanicos.filter(
      (m) => m.location_id === input.location_id && m.skill_level >= skillNecessario
    );

    if (elegiveis.length === 0) {
      return reserva(
        "C4_SEM_MECANICO",
        `nenhum mecânico ${skillNecessario >= 5 ? "MEC2+" : "MEC1+"} ativo na base`,
        base
      );
    }

    // Melhor mecânico = menor tempo até ficar livre
    const melhor = elegiveis.reduce((min, m) =>
      m.min_restantes < min.min_restantes ? m : min
    );

    // Preenche sugestão de mecânico no output mesmo quando não reserva
    base.mecanico_sugerido = melhor.email;
    base.tempo_para_inicio_min = melhor.min_restantes;

    // Fila longa: próximo elegível só fica livre daqui muito tempo
    if (melhor.min_restantes > THRESHOLDS.fila_max) {
      return reserva(
        "C4_FILA_LONGA",
        `próximo mecânico elegível livre em ~${melhor.min_restantes}min (limite: ${THRESHOLDS.fila_max}min)`,
        base
      );
    }

    // Tempo total com fila: espera atual + fila + execução > 3h
    const totalComFila = input.min_desde_open + melhor.min_restantes + input.tempo_estimado_min;
    if (input.tempo_estimado_min > 0 && totalComFila > THRESHOLDS.tempo_total_max) {
      return reserva(
        "C4_TEMPO_COM_FILA",
        `${input.min_desde_open}min aberta + ${melhor.min_restantes}min fila + ${input.tempo_estimado_min}min serviço = ${totalComFila}min`,
        base
      );
    }

    // Passou por C4 determinístico sem reserva → dentro do prazo com mecânico disponível
    return {
      ...base,
      decision: "SEM_RESERVA" as ReservaDecision,
      rule_triggered: "C4_OK",
      motivo: `${melhor.email} livre em ~${melhor.min_restantes}min, total estimado ${input.min_desde_open + melhor.min_restantes + input.tempo_estimado_min}min`,
      motivo_claude: null,
    };
  }

  // ── Sem dados de mecânicos → passa pro Claude (C5) ─────────────────────
  return {
    ...base,
    decision: "SEM_RESERVA" as ReservaDecision,
    rule_triggered: "C4_PENDING",
    motivo: `aberta há ${input.min_desde_open}min, estimado ${input.tempo_estimado_min}min — sem dados de mecânicos, passa para IA`,
    motivo_claude: null,
  };
}

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
    motivo_claude: null,
  };
}

export { THRESHOLDS, PECAS_CRITICAS };
