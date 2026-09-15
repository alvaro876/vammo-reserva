// E se o fator de bancada e o corte da conta fossem outros?
//
// Medido: a razão bancada_real/estimativa é 0,51 na mediana pra quem fica no prazo e 0,99 pra
// quem estoura. O motor aplica 0,67 pra todo mundo, então ENCURTA a projeção justo na população
// que precisa ser pega. Aqui se varre fator x corte e se mede o placar de cada combinação, com
// a régua do projeto: primeiro alerta de SLA por OS, 60+ min de folga, denominador único.

import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const argv = process.argv.slice(2);
const baseArg = argv.find((a) => a.startsWith("--base="));
const baseFiltro = baseArg ? Number(baseArg.split("=")[1]) : null;
const dias = argv.filter((a) => !a.startsWith("--"));
const LIMITE = 180, ANTEC = 60, QA = 14, MIN_RESTANTE = 30;

const out = join(mkdtempSync(join(tmpdir(), "vf-")), "r.mjs");
await build({
  entryPoints: ["src/lib/diario-replay.ts"],
  bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "warning",
  alias: { "@": "./src" },
  define: { "process.env.RIVERS_GUINCHO": '""', "process.env.RIVERS_REGRA_C4": '""',
            "process.env.RIVERS_REGRA_ESTOQUE": '""', "process.env.RIVERS_REGRA_RELOGIO": '""' },
});
const { estimativaEm, execAcumEm, statusEm, replay, TETO_REPLAY_MIN } = await import(`file://${out}`);

const RES = ["RESERVE_DELIVERED", "BIKE_REPLACED"];
const QA_ST = new Set(["AWAITING_QA", "IN_QA", "QA_REJECTED"]);

// carrega o universo uma vez
const motos = [];
for (const dia of dias) {
  const arq = `scripts/fixture/diario_${dia}.json`;
  if (!existsSync(arq)) continue;
  const f = JSON.parse(readFileSync(arq, "utf8"));
  for (const r of f.linhas) {
    if (baseFiltro !== null && r.base !== baseFiltro) continue;
    if (r.guincho === 1 || r.pronta_ts <= 0) continue;
    const temCliente = r.chamado_ts > 0 || r.ofertou === 1 || r.chamou === 1 || RES.includes(r.service_conclusion);
    if (!temCliente) continue;
    const dur = Math.round((r.pronta_ts - r.t0) / 60);
    const rp = replay(r, Math.min(TETO_REPLAY_MIN, dur));
    const outras = (rp.disparos || []).filter((d) => d.sla && d.regra !== "C3_CONTA_NAO_FECHA")
      .sort((a, b) => a.min - b.min)[0] ?? null;
    motos.push({ r, dia, dur, estourou: dur > LIMITE, outras });
  }
}
const estouros = motos.filter((m) => m.estourou).length;

// reexecuta SÓ a conta-não-fecha com outro fator e outro corte
function contaNaoFecha(m, fator, corte) {
  const { r, dur } = m;
  for (let min = 10; min <= Math.min(TETO_REPLAY_MIN, dur); min += 10) {
    const T = r.t0 + min * 60;
    const { status } = statusEm(r.evs, T);
    if (QA_ST.has(status)) continue;
    const piso = r.chamado_ts > 0 && r.chamado_ts <= T && (r.saiu_ts <= 0 || T < r.saiu_ts);
    if (!piso) continue;
    if (min >= 480) break;
    const est = estimativaEm(r.itens, T).est;
    if (est <= 0) continue;
    const restante = Math.max(0, est - execAcumEm(r.evs, T));
    const corrigido = Math.round(restante * fator);
    if (corrigido + QA < MIN_RESTANTE) continue;
    if (min + corrigido + QA > corte) return min;
  }
  return null;
}

const pad = (s, n) => String(s).padEnd(n);
const num = (s, n) => String(s).padStart(n);
console.log(`\n=== ${motos.length} motos no alvo, ${estouros} estouros · varrendo fator x corte ===\n`);
console.log(pad("fator", 7) + num("corte", 7) + num("alertas", 9) + num("certos", 8) + num("precisão", 10) + num("a tempo", 9) + num("alcance", 9));
console.log("─".repeat(59));

const metade = Math.ceil(dias.length / 2);
const diasA = new Set(dias.slice(0, metade)), diasB = new Set(dias.slice(metade));
function placar(sub, fator, corte) {
  let alertas = 0, certos = 0, aTempo = 0;
  const est = sub.filter((m) => m.estourou).length;
  for (const m of sub) {
    const minCNF = contaNaoFecha(m, fator, corte);
    const cands = [];
    if (minCNF !== null) cands.push(minCNF);
    if (m.outras) cands.push(m.outras.min);
    if (!cands.length) continue;
    const primeiro = Math.min(...cands);
    alertas++;
    if (m.estourou) { certos++; if (LIMITE - primeiro >= ANTEC) aTempo++; }
  }
  return { alertas, certos, aTempo, est,
           prec: alertas ? 100 * certos / alertas : 0, alc: est ? 100 * aTempo / est : 0 };
}
const subA = motos.filter((m) => diasA.has(m.dia)), subB = motos.filter((m) => diasB.has(m.dia));
console.log(`
PARTIDO POR DATA  A = ${[...diasA].join(", ")} (${subA.length} motos, ${subA.filter(m=>m.estourou).length} estouros)`);
console.log(`                  B = ${[...diasB].join(", ")} (${subB.length} motos, ${subB.filter(m=>m.estourou).length} estouros)
`);
console.log(pad("fator", 7) + num("corte", 7) + num("prec A", 9) + num("alc A", 8) + num("prec B", 9) + num("alc B", 8));
console.log("-".repeat(48));
for (const [fator, corte] of [[0.67,210],[0.80,230],[0.90,230],[0.67,200],[0.80,210],[0.80,200]]) {
  const a = placar(subA, fator, corte), b = placar(subB, fator, corte);
  console.log(pad(fator.toFixed(2), 7) + num(corte, 7) +
    num(a.prec.toFixed(1)+"%", 9) + num(a.alc.toFixed(1)+"%", 8) +
    num(b.prec.toFixed(1)+"%", 9) + num(b.alc.toFixed(1)+"%", 8) +
    ((fator===0.67&&corte===210) ? "  <- hoje" : ""));
}

for (const fator of [0.67, 0.8, 0.9, 1.0]) {
  for (const corte of [230, 210, 200, 190]) {
    let alertas = 0, certos = 0, aTempo = 0;
    for (const m of motos) {
      const minCNF = contaNaoFecha(m, fator, corte);
      const cands = [];
      if (minCNF !== null) cands.push(minCNF);
      if (m.outras) cands.push(m.outras.min);
      if (!cands.length) continue;
      const primeiro = Math.min(...cands);
      alertas++;
      if (m.estourou) { certos++; if (LIMITE - primeiro >= ANTEC) aTempo++; }
    }
    const marca = (fator === 0.67 && corte === 210) ? "  <- hoje" : "";
    console.log(pad(fator.toFixed(2), 7) + num(corte, 7) + num(alertas, 9) + num(certos, 8) +
      num((100 * certos / alertas).toFixed(1) + "%", 10) + num(aTempo, 9) +
      num((100 * aTempo / estouros).toFixed(1) + "%", 9) + marca);
  }
}
