// Camada de AUTONOMIA do RIVERS.
//
// Nem toda sugestão tem o mesmo grau de confiança. As regras com precisão
// comprovada no histórico podem ser ACATADAS DIRETO pela operação (a mesa
// entrega a reserva sem revisão humana); as demais seguem como sugestão.
//
// Precisão medida (25/06–20/07, casos "só RIVERS" que passaram de 3h):
//   C1_ESPERA_SEM_DIAG  48/54 (89%)  → auto
//   C1_ANOMALIA          3/3         → auto
//   C1_HARD             (guincho/acidente/imobilizada — óbvias por definição) → auto
//   C3_*/C4_*/C2        cortes largos em recalibração → SUGESTÃO com humano
//
// KILL-SWITCH: defina RIVERS_REGRAS_AUTO no ambiente pra mudar a lista sem
// mexer em código (csv de regras; string vazia = desliga toda autonomia).
// No Vercel: Settings → Environment Variables → redeploy (~1 min).

const DEFAULT_AUTO = "C1_HARD,C1_ANOMALIA,C1_ESPERA_SEM_DIAG";

export function regrasAuto(): Set<string> {
  const raw = process.env.RIVERS_REGRAS_AUTO ?? DEFAULT_AUTO;
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

// Uma sugestão é "ação automática" quando: é RESERVA, o cliente está em piso
// (esperando na base — onde o SLA de 3h vale) e a regra está na lista auto.
export function isAcaoAutomatica(
  rule: string | null,
  decision: string,
  isPiso: boolean
): boolean {
  return decision === "RESERVA" && isPiso && rule != null && regrasAuto().has(rule);
}
