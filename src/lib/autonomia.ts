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

// ESCOPO DO TESTE (decisão de 28/07): o piloto roda SÓ NA MOOCA (location_id 1 no OMS).
// Autonomia e notificações valem apenas pras bases desta lista; expandir pra Osasco (34)
// e SBC (166) é mudar a env RIVERS_BASES_TESTE (csv de location_ids) — sem deploy.
const DEFAULT_BASES_TESTE = "1";

export function basesTeste(): Set<number> {
  const raw = process.env.RIVERS_BASES_TESTE ?? DEFAULT_BASES_TESTE;
  return new Set(
    raw
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0)
  );
}

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
// (esperando na base — onde o SLA de 3h vale), a regra está na lista auto e a
// base está no escopo do teste.
export function isAcaoAutomatica(
  rule: string | null,
  decision: string,
  isPiso: boolean,
  locationId?: number | null
): boolean {
  return (
    decision === "RESERVA" &&
    isPiso &&
    rule != null &&
    regrasAuto().has(rule) &&
    (locationId == null || basesTeste().has(locationId))
  );
}
