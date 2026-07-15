// Cliente Supabase (lado servidor) + helpers de log do Rivers.
//
// Por que aqui e não no browser? A service_role key dá acesso total ao banco —
// só pode viver no servidor (rotas /api). Nunca exponha no client.
//
// Importante: se as variáveis do Supabase ainda não estiverem no .env.local,
// TUDO aqui vira no-op. O app continua rodando e mostrando o algoritmo —
// só não grava ainda. Assim dá pra testar o algoritmo antes do Supabase pronto.

import { createClient, SupabaseClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const supabaseConfigurado = Boolean(url && serviceKey);

let _client: SupabaseClient | null = null;
function client(): SupabaseClient | null {
  if (!supabaseConfigurado) return null;
  if (!_client) {
    _client = createClient(url as string, serviceKey as string, {
      auth: { persistSession: false },
    });
  }
  return _client;
}

// Espelha a tabela rivers_suggestion
export interface SuggestionLog {
  algo_version: string;
  os_id: number;
  placa: string | null;
  location_id: number | null;
  asset_model: string | null;
  is_piso: boolean | null;
  status_atual: string | null;
  decision: string;
  fired_layer: string | null;
  reason_code: string | null;
  motivo: string | null;
  features: Record<string, unknown>;
}

// Grava as sugestões. on conflict (os_id, algo_version, decision) do nothing →
// guarda o PRIMEIRO instante em que cada decisão apareceu. Idempotente.
export async function logRiversSuggestions(rows: SuggestionLog[]): Promise<void> {
  const c = client();
  if (!c || rows.length === 0) return;
  const { error } = await c
    .from("rivers_suggestion")
    .upsert(rows, { onConflict: "os_id,algo_version,decision", ignoreDuplicates: true });
  if (error) console.error("[rivers] erro ao gravar sugestao:", error.message);
}

// Quais OS já têm uma RESERVA logada nas últimas 48h (mesma versão do algoritmo).
// Serve pro cron NÃO notificar a mesma reserva a cada rodada. Vazio se Supabase off.
export async function getLoggedReservaOsIds(algoVersion: string): Promise<Set<number>> {
  const c = client();
  if (!c) return new Set();
  const desde = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const { data, error } = await c
    .from("rivers_suggestion")
    .select("os_id")
    .eq("algo_version", algoVersion)
    .eq("decision", "RESERVA")
    .gte("created_at", desde)
    .limit(5000);
  if (error || !data) {
    if (error) console.error("[rivers] erro ao ler reservas logadas:", error.message);
    return new Set();
  }
  return new Set(data.map((r) => r.os_id as number));
}

export interface SuggestionRow {
  os_id: number;
  decision: string;
  fired_layer: string | null;
  motivo: string | null;
  created_at: string;
  is_piso: boolean | null;
}

// Sugestões logadas pelo algoritmo nos últimos N dias (pro painel de acurácia).
// Vazio se Supabase off. Usado pra cruzar com a verdade de campo do Maestro.
export async function getRecentSuggestions(days: number): Promise<SuggestionRow[]> {
  const c = client();
  if (!c) return [];
  const desde = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await c
    .from("rivers_suggestion")
    .select("os_id,decision,fired_layer,motivo,created_at,is_piso")
    .gte("created_at", desde)
    .order("created_at", { ascending: true })
    .limit(20000);
  if (error || !data) {
    if (error) console.error("[acuracia] erro ao ler sugestoes:", error.message);
    return [];
  }
  return data as unknown as SuggestionRow[];
}

export interface FeedbackLogInput {
  os_id: number;
  aceitou: boolean;
  actor?: string | null;
  motivo_humano?: string | null;
}

export async function logRiversFeedback(
  fb: FeedbackLogInput
): Promise<{ ok: boolean; error?: string }> {
  const c = client();
  if (!c) return { ok: false, error: "Supabase nao configurado (.env.local)" };
  const { error } = await c.from("rivers_feedback").insert({
    os_id: fb.os_id,
    aceitou: fb.aceitou,
    actor: fb.actor ?? null,
    motivo_humano: fb.motivo_humano ?? null,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
