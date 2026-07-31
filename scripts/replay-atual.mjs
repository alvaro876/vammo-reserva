import { join as __join } from "path";
const ROOT = __join(import.meta.dirname, "..");
// SIMULAÇÃO COMPLETA da semana 20-26/07 com o ALGORITMO ATUAL (v0.6→v0.9):
// reconstrói, a cada tique de 10min, o que o motor veria (peças→estimativa, status,
// execução acumulada, cliente presente) e roda as regras REAIS na ordem real:
//   C1_HARD (real, regra inalterada) → C1_ANOMALIA (incl. presa em OPEN, v0.5.1)
//   → C1_ESPERA_SEM_DIAG (is_piso = união chamado+client_present, v0.9)
//   → C2_TRAVADA_SEM_PECA (v0.8) → C2_SEM_ESTOQUE com gate de moto-parada (v0.8)
//   → C3_TEMPO_ALTO 140 (v0.6, conf alta) → C3_TEMPO_COMBINADO exec-acum (v0.6/0.7, fronteira).
// Radar atual: inclui AWAITING_PARTS/AWAITING_SERVICE (v0.8). Janela: 7d + fim da semana
// (sem vazamento do futuro). C4 fora (zero disparos de piso na semana; fila/capacidade
// não-reconstruível com fidelidade). Fidelidade do simulador: validada em replay-semana.mjs
// (reproduz o log real em 96/103 OSs, horários ±3min, zero disparo fantasma).

import { readFileSync } from "fs";

