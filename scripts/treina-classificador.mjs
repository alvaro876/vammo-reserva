// FASE 3 — classificador logístico P(estourar 3h | estado da OS no instante t).
// Desenho Lyft/literatura de process monitoring: exemplos = prefixos (OS, t);
// treino/val/teste separados NO TEMPO; calibração Platt; corte escolhido pra
// precisão >= 0.85 na validação. Pesos exportados pra JSON (portável pro TS).
// Uso: node scripts/treina-classificador.mjs
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
const ROOT = join(import.meta.dirname, "..");
const DL = "C:\\Users\\Usuário\\Downloads\\Metabase";

const tp = readFileSync(join(ROOT, "src/lib/tempo-pecas.ts"), "utf8");
const MAPA = new Map();
for (const m of tp.slice(tp.indexOf("MINUTOS_POR_PECA")).matchAll(/(\d+):\s*(\d+)/g)) MAPA.set(+m[1], +m[2]);
const FATOR = [null, 1.39, 1.11, 1.04, 1.04, 1.0, 1.03, 0.95, 0.94];
const QA = new Set(["AWAITING_QA", "IN_QA", "QA_REJECTED"]);
const DIRECAO = new Set([229, 240, 340, 359, 228]);

const meta = JSON.parse(readFileSync(join(DL, "bt-meta.json"), "utf8"));
const status = JSON.parse(readFileSync(join(DL, "bt-status.json"), "utf8"));
const itens = JSON.parse(readFileSync(join(DL, "bt-itens.json"), "utf8"));
const OS = new Map();
for (const m of meta) OS.set(m.so_id, { ...m, ev: [], it: [] });
for (const s of status) OS.get(s.so_id)?.ev.push([+s.ts, s.status]);
for (const i of itens) OS.get(i.so_id)?.it.push([+i.ts, +i.ig, +i.qty, +i.tt]);
const AGORA = Math.floor(Date.now() / 1000);

for (const o of OS.values()) {
  o.ev.sort((a, b) => a[0] - b[0]); o.it.sort((a, b) => a[0] - b[0]);
  o.open = o.ev.find((e) => e[1] === "OPEN")?.[0] ?? 0;
  o.cx = o.ev.find((e) => e[1] === "AWAITING_CX")?.[0] ?? 0;
  o.cancel = o.ev.some((e) => e[1] === "CANCELLED");
}

function featuresEm(o, t) {
  let st = "OPEN", exec = 0, execIni = 0, emExec = false;
  for (const [ts, s] of o.ev) {
    if (ts > t) break;
    if (emExec && s !== "IN_PROGRESS") { exec += ts - execIni; emExec = false; }
    if (!emExec && s === "IN_PROGRESS") { emExec = true; execIni = ts; }
    st = s;
  }
  if (emExec) exec += t - execIni;
  let soma = 0; const grupos = new Set(); let dir = false;
  for (const [ts, ig, qty, tt] of o.it) {
    if (ts > t) break;
    soma += qty * (MAPA.get(ig) ?? (tt > 0 ? tt : 15));
    grupos.add(ig); if (DIRECAO.has(ig)) dir = true;
  }
  const n = grupos.size;
  const est = n > 0 ? soma * (FATOR[Math.min(n, 8)] ?? 0.94) + 25 : 0;
  const min = (t - o.open) / 60;
  const execMin = exec / 60;
  const restante = QA.has(st) ? 0 : Math.max(0, est - execMin);
  const hora = new Date((t - 3 * 3600) * 1000).getUTCHours();
  // ordem fixa — exportada junto com os pesos
  return [
    1,                                   // bias
    min / 180,
    est / 180,
    restante / 180,
    (min + restante + 8) / 180,          // projeção
    Math.min(n, 16) / 10,
    QA.has(st) ? 1 : 0,
    st === "OPEN" ? 1 : 0,
    st === "AWAITING_MECHANIC" ? 1 : 0,
    st === "IN_PROGRESS" ? 1 : 0,
    st === "AWAITING_PARTS" || st === "AWAITING_SERVICE" || st === "AWAITING_VMGMT" ? 1 : 0,
    o.modelo === "VMOTO CPX" ? 1 : 0,
    dir ? 1 : 0,
    o.so_type === "RETURN_INSPECTION" ? 1 : 0,
    hora >= 17 ? 1 : 0,
    est === 0 ? 1 : 0,                   // sem diagnóstico ainda
  ];
}
const NOMES = ["bias","min","est","restante","proj","n_pecas","emQa","open","awaitMec","inProg","parado","cpx","direcao","retorno","fimdia","semdiag"];

