import { join as __join } from "path";
const ROOT = __join(import.meta.dirname, "..");
// Os disparos C2_SEM_ESTOQUE pós-deploy (21/07+): o que dispararam e o desfecho real.
import { readFileSync } from "fs";

const env = {};
for (const line of readFileSync(ROOT + "\\.env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL;
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY };

const r = await fetch(
  `${SB}/rest/v1/rivers_suggestion?select=os_id,created_at,motivo,features&decision=eq.RESERVA&fired_layer=eq.C2_SEM_ESTOQUE&created_at=gte.2026-07-21&order=created_at.asc`,
  { headers: H }
);
const rows = await r.json();
const DL = process.env.METABASE_DIR || "C:\\Users\\Usuário\\Downloads\\Metabase";
const out = new Map(JSON.parse(readFileSync(DL + "\\rivers-semana-outcomes.json", "utf8")).map((o) => [Number(o.so_id), o]));
const brt = (iso) => new Date(Date.parse(iso) - 3 * 3600e3).toISOString().slice(5, 16).replace("T", " ");

const vistos = new Set();
for (const s of rows) {
  if (vistos.has(s.os_id)) continue;
  vistos.add(s.os_id);
  const o = out.get(Number(s.os_id));
  const total = o && o.ready_ts > 0 ? Math.round((o.ready_ts - o.open_ts) / 60) : null;
  const f = s.features || {};
  console.log(`OS ${s.os_id} | ${brt(s.created_at)} | pronta em ${total ?? "?"}min | pecas_bloq_falta="${f.pecas_sem_estoque_bloq ?? "?"}" | motivo="${s.motivo}"`);
}
