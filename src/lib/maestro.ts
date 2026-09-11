// Envia sugestões de reserva do RIVERS pro Maestro (POST machine-auth no scheduler).
//
// Igual ao supabase.ts: se MAESTRO_BASE_URL / MAESTRO_INTERNAL_API_TOKEN não estiverem
// no ambiente, TUDO aqui vira no-op — nada é enviado. Assim dá pra ligar por env
// (dev primeiro, depois prod) sem tocar no código. Nunca lança: um erro de rede não
// pode derrubar o cron.
//
// MAESTRO_BASE_URL inclui o prefixo do serviço, ex.:
//   https://services.dev.vammo.com/ms-maestro-scheduler

import type { MaestroReason } from "@/lib/maestro-reason";

const base = process.env.MAESTRO_BASE_URL;
const token = process.env.MAESTRO_INTERNAL_API_TOKEN;

export const maestroConfigurado = Boolean(base && token);

export interface SugestaoMaestro {
  soId: number;
  reason: MaestroReason;
  // Omitido quando não há estimativa (ex.: reserva pré-diagnóstico como troca de placa).
  estimatedHours?: number | null;
  notes?: string | null;
  source: string;
  computedAt?: string | null;
}

export type EnvioResultado =
  | "applied" // Maestro criou a proposta/oferta
  | "skipped" // Maestro aceitou mas um guard pulou (já ofertada, moto pronta, etc.)
  | "no_checkin" // OS sem check-in ativo no piso (ou ingest desligado) — normal, tenta de novo
  | "error"
  | "disabled"; // env não configurada

// Envia UMA sugestão. Devolve o resultado; nunca lança.
export async function enviarSugestaoMaestro(
  s: SugestaoMaestro
): Promise<EnvioResultado> {
  if (!maestroConfigurado) return "disabled";

  const body: Record<string, unknown> = {
    soId: s.soId,
    reason: s.reason,
    source: s.source,
  };
  if (s.estimatedHours != null) body.estimatedHours = s.estimatedHours;
  if (s.notes) body.notes = s.notes;
  if (s.computedAt) body.computedAt = s.computedAt;

  try {
    const resp = await fetch(`${base}/checkins/internal/suggest-reserve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });

    // Sem check-in ativo pra essa OS (ou ingest desligado no scheduler): não é erro,
    // só não há onde propor agora. Não marca como enviado → tenta na próxima rodada.
    //
    // LOGADO DE PROPÓSITO (11/09): sem esta linha o 404 some, e "está mandando e tomando
    // 404" fica indistinguível de "não está nem tentando" — as duas produzem zero registro
    // no Supabase. Foi exatamente o que travou a verificação do primeiro espelhamento: a
    // OS 223228 (BZG5H82, Mooca, piso) virou reserva às 16:51 e não houve como saber se o
    // POST saiu. Caso provável: o motor lê o ClickHouse de PRODUÇÃO e a env aponta pro
    // scheduler de DEV, que não conhece os ids de produção.
    if (resp.status === 404) {
      console.warn(`[maestro] so_id=${s.soId} reason=${s.reason}: 404 sem check-in ativo (ou ingest off) — repete na próxima rodada`);
      return "no_checkin";
    }

    if (!resp.ok) {
      console.error(
        `[maestro] POST suggest-reserve so_id=${s.soId} falhou: HTTP ${resp.status}`
      );
      return "error";
    }

    const data = (await resp.json().catch(() => null)) as {
      applied?: boolean;
    } | null;
    const r = data?.applied ? "applied" : "skipped";
    // sucesso também é logado: é o que prova, no tail, que a integração está viva
    console.log(`[maestro] so_id=${s.soId} reason=${s.reason} → ${r}`);
    return r;
  } catch (e) {
    console.error(
      `[maestro] POST suggest-reserve so_id=${s.soId} erro de rede:`,
      (e as Error).message
    );
    return "error";
  }
}
