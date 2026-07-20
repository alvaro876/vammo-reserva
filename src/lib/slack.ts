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

// Posta UMA mensagem com a lista de reservas novas. Devolve quantas foram avisadas.
export async function notifyReserva(itens: ReservaNotificavel[]): Promise<number> {
  const webhook = process.env.SLACK_WEBHOOK_URL;
  if (!webhook || itens.length === 0) return 0;

  const linhas = itens
    .map((i) => {
      const base = BASES[i.location_id ?? 0] ?? `base ${i.location_id ?? "?"}`;
      const placa = i.placa || "sem placa";
      const tag = i.auto ? "⚡ " : "• ";
      return `${tag}*${placa}* (${base}) — ${i.motivo ?? "reserva sugerida"}  _OS ${i.os_id}_`;
    })
    .join("\n");
  const temAuto = itens.some((i) => i.auto);

  const text =
    `🛵 *RIVERS — ${itens.length} reserva(s) sugerida(s)*\n` +
    linhas +
    (temAuto ? `\n_⚡ = regra de alta precisão — pode acatar direto_` : "") +
    `\n<https://vammo-reserva.vercel.app|abrir o painel>`;

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