const DL = process.env.METABASE_DIR || "C:\\Users\\Usuário\\Downloads\\Metabase";
const env = {};
for (const line of readFileSync(ROOT + "\\.env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}

// ── mapa de minutos por peça (igual ao motor) ────────────────────────────────
const tpSrc = readFileSync(ROOT + "\\src\\lib\\tempo-pecas.ts", "utf8");
const BASE = Number(tpSrc.match(/TEMPO_BASE_MIN = (\d+)/)[1]);
const FALLBACK = Number(tpSrc.match(/TEMPO_FALLBACK_MIN = (\d+)/)[1]);
const MAPA = new Map();
for (const m of tpSrc.slice(tpSrc.indexOf("MINUTOS_POR_PECA")).matchAll(/(\d+):\s*([\d.]+)/g)) MAPA.set(Number(m[1]), Number(m[2]));
const FATOR = [null, 0.2, 0.42, 0.65, 0.91, 0.96, 1.0, 0.99, 1.0];

// ── dados ─────────────────────────────────────────────────────────────────────
let ids = JSON.parse(readFileSync(ROOT + "\\calib\\replay-ids.json", "utf8")).map(Number);
// filtro opcional por base: BASE=1 node scripts/replay-atual.mjs (loc do checkin da semana)
if (process.env.BASE) {
  const locMap = new Map(JSON.parse(readFileSync((process.env.METABASE_DIR || "C:\\Users\\Usuário\\Downloads\\Metabase") + "\\rivers-semana-checkins.json", "utf8")).map((c) => [Number(c.os_id), Number(c.loc)]));
  ids = ids.filter((id) => locMap.get(id) === Number(process.env.BASE));
  console.log(`(filtro BASE=${process.env.BASE}: ${ids.length} OSs)`);
}
const outcomes = new Map(JSON.parse(readFileSync(DL + "\\rivers-semana-outcomes.json", "utf8")).map((o) => [Number(o.so_id), o]));
const pecasAll = JSON.parse(readFileSync(DL + "\\rivers-replay-pecas.json", "utf8"));
const statusAll = JSON.parse(readFileSync(DL + "\\rivers-replay-status.json", "utf8"));
const psosAll = JSON.parse(readFileSync(DL + "\\rivers-replay-psos.json", "utf8"));
const chkAll = JSON.parse(readFileSync(DL + "\\rivers-replay-checkins2.json", "utf8"));

const pecas = new Map(), status = new Map();
for (const p of pecasAll) { if (!pecas.has(p.os_id)) pecas.set(p.os_id, []); pecas.get(p.os_id).push(p); }
for (const s of statusAll) { if (!status.has(s.os_id)) status.set(s.os_id, []); status.get(s.os_id).push(s); }
const psos = new Map(psosAll.map((p) => [Number(p.os_id), p]));
const chk = new Map();
for (const c of chkAll) {
  const id = Number(c.os_id);
  const cur = chk.get(id);
  if (!cur || Number(c.checkin_ts) < Number(cur.checkin_ts)) chk.set(id, c);
}

// log real: 1ª RESERVA por OS por regra (fidelidade + candidatos de regras não-replayáveis)
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY };
const sugg = [];
for (let from = 0; ; from += 1000) {
  const r = await fetch(
    `${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rivers_suggestion?select=os_id,fired_layer,created_at&decision=eq.RESERVA&created_at=gte.2026-07-10&created_at=lt.2026-07-27&order=created_at.asc,id.asc`,
    { headers: { ...H, Range: `${from}-${from + 999}` } }
  );
  const page = await r.json();
  if (!Array.isArray(page)) throw new Error("supabase: " + JSON.stringify(page).slice(0, 150));
  sugg.push(...page);
  if (page.length < 1000) break;
}
const realFire = new Map();       // 1ª RESERVA real (qualquer regra) — o "ANTIGO"
const realPorRegra = new Map();   // os_id -> {regra: ts}
for (const s of sugg) {
  const id = Number(s.os_id);
  const ts = Date.parse(s.created_at) / 1000;
  if (!realFire.has(id)) realFire.set(id, { ts, regra: s.fired_layer });
  const pr = realPorRegra.get(id) ?? {};
  if (!(s.fired_layer in pr)) { pr[s.fired_layer] = ts; realPorRegra.set(id, pr); }
}

// ── simulação ─────────────────────────────────────────────────────────────────
const AVALIAVEIS = new Set(["OPEN", "IN_DIAGNOSIS", "AWAITING_MECHANIC", "IN_PROGRESS", "PAUSED", "AWAITING_VMGMT", "AWAITING_PARTS", "AWAITING_SERVICE"]);
const PARADA_C2 = new Set(["OPEN", "IN_DIAGNOSIS", "AWAITING_MECHANIC", "PAUSED", "AWAITING_SERVICE"]);
const TICK = 600, JANELA_7D = 7.5 * 86400;
const FIM_SEMANA = Date.parse("2026-07-27T03:00:00Z") / 1000;
const diaBRT = (ts) => new Date((ts - 3 * 3600) * 1000).toISOString().slice(0, 10);

function estimativa(parts, t) {
  const vis = parts.filter((p) => p.ts <= t && (!p.del_ts || p.del_ts > t));
  if (!vis.length) return 0;
  const igs = new Set(vis.map((p) => p.ig));
  let soma = 0;
  for (const p of vis) soma += Number(p.qty) * (MAPA.get(p.ig) || Number(p.time_target) || FALLBACK);
  return Math.round(soma * FATOR[Math.min(igs.size, 8)] + BASE);
}

function simulaOS(id) {
  const evs = status.get(id) || [];
  if (!evs.length) return null;
  const open = evs[0].ts;
  const parts = pecas.get(id) || [];
  const ps = psos.get(id);
  const ck = chk.get(id);
  const hard = (realPorRegra.get(id) || {})["C1_HARD"];
  const estoqueReal = (realPorRegra.get(id) || {})["C2_SEM_ESTOQUE"];
  const fim = Math.min(FIM_SEMANA, open + JANELA_7D);

  for (let t = Math.ceil(open / TICK) * TICK; t <= fim; t += TICK) {
    // estado em t
    let st = null, exec = 0, ini = null, lastTs = open, lastAwaiting = 0;
    for (const e of evs) {
      if (e.ts > t) break;
      if (ini !== null) { exec += (e.ts - ini) / 60; ini = null; }
      if (e.status === "IN_PROGRESS") ini = e.ts;
      if (e.status === "AWAITING_MECHANIC") lastAwaiting = e.ts;
      st = e.status; lastTs = e.ts;
    }
    if (ini !== null) exec += (t - ini) / 60;
    if (!st || !AVALIAVEIS.has(st)) continue;

    const elapsed = (t - open) / 60;
    const minNoStatus = (t - lastTs) / 60;
    const est = estimativa(parts, t);
    const isPiso =
      (ck && Number(ck.com_called) === 1 && !["NO_SHOW", "CANCELLED", "DROPOUT"].includes(ck.checkin_status) && diaBRT(Number(ck.checkin_ts)) === diaBRT(t)) ||
      (ps && Number(ps.presente) === 1 && diaBRT(Number(ps.ts)) === diaBRT(t));
    const fire = (regra, conf) => ({ ts: t, regra, conf: conf ?? null, auto: !!(isPiso && ["C1_HARD", "C1_ANOMALIA", "C1_ESPERA_SEM_DIAG"].includes(regra)) });

    // ordem real das camadas
    if (hard && hard <= t) return fire("C1_HARD", "alta");
    const minOpenToAwaiting = lastAwaiting > 0 ? (lastAwaiting - open) / 60 : (st === "OPEN" ? elapsed : 0);
    if (minOpenToAwaiting > 240) return fire("C1_ANOMALIA", "alta");
    if (isPiso && est === 0 && elapsed > 150) return fire("C1_ESPERA_SEM_DIAG", "alta");
    if (st === "AWAITING_PARTS" && minNoStatus >= 30 && elapsed >= 90 && elapsed <= 480) return fire("C2_TRAVADA_SEM_PECA", "alta");
    if (estoqueReal && estoqueReal <= t && PARADA_C2.has(st) && minNoStatus >= 30) return fire("C2_SEM_ESTOQUE", null);
    if (est > 140) return fire("C3_TEMPO_ALTO", "alta");
    if (est > 0 && elapsed < 480) {
      const proj = elapsed + Math.max(0, est - exec) + 8;
      if (proj > 180) return fire("C3_TEMPO_COMBINADO", proj >= 210 ? "alta" : "fronteira");
    }
  }
  return null;
}

const simFire = new Map();
for (const id of ids) { const f = simulaOS(id); if (f) simFire.set(id, f); }
if (process.env.DUMP) {
  const { writeFileSync } = await import("fs");
  writeFileSync(ROOT + "\\calib\\sim-fire.json", JSON.stringify([...simFire].map(([k, v]) => ({ os_id: k, ...v }))));
  console.log("(dump: calib/sim-fire.json)");
}

// ── métricas no universo fechado (checkins não-especiais com desfecho) ────────
function estourou(id) {
  const o = outcomes.get(id);
  if (!o || !o.open_ts || o.cancel_ts > 0) return null;
  if (o.ready_ts > 0) return (o.ready_ts - o.open_ts) / 60 > 180;
  return (FIM_SEMANA - o.open_ts) / 60 > 180 ? true : null; // aberta no fim da semana e já passou
}
const oferta = new Map();
for (const c of chkAll) {
  const id = Number(c.os_id);
  if (["NO_SHOW", "CANCELLED", "DROPOUT"].includes(c.checkin_status)) continue;
  if (c.motivo === "awaiting_special_service") continue;
  const of = Number(c.ofertada_ts) || Number(c.entregue_ts) || 0;
  if (!oferta.has(id) || of > 0) oferta.set(id, of);
}

function metricas(fires, nome) {
  let sug = 0, exc = 0, capt = 0, antesDia = 0, vesp = 0, atrasos = [], avisados = 0, semOf = 0, autoN = 0, frontN = 0;
  for (const id of ids) {
    const f = fires.get(id);
    const of = oferta.get(id) ?? 0;
    const e = estourou(id);
    if (f) {
      sug++;
      if (f.auto) autoN++;
      if (f.conf === "fronteira") frontN++;
    }
    if (f && e === false && !of) exc++;
    if (of && e === true) {
      if (f) {
        capt++;
        const d = Math.round((of - f.ts) / 60);
        if (d > 0) { diaBRT(f.ts) < diaBRT(of) ? vesp++ : antesDia++; } else atrasos.push(-d);
      }
    }
    if (!of && e === true) { semOf++; if (f) avisados++; }
  }
  atrasos.sort((a, b) => a - b);
  console.log(`${nome}: sugestões ${sug} | excesso ${exc} | capturas ${capt}/29 | antes ${antesDia}+${vesp}vésp | atraso med ${atrasos[Math.floor(atrasos.length / 2)] ?? "-"}min | avisos estouro s/ oferta ${avisados}/${semOf} | automáticas ${autoN} | fronteira ${frontN}`);
}

console.log("== SIMULAÇÃO SEMANA 20-26 — ALGORITMO ATUAL (v0.9) vs O QUE ACONTECEU ==\n");
metricas(realFire.size ? new Map([...realFire].map(([k, v]) => [k, { ...v, conf: null, auto: false }])) : new Map(), "ACONTECEU (log real) ");
metricas(simFire, "ATUAL (simulado)     ");

// furos da semana: o atual pegaria?
console.log("\n== OS 4 FUROS REAIS DA SEMANA ==");
for (const [id, oficinaTs, desc] of [
  [42676, null, "QA rejeitada (ter)"],
  [42908, null, "aguard. peças sem item (qua)"],
  [43397, null, "aguard. peças sem item (qui)"],
  [44130, null, "oficina cheia pré-diag (sex)"],
]) {
  const f = simFire.get(id);
  const of = oferta.get(id) ?? 0;
  console.log(`OS ${id} (${desc}): ${f ? `PEGARIA — ${f.regra} às ${new Date((f.ts - 3 * 3600) * 1000).toISOString().slice(5, 16)}` : "continuaria furo"}${of ? ` | oficina ${new Date((of - 3 * 3600) * 1000).toISOString().slice(5, 16)}` : ""}`);
}

// quebra por regra do simulado (com desfecho)
console.log("\n== ATUAL por regra (piso, casos com desfecho) ==");
const porRegra = {};
for (const id of ids) {
  const f = simFire.get(id);
  if (!f) continue;
  const e = estourou(id);
  if (e === null) continue;
  const r = (porRegra[f.regra] ||= { n: 0, ok: 0 });
  r.n++; if (e) r.ok++;
}
for (const [regra, v] of Object.entries(porRegra).sort((a, b) => b[1].n - a[1].n))
  console.log(`${regra.padEnd(22)} n=${String(v.n).padStart(3)}  acerto=${Math.round((100 * v.ok) / v.n)}%`);

// ── diff de capturas (corridas válidas) e perfil do excesso restante ──────────
const ganhou = [], perdeu = [];
for (const id of ids) {
  const of = oferta.get(id) ?? 0;
  if (!of || estourou(id) !== true) continue;
  const r = realFire.has(id), s = simFire.has(id);
  if (s && !r) ganhou.push(id);
  if (r && !s) perdeu.push(id);
}
console.log(`\ncapturas GANHAS pelo atual: ${ganhou.join(", ") || "-"} | PERDIDAS: ${perdeu.join(", ") || "-"}`);
const excFront = [];
for (const id of ids) {
  const f = simFire.get(id);
  if (!f) continue;
  if (estourou(id) === false && !(oferta.get(id) ?? 0)) excFront.push(`${id}(${f.regra}${f.conf === "fronteira" ? ",FRONTEIRA" : ""})`);
}
console.log(`excesso restante (${excFront.length}): ${excFront.join(" ")}`);
