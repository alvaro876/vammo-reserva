import { join as __join } from "path";
const ROOT = __join(import.meta.dirname, "..");
// Consolidado da SEMANA (20-24/jul) direto das fontes vivas:
//  - Supabase rivers_suggestion (1ª RESERVA por OS + volume diário por regra)
//  - ClickHouse: checkins Maestro da semana (ofertas) + desfechos (OPEN→AWAITING_CX)
// Mesmas definições do cross-analysis: especial fora, pronta = 1º AWAITING_CX,
// estouro = >180min, precisão por regra no molde do /api/health (14d, madura).

import { readFileSync } from "fs";

const env = {};
for (const line of readFileSync(ROOT + "\\.env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL;
const SBH = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY };

// ClickHouse local está sem credencial válida (Vercel marca como sensitive) →
// os dados vêm de exports do Metabase (MCP) salvos em Downloads/Metabase.
const DL = process.env.METABASE_DIR || "C:\\Users\\Usuário\\Downloads\\Metabase";

// ── 1. Log de decisões desde 10/07 (p/ precisão 14d) ─────────────────────────
const sugg = [];
for (let from = 0; ; from += 1000) {
  const r = await fetch(
    `${SB}/rest/v1/rivers_suggestion?select=os_id,decision,fired_layer,created_at&created_at=gte.2026-07-10&order=created_at.asc,id.asc`,
    { headers: { ...SBH, Range: `${from}-${from + 999}` } }
  );
  const page = await r.json();
  if (!Array.isArray(page)) throw new Error("supabase: " + JSON.stringify(page).slice(0, 150));
  sugg.push(...page);
  if (page.length < 1000) break;
}

const primeiraReserva = new Map(); // os_id -> {ts, regra}
const porDiaOS = new Map();        // 'MM-DD' -> Set(os_id) (RESERVA logada no dia, BRT)
const porDiaRegra = new Map();     // 'MM-DD' -> {regra: n}
for (const s of sugg) {
  if (s.decision !== "RESERVA") continue;
  const ts = Date.parse(s.created_at);
  if (!primeiraReserva.has(s.os_id)) primeiraReserva.set(s.os_id, { ts, regra: s.fired_layer });
  const dia = new Date(ts - 3 * 3600e3).toISOString().slice(5, 10);
  if (!porDiaOS.has(dia)) porDiaOS.set(dia, new Set());
  porDiaOS.get(dia).add(s.os_id);
  if (!porDiaRegra.has(dia)) porDiaRegra.set(dia, {});
  const pr = porDiaRegra.get(dia);
  pr[s.fired_layer] = (pr[s.fired_layer] || 0) + 1;
}

// ── 2. Checkins da semana (Maestro) + desfechos — dos exports ─────────────────
const checkins = JSON.parse(readFileSync(DL + "\\rivers-semana-checkins.json", "utf8"));
const outcomes = JSON.parse(readFileSync(DL + "\\rivers-semana-outcomes.json", "utf8"));
const out = new Map(outcomes.map((o) => [Number(o.so_id), o]));

const AGORA = Date.now() / 1000;
const BASES = { 1: "Mooca", 34: "Osasco", 166: "SBC" }; // location_id do OMS no checkin
const dia = (ts) => new Date((ts - 3 * 3600) * 1000).toISOString().slice(5, 10);
const hhmm = (ts) => new Date((ts - 3 * 3600) * 1000).toISOString().slice(11, 16);

// estourou 3h? (pronta>180 | ainda aberta>180 e não cancelada)
function estourou(o) {
  if (!o || !o.open_ts) return null;
  if (o.ready_ts > 0) return (o.ready_ts - o.open_ts) / 60 > 180;
  if (o.cancel_ts > 0) return null; // cancelada sem pronta: fora
  return (AGORA - o.open_ts) / 60 > 180 ? true : null; // aberta e já passou → estourou
}

// ── 4. A corrida da semana (ofertas não-especiais vigentes) ──────────────────
console.log("=== CORRIDA (ofertas nao-especiais da semana) ===");
const corrida = [];
for (const c of checkins) {
  const osId = Number(c.os_id);
  const ofer = Number(c.ofertada_ts) || Number(c.entregue_ts);
  if (!ofer) continue;
  if (c.motivo === "awaiting_special_service") continue;
  const r = primeiraReserva.get(osId);
  const delta = r ? Math.round((ofer - r.ts / 1000) / 60) : null; // >0 = RIVERS antes
  const vespera = r ? dia(r.ts / 1000) < dia(ofer) : false;
  corrida.push({ dia: dia(ofer), os: osId, base: BASES[c.loc] || c.loc, oficina: hhmm(ofer),
    rivers: r ? hhmm(r.ts / 1000) : null, delta, vespera, regra: r ? r.regra : null, motivo: c.motivo });
}
corrida.sort((a, b) => a.dia.localeCompare(b.dia) || a.oficina.localeCompare(b.oficina));
for (const c of corrida) {
  console.log(`${c.dia} ${c.base.padEnd(7)} OS ${c.os} oficina ${c.oficina} rivers ${c.rivers ?? "----"} ` +
    (c.delta === null ? "FURO" : c.delta > 0 ? `RIVERS ${c.delta}min ANTES` : `depois ${-c.delta}min`) +
    ` [${c.regra ?? "-"}] (${c.motivo || "sem motivo"})`);
}
const cap = corrida.filter((c) => c.delta !== null);
const antesDia = cap.filter((c) => c.delta > 0 && !c.vespera);
const antesVesp = cap.filter((c) => c.delta > 0 && c.vespera);
const atrasos = cap.filter((c) => c.delta <= 0).map((c) => -c.delta).sort((a, b) => a - b);
console.log(`\nplacar semana: ${cap.length}/${corrida.length} capturadas | ${antesDia.length} antes (mesmo dia) + ${antesVesp.length} avisadas na véspera | ` +
  `furos ${corrida.length - cap.length} | atraso mediano ${atrasos[Math.floor(atrasos.length / 2)] ?? "-"}min`);

// por dia
const porDiaCorrida = {};
for (const c of corrida) {
  const d = (porDiaCorrida[c.dia] ||= { total: 0, cap: 0, antes: 0 });
  d.total++; if (c.delta !== null) d.cap++; if (c.delta > 0) d.antes++;
}
console.log("por dia:", JSON.stringify(porDiaCorrida));

// ── 5. Estouros SEM oferta: RIVERS avisou? (semana toda × era pg_cron 21+) ───
const ERA = Date.parse("2026-07-21T03:00:00Z") / 1000; // 21/jul 00:00 BRT
for (const [nome, corte] of [["semana toda", 0], ["21/jul em diante", ERA]]) {
  let semOferta = 0, avisados = 0;
  for (const c of checkins) {
    const osId = Number(c.os_id);
    if (Number(c.checkin_ts) < corte) continue;
    if (Number(c.ofertada_ts) || Number(c.entregue_ts)) continue;
    if (["NO_SHOW", "CANCELLED", "DROPOUT"].includes(c.checkin_status)) continue;
    if (estourou(out.get(osId)) !== true) continue;
    semOferta++;
    if (primeiraReserva.has(osId)) avisados++;
  }
  console.log(`=== ESTOUROS SEM RESERVA (${nome}): ${semOferta} | RIVERS avisou: ${avisados} (${semOferta ? Math.round((100 * avisados) / semOferta) : 0}%) ===`);
}

// ── 6. Excessos no universo piso (por regra, era pg_cron) ────────────────────
const excRegra = {};
let exc = 0, sugPiso = 0;
for (const c of checkins) {
  const osId = Number(c.os_id);
  const r = primeiraReserva.get(osId);
  if (!r || r.ts / 1000 < ERA) continue;
  if (c.motivo === "awaiting_special_service") continue;
  const e = estourou(out.get(osId));
  if (e === null) continue;
  sugPiso++;
  if (e === false && !Number(c.ofertada_ts) && !Number(c.entregue_ts)) {
    exc++;
    excRegra[r.regra] = (excRegra[r.regra] || 0) + 1;
  }
}
console.log(`=== EXCESSOS no piso desde 21/jul (sugeriu, pronta <=3h, sem reserva): ${exc}/${sugPiso} | por regra: ${JSON.stringify(excRegra)} ===`);

// ── 7. Precisão por regra (1ª RESERVA por OS, madura) — 2 janelas ────────────
for (const [nome, corte] of [["desde 10/07", 0], ["pós-deploy 21/07+", ERA]]) {
  console.log(`\n=== PRECISAO POR REGRA (${nome}) ===`);
  const porRegra = {};
  for (const [osId, r] of primeiraReserva) {
    if (r.ts / 1000 < corte) continue;
    if (AGORA - r.ts / 1000 < 180 * 60) continue; // ainda imatura
    const e = estourou(out.get(Number(osId)));
    if (e === null) continue;
    const pr = (porRegra[r.regra] ||= { n: 0, ok: 0 });
    pr.n++; if (e) pr.ok++;
  }
  for (const [regra, v] of Object.entries(porRegra).sort((a, b) => b[1].n - a[1].n)) {
    console.log(`${regra.padEnd(22)} n=${String(v.n).padStart(4)}  precisao=${Math.round((100 * v.ok) / v.n)}%`);
  }
}

// ── 8. Volume diário ──────────────────────────────────────────────────────────
console.log("\n=== VOLUME DIARIO (OSs com RESERVA logada no dia) ===");
for (const [d, s] of [...porDiaOS.entries()].sort()) {
  if (d < "07-20") continue;
  console.log(`${d}: ${s.size} OSs | regras: ${JSON.stringify(porDiaRegra.get(d))}`);
}
