// CALIBRAÇÃO DE SINTOMAS — gerada em 2026-08-10 (Mooca, piso, 90 dias).
//
// O Maestro lançou "diagnóstico orientado a sintomas" em 05/08: o cliente relata o que
// sentiu ao abrir a OS. Isso é a PRIMEIRA informação que existe antes de qualquer peça
// ser lançada — exatamente o buraco onde o RIVERS era cego (moto em execução com
// estimativa 0 porque nada foi registrado ainda).
//
// COMO FOI MEDIDO (e por que é aproximação): só existem ~28 OSs com sintoma real, e a
// medição direta deu n=10/n=14 com sinal INVERTIDO — ruído puro. Então medi INDIRETO:
// sintoma -> symptom_component -> public_diagnosis_component -> item_group (match por
// nome normalizado, 26 dos 33 sintomas casam, 110 grupos) -> tempo real das OSs
// históricas que trocaram essas peças. É bom pra calibrar, NÃO é prova final: o cliente
// que relata "freio fraco" às vezes só precisa de regulagem, não de troca.
//
// ACHADO QUE CONTRARIA O CATÁLOGO: o campo is_complex_service NÃO prevê tempo.
// "Carenagem quebrada" é marcada como simples e é a PIOR (70%); "Suspensão batendo
// seco" é marcada como complexa e dá 40%. Complexidade de diagnóstico != tempo de
// reparo. Não usar essa flag como atalho.
//
// USO ATUAL: só CONTEXTO na tela do CX. Não decide reserva — promoção depende de ~3
// semanas de sintoma real pra validar se o relatado se comporta como a peça trocada.
// Regenerar: ver a query em docs/DECISOES.md (D13).

export interface SintomaCalib {
  nome: string;
  pctEstouro: number;  // % das OSs históricas com essa peça que passaram de 3h
  medianaMin: number;  // tempo mediano real (chegada -> pronta)
  n: number;           // tamanho da amostra histórica
}

export const SINTOMAS: Record<number, SintomaCalib> = {
  4: { nome: "Carenagem quebrada ou solta", pctEstouro: 70, medianaMin: 292, n: 476 },
  29: { nome: "Farol não funciona", pctEstouro: 64.8, medianaMin: 246, n: 99 },
  26: { nome: "Moto perdendo força ou desliga andando", pctEstouro: 58.5, medianaMin: 199, n: 550 },
  27: { nome: "Bateria não carrega ou descarrega rápido", pctEstouro: 58.4, medianaMin: 198, n: 520 },
  25: { nome: "Moto não anda (com painel aceso)", pctEstouro: 58, medianaMin: 199, n: 610 },
  33: { nome: "Painel com defeito ou erro", pctEstouro: 55.2, medianaMin: 203, n: 92 },
  5: { nome: "Paralama quebrado ou solto", pctEstouro: 53.4, medianaMin: 187, n: 368 },
  1: { nome: "Freio fraco ou não freia", pctEstouro: 51.2, medianaMin: 194, n: 43 },
  2: { nome: "Freio com barulho ou trepidando", pctEstouro: 51.2, medianaMin: 194, n: 43 },
  22: { nome: "Frente torta ou desalinhada", pctEstouro: 50.7, medianaMin: 183, n: 713 },
  10: { nome: "Refletor quebrado ou faltando", pctEstouro: 50.4, medianaMin: 181, n: 242 },
  9: { nome: "Placa solta, torta ou ilegível", pctEstouro: 50, medianaMin: 179, n: 65 },
  20: { nome: "Direção dura ou pesada", pctEstouro: 49.2, medianaMin: 177, n: 294 },
  19: { nome: "Roda vibrando ou com barulho", pctEstouro: 48.7, medianaMin: 177, n: 518 },
  18: { nome: "Roda torta ou amassada", pctEstouro: 48.7, medianaMin: 177, n: 518 },
  31: { nome: "Lanterna não funciona", pctEstouro: 47, medianaMin: 169, n: 270 },
  24: { nome: "Vazamento de óleo na suspensão", pctEstouro: 45.4, medianaMin: 168, n: 441 },
  21: { nome: "Frente boba, solta ou balançando", pctEstouro: 45, medianaMin: 169, n: 559 },
  23: { nome: "Suspensão batendo seco", pctEstouro: 40.4, medianaMin: 156, n: 640 },
  17: { nome: "Pneu gasto ou careca", pctEstouro: 40.1, medianaMin: 157, n: 1186 },
  16: { nome: "Pneu furado, rasgado ou com bolha", pctEstouro: 40.1, medianaMin: 157, n: 1186 },
  32: { nome: "Buzina não funciona", pctEstouro: 38.2, medianaMin: 147, n: 68 },
  8: { nome: "USB não carrega", pctEstouro: 30.5, medianaMin: 128, n: 262 },
  11: { nome: "Bolha para-brisa quebrada ou faltando", pctEstouro: 15.3, medianaMin: 99, n: 266 },
};

// Base de comparação: ~27% das OSs de piso da Mooca passam de 3h. Acima de 55% é sinal
// forte de espera longa; abaixo de 35%, sinal de serviço rápido.
export const BASE_ESTOURO_PCT = 27;

// Resumo do pior sintoma da OS, pro card do CX. null = sem sintoma calibrado.
export function piorSintoma(ids: number[]): (SintomaCalib & { id: number }) | null {
  let pior: (SintomaCalib & { id: number }) | null = null;
  for (const id of ids) {
    const s = SINTOMAS[id];
    if (s && (!pior || s.pctEstouro > pior.pctEstouro)) pior = { ...s, id };
  }
  return pior;
}
