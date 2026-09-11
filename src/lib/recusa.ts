// Motivos de recusa da moto reserva (04/09/2026).
//
// Por que existe: o Maestro grava o cancelamento da oferta (RESERVE_CANCELLED) sem
// motivo — 0 de 79 recusas no piloto 13/08-03/09 tinham qualquer explicação. Metade
// das ofertas é recusada e ninguém sabe por quê. Enquanto o campo não nasce no
// Maestro, o CX registra aqui, pela tela /cx, e a resposta fica no nosso banco
// (rivers_recusa_motivo) pra análise e pro modelo.
//
// Lista FECHADA e compartilhada entre a tela e a API: o código é fixo (não muda com
// o rótulo), pra o histórico não quebrar quando alguém reescrever o texto do botão.
// A última opção separa "cliente recusou" de "não foi o cliente" — sem isso a taxa
// de recusa mistura fechamento interno com decisão do cliente.

export const MOTIVOS_RECUSA = [
  { code: "espera_moto_perto", label: "Prefere esperar: a moto está quase pronta" },
  { code: "compromisso_vai_embora", label: "Vai embora sem moto (compromisso, volta depois)" },
  { code: "nao_quer_reserva", label: "Não quer a moto reserva (modelo, estado, hábito)" },
  { code: "sem_moto_disponivel", label: "Não tinha moto reserva disponível" },
  { code: "burocracia_tempo", label: "Achou demorado ou burocrático pegar a reserva" },
  { code: "cancelamento_interno", label: "Não foi o cliente: cancelamento interno ou oferta indevida" },
  { code: "outro", label: "Outro (escrever)" },
] as const;

export type MotivoRecusa = (typeof MOTIVOS_RECUSA)[number]["code"];

export const CODIGOS_RECUSA: ReadonlySet<string> = new Set(MOTIVOS_RECUSA.map((m) => m.code));

export function rotuloRecusa(code: string): string {
  return MOTIVOS_RECUSA.find((m) => m.code === code)?.label ?? code;
}
