import { join as __join } from "path";
const ROOT = __join(import.meta.dirname, "..");
// Forense da "corrida" de 22/jul: para cada OS, imprime o tique-a-tique do log
// (o que o RIVERS viu e decidiu a cada execução) pra separar o atraso em:
// (a) janela pré-diagnóstico, (b) hesitação pós-diagnóstico, (c) granularidade do tique.

import { readFileSync } from "fs";

const env = {};
for (const line of readFileSync(ROOT + "\\.env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const URL = env.NEXT_PUBLIC_SUPABASE_URL;
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY };

const OSS = process.argv[2]
  ? process.argv[2].split(",").map(Number)
  : [42906, 42953, 43038, 43066, 43071, 43167, 43247, 42908];

const rows = [];
for (let from = 0; ; from += 1000) {
  const r = await fetch(
    `${URL}/rest/v1/rivers_suggestion?select=os_id,decision,fired_layer,created_at,features&os_id=in.(${OSS.join(",")})&created_at=gte.2026-07-15&order=created_at.asc,id.asc`,
    { headers: { ...H, Range: `${from}-${from + 999}` } }
  );
  const page = await r.json();
  if (!Array.isArray(page)) throw new Error("supabase: " + JSON.stringify(page).slice(0, 150));
  rows.push(...page);
  if (page.length < 1000) break;
}

const brt = (iso) => new Date(Date.parse(iso) - 3 * 3600e3).toISOString().slice(5, 16).replace("T", " ");

for (const os of OSS) {
  const ticks = rows.filter((r) => r.os_id === os);
  console.log(`\n===== OS ${os} — ${ticks.length} tiques =====`);
  let prev = null;
  for (const t of ticks) {
    const f = t.features || {};
    const key = `${t.decision}|${t.fired_layer}|${f.tempo_estimado_min}|${f.n_pecas}|${f.is_piso}`;
    // imprime só transições (e o primeiro/último tique de cada estado) pra não inundar
    if (key !== prev) {
      console.log(
        `${brt(t.created_at)} BRT | ${t.decision}${t.fired_layer ? " (" + t.fired_layer + ")" : ""}` +
        ` | est=${f.tempo_estimado_min ?? "-"}min n_pecas=${f.n_pecas ?? "-"} desde_open=${f.min_desde_open ?? "-"}min` +
        ` fila=${f.fila_min ?? "-"} cap=${f.capacidade_esperada ?? "-"} piso=${f.is_piso ?? "-"} status=${f.status_atual ?? "-"}`
      );
      prev = key;
    }
  }
}
