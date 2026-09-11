// Quais regras contam como PREVISÃO de estouro de SLA, e o nome de cada uma na tela.
// Saiu de api/kpi/route.ts pra ser fonte única: o painel de KPI e o relatório diário
// TÊM que usar o mesmo conjunto, senão as duas telas contam avisos diferentes e ninguém
// acredita em nenhuma das duas.
//
// Ficam FORA do conjunto:
//   política  → C1_PLACA, C1_HARD, C2_TRAVADA_SEM_PECA, C2_PARADA_TERCEIRO
//               (a moto não pode circular; não é previsão, é lei)
//   anomalia  → C1_ANOMALIA (dispara sem cliente na base; polui qualquer contagem)
//   fora de escopo → C0_GUINCHO_FORA_ESCOPO
//   sem reserva    → C4_OK, C5_*

export const REGRAS_SLA = new Set([
  "C3_RELOGIO_150",
  "C3_TEMPO_COMBINADO",
  "C3_TEMPO_ALTO",
  "C3_NAO_COMECOU",
  "C3_SEM_EXECUCAO_90",
  "C3_CONTA_NAO_FECHA",
  "C1_FILA_DIAG_LONGA",
  "C1_QA_TARDIA",
  "C1_ESPERA_SEM_DIAG",
  "C4_CAPACIDADE",
]);

export const NOME_REGRA: Record<string, string> = {
  C3_RELOGIO_150: "Relógio de 2h40",
  C3_TEMPO_COMBINADO: "Soma dos tempos",
  C3_TEMPO_ALTO: "Serviço grande (4h+)",
  C3_NAO_COMECOU: "Conserto nem começou",
  C3_SEM_EXECUCAO_90: "90 min sem execução",
  C3_CONTA_NAO_FECHA: "Conta corrigida passa de 3h30",
  C1_FILA_DIAG_LONGA: "Parada sem triar (60 min)",
  C1_QA_TARDIA: "Reprovou no QA tarde",
  C1_ESPERA_SEM_DIAG: "Espera sem diagnóstico",
  C4_CAPACIDADE: "Oficina saturada",
  // fora do conjunto SLA, mas aparecem no relatório diário como contexto
  C1_PLACA: "Troca de placa",
  C1_HARD: "Situação crítica",
  C1_ANOMALIA: "Anomalia de fluxo",
  C2_TRAVADA_SEM_PECA: "Travada aguardando peça",
  C2_PARADA_TERCEIRO: "Parada em serviço externo",
  C2_SEM_ESTOQUE: "Peça sem estoque",
  C0_GUINCHO_FORA_ESCOPO: "Guincho (fora do escopo)",
  C4_OK: "Cabe no prazo",
  C5_AGUARDA_DIAG: "Sem diagnóstico ainda",
  C5_DENTRO_PRAZO: "Dentro do prazo",
};

// Três regras do conjunto SLA são ESTRUTURALMENTE TARDIAS: o gatilho delas fica em um
// relógio que já não deixa 60 min de antecedência. Não é defeito de calibração, é
// desenho — o relatório carimba isso no rodapé em vez de acusar "não pegou".
export const REGRAS_ESTRUTURALMENTE_TARDIAS: Record<string, number> = {
  C3_RELOGIO_150: 160,
  C1_QA_TARDIA: 165,
  C1_ESPERA_SEM_DIAG: 150,
};
