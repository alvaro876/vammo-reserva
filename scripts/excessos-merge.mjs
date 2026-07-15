import { fileURLToPath as __furl } from "url";
const ROOT = __furl(new URL("..", import.meta.url)).replace(/[\\/]$/, "");
const DL = process.env.METABASE_DIR || (ROOT + "\\data");
// Junta: excessos (est. do algoritmo) + peças trocadas + tempo real de execução (rampa).
// Sai: calib/excessos-detalhe.csv (caso a caso) + agregados no console.

import { readFileSync, writeFileSync } from "fs";

const excessos = JSON.parse(readFileSync(ROOT + "\\calib\\excessos.json", "utf8"));
const pecasFlat = JSON.parse(readFileSync(DL + "\\excessos-pecas.json", "utf8"));
const rampa = new Map(JSON.parse(readFileSync(DL + "\\excessos-rampa.json", "utf8")).map((r) => [Number(r.os_id), Number(r.rampa_min)]));

// mapa calibrado (minutos por peça)
const ts = readFileSync(ROOT + "\\src\\lib\\tempo-pecas.ts", "utf8");
const BASE = Number(ts.match(/TEMPO_BASE_MIN = (\d+)/)[1]);
const mapa = {};
for (const m of ts.matchAll(/^\s{2}(\d+): (\d+),$/gm)) mapa[m[1]] = Number(m[2]);

const pecasPorOS = new Map();
for (const p of pecasFlat) {
  const id = Number(p.os_id);
  if (!pecasPorOS.has(id)) pecasPorOS.set(id, []);
  pecasPorOS.get(id).push(p);
}

// caso a caso
const linhas = [["os_id","placa","base","regra","est_algoritmo_min","rampa_real_min","pronta_real_min","n_pecas","pecas"]];
const casos = [];
for (const e of excessos) {
  const ps = pecasPorOS.get(e.os_id) ?? [];
  const pecasStr = ps.map((p) => `${p.peca} x${Math.round(p.qty)}`).join(" | ");
  const c = { ...e, rampa_real_min: rampa.get(e.os_id) ?? null, pecas: pecasStr };
  casos.push(c);
  linhas.push([e.os_id, e.placa, e.base, e.regra, e.est_algoritmo_min, c.rampa_real_min ?? "", e.pronta_real_min, ps.length, `"${pecasStr.replaceAll('"', "'")}"`]);
}
writeFileSync(ROOT + "\\calib\\excessos-detalhe.csv", linhas.map((l) => l.join(",")).join("\n"), "utf8");

const med = (a) => { const v = a.filter((x) => x != null && !isNaN(x)).sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : null; };

// agregado por regra: estimado vs executado vs pronta
console.log("== POR REGRA (medianas, min) ==");
console.log("regra | n | est.algoritmo | rampa real | pronta real");
const regras = [...new Set(casos.map((c) => c.regra))];
for (const r of regras) {
  const cs = casos.filter((c) => c.regra === r);
  console.log(`${r} | ${cs.length} | ${med(cs.map((c) => c.est_algoritmo_min))} | ${med(cs.map((c) => c.rampa_real_min))} | ${med(cs.map((c) => c.pronta_real_min))}`);
}

// os TEMPO_ALTO: estimado vs real (a pergunta do Marcelo)
const ta = casos.filter((c) => c.regra === "C3_TEMPO_ALTO" && c.rampa_real_min != null && c.est_algoritmo_min != null);
const ratios = ta.map((c) => c.est_algoritmo_min / Math.max(1, c.rampa_real_min)).sort((a, b) => a - b);
console.log(`\nTEMPO_ALTO: est/real mediano = ${ratios[Math.floor(ratios.length / 2)].toFixed(2)}x (n=${ta.length}) — >1 = superestima`);

// top peças nos excessos de TEMPO_ALTO (o que infla a estimativa)
const freq = new Map();
for (const c of casos.filter((x) => x.regra === "C3_TEMPO_ALTO")) {
  for (const p of (pecasPorOS.get(c.os_id) ?? [])) {
    const k = p.item_group_id;
    if (!freq.has(k)) freq.set(k, { peca: p.peca, n: 0, calib: mapa[k] ?? (Number(p.time_target) || 15) });
    freq.get(k).n++;
  }
}
console.log("\n== TOP 15 PEÇAS nos excessos de 'serviço longo' (n casos | min calibrados) ==");
for (const f of [...freq.values()].sort((a, b) => b.n - a.n).slice(0, 15))
  console.log(` ${String(f.n).padStart(3)}x | ${String(f.calib).padStart(3)}min | ${f.peca}`);

console.log("\nbase fixa por OS (intercepto):", BASE, "min");
console.log("CSV salvo em calib/excessos-detalhe.csv (", casos.length, "casos )");
