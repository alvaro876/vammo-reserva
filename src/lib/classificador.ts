// Classificador logístico P(estourar 3h) — FASE 3 do diagnóstico de 05/08.
// EM SOMBRA: calculado e logado a cada tique, NÃO decide reserva ainda.
// Promoção pra decisor exige 2-3 dias de validação ao vivo contra o log.
//
// Treinado em 05/08 03h (scripts/treina-classificador.mjs): 24.278 prefixos de
// 92d de piso Mooca, split temporal (treino até D-14, validação D-14..D-6,
// TESTE = últimos 5 dias que o modelo nunca viu). Calibração Platt na validação.
// Resultado no TESTE, corte 0.80: precisão 89,3% · recall 96,2% (n=28 OSs).
// Pesos coerentes com tudo que medimos: relógio +2,55 · projeção +2,27 ·
// em QA −2,09 (o split do hazard) · em execução −1,76 · sem diagnóstico +1,16.
// Fonte dos pesos: calib/classificador-v1.json (regenerável pelo script).

const W: Record<string, number> = {
  bias: -2.425, min: 2.546, est: -0.387, restante: -0.181, proj: 2.271,
  n_pecas: 0.147, emQa: -2.087, open: 1.186, awaitMec: -0.181, inProg: -1.758,
  parado: 0.38, cpx: 0.221, direcao: 0.509, retorno: 1.059, fimdia: 0.055, semdiag: 1.155,
};
const PLATT = { a: 1.589, b: -0.46 };
export const CORTE_SOMBRA = 0.8; // corte que deu 89,3%/96,2% no teste

const sig = (z: number) => 1 / (1 + Math.exp(-z));

export interface EstadoClassificador {
  min_desde_open: number;
  tempo_estimado_min: number;
  restante_min: number;
  n_pecas: number;
  status_atual: string;
  asset_model: string;
  tem_direcao: number;
  so_type: string;
}

// P(estourar 3h) dado o estado da OS agora. Hora de SP calculada aqui dentro.
export function pEstouro(e: EstadoClassificador): number {
  const emQa = ["AWAITING_QA", "IN_QA", "QA_REJECTED"].includes(e.status_atual);
  const horaSP = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: "America/Sao_Paulo" }).format(new Date()));
  const proj = e.min_desde_open + e.restante_min + 8;
  const z =
    W.bias +
    W.min * (e.min_desde_open / 180) +
    W.est * (e.tempo_estimado_min / 180) +
    W.restante * (e.restante_min / 180) +
    W.proj * (proj / 180) +
    W.n_pecas * (Math.min(e.n_pecas, 16) / 10) +
    W.emQa * (emQa ? 1 : 0) +
    W.open * (e.status_atual === "OPEN" ? 1 : 0) +
    W.awaitMec * (e.status_atual === "AWAITING_MECHANIC" ? 1 : 0) +
    W.inProg * (e.status_atual === "IN_PROGRESS" ? 1 : 0) +
    W.parado * (["AWAITING_PARTS", "AWAITING_SERVICE", "AWAITING_VMGMT"].includes(e.status_atual) ? 1 : 0) +
    W.cpx * (e.asset_model === "VMOTO CPX" ? 1 : 0) +
    W.direcao * (e.tem_direcao === 1 ? 1 : 0) +
    W.retorno * (e.so_type === "RETURN_INSPECTION" ? 1 : 0) +
    W.fimdia * (horaSP >= 17 ? 1 : 0) +
    W.semdiag * (e.tempo_estimado_min === 0 ? 1 : 0);
  return Math.round(sig(PLATT.a * z + PLATT.b) * 1000) / 1000;
}
