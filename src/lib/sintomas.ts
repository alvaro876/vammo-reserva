// CALIBRAÇÃO DE SINTOMAS — v2, RECALIBRADA EM 2026-08-20 COM DADO REAL.
//
// A v1 (10/08) usava a ponte histórica sintoma -> componente -> peça trocada e dizia
// 51-70% de estouro pros piores sintomas. A validação com 2 semanas de sintoma REAL
// (673 OSs concluídas com relato do cliente) DERRUBOU a ponte: quem RELATA "carenagem
// quebrada" leva 23% de estouro, não 70% — a ponte media quem TROCAVA a peça (4h52 de
// serviço); o relato geralmente é aperto de parafuso. Era o risco registrado na D13,
// confirmado. E mais: quem relata sintoma sai MAIS RÁPIDO que a base (1 sintoma =
// mediana 74min, 4% de estouro) — o fluxo de agendamento+sintoma deixa a oficina se
// preparar. Sintoma NÃO é gatilho de reserva; é o NÚMERO inicial da moto sem diagnóstico.
//
// MEDIANA aqui = tempo TOTAL da abertura da OS até a moto pronta (fila + serviço) das
// OSs reais com aquele sintoma. Serve de estimativa inicial de conclusão enquanto o
// diagnóstico não existe — quando as peças são apontadas, a estimativa real assume.
// Recalibrar semanalmente enquanto o rollout cresce (a query está em docs/DECISOES.md).

export interface SintomaCalib {
  nome: string;
  pctEstouro: number;  // % REAL das OSs com esse sintoma relatado que passaram de 3h
  medianaMin: number;  // tempo TOTAL mediano real (abertura -> pronta), fila incluída
  n: number;           // amostra real (05-19/08/2026, todas as bases)
}

export const SINTOMAS: Record<number, SintomaCalib> = {
  1: { nome: "Freio fraco ou não freia", pctEstouro: 10, medianaMin: 100, n: 188 },
  2: { nome: "Freio com barulho ou trepidando", pctEstouro: 9, medianaMin: 93, n: 272 },
  3: { nome: "Manete quebrado ou frouxo", pctEstouro: 14, medianaMin: 90, n: 42 },
  4: { nome: "Carenagem quebrada ou solta", pctEstouro: 16, medianaMin: 117, n: 43 },
  5: { nome: "Paralama quebrado ou solto", pctEstouro: 12, medianaMin: 84, n: 64 },
  6: { nome: "Retrovisor quebrado ou faltando", pctEstouro: 6, medianaMin: 94, n: 49 },
  7: { nome: "Suporte de celular danificado ou faltando", pctEstouro: 0, medianaMin: 124, n: 16 },
  8: { nome: "USB não carrega", pctEstouro: 11, medianaMin: 95, n: 61 },
  9: { nome: "Placa solta, torta ou ilegível", pctEstouro: 18, medianaMin: 126, n: 11 },
  11: { nome: "Bolha para-brisa quebrada ou faltando", pctEstouro: 15, medianaMin: 94, n: 20 },
  14: { nome: "Cavalete (descanso) com problema", pctEstouro: 7, medianaMin: 96, n: 14 },
  16: { nome: "Pneu furado, rasgado ou com bolha", pctEstouro: 15, medianaMin: 93, n: 82 },
  17: { nome: "Pneu gasto ou careca", pctEstouro: 16, medianaMin: 94, n: 81 },
  18: { nome: "Roda torta ou amassada", pctEstouro: 11, medianaMin: 98, n: 35 },
  19: { nome: "Roda vibrando ou com barulho", pctEstouro: 12, medianaMin: 102, n: 119 },
  20: { nome: "Direção dura ou pesada", pctEstouro: 16, medianaMin: 103, n: 62 },
  21: { nome: "Frente boba, solta ou balançando", pctEstouro: 9, medianaMin: 107, n: 90 },
  22: { nome: "Frente torta ou desalinhada", pctEstouro: 12, medianaMin: 113, n: 52 },
  23: { nome: "Suspensão batendo seco", pctEstouro: 12, medianaMin: 108, n: 88 },
  26: { nome: "Moto perdendo força ou desliga andando", pctEstouro: 10, medianaMin: 108, n: 41 },
  27: { nome: "Bateria não carrega ou descarrega rápido", pctEstouro: 28, medianaMin: 119, n: 18 },
  30: { nome: "Seta não funciona", pctEstouro: 12, medianaMin: 132, n: 26 },
  32: { nome: "Buzina não funciona", pctEstouro: 8, medianaMin: 104, n: 12 },
  33: { nome: "Painel com defeito ou erro", pctEstouro: 8, medianaMin: 86, n: 24 },
};

// Base de comparação da era atual (pós-release, bancada rápida): ~15% das OSs de piso
// passam de 3h. Nenhum sintoma isolado chega perto de sinal de reserva — o selo de
// alerta na tela (>=50%) fica naturalmente apagado até o dado dizer o contrário.
export const BASE_ESTOURO_PCT = 15;

// Múltiplos sintomas alongam a visita (medido, dado real): 1 sintoma mediana 74min ·
// 2 = 85 · 3 = 101 · 4+ = 116. Fator relativo sobre a mediana do pior sintoma.
const FATOR_N_SINTOMAS = [1, 1, 1.15, 1.35, 1.55];

// Resumo do pior sintoma da OS, pro card do CX. null = sem sintoma calibrado.
export function piorSintoma(ids: number[]): (SintomaCalib & { id: number }) | null {
  let pior: (SintomaCalib & { id: number }) | null = null;
  for (const id of ids) {
    const s = SINTOMAS[id];
    if (s && (!pior || s.pctEstouro > pior.pctEstouro)) pior = { ...s, id };
  }
  return pior;
}

// ESTIMATIVA INICIAL POR SINTOMA (v0.32): quanto falta pra moto ficar pronta quando
// AINDA NÃO HÁ diagnóstico, baseada na mediana real do perfil de sintomas.
// Retorna minutos restantes (mínimo 15) ou null quando não dá pra afirmar nada:
// sem sintoma calibrado, ou a moto já passou de 1,5x a mediana do perfil (aí o
// perfil provou que não descreve esse caso — número nenhum é melhor que um falso).
export function estimativaInicialPorSintomas(ids: number[], minDecorrido: number): number | null {
  let piorMediana = 0;
  let calibrados = 0;
  for (const id of ids) {
    const s = SINTOMAS[id];
    if (!s) continue;
    calibrados++;
    if (s.medianaMin > piorMediana) piorMediana = s.medianaMin;
  }
  if (calibrados === 0) return null;
  const fator = FATOR_N_SINTOMAS[Math.min(calibrados, 4)];
  const totalEsperado = piorMediana * fator;
  if (minDecorrido > totalEsperado * 1.5) return null;
  return Math.max(15, Math.round(totalEsperado - minDecorrido));
}
