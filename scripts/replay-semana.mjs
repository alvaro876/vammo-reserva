import { join as __join } from "path";
const ROOT = __join(import.meta.dirname, "..");
// REPLAY da semana 20-26/07 no universo piso (749 OSs): reconstrói, a cada tick de
// 10min, o que o motor via (peças registradas → estimativa, status, execução
// acumulada) e aplica as regras de tempo ANTIGAS (v0.5.x) e NOVAS (v0.6.0).
//
// - Regras não alteradas (C1_HARD/ANOMALIA/ESPERA, C2) entram como candidatos com o
//   horário REAL do log nas duas variantes.
// - Validação embutida: o replay-ANTIGO deve reproduzir o comportamento real do log
//   (mesmas OSs disparadas, horários próximos). Divergência alta = simulador ruim.
//
// Regras replayadas (algorithm.ts):
//   ALTO:      est(t) > TH                       (antigo TH=120, novo TH=140)
//   COMBINADO: est>0 && elapsed<480 && elapsed + restante + 8 > 180
//     restante antigo = status==IN_PROGRESS ? max(0, est - min_no_status) : est
//     restante novo   = max(0, est - exec_acum)
//   C4 fora (0 disparos piso na semana). Avaliação só em STATUSES_AVALIAVEIS e
//   janela de 7 dias da abertura (como o motor).

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
const mapaSrc = tpSrc.slice(tpSrc.indexOf("MINUTOS_POR_PECA"));
const MAPA = new Map();
for (const m of mapaSrc.matchAll(/(\d+):\s*([\d.]+)/g)) MAPA.set(Number(m[1]), Number(m[2]));
const FATOR = [null, 0.2, 0.42, 0.65, 0.91, 0.96, 1.0, 0.99, 1.0];
console.log(`mapa: ${MAPA.size} peças | base ${BASE} | fallback ${FALLBACK}`);

// ── dados ─────────────────────────────────────────────────────────────────────
const ids = new Set(JSON.parse(readFileSync(ROOT + "\\calib\\replay-ids.json", "utf8")));
const checkins = JSON.parse(readFileSync(DL + "\\rivers-semana-checkins.json", "utf8"));
const outcomes = new Map(JSON.parse(readFileSync(DL + "\\rivers-semana-outcomes.json", "utf8")).map((o) => [Number(o.so_id), o]));
const pecasAll = JSON.parse(readFileSync(DL + "\\rivers-replay-pecas.json", "utf8"));
const statusAll = JSON.parse(readFileSync(DL + "\\rivers-replay-status.json", "utf8"));

const pecas = new Map(), status = new Map();
for (const p of pecasAll) { if (!pecas.has(p.os_id)) pecas.set(p.os_id, []); pecas.get(p.os_id).push(p); }
for (const s of statusAll) { if (!status.has(s.os_id)) status.set(s.os_id, []); status.get(s.os_id).push(s); }

const oferta = new Map(); // os_id -> ofertada_ts (0 se não)
for (const c of checkins) {
  if (["NO_SHOW", "CANCELLED", "DROPOUT"].includes(c.checkin_status)) continue;
  if (c.motivo === "awaiting_special_service") continue;
  oferta.set(Number(c.os_id), Number(c.ofertada_ts) || Number(c.entregue_ts) || 0);
}

// log real: 1ª RESERVA por OS (verdade do ANTIGO) + candidatos das regras não-alteradas
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY };
const sugg = [];
for (let from = 0; ; from += 1000) {
  const r = await fetch(
    `${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rivers_suggestion?select=os_id,fired_layer,created_at&decision=eq.RESERVA&created_at=gte.2026-07-10&order=created_at.asc,id.asc`,
    { headers: { ...H, Range: `${from}-${from + 999}` } }
  );
  const page = await r.json();
  if (!Array.isArray(page)) throw new Error("supabase: " + JSON.stringify(page).slice(0, 150));
  sugg.push(...page);
  if (page.length < 1000) break;
}
const realFire = new Map();   // 1ª RESERVA real (qualquer regra)
const externo = new Map();    // 1ª RESERVA real de regra NÃO-alterada (candidato nas 2 variantes)
const NAO_ALTERADAS = new Set(["C1_HARD", "C1_ANOMALIA", "C1_ESPERA_SEM_DIAG", "C2_SEM_ESTOQUE"]);
for (const s of sugg) {
  const id = Number(s.os_id);
  if (!ids.has(id)) continue;
  const ts = Date.parse(s.created_at) / 1000;
  if (!realFire.has(id)) realFire.set(id, { ts, regra: s.fired_layer });
  if (NAO_ALTERADAS.has(s.fired_layer) && !externo.has(id)) externo.set(id, { ts, regra: s.fired_layer });
}

// ── replay por OS ─────────────────────────────────────────────────────────────
const AVALIAVEIS = new Set(["OPEN", "IN_DIAGNOSIS", "AWAITING_MECHANIC", "IN_PROGRESS", "PAUSED", "AWAITING_VMGMT"]);
const AGORA = Date.now() / 1000;
const TICK = 600, JANELA_7D = 7.5 * 86400;

function estimativa(parts, t) {
  const vis = parts.filter((p) => p.ts <= t && (!p.del_ts || p.del_ts > t));
  if (!vis.length) return 0;
  const igs = new Set(vis.map((p) => p.ig));
  let soma = 0;
  for (const p of vis) {
    const min = MAPA.get(p.ig) || Number(p.time_target) || FALLBACK;
    soma += Number(p.qty) * min;
  }
  return Math.round(soma * FATOR[Math.min(igs.size, 8)] + BASE);
}