// prefixos: t = open+30, +45... até min(cx, open+300min), passo 15min
const treino = [], val = [], teste = [];
const T_VAL = AGORA - 14 * 86400, T_TESTE = AGORA - 6 * 86400;
for (const o of OS.values()) {
  if (!o.open || o.cancel) continue;
  const dur = o.cx > 0 ? (o.cx - o.open) / 60 : (AGORA - o.open) / 60;
  if (o.cx === 0 && dur < 180) continue;
  const blew = dur > 180 ? 1 : 0;
  const fim = Math.min(o.cx > 0 ? o.cx : AGORA, o.open + 300 * 60);
  for (let t = o.open + 30 * 60; t <= fim; t += 15 * 60) {
    const ex = { x: featuresEm(o, t), y: blew, os: o.so_id, t };
    if (o.open >= T_TESTE) teste.push(ex);
    else if (o.open >= T_VAL) val.push(ex);
    else treino.push(ex);
  }
}
console.log(`prefixos: treino ${treino.length} | val ${val.length} | teste ${teste.length}`);

// logística com L2, gradiente batch
const D = NOMES.length;
let w = new Array(D).fill(0);
const sig = (z) => 1 / (1 + Math.exp(-z));
const dot = (w, x) => { let s = 0; for (let i = 0; i < D; i++) s += w[i] * x[i]; return s; };
const L2 = 0.001, LR = 0.5, EPOCHS = 400;
for (let ep = 0; ep < EPOCHS; ep++) {
  const g = new Array(D).fill(0);
  for (const ex of treino) {
    const p = sig(dot(w, ex.x)); const err = p - ex.y;
    for (let i = 0; i < D; i++) g[i] += err * ex.x[i];
  }
  for (let i = 0; i < D; i++) w[i] -= (LR / treino.length) * (g[i] + L2 * treino.length * (i === 0 ? 0 : w[i]));
}

// Platt na validação (recalibra a saída com sigmoide a*z+b)
let a = 1, b = 0;
for (let ep = 0; ep < 300; ep++) {
  let ga = 0, gb = 0;
  for (const ex of val) {
    const z = dot(w, ex.x); const p = sig(a * z + b); const err = p - ex.y;
    ga += err * z; gb += err;
  }
  a -= (0.1 / val.length) * ga; b -= (0.1 / val.length) * gb;
}

// corte por OS (decisão = 1º instante com P>=corte): varre na VALIDAÇÃO
function scorePorOS(exs, corte) {
  const por = new Map();
  for (const ex of exs) {
    if (!por.has(ex.os)) por.set(ex.os, { y: ex.y, fired: false });
    const o = por.get(ex.os);
    if (!o.fired && sig(a * dot(w, ex.x) + b) >= corte) o.fired = true;
  }
  let tp = 0, fp = 0, blows = 0;
  for (const o of por.values()) { if (o.y) blows++; if (o.fired) { if (o.y) tp++; else fp++; } }
  return { tp, fp, blows, prec: tp / Math.max(1, tp + fp), rec: tp / Math.max(1, blows) };
}
console.log("\ncorte  VAL prec/rec        TESTE(5d) prec/rec");
let melhor = null;
for (const c of [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9]) {
  const v = scorePorOS(val, c), te = scorePorOS(teste, c);
  console.log(`${c.toFixed(2)}  ${(100 * v.prec).toFixed(1)}%/${(100 * v.rec).toFixed(1)}% (n=${v.tp + v.fp})   ${(100 * te.prec).toFixed(1)}%/${(100 * te.rec).toFixed(1)}% (n=${te.tp + te.fp})`);
  if (!melhor && v.prec >= 0.85) melhor = c;
}
console.log("\npesos:", NOMES.map((n, i) => `${n}=${w[i].toFixed(3)}`).join(" "));
console.log(`platt a=${a.toFixed(3)} b=${b.toFixed(3)} | corte escolhido (val>=85%): ${melhor}`);
writeFileSync(join(ROOT, "calib/classificador-v1.json"), JSON.stringify({ nomes: NOMES, w, platt: { a, b }, corte: melhor, treinado_em: new Date().toISOString(), n_treino: treino.length }, null, 1));
console.log("salvo em calib/classificador-v1.json");
