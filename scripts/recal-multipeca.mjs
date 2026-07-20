// Recalibração MULTI-PEÇA: o modelo aditivo (base + Σ minutos-por-peça) superestima
// motos com muitas peças — o mecânico executa várias na mesma desmontagem.
// Este script MEDE o fator real por nº de peças e VALIDA out-of-sample um desconto
// f(n) aplicado à soma: tempo = BASE + f(n) × Σ(qtd × minutos-da-peça).
//
// Saída: tabela de fatores + comparação OOS (MAE e métrica de decisão @180)
// entre o modelo atual (f=1) e o corrigido. Rodar: node scripts/recal-multipeca.mjs

import { readFileSync } from "fs";
import { dirname as __dir, join as __join } from "path";
import { MINUTOS_POR_PECA, TEMPO_BASE_MIN, TEMPO_FALLBACK_MIN } from "../src/lib/tempo-pecas.ts";

const ROOT = __join(import.meta.dirname, "..");
const DL = process.env.METABASE_DIR || __join(ROOT, "data");

const flat = JSON.parse(readFileSync(__join(DL, "recal-multipeca-train.json"), "utf8"));
const tts = new Map(JSON.parse(readFileSync(__join(DL, "recal-timetargets.json"), "utf8"))
  .map((r) => [Number(r.igid), Number(r.time_target)]));

// minutos de uma peça: mapa calibrado → time_target → fallback (espelha o SQL)
function minutosPeca(igid) {
  const m = MINUTOS_POR_PECA[igid];
  if (m && m > 0) return m;
  const tt = tts.get(igid);
  if (tt && tt > 0) return tt;
  return TEMPO_FALLBACK_MIN;
}

// monta por-OS
const porOS = new Map();
for (const r of flat) {
  const id = Number(r.os_id);
  if (!porOS.has(id)) porOS.set(id, { dia: r.dia, rampa: Number(r.rampa_min), n: 0, partsum: 0 });
  const o = porOS.get(id);
  o.n += 1;
  o.partsum += Number(r.qty) * minutosPeca(Number(r.igid));
}
const oss = [...porOS.values()].filter((o) => o.partsum > 0);
console.log("OSs no dataset:", oss.length);

// split temporal: teste = últimos 14 dias
const dias = [...new Set(oss.map((o) => o.dia))].sort();
const corte = dias[dias.length - 14];
const train = oss.filter((o) => o.dia < corte);
const test = oss.filter((o) => o.dia >= corte);
console.log(`train: ${train.length} OSs (< ${corte}) | test: ${test.length} OSs`);

const med = (a) => { const v = [...a].sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : null; };
const bucket = (n) => Math.min(n, 8); // 8+ agrupado

// fator observado por bucket (train): f = (rampa - BASE) / partsum
console.log("\n== fator real por nº de peças (train) ==");
console.log("n_pecas | OSs | mediana f | mediana est_atual | mediana rampa real");
const fRaw = {};
for (let b = 1; b <= 8; b++) {
  const grp = train.filter((o) => bucket(o.n) === b);
  const fs = grp.map((o) => Math.max(0, o.rampa - TEMPO_BASE_MIN) / o.partsum);
  fRaw[b] = med(fs);
  console.log(
    `${String(b).padStart(2)}${b === 8 ? "+" : " "}     | ${String(grp.length).padStart(4)} | ${fRaw[b]?.toFixed(2) ?? "-"}      | ${med(grp.map((o) => TEMPO_BASE_MIN + o.partsum))}min | ${med(grp.map((o) => o.rampa))}min`
  );
}

// fatores finais: fiéis ao dado (SEM constrangimento de monotonia — o dado mostra
// que o modelo superestima OS PEQUENAS e acerta as grandes); cap 1.0 (nunca inflar,
// pra não piorar o lado dos furos), piso 0.2.
const F = {};
for (let b = 1; b <= 8; b++) {
  F[b] = Math.round(Math.min(1.0, Math.max(0.2, fRaw[b] ?? 1.0)) * 100) / 100;
}
console.log("\nfatores propostos f(n):", JSON.stringify(F));

// ── validação OOS (test) ─────────────────────────────────────────────────────
function avalia(nome, estFn) {
  const errs = [], conf = { tp: 0, fp: 0, fn: 0, tn: 0 };
  for (const o of test) {
    const est = estFn(o);
    errs.push(Math.abs(est - o.rampa));
    const realLonga = o.rampa > 180, estLonga = est > 180;
    if (realLonga && estLonga) conf.tp++;
    else if (!realLonga && estLonga) conf.fp++;
    else if (realLonga && !estLonga) conf.fn++;
    else conf.tn++;
  }
  const mae = errs.reduce((a, b) => a + b, 0) / errs.length;
  const recall = conf.tp / Math.max(1, conf.tp + conf.fn);
  const prec = conf.tp / Math.max(1, conf.tp + conf.fp);
  const acc = (conf.tp + conf.tn) / test.length;
  console.log(
    `${nome}: MAE ${mae.toFixed(1)}min | @180: acc ${(acc * 100).toFixed(1)}% recall ${(recall * 100).toFixed(0)}% prec ${(prec * 100).toFixed(0)}% (tp${conf.tp} fp${conf.fp} fn${conf.fn} tn${conf.tn})`
  );
  return { mae, recall, prec, acc };
}

console.log("\n== validação OUT-OF-SAMPLE (últimos 14 dias) ==");
const atual = avalia("ATUAL   (f=1)   ", (o) => TEMPO_BASE_MIN + o.partsum);
const novo = avalia("CORRIGIDO f(n)  ", (o) => TEMPO_BASE_MIN + F[bucket(o.n)] * o.partsum);

console.log("\nveredito: MAE " + (novo.mae < atual.mae ? "MELHOROU" : "piorou") +
  ` (${atual.mae.toFixed(1)} → ${novo.mae.toFixed(1)})` +
  ` | recall@180 ${(atual.recall * 100).toFixed(0)}% → ${(novo.recall * 100).toFixed(0)}%` +
  ` | precisão@180 ${(atual.prec * 100).toFixed(0)}% → ${(novo.prec * 100).toFixed(0)}%`);

// arrays pro SQL (transform)
console.log("\nSQL: transform(least(n,8), [1,2,3,4,5,6,7,8], [" +
  [1,2,3,4,5,6,7,8].map((b) => F[b]).join(",") + "], " + F[8] + ")");