function replayOS(id, variante) {
  const evs = status.get(id) || [];
  if (!evs.length) return null;
  const open = evs[0].ts;
  const parts = pecas.get(id) || [];
  const fimAtivo = Math.min(AGORA, open + JANELA_7D);
  const ext = externo.get(id);
  const TH = variante === "novo" ? 140 : 120;

  for (let t = Math.ceil(open / TICK) * TICK; t <= fimAtivo; t += TICK) {
    if (ext && ext.ts <= t) return { ts: ext.ts, regra: ext.regra }; // regra não-alterada disparou antes
    // status e execução acumulada em t
    let st = null, exec = 0, ini = null, lastTs = open;
    for (const e of evs) {
      if (e.ts > t) break;
      if (ini !== null) { exec += (e.ts - ini) / 60; ini = null; }
      if (e.status === "IN_PROGRESS") ini = e.ts;
      st = e.status; lastTs = e.ts;
    }
    if (ini !== null) exec += (t - ini) / 60;
    if (!st || !AVALIAVEIS.has(st)) continue;

    const elapsed = (t - open) / 60;
    const est = estimativa(parts, t);
    if (est > TH) return { ts: t, regra: "C3_TEMPO_ALTO" };
    if (est > 0 && elapsed < 480) {
      const minNoStatus = (t - lastTs) / 60;
      const restante = variante === "novo"
        ? Math.max(0, est - exec)
        : (st === "IN_PROGRESS" ? Math.max(0, est - minNoStatus) : est);
      if (elapsed + restante + 8 > 180) return { ts: t, regra: "C3_TEMPO_COMBINADO" };
    }
  }
  if (ext && ext.ts <= fimAtivo) return { ts: ext.ts, regra: ext.regra };
  return null;
}

function estourou(id) {
  const o = outcomes.get(id);
  if (!o || !o.open_ts || o.cancel_ts > 0) return null;
  if (o.ready_ts > 0) return (o.ready_ts - o.open_ts) / 60 > 180;
  return (AGORA - o.open_ts) / 60 > 180 ? true : null;
}

function metricas(fires, nome) {
  let sug = 0, exc = 0, capt = 0, antes = 0, atrasos = [], avisados = 0, estourosSemOferta = 0;
  for (const id of ids) {
    const f = fires.get(id);
    const of = oferta.get(id) ?? 0;
    const e = estourou(id);
    if (f) sug++;
    if (f && e === false && !of) exc++;
    if (of && e === true) { // oferta válida (corrida real)
      if (f) {
        capt++;
        const d = Math.round((of - f.ts) / 60);
        if (d > 0) antes++; else atrasos.push(-d);
      }
    }
    if (!of && e === true) { estourosSemOferta++; if (f) avisados++; }
  }
  atrasos.sort((a, b) => a - b);
  console.log(`${nome}: sugestões ${sug} | excesso ${exc} | capturas ${capt} | RIVERS antes ${antes} | atraso med ${atrasos[Math.floor(atrasos.length / 2)] ?? "-"}min | estouros s/ oferta avisados ${avisados}/${estourosSemOferta}`);
  return { sug, exc, capt, antes };
}

// variantes
const fireAntigoReplay = new Map(), fireNovo = new Map();
for (const id of ids) {
  const a = replayOS(id, "antigo"); if (a) fireAntigoReplay.set(id, a);
  const n = replayOS(id, "novo"); if (n) fireNovo.set(id, n);
}

// ── fidelidade: replay-antigo × log real ─────────────────────────────────────
let ambos = 0, soReplay = 0, soReal = 0; const deltas = [];
for (const id of ids) {
  const r = realFire.get(id), s = fireAntigoReplay.get(id);
  if (r && s) { ambos++; deltas.push(Math.round((s.ts - r.ts) / 60)); }
  else if (s) soReplay++;
  else if (r) soReal++;
}
deltas.sort((a, b) => a - b);
console.log(`\n== FIDELIDADE (replay-antigo × log real) ==`);
console.log(`ambos ${ambos} | só replay ${soReplay} | só log ${soReal} | delta de horário mediano ${deltas[Math.floor(deltas.length / 2)] ?? "-"}min (p10 ${deltas[Math.floor(deltas.length * 0.1)] ?? "-"} / p90 ${deltas[Math.floor(deltas.length * 0.9)] ?? "-"})`);

console.log(`\n== MÉTRICAS (universo piso ${ids.size} OSs, semana 20-26) ==`);
const real = metricas(realFire, "ANTIGO (log real)     ");
metricas(fireAntigoReplay, "ANTIGO (replay)       ");
const novo = metricas(fireNovo, "NOVO v0.6.0 (replay)  ");

// capturas perdidas / excessos mortos: novo × real
const perdidas = [], mortas = [], atrasadas = [];
for (const id of ids) {
  const r = realFire.get(id), n = fireNovo.get(id);
  const e = estourou(id); const of = oferta.get(id) ?? 0;
  if (r && !n && e === true) perdidas.push(id);
  if (r && !n && e === false && !of) mortas.push(id);
  if (r && n && e === true && n.ts - r.ts > 900) atrasadas.push({ id, min: Math.round((n.ts - r.ts) / 60) });
}
console.log(`\nnovo × antigo-real: excessos eliminados ${mortas.length} | capturas de estouro perdidas ${perdidas.length} ${perdidas.length ? "(" + perdidas.join(",") + ")" : ""}`);
console.log(`avisos de estouro que atrasam >15min: ${atrasadas.length}`, atrasadas.map((a) => `${a.id}+${a.min}m`).join(" "));
