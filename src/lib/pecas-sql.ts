// Constantes da CONTA DE TEMPO compartilhadas entre o motor (rivers-engine.ts) e o
// relatório diário (api/diario). Viviam soltas dentro do rivers-engine; saíram daqui
// pra que o diário aplique EXATAMENTE a mesma fórmula do motor. Se divergirem, o
// relatório passa a mentir sobre o próprio motor, que é o pior defeito possível nele.

// Peças de FIXAÇÃO: quantidade não multiplica (27/08, caso TJQ9C16 achado pelo Victor —
// 3 parafusos de disco viravam 24min, como se saíssem em série). Tudo que casa
// parafuso|porca|arruela|presilha|clipe|borracha de vedação|abraçadeira|rebite no
// cadastro. Ids fixos de propósito: casar por nome mudaria o comportamento em silêncio
// num rename do cadastro.
export const FIXACAO_IDS: readonly number[] = [
  172, 181, 262, 263, 264, 265, 266, 267, 268, 269, 281, 290, 291, 292, 293, 294,
  350, 351, 352, 353, 354, 355, 356, 623, 824, 825, 827, 1068,
];
export const FIXACAO_IDS_SQL = FIXACAO_IDS.join(",");

// Fator multi-peça: OS de 1 peça leva 39% a mais que o tempo da peça (deslocamento
// pesa) e OS grande ganha desconto de paralelismo. Recalibrado em 05/08 no backtest de
// 92d: 9+ peças estendido porque o viés crescia +39min (9-12) e +47min (13+) quando a
// soma travava no fator de 8.
export const FATOR_POR_N_PECAS: readonly number[] = [
  1.39, 1.11, 1.04, 1.04, 1.0, 1.03, 0.95, 0.94, 0.85, 0.85, 0.85, 0.85, 0.8,
];
export const FATOR_TETO = 0.8;

/** O fator em TypeScript. Espelha o transform(least(n, 13), …) do SQL. */
export function fatorMultiPeca(nChaves: number): number {
  if (nChaves <= 0) return FATOR_TETO;
  return FATOR_POR_N_PECAS[Math.min(nChaves, 13) - 1] ?? FATOR_TETO;
}

/** O mesmo fator em SQL. `expr` é o que conta as chaves (ex.: "uniqExact(chave)"). */
export function fatorMultiPecaSQL(expr: string): string {
  const idx = FATOR_POR_N_PECAS.map((_, i) => i + 1).join(",");
  // toFixed(2): sem isso o 1.0 vira "1" no join e o array do transform muda de tipo.
  const vals = FATOR_POR_N_PECAS.map((f) => f.toFixed(2)).join(",");
  return `transform(least(${expr}, 13), [${idx}], [${vals}], ${FATOR_TETO.toFixed(2)})`;
}

// Nível de habilidade por peça. Era uma CTE hardcoded dentro do OS_QUERY do motor
// (`item_skill`); vive aqui pra que o relatório diário mostre a mesma complexidade.
// Só alimenta display — nenhuma regra decide por ela.
export const SKILL_POR_PECA: Readonly<Record<number, number>> = {
  296: 7,
  240: 6, 250: 6, 308: 6, 340: 6, 359: 6,
  184: 5, 357: 5, 229: 5, 257: 5, 258: 5, 259: 5, 260: 5,
  214: 4, 215: 4,
  219: 3, 247: 3, 344: 3, 345: 3, 346: 3,
  212: 2, 222: 2, 223: 2, 224: 2, 310: 2, 330: 2, 331: 2, 332: 2,
  273: 1, 274: 1, 288: 1, 289: 1,
};
