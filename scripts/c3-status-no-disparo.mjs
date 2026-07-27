import { join as __join } from "path";
const ROOT = __join(import.meta.dirname, "..");
// Cruza os 78 casos C3 (legit × excesso) com o STATUS da OS no momento do disparo,
// pra testar: (H1) COMBINADO dispara errado quando a moto já passou da execução
// (restante superestimado); (H2) no ALTO a faixa est 121-140 é o problema.
// Também mede: tempo já gasto em execução até o disparo (desconto que a regra viu).

import { readFileSync } from "fs";

const casos = JSON.parse(readFileSync(ROOT + "\\calib\\c3-casos.json", "utf8"));
const DL = process.env.METABASE_DIR || "C:\\Users\\Usuário\\Downloads\\Metabase";
const eventos = JSON.parse(readFileSync(DL + "\\rivers-c3-status-events.json", "utf8"));

const porOS = new Map();
for (const e of eventos) {
  if (!porOS.has(e.os_id)) porOS.set(e.os_id, []);
  porOS.get(e.os_id).push(e);
}

const FASE = (s) =>
  ["OPEN"].includes(s) ? "1-aberta" :
  ["IN_DIAGNOSIS"].includes(s) ? "2-diagnostico" :
  ["AWAITING_MECHANIC"].includes(s) ? "3-fila" :
  ["IN_PROGRESS", "PAUSED"].includes(s) ? "4-execucao" :
  ["AWAITING_QA", "IN_QA", "QA_REJECTED"].includes(s) ? "5-qa" : "6-outra";

for (const c of casos) {
  const evs = (porOS.get(c.os) || []).filter((e) => e.ts * 1000 <= c.fire_ts);
  const atual = evs.length ? evs[evs.length - 1] : null;
  c.status_fire = atual ? atual.status : "?";
  c.fase = atual ? FASE(atual.status) : "?";
  // minutos de execução acumulados até o disparo (todos episódios IN_PROGRESS)
  let exec = 0, ini = null;
  for (const e of (porOS.get(c.os) || [])) {
    if (e.ts * 1000 > c.fire_ts) break;
    if (e.status === "IN_PROGRESS") { if (ini === null) ini = e.ts; }
    else if (ini !== null) { exec += (e.ts - ini) / 60; ini = null; }
  }
  if (ini !== null) exec += (c.fire_ts / 1000 - ini) / 60;
  c.exec_min = Math.round(exec);
}

for (const regra of ["C3_TEMPO_COMBINADO", "C3_TEMPO_ALTO"]) {
  console.log(`\n===== ${regra} — fase da OS no momento do disparo =====`);
  const cs = casos.filter((c) => c.regra === regra);
  const fases = [...new Set(cs.map((c) => c.fase))].sort();
  for (const f of fases) {
    const g = cs.filter((c) => c.fase === f);
    const ok = g.filter((c) => c.estourou).length;
    console.log(`${f.padEnd(15)} legit ${String(ok).padStart(2)} × excesso ${String(g.length - ok).padStart(2)}`);
  }
  const med = (a) => { const v = a.filter((x) => x != null).sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : null; };
  const ok = cs.filter((c) => c.estourou), exc = cs.filter((c) => !c.estourou);
  console.log(`exec já feita até o disparo (min): legit med=${med(ok.map((c) => c.exec_min))} × excesso med=${med(exc.map((c) => c.exec_min))}`);
}

// H2: precisão por faixa de est no ALTO
console.log("\n===== C3_TEMPO_ALTO — precisão por faixa de estimativa =====");
for (const [lo, hi] of [[121, 130], [131, 140], [141, 999]]) {
  const g = casos.filter((c) => c.regra === "C3_TEMPO_ALTO" && c.est >= lo && c.est <= hi);
  const ok = g.filter((c) => c.estourou).length;
  console.log(`est ${lo}-${hi === 999 ? "+" : hi}: ${ok}/${g.length} legit (${g.length ? Math.round((100 * ok) / g.length) : 0}%)`);
}

// H1 detalhe: COMBINADO em fase 5-qa — quanto tempo até ficar pronta após o disparo?
console.log("\n===== COMBINADO disparado na fase QA/execução — pronta quanto tempo depois? =====");
for (const c of casos.filter((c) => c.regra === "C3_TEMPO_COMBINADO" && (c.fase === "5-qa" || c.fase === "4-execucao"))) {
  const dep = c.pronta != null ? c.pronta - Math.round((c.fire_ts / 1000 - 0) / 60) : null; // aproximação abaixo
  console.log(`OS ${c.os} ${c.estourou ? "LEGIT  " : "EXCESSO"} fase=${c.fase} est=${c.est} exec_feita=${c.exec_min}min elapsed=${c.elapsed} pronta_total=${c.pronta ?? "aberta"}`);
}
