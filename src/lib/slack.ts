// Notificação Slack do RIVERS — via Incoming Webhook.
//
// Liga só se SLACK_WEBHOOK_URL estiver no ambiente (senão é no-op silencioso, como
// o Supabase). Assim o app roda sem Slack, e basta adicionar a env pra ativar.
// O webhook posta num canal fixo (o que você escolher ao criar o webhook).

const BASES: Record<number, string> = { 1: "Mooca", 34: "Osasco", 166: "SBC" };

export interface ReservaNotificavel {
  os_id: number;
  placa: string | null;
  location_id: number | null;
  motivo: string | null;
  // regra de alta precisão → a operação pode acatar direto (marcada com ⚡ na mensagem)
  auto?: boolean;
  // projeção perto da linha das 3h → o encarregado decide sabendo que é foto de chegada
  fronteira?: boolean;
}

// Link das mensagens: a TELA DO CX com o token (a audiência do grupo é o CX; pedido
// do Alvaro em 20/08 — o link da raiz é o painel do líder, que o grupo não usa).
// O token vem do secret RIVERS_CX_TOKEN — NUNCA literal no código: o repo é público
// e o token protege nomes de clientes. Sem o secret, cai na raiz.
function linkPainel(): string {
  const tk = process.env.RIVERS_CX_TOKEN;
  return tk
    ? `<https://vammo-reserva.alvaro-d42.workers.dev/cx?k=${tk}|abrir a tela do CX>`
    : `<https://vammo-reserva.alvaro-d42.workers.dev|abrir o painel>`;
}

// Posta um texto simples no canal (alertas do monitor de precisão etc.).
export async function notifyTexto(text: string): Promise<boolean> {
  const webhook = process.env.SLACK_WEBHOOK_URL;
  if (!webhook) return false;
  try {
    const r = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

// AVISO de SLA (18/08, pedido do Alvaro): além das reservas, o bot avisa o grupo do
// CX quando um cliente vai cruzar (ou cruzou) as 3h SEM regra de reserva — o caso
// "moto sai antes de uma reserva chegar", em que a ação certa é CONVERSAR, não reservar.
export interface AvisoNotificavel {
  os_id: number;
  placa: string | null;
  location_id: number | null;
  // minutos que faltam pro SLA (negativo = já estourou)
  sla_restante_min: number;
  // minutos até a moto ficar pronta (null = sem número confiável)
  pronta_em_min: number | null;
}

export async function notifyAviso(itens: AvisoNotificavel[]): Promise<number> {
  const webhook = process.env.SLACK_WEBHOOK_URL;
  if (!webhook || itens.length === 0) return 0;

  // linha mínima (Alvaro, 18-19/08): fato + previsão quando existe. Nada de
  // justificativa no texto. 🟡 antes da linha só chega aqui no caso específico
  // aprovado (número firme dizendo que não sai a tempo — filtro no cron).
  const linhas = itens
    .map((i) => {
      const base = BASES[i.location_id ?? 0] ?? `base ${i.location_id ?? "?"}`;
      const placa = i.placa || "sem placa";
      const quando =
        i.sla_restante_min > 0
          ? `passa das 3h em ~${Math.round(i.sla_restante_min)}min`
          : `passou das 3h (${Math.round(-i.sla_restante_min)}min de atraso)`;
      const pronta = i.pronta_em_min !== null ? ` · moto pronta em ~${Math.round(i.pronta_em_min)}min` : "";
      return `${i.sla_restante_min > 0 ? "🟡" : "🔴"} *${placa}* (${base}) — ${quando}${pronta}  _OS ${i.os_id}_`;
    })
    .join("\n");

  const text =
    `⏰ *RIVERS — avisar o cliente* _(sem sugestão de reserva)_\n` +
    linhas +
    `\n${linkPainel()}`;

  try {
    const r = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) {
      console.error("[rivers] slack respondeu", r.status);
      return 0;
    }
    return itens.length;
  } catch (e) {
    console.error("[rivers] slack falhou:", e);
    return 0;
  }
}

// Posta UMA mensagem com a lista de reservas novas. Devolve quantas foram avisadas.
export async function notifyReserva(itens: ReservaNotificavel[]): Promise<number> {
  const webhook = process.env.SLACK_WEBHOOK_URL;
  if (!webhook || itens.length === 0) return 0;

  const linhas = itens
    .map((i) => {
      const base = BASES[i.location_id ?? 0] ?? `base ${i.location_id ?? "?"}`;
      const placa = i.placa || "sem placa";
      const tag = i.auto ? "⚡ " : "• ";
      const front = i.fronteira ? " _(fronteira — perto das 3h, confirmar no piso)_" : "";
      return `${tag}*${placa}* (${base}) — ${i.motivo ?? "reserva sugerida"}${front}  _OS ${i.os_id}_`;
    })
    .join("\n");
  const temAuto = itens.some((i) => i.auto);

  const text =
    `🛵 *RIVERS — ${itens.length} reserva(s) sugerida(s)*\n` +
    linhas +
    (temAuto ? `\n_⚡ = regra de alta precisão — pode acatar direto_` : "") +
    `\n${linkPainel()}`;

  try {
    const r = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) {
      console.error("[rivers] slack respondeu", r.status);
      return 0;
    }
    return itens.length;
  } catch (e) {
    console.error("[rivers] slack falhou:", e);
    return 0;
  }
}
