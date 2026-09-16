// A C3_SEM_EXECUCAO_90 dispara aos 90 min pra moto que ainda não entrou na bancada.
// Ela é a regra mais fraca do conjunto: 9 alertas, 5 certos, 55,6%.
// Hipótese a testar: esperar até 110 min corta o falso positivo sem perder estouro, porque a moto
// que entra na bancada entre 90 e 110 ainda tem tempo, e a que continua parada aos 110 não tem.
// Varre o limiar e mede o efeito NO CONJUNTO, que é o que importa: regra isolada engana.

import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const argv = process.argv.slice(2);
const baseFiltro = Number((argv.find((a) => a.startsWith("--base=")) ?? "--base=1").split("=")[1]);
const dias = argv.filter((a) => !a.startsWith("--"));
const LIMITE = 180, ANTEC = 60, TETO_AVISO = 120;
const PRE_EXEC = new Set(["OPEN", "IN_DIAGNOSIS", "AWAITING_MECHANIC", "AWAITING_PARTS", "PAUSED"]);
const QA_ST = new Set(["AWAITING_QA", "IN_QA", "QA_REJECTED"]);

const out = join(mkdtempSync(join(tmpdir(), "se-")), "r.mjs");
await build({
  entryPoints: ["src/lib/diario-replay.ts"],
  bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "warning",
  alias: { "@": "./src" },
  define: { "process.env.RIVERS_GUINCHO": '""', "process.env.RIVERS_REGRA_C4": '""',
            "process.env.RIVERS_REGRA_ESTOQUE": '""', "process.env.RIVERS_REGRA_RELOGIO": '""' },
});
const { replay, statusEm, execAcumEm, TETO_REPLAY_MIN } = await import(`file://${out}`);

const RES = ["RESERVE_DELIVERED", "BIKE_REPLACED"];
const motos = [];
for (const dia of dias) {
  const arq = `scripts/fixture/diario_${dia}.json`;
  if (!existsSync(arq)) continue;
  for (const r of JSON.parse(readFileSync(arq, "utf8")).linhas) {
    if (r.base !== baseFiltro || r.guincho === 1 || r.pronta_ts <= 0) continue;
    const temCliente = r.chamado_ts > 0 || r.ofertou === 1 || r.chamou === 1 || RES.includes(r.service_conclusion);
    if (!temCliente) continue;
    const dur = Math.round((r.pronta_ts - r.t0) / 60);
    const rp = replay(r, Math.min(TETO_REPLAY_MIN, dur));
    const sla = (rp.disparos || []).filter((d) => d.sla);
    motos.push({ r, dia, dur, estourou: dur > LIMITE,
      outras: sla.filter((d) => d.regra !== "C3_SEM_EXECUCAO_90").sort((a, b) => a.min - b.min)[0] ?? null });
  }
}
const estouros = motos.filter((m) => m.estourou).length;

function semExecucao(m, limiar) {
  const { r, dur } = m;
  for (let min = 10; min <= Math.min(TETO_REPLAY_MIN, dur); min += 10) {
    if (min < limiar) continue;
    const T = r.t0 + min * 60;
    const { status } = statusEm(r.evs, T);
    if (QA_ST.has(status) || !PRE_EXEC.has(status)) continue;
    const piso = r.chamado_ts > 0 && r.chamado_ts <= T && (r.saiu_ts <= 0 || T < r.saiu_ts);
    if (!piso) continue;
    return min;
  }
  return null;
}

function placar(sub, limiar, calaDepoisDe120) {
  let alertas = 0, certos = 0, aTempo = 0, seA = 0, seC = 0;
  const est = sub.filter((m) => m.estourou).length;
  for (const m of sub) {
    const se = semExecucao(m, limiar);
    const cands = [];
    if (se !== null) cands.push(se);
    if (m.outras) cands.push(m.outras.min);
    let min = cands.length ? Math.min(...cands) : null;
    if (min !== null && calaDepoisDe120 && min > TETO_AVISO) min = null;
    if (min === null) continue;
    alertas++;
    if (m.estourou) { certos++; if (LIMITE - min >= ANTEC) aTempo++; }
    if (se !== null && se === min) { seA++; if (m.estourou) seC++; }
  }
  return { alertas, certos, aTempo, est, seA, seC,
           prec: alertas ? 100 * certos / alertas : 0, alc: est ? 100 * aTempo / est : 0 };
}

const metade = Math.ceil(dias.length / 2);
const A = new Set(dias.slice(0, metade)), B = new Set(dias.slice(metade));
const subA = motos.filter((m) => A.has(m.dia)), subB = motos.filter((m) => B.has(m.dia));
const pad = (s, n) => String(s).padEnd(n); const num = (s, n) => String(s).padStart(n);

console.log(`\n=== ${motos.length} motos, ${estouros} estouros · efeito NO CONJUNTO ===\n`);
console.log(pad("configuração", 30) + num("alertas", 8) + num("precisão", 10) + num("a tempo", 9) + num("alcance", 9) + num("prec A", 8) + num("prec B", 8));
console.log("─".repeat(82));
for (const [lim, cala, rot] of [
  [90, false, "hoje: 90 min"],
  [90, true,  "90 min + cala após 120"],
  [100, true, "100 min + cala após 120"],
  [110, true, "110 min + cala após 120"],
  [120, true, "120 min + cala após 120"],
]) {
  const t = placar(motos, lim, cala), a = placar(subA, lim, cala), b = placar(subB, lim, cala);
  console.log(pad(rot, 30) + num(t.alertas, 8) + num(t.prec.toFixed(1) + "%", 10) + num(t.aTempo, 9) +
    num(t.alc.toFixed(1) + "%", 9) + num(a.prec.toFixed(0) + "%", 8) + num(b.prec.toFixed(0) + "%", 8) +
    `   (a regra sozinha: ${t.seC}/${t.seA})`);
}
