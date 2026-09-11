// De-para entre o código de regra do RIVERS (rule_triggered) e o `reason` que o Maestro
// aceita em POST /ms-maestro-scheduler/checkins/internal/suggest-reserve. O enum do Maestro
// foi reduzido a 4 razões (09/2026): awaiting_plate, awaiting_part, awaiting_special_service
// e predicted_delay. Não está ligado a nada ainda: fica aqui pra integração usar.
//
// Regras que NÃO são previsão de estouro (C1_HARD, C1_ANOMALIA, C4_OK, C5_*) não viram
// sugestão pro Maestro — a função devolve null e quem chama não manda nada.

export type MaestroReason =
  | "predicted_delay"
  | "awaiting_plate"
  | "awaiting_part"
  | "awaiting_special_service";

const DE_PARA: Record<string, MaestroReason> = {
  // política: a moto não pode circular
  C1_PLACA: "awaiting_plate",
  C2_SEM_ESTOQUE: "awaiting_part",
  C2_TRAVADA_SEM_PECA: "awaiting_part",
  C2_PARADA_TERCEIRO: "awaiting_special_service",
  // previsão de estouro das 3h
  C1_ESPERA_SEM_DIAG: "predicted_delay",
  C1_FILA_DIAG_LONGA: "predicted_delay",
  C1_QA_TARDIA: "predicted_delay",
  C3_RELOGIO_150: "predicted_delay",
  C3_NAO_COMECOU: "predicted_delay",
  C3_SEM_EXECUCAO_90: "predicted_delay",
  C3_CONTA_NAO_FECHA: "predicted_delay",
  C3_TEMPO_COMBINADO: "predicted_delay",
  // tempo alto e falta de capacidade também são previsão de estouro das 3h
  C3_TEMPO_ALTO: "predicted_delay",
  C4_CAPACIDADE: "predicted_delay",
};

export function maestroReason(rule_triggered: string | null | undefined): MaestroReason | null {
  if (!rule_triggered) return null;
  return DE_PARA[rule_triggered] ?? null;
}
