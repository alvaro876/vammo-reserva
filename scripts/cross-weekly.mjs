import { fileURLToPath as __furl } from "url";
const ROOT = __furl(new URL("..", import.meta.url)).replace(/[\\/]$/, "");
const DL = process.env.METABASE_DIR || (ROOT + "\\data");
// Comparativo semanal RIVERS × Oficina: "esta semana" (últimos 7 dias do snapshot)
// vs a semana anterior. Mesmas definições do cross-analysis (tempo até pronta,
// canceladas fora, serviço especial excluído).

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
const AGORA = Math.max(
  ...maestro.map((m) => Date.parse(m.os_criada_em) || 0),
  ...maestro.map((m) => (m.ofertada_em ? Date.parse(m.ofertada_em) : 0))
);
console.log("snapshot:", new Date(AGORA).toISOString());
const CORTE = AGORA - 7 * 86400e3; // esta semana = últimos 7 dias

const algo = new Map();
for (const s of sugg) {
  if (Date.parse(s.created_at) > AGORA) continue;
  const a = algo.get(s.os_id) ?? { reserva: false, ts: null, regra: null };
  if (s.decision === "RESERVA" && !a.reserva) {
    a.reserva = true; a.ts = Date.parse(s.created_at); a.regra = s.fired_layer;
  }
  algo.set(s.os_id, a);
}

const tempoUtil = (m) =>
  m.pronta_min != null && m.permanencia_min != null ? Math.min(m.pronta_min, m.permanencia_min)
  : m.pronta_min != null ? m.pronta_min : m.permanencia_min;

function analisa(rows, nome) {
  const tp = [], fp = [], miss = []; let tn = 0; let especiais = 0, foraRadar = 0;
  for (const m of rows) {
    const oficina = m.ofertada === 1 || m.entregue === 1;
    if (oficina && m.motivo_oficina === "awaiting_special_service") { especiais++; continue; }
    const a = algo.get(Number(m.os_id));
    if (!a) { if (oficina) foraRadar++; continue; }
    if (a.reserva && oficina) tp.push({ m, a });
    else if (a.reserva && !oficina) fp.push({ m, a });
    else if (!a.reserva && oficina) miss.push({ m, a });
    else tn++;
  }
  const fpCerto = fp.filter(({ m }) => {
    const t = tempoUtil(m);
    if (t != null) return t > 180;
    return m.status_atual !== "CANCELLED" && (AGORA - Date.parse(m.os_criada_em)) / 60000 > 180;
  }).length;
  const missReal = miss.filter(({ m }) => {
    const t = tempoUtil(m);
    if (t != null) return t > 180;
    return m.status_atual !== "CANCELLED" && (AGORA - Date.parse(m.os_criada_em)) / 60000 > 180;
  }).length;
  const timing = tp.filter(({ m }) => m.ofertada_em)
    .map(({ m, a }) => Math.round((Date.parse(m.ofertada_em) - a.ts) / 60000));
  const antes = timing.filter((d) => d > 0).length;
  const fpRegra = {};
  for (const { a } of fp) fpRegra[a.regra] = (fpRegra[a.regra] || 0) + 1;
  const oficinaTot = tp.length + miss.length;
  console.log(`\n== ${nome} ==`);
  console.log(`checkins ${rows.length} | universo ${tp.length + fp.length + miss.length + tn} | especiais fora ${especiais} | fora do radar ${foraRadar}`);
  console.log(`oficina ${oficinaTot} | rivers ${tp.length + fp.length} | TP ${tp.length} | FP ${fp.length} | MISS ${miss.length}`);
  console.log(`recall ${oficinaTot ? Math.round((100 * tp.length) / oficinaTot) : "-"}% | furos reais ${missReal}/${miss.length} | FP que passaram 3h: ${fpCerto}/${fp.length} (${fp.length ? Math.round((100 * fpCerto) / fp.length) : 0}%)`);
  console.log(`timing: RIVERS antes em ${antes}/${timing.length}`);
  console.log(`FP por regra:`, JSON.stringify(fpRegra));
  // por dia (cobertura — fins de semana/cron)
  const porDia = {};
  for (const { a } of [...tp, ...fp]) {
    const d = new Date(a.ts - 3 * 3600e3).toISOString().slice(5, 10);
    porDia[d] = (porDia[d] || 0) + 1;
  }
  console.log(`sugestões RESERVA por dia:`, JSON.stringify(porDia));
}

const semanaAtual = maestro.filter((m) => Date.parse(m.os_criada_em) >= CORTE);
const semanaAnterior = maestro.filter((m) => Date.parse(m.os_criada_em) < CORTE && Date.parse(m.os_criada_em) >= CORTE - 7 * 86400e3);
analisa(semanaAnterior, "SEMANA ANTERIOR (7d antes)");
analisa(semanaAtual, "ESTA SEMANA (últimos 7 dias)");

// quebra extra: FP de C4_CAPACIDADE por base, esta semana
const fpC4 = [];
for (const m of semanaAtual) {
  const oficina = m.ofertada === 1 || m.entregue === 1;
  if (oficina) continue;
  const a = algo.get(Number(m.os_id));
  if (a && a.reserva && a.regra === "C4_CAPACIDADE") fpC4.push(Number(m.base));
}
console.log("\nFP C4_CAPACIDADE esta semana por base:", JSON.stringify(fpC4.reduce((o,b)=>(o[b]=(o[b]||0)+1,o),{})));
