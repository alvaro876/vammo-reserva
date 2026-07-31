import { join as __join } from "path";
const ROOT = __join(import.meta.dirname, "..");
// Recorte MOOCA (location_id 1): semana 20-26 fechada + ontem/hoje.
// Fontes: exports da semana (checkins/outcomes) + log Supabase filtrado por base.

import { readFileSync } from "fs";

const DL = process.env.METABASE_DIR || "C:\\Users\\Usuário\\Downloads\\Metabase";
const env = {};
for (const line of readFileSync(ROOT + "\\.env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY };

// checkins da semana (com loc) + desfechos
const checkins = JSON.parse(readFileSync(DL + "\\rivers-semana-checkins.json", "utf8"));
const out = new Map(JSON.parse(readFileSync(DL + "\\rivers-semana-outcomes.json", "utf8")).map((o) => [Number(o.so_id), o]));

// 1ª RESERVA por OS (log completo)
const prim = new Map();
for (let from = 0; ; from += 1000) {
  const r = await fetch(
    `${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rivers_suggestion?select=os_id,created_at&decision=eq.RESERVA&created_at=gte.2026-06-25&order=created_at.asc,id.asc`,
    { headers: { ...H, Range: `${from}-${from + 999}` } }
  );
  const page = await r.json();
  for (const s of page) if (!prim.has(Number(s.os_id))) prim.set(Number(s.os_id), Date.parse(s.created_at) / 1000);
  if (page.length < 1000) break;
}

const FIM = Date.parse("2026-07-27T03:00:00Z") / 1000;
const dia = (ts) => new Date((ts - 3 * 3600) * 1000).toISOString().slice(5, 10);
const estourou = (id, ref) => {
  const o = out.get(id);
  if (!o || !o.open_ts || o.cancel_ts > 0) return null;
  if (o.ready_ts > 0) return (o.ready_ts - o.open_ts) / 60 > 180;
  return (ref - o.open_ts) / 60 > 180 ? true : null;
};

// ── SEMANA 20-26, SÓ MOOCA ────────────────────────────────────────────────────
let corridas = 0, cap = 0, antesDia = 0, vesp = 0, atrasos = [], furos = [];
let sugPiso = 0, exc = 0, semOf = 0, avisados = 0;
for (const c of checkins) {
  if (Number(c.loc) !== 1) continue;
  if (["NO_SHOW", "CANCELLED", "DROPOUT"].includes(c.checkin_status)) continue;
  if (c.motivo === "awaiting_special_service") continue;
  const id = Number(c.os_id);
  const of = Number(c.ofertada_ts) || Number(c.entregue_ts) || 0;
  const e = estourou(id, FIM);
  const f = prim.get(id);
  if (f && e !== null) { sugPiso++; if (e === false && !of) exc++; }
  if (!of && e === true) { semOf++; if (f) avisados++; }
  if (of && e === true) {
    corridas++;
    if (f) {
      cap++;
      const d = Math.round((of - f) / 60);
      if (d > 0) { dia(f) < dia(of) ? vesp++ : antesDia++; } else atrasos.push(-d);
    } else furos.push(id);
  }
}
atrasos.sort((a, b) => a - b);
console.log("== MOOCA — SEMANA 20-26 (fechada) ==");
console.log(`corridas reais ${corridas} | capturadas ${cap} (${Math.round((100 * cap) / corridas)}%) | antes ${antesDia} mesmo dia + ${vesp} véspera | atraso med ${atrasos[Math.floor(atrasos.length / 2)] ?? "-"}min | furos: ${furos.join(",") || "0"}`);
console.log(`sugestões piso c/ desfecho ${sugPiso} | excesso ${exc} | estouros sem oferta ${semOf}, avisados ${avisados}`);

// ── ONTEM/HOJE, SÓ MOOCA (log com location_id) ───────────────────────────────
const rows = [];
for (let from = 0; ; from += 1000) {
  const r = await fetch(
    `${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rivers_suggestion?select=os_id,fired_layer,created_at,features,is_piso&decision=eq.RESERVA&location_id=eq.1&created_at=gte.2026-07-27&order=created_at.asc,id.asc`,
    { headers: { ...H, Range: `${from}-${from + 999}` } }
  );
  const page = await r.json();
  if (!Array.isArray(page)) throw new Error(JSON.stringify(page).slice(0, 150));
  rows.push(...page);
  if (page.length < 1000) break;
}
const porDia = {};
for (const s of rows) {
  const d = dia(Date.parse(s.created_at) / 1000);
  const f = s.features || {};
  const dd = (porDia[d] ||= { os: new Set(), piso: new Set(), auto: new Set(), front: new Set(), regras: {} });
  dd.os.add(s.os_id);
  if (s.is_piso) dd.piso.add(s.os_id);
  if (f.acao_automatica === true) dd.auto.add(s.os_id);
  if (f.confianca === "fronteira") dd.front.add(s.os_id);
  dd.regras[s.fired_layer] = (dd.regras[s.fired_layer] || 0) + 1;
}
console.log("\n== MOOCA — ONTEM/HOJE (sugestões RESERVA) ==");
for (const [d, v] of Object.entries(porDia).sort())
  console.log(`${d}: OSs ${v.os.size} (piso ${v.piso.size}) | auto ${v.auto.size} | fronteira ${v.front.size} | regras ${JSON.stringify(v.regras)}`);
