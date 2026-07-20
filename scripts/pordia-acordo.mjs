import { dirname as __dir, join as __join } from "path";
const ROOT = __join(import.meta.dirname, "..");
const DL = process.env.METABASE_DIR || __join(ROOT, "data");
// Recomputa, por dia, a quebra das sugestões do RIVERS em:
//   - TP  (os dois reservaram)
//   - FP  (só o RIVERS)
// + a oficina por dia (referência). Mesmas definições do cross-analysis:
// serviço especial fora, snapshot no máximo do Maestro.
import { readFileSync } from "fs";

const env = {};
for (const line of readFileSync(ROOT + "\\.env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const URL = env.NEXT_PUBLIC_SUPABASE_URL;
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY };

const sugg = [];
for (let from = 0; ; from += 1000) {
  const r = await fetch(
    `${URL}/rest/v1/rivers_suggestion?select=os_id,decision,fired_layer,created_at&created_at=gte.2026-06-25&order=created_at.asc,id.asc`,
    { headers: { ...H, Range: `${from}-${from + 999}` } }
  );
  const page = await r.json();
  if (!Array.isArray(page)) throw new Error("supabase: " + JSON.stringify(page).slice(0, 150));
  sugg.push(...page);
  if (page.length < 1000) break;
}
const maestro = JSON.parse(readFileSync(DL + "\\rivers-cross-v7.json", "utf8"));
const AGORA = Math.max(...maestro.map((m) => Date.parse(m.os_criada_em) || 0),
  ...maestro.map((m) => (m.ofertada_em ? Date.parse(m.ofertada_em) : 0)));

const algo = new Map();
for (const s of sugg) {
  if (Date.parse(s.created_at) > AGORA) continue;
  const a = algo.get(s.os_id) ?? { reserva: false, ts: null };
  if (s.decision === "RESERVA" && !a.reserva) { a.reserva = true; a.ts = Date.parse(s.created_at); }
  algo.set(s.os_id, a);
}
const diaLocal = (ms) => new Date(ms - 3 * 3600e3).toISOString().slice(5, 10);

const porDia = {}; // dia -> {of, tp, fp}
const bump = (d, k) => { (porDia[d] ??= { of: 0, tp: 0, fp: 0 })[k]++; };

for (const m of maestro) {
  const oficina = m.ofertada === 1 || m.entregue === 1;
  if (oficina && m.motivo_oficina === "awaiting_special_service") continue;
  const a = algo.get(Number(m.os_id));
  const reservaRivers = a && a.reserva;
  // oficina por dia de oferta
  if (oficina && m.ofertada_em) bump(diaLocal(Date.parse(m.ofertada_em)), "of");
  // rivers por dia da sugestão
  if (reservaRivers) bump(diaLocal(a.ts), oficina ? "tp" : "fp");
}

const dias = Object.keys(porDia).sort();
let sof = 0, stp = 0, sfp = 0;
console.log("dia    | ofic |  tp |  fp | rivers(tp+fp)");
for (const d of dias) {
  const p = porDia[d];
  sof += p.of; stp += p.tp; sfp += p.fp;
  console.log(`${d} | ${String(p.of).padStart(4)} | ${String(p.tp).padStart(3)} | ${String(p.fp).padStart(3)} | ${p.tp + p.fp}`);
}
console.log(`TOTAL  | ${sof} | ${stp} | ${sfp} | ${stp + sfp}`);
console.log("\nJS_PORDIA=" + JSON.stringify(dias.map((d) => [d, porDia[d].of, porDia[d].tp, porDia[d].fp])));
