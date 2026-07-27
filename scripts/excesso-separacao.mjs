import { join as __join } from "path";
const ROOT = __join(import.meta.dirname, "..");
// O que separa EXCESSO (pronta <=3h) de CAPTURA LEGÍTIMA (estourou) nas regras de
// tempo, no universo piso? Olha as features QUE O MOTOR VIU NA HORA do disparo
// (log), pra decidir se o fix é limiar ou sinal novo. Janela: era v0.4.1+ (20/07+).

import { readFileSync } from "fs";

const env = {};
for (const line of readFileSync(ROOT + "\\.env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL;
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY };
const DL = process.env.METABASE_DIR || "C:\\Users\\Usuário\\Downloads\\Metabase";

const checkins = JSON.parse(readFileSync(DL + "\\rivers-semana-checkins.json", "utf8"));
const piso = new Map(); // os_id -> {ofertada}
for (const c of checkins) {
  if (["NO_SHOW", "CANCELLED", "DROPOUT"].includes(c.checkin_status)) continue;
  if (c.motivo === "awaiting_special_service") continue;
  piso.set(Number(c.os_id), { ofertada: !!(Number(c.ofertada_ts) || Number(c.entregue_ts)) });
}
const out = new Map(JSON.parse(readFileSync(DL + "\\rivers-semana-outcomes.json", "utf8")).map((o) => [Number(o.so_id), o]));

// 1ª RESERVA por OS com features, desde 20/07
const rows = [];
for (let from = 0; ; from += 1000) {
  const r = await fetch(
    `${SB}/rest/v1/rivers_suggestion?select=os_id,fired_layer,created_at,features&decision=eq.RESERVA&created_at=gte.2026-07-20&order=created_at.asc,id.asc`,
    { headers: { ...H, Range: `${from}-${from + 999}` } }
  );
  const page = await r.json();
  if (!Array.isArray(page)) throw new Error("supabase: " + JSON.stringify(page).slice(0, 150));
  rows.push(...page);
  if (page.length < 1000) break;
}
const prim = new Map();
for (const s of rows) if (!prim.has(s.os_id)) prim.set(s.os_id, s);

const AGORA = Date.now() / 1000;
const casos = [];
for (const [osId, s] of prim) {
  const p = piso.get(Number(osId));
  if (!p) continue; // fora do universo piso da semana
  const o = out.get(Number(osId));
  if (!o || !o.open_ts || o.cancel_ts > 0) continue;
  let estourou;
  if (o.ready_ts > 0) estourou = (o.ready_ts - o.open_ts) / 60 > 180;
  else if ((AGORA - o.open_ts) / 60 > 180) estourou = true;
  else continue;
  const f = s.features || {};
  casos.push({
    os: Number(osId), regra: s.fired_layer, estourou, ofertada: p.ofertada,
    est: f.tempo_estimado_min ?? null, n_pecas: f.n_pecas ?? null,
    elapsed: f.min_desde_open ?? null, fila: f.fila_min ?? null,
    pronta: o.ready_ts > 0 ? Math.round((o.ready_ts - o.open_ts) / 60) : null,
  });
}

const med = (a) => { const v = a.filter((x) => x != null).sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : null; };

for (const regra of ["C3_TEMPO_ALTO", "C3_TEMPO_COMBINADO"]) {
  const cs = casos.filter((c) => c.regra === regra);
  const ok = cs.filter((c) => c.estourou), exc = cs.filter((c) => !c.estourou);
  console.log(`\n===== ${regra} (piso, semana) — legit ${ok.length} × excesso ${exc.length} =====`);
  for (const [nome, g] of [["LEGIT  ", ok], ["EXCESSO", exc]]) {
    console.log(`${nome}: est med=${med(g.map(c=>c.est))} | n_pecas med=${med(g.map(c=>c.n_pecas))} | elapsed@fire med=${med(g.map(c=>c.elapsed))} | fila med=${med(g.map(c=>c.fila))}`);
  }
  console.log("LEGIT   caso a caso:", ok.map(c=>`${c.os}(est${c.est},n${c.n_pecas},e${c.elapsed}${c.ofertada?",OF":""})`).join(" "));
  console.log("EXCESSO caso a caso:", exc.map(c=>`${c.os}(est${c.est},n${c.n_pecas},e${c.elapsed},pronta${c.pronta})`).join(" "));
}

// dump p/ cruzar com status-no-disparo (ClickHouse)
import { writeFileSync } from "fs";
const c3 = casos.filter((c) => c.regra.startsWith("C3"));
writeFileSync(ROOT + "\\calib\\c3-casos.json", JSON.stringify(
  c3.map((c) => ({ ...c, fire_ts: Date.parse(prim.get(c.os)?.created_at ?? prim.get(String(c.os))?.created_at) })), null, 1));
console.log("\ndump:", c3.length, "casos C3 em calib/c3-casos.json | ids:", c3.map((c) => c.os).join(","));

// e as demais regras no piso (contexto)
const resto = {};
for (const c of casos) if (!c.regra.startsWith("C3")) {
  const r = (resto[c.regra] ||= { ok: 0, exc: 0 });
  c.estourou ? r.ok++ : r.exc++;
}
console.log("\ndemais regras no piso:", JSON.stringify(resto));
