// Testa candidatas de regra PELO MOTOR DE VERDADE, usando o slot RIVERS_REGRA_EXP.
//
// Por que existe: a primeira varredura foi feita numa reimplementação por fora e prometeu +30
// clientes salvos que não existiam. A reimplementação ignorava a janela do cron (7h–21h), a lista
// de status avaliáveis e as exclusões do piso. Aqui cada candidata entra no slot experimental do
// próprio algorithm.ts, passa pela cascata inteira e pelas mesmas travas, e o ganho sai marginal
// por construção, porque o slot fica depois de todas as regras de reserva.
//
// Régua: primeiro alerta de SLA por OS, 60+ min de folga conta como salvo, denominador único
// (estouros com cliente na base, sem guincho). Partição por data em tudo.
//
//   node scripts/testa-candidatas.mjs --base=1 2026-08-11 ...

import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const argv = process.argv.slice(2);
const baseFiltro = Number((argv.find((a) => a.startsWith("--base=")) ?? "--base=1").split("=")[1]);
const dias = argv.filter((a) => !a.startsWith("--")).sort();
const LIMITE = 180, ANTEC = 60;
const RES = ["RESERVE_DELIVERED", "BIKE_REPLACED"];

const CANDIDATAS = [
  "",                                              // baseline, o motor como está
  "piso,status_pre,relogio>=100",
  "piso,status_pre,relogio>=110",
  "piso,status_pre,parado>=45",
  "piso,status_pre,parado>=60",
  "piso,fora_qa,parado>=60,relogio>=90",
  "piso,fora_qa,conta>=215,relogio>=90",
  "piso,fora_qa,conta>=200,relogio>=110",
  "piso,fora_qa,est>=160,relogio>=90",
  "piso,fora_qa,pecas>=8,relogio>=90",
  "piso,fora_qa,exec<=5,relogio>=100",
  "piso,fora_qa,restante>=60,relogio>=100",
];

const linhasPorDia = new Map();
for (const dia of dias) {
  const arq = `scripts/fixture/diario_${dia}.json`;
  if (!existsSync(arq)) continue;
  const f = JSON.parse(readFileSync(arq, "utf8"));
  if (!f.linhas || !f.linhas.length) continue;
  linhasPorDia.set(dia, f.linhas.filter((r) =>
    r.base === baseFiltro && r.guincho !== 1 && r.pronta_ts > 0 &&
    (r.chamado_ts > 0 || r.ofertou === 1 || r.chamou === 1 || RES.includes(r.service_conclusion))));
}
const diasComDado = [...linhasPorDia.keys()].sort();
const corte = diasComDado[Math.floor(diasComDado.length / 2)];

async function medir(spec) {
  const out = join(mkdtempSync(join(tmpdir(), "cand-")), "r.mjs");
  await build({
    entryPoints: ["src/lib/diario-replay.ts"],
    bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "error",
    alias: { "@": "./src" },
    define: {
      "process.env.RIVERS_GUINCHO": '""', "process.env.RIVERS_REGRA_C4": '""',
      "process.env.RIVERS_REGRA_ESTOQUE": '""', "process.env.RIVERS_REGRA_RELOGIO": '""',
      "process.env.RIVERS_REGRA_EXP": JSON.stringify(spec),
    },
  });
  const { replay, TETO_REPLAY_MIN } = await import(`file://${out}?v=${encodeURIComponent(spec)}`);
  const acc = { A: novo(), B: novo(), T: novo() };
  for (const dia of diasComDado) {
    const meio = dia < corte ? "A" : "B";
    for (const r of linhasPorDia.get(dia)) {
      const dur = Math.round((r.pronta_ts - r.t0) / 60);
      const estourou = dur > LIMITE;
      const rp = replay(r, Math.min(TETO_REPLAY_MIN, dur));
      const sla = (rp.disparos || []).filter((d) => d.sla).sort((a, b) => a.min - b.min)[0] ?? null;
      for (const k of [meio, "T"]) {
        const a = acc[k];
        if (estourou) a.est++;
        if (!sla) continue;
        a.alertas++;
        if (estourou) { a.certos++; if (LIMITE - sla.min >= ANTEC) a.salvos++; }
        if (sla.regra === "C3_EXPERIMENTAL") a.doSlot++;
      }
    }
  }
  return acc;
}
function novo() { return { alertas: 0, certos: 0, salvos: 0, est: 0, doSlot: 0 }; }
const prec = (a) => (a.alertas ? 100 * a.certos / a.alertas : 0);
const alc = (a) => (a.est ? 100 * a.salvos / a.est : 0);

const pad = (s, n) => String(s).padEnd(n), p2 = (s, n) => String(s).padStart(n);
const base = await medir("");
console.log(`\n=== ${base.T.est} estouros · ${diasComDado.length} dias · base ${baseFiltro} ===`);
console.log(`partição: A até ${corte}, B de ${corte} em diante\n`);
console.log(pad("candidata (entra DEPOIS de todas)", 40) + p2("alertas", 9) + p2("precisão", 10) +
  p2("salvos", 8) + p2("alcance", 9) + p2("do slot", 9) + p2("prec A", 8) + p2("prec B", 8));
console.log("─".repeat(101));
console.log(pad("hoje (v0.37.1)", 40) + p2(base.T.alertas, 9) + p2(prec(base.T).toFixed(1) + "%", 10) +
  p2(base.T.salvos, 8) + p2(alc(base.T).toFixed(1) + "%", 9) + p2("-", 9) +
  p2(prec(base.A).toFixed(0) + "%", 8) + p2(prec(base.B).toFixed(0) + "%", 8));

for (const spec of CANDIDATAS.slice(1)) {
  const a = await medir(spec);
  const dS = a.T.salvos - base.T.salvos, dP = prec(a.T) - prec(base.T);
  console.log(pad(spec, 40) + p2(a.T.alertas, 9) + p2(prec(a.T).toFixed(1) + "%", 10) +
    p2(a.T.salvos, 8) + p2(alc(a.T).toFixed(1) + "%", 9) + p2(a.T.doSlot, 9) +
    p2(prec(a.A).toFixed(0) + "%", 8) + p2(prec(a.B).toFixed(0) + "%", 8) +
    `   ${dS >= 0 ? "+" : ""}${dS} salvos, ${dP >= 0 ? "+" : ""}${dP.toFixed(1)}pp`);
}
