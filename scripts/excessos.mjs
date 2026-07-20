import { dirname as __dir, join as __join } from "path";
const ROOT = __join(import.meta.dirname, "..");
const DL = process.env.METABASE_DIR || __join(ROOT, "data");
// Isola os "excessos" do RIVERS (só-RIVERS que ficaram prontas <3h) e junta:
// o que o algoritmo ESTIMOU na hora (features do log) × o desfecho real (v7).
// Sai uma lista de os_ids pra buscar peças/tempo real no ClickHouse.

import { readFileSync, writeFileSync } from "fs";

const env = {};
for (const line of readFileSync(ROOT + "\\.env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const URL = env.NEXT_PUBLIC_SUPABASE_URL;
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY };

// log completo (com features) das decisões RESERVA
const sugg = [];
for (let from = 0; ; from += 1000) {
  const r = await fetch(
    `${URL}/rest/v1/rivers_suggestion?select=os_id,decision,fired_layer,created_at,features&decision=eq.RESERVA&created_at=gte.2026-06-25&order=created_at.asc,id.asc`,
    { headers: { ...H, Range: `${from}-${from + 999}` } }
  );
  const page = await r.json();
  if (!Array.isArray(page)) throw new Error(JSON.stringify(page).slice(0, 150));
  sugg.push(...page);
  if (page.length < 1000) break;
}
const primeira = new Map();
for (const s of sugg) if (!primeira.has(s.os_id)) primeira.set(s.os_id, s);

const maestro = JSON.parse(readFileSync(DL + "\\rivers-cross-v7.json", "utf8"));
const AGORA = Math.max(...maestro.map((m) => Date.parse(m.os_criada_em) || 0));
const tempoUtil = (m) =>
  m.pronta_min != null && m.permanencia_min != null ? Math.min(m.pronta_min, m.permanencia_min)
  : m.pronta_min != null ? m.pronta_min : m.permanencia_min;

const excessos = [];
for (const m of maestro) {
  const oficina = m.ofertada === 1 || m.entregue === 1;
  if (oficina) continue; // só-RIVERS
  const s = primeira.get(Number(m.os_id));
  if (!s || Date.parse(s.created_at) > AGORA) continue;
  const t = tempoUtil(m);
  if (t == null || t > 180) continue; // excesso = ficou pronta <=3h
  const f = s.features || {};
  excessos.push({
    os_id: Number(m.os_id), placa: m.placa, base: Number(m.base),
    regra: s.fired_layer,
    est_algoritmo_min: f.tempo_estimado_min ?? null,
    ja_esperado_min: f.min_desde_open ?? null,
    capacidade: f.capacidade_esperada ?? null,
    fila_min: f.fila_min ?? null,
    n_pecas: f.n_pecas ?? null,
    pronta_real_min: t,
  });
}
writeFileSync(ROOT + "\\calib\\excessos.json", JSON.stringify(excessos, null, 1));
const porRegra = {};
for (const e of excessos) porRegra[e.regra] = (porRegra[e.regra] || 0) + 1;
console.log("excessos (só-RIVERS, pronta <=3h):", excessos.length);
console.log("por regra:", JSON.stringify(porRegra));
const med = (a) => { const v = a.filter((x) => x != null).sort((x, y) => x - y); return v[Math.floor(v.length / 2)]; };
console.log("mediana est. algoritmo:", med(excessos.map((e) => e.est_algoritmo_min)), "min | mediana pronta real:", med(excessos.map((e) => e.pronta_real_min)), "min");
console.log("IDS=" + excessos.map((e) => e.os_id).join(","));
