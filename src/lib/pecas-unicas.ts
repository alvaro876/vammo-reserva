// Peças que a moto só tem UMA (06/09/2026) — e por isso não podem multiplicar a estimativa.
//
// O que foi medido (3 bases, 01/06–05/09, 11.742 OS com itens): 1,0% das OS trazem uma peça
// única com quantidade > 1 (pneu traseiro ×2, garfo ×2, tampa do motor ×2, motor ×2) ou duas
// VARIANTES da mesma peça física (Roda traseira _v1 + _v2, Tampa do motor v1 + v2,
// Controladora 3500W + 4000W). Inflação da estimativa: mediana 13 min, p90 30, máx 72; em
// 3 meses, 8 OS cruzaram a trava de reserva (230/240) só por causa disso. Na Mooca, desde
// 13/08, nenhuma sugestão mudaria — é erro de cadastro, raro, mas barato de neutralizar aqui
// enquanto a validação não existe no Maestro (proposta: quantidade máxima 1 e uma variante
// por família, aviso antes de bloqueio).
//
// Como o motor usa (rivers-engine.ts, CTE pecas_tempo):
//   - id em PECAS_UNICAS → conta 1 POR OS (max por chave), mesmo lançado em duas linhas ou com
//     quantidade 2 — diferente da fixação (v0.33), que conta 1 por LINHA;
//   - ids da mesma FAMILIA na mesma OS → contam como UMA peça (fica a variante de maior tempo),
//     inclusive no nº de peças que alimenta o fator multi-peça.
//
// FORA da lista, de propósito: Seta LD/LE (a moto tem duas por lado, dianteira e traseira, e o
// cadastro não separa), Conjunto de seta, Amortecedor traseiro (179, 1067 V2 e 1108 DS — a dupla
// suspensão usa dois), pedaleiras, pastilhas, rolamentos, retentores, parafusos (esses já têm regra própria).
// Ids fixos, não nome: casar por nome mudaria o comportamento em silêncio num rename.

export const PECAS_UNICAS: readonly number[] = [
  // controladora · motor · elétrica central
  222, 223, 224, 257, 258, 259, 260, 1063, 214, 215, 216, 217, 343, 242, 105, 333, 285, 286, 929, 1061,
  // rodante · direção · suspensão dianteira (um amortecedor por lado)
  288, 289, 305, 306, 307, 491, 232, 240, 241, 1071, 250, 218, 184, 357, 296, 177, 178,
  // freio: um disco, uma pinça e um manete por roda
  228, 229, 278, 280, 279, 328, 245, 246,
  // carroceria
  270, 271, 194, 195, 196, 197, 198, 199, 200, 201, 202, 203, 204, 205, 206, 207, 261, 297, 298,
  173, 174, 175, 318, 319, 320, 329, 330, 331, 332, 210, 317, 187, 188, 189,
  // iluminação · comandos · assento · apoio
  237, 249, 1069, 1070, 243, 301, 191, 221, 248, 234, 341, 185, 186, 193, 334, 182, 183, 226, 227, 313,
];

// Variantes da mesma peça física: duas na mesma OS é erro de lançamento (a moto tem uma).
export const FAMILIAS_UNICAS: Readonly<Record<string, readonly number[]>> = {
  motor: [257, 258, 259, 260, 1063],
  controladora: [222, 223, 224],
  roda_traseira: [306, 307, 491],
  chicote_principal: [214, 215],
  chicote_secundario: [216, 217],
  tampa_motor: [330, 331, 332],
  carenagem_diant_dir: [195, 196],
  carenagem_diant_esq: [197, 198],
  mascara_farol: [249, 1069],
  bau: [187, 188, 189],
};

// Pedaços de SQL prontos pro motor (ClickHouse).
export const PECAS_UNICAS_SQL = PECAS_UNICAS.join(",");
const famIds: number[] = [];
const famChaves: string[] = [];
for (const [chave, ids] of Object.entries(FAMILIAS_UNICAS)) {
  for (const id of ids) {
    famIds.push(id);
    famChaves.push(`'F:${chave}'`);
  }
}
// transform(id, [ids], ['F:motor', ...], toString(id)) → chave de agrupamento por OS
export const CHAVE_PECA_SQL = `transform(si.item_group_id, [${famIds.join(",")}], [${famChaves.join(",")}], toString(si.item_group_id))`;
export const FAMILIA_IDS_SQL = famIds.join(",");
