// "Como está pegando?" — o placar do motor sobre dias fechados, com a quebra fechando.
//
// Reexecuta o avaliarOS de produção minuto a minuto (o mesmo replay do /diario) com as regras
// de HOJE, e responde três perguntas em ordem: quantos clientes ficaram na mão, quantos o motor
// avisou, e de quem avisou, quantos deu tempo de entregar moto.
//
//   node scripts/como-ta-pegando.mjs 2026-09-08 ... --base=1

import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const argv = process.argv.slice(2);
const baseArg = argv.find((a) => a.startsWith("--base="));
const baseFiltro = baseArg ? Number(baseArg.split("=")[1]) : null;
const dias = argv.filter((a) => !a.startsWith("--"));

const LIMITE = 180, ANTEC = 60, ENTREGA = 30;

const out = join(mkdtempSync(join(tmpdir(), "pega-")), "r.mjs");
await build({
  entryPoints: ["src/lib/diario-replay.ts"],
  bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "warning",
  alias: { "@": "./src" },
  define: { "process.env.RIVERS_GUINCHO": '""', "process.env.RIVERS_REGRA_C4": '""',
            "process.env.RIVERS_REGRA_ESTOQUE": '""', "process.env.RIVERS_REGRA_RELOGIO": '""' },
});
const { replay, porQueNaoPegou, TETO_REPLAY_MIN } = await import(`file://${out}`);

const RES = ["RESERVE_DELIVERED", "BIKE_REPLACED"];
let motos = 0, foraDoAlvo = 0, estouros = 0, naMao = 0, deReserva = 0;
let alertas = 0, certos = 0, errados = 0, aTempo = 0, daTempoEntregar = 0, tarde = 0;
const porRegra = new Map(), motivos = new Map();

for (const dia of dias) {
  const arq = `scripts/fixture/diario_${dia}.json`;
  if (!existsSync(arq)) continue;
  const f = JSON.parse(readFileSync(arq, "utf8"));
  for (const r of f.linhas) {
    if (baseFiltro !== null && r.base !== baseFiltro) continue;
    const dur = r.pronta_ts > 0 ? Math.round((r.pronta_ts - r.t0) / 60) : -1;
    if (dur < 0) continue;                              // ainda aberta
    const temCliente = r.chamado_ts > 0 || r.ofertou === 1 || r.chamou === 1
      || RES.includes(r.service_conclusion);
    if (r.guincho === 1 || !temCliente) { if (dur > LIMITE) foraDoAlvo++; continue; }
    motos++;
    const estourou = dur > LIMITE;
    if (estourou) { estouros++; RES.includes(r.service_conclusion) ? deReserva++ : naMao++; }

    const rp = replay(r, Math.min(TETO_REPLAY_MIN, dur));
    const sla = (rp.disparos || []).filter((d) => d.sla).sort((a, b) => a.min - b.min)[0];
    if (sla) {
      const folga = LIMITE - sla.min;
      alertas++; estourou ? certos++ : errados++;
      if (estourou && folga >= ANTEC) aTempo++;
      else if (estourou && folga >= ENTREGA) daTempoEntregar++;
      else if (estourou) tarde++;
      const e = porRegra.get(sla.regra) ?? { n: 0, certos: 0, folgas: [] };
      e.n++; if (estourou) e.certos++; e.folgas.push(folga);
      porRegra.set(sla.regra, e);
    } else if (estourou) {
      const m = porQueNaoPegou(r, rp, { estourou: true, dur });
      const k = (m && (m.motivo || m.codigo)) || "SEM_MOTIVO";
      motivos.set(k, (motivos.get(k) ?? 0) + 1);
    }
  }
}

const med = (v) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const pad = (s, n) => String(s).padEnd(n);
const num = (s, n) => String(s).padStart(n);
const pc = (a, b) => b ? (100 * a / b).toFixed(1) + "%" : "—";

console.log(`\n=== ${dias.length} dias${baseFiltro !== null ? `, Mooca` : ""} · motor v0.37 (sem a regra do relógio) ===\n`);
console.log(`chegaram e fecharam no alvo: ${motos} motos  (+ ${foraDoAlvo} estouros fora do alvo: guincho ou sem cliente)`);
console.log(`estouros ${estouros} = ${naMao} ficaram na mão + ${deReserva} saíram de reserva`);
console.log("");
console.log(`alertas ${alertas} = ${certos} certos + ${errados} errados     precisão ${pc(certos, alertas)}`);
console.log(`dos ${certos} certos:`);
console.log(`   ${num(aTempo, 3)}  com 60+ min de folga        → alcance ${pc(aTempo, estouros)}`);
console.log(`   ${num(daTempoEntregar, 3)}  com 30 a 59 min             → ainda dá pra entregar`);
console.log(`   ${num(tarde, 3)}  com menos de 30 min         → não dá tempo`);
console.log(`   ${num(aTempo + daTempoEntregar + tarde, 3)}  soma`);
console.log(`\nútil de verdade (30+ min de folga): ${aTempo + daTempoEntregar} de ${estouros} estouros = ${pc(aTempo + daTempoEntregar, estouros)}`);

console.log(`\nregra                       alertas  certos  precisão  folga med`);
console.log("─".repeat(66));
for (const [regra, e] of [...porRegra.entries()].sort((a, b) => b[1].n - a[1].n))
  console.log(pad(regra, 26) + num(e.n, 8) + num(e.certos, 8) + num(pc(e.certos, e.n), 10) + num(med(e.folgas) + " min", 11));

const semAviso = [...motivos.values()].reduce((a, b) => a + b, 0);
console.log(`\nos ${semAviso} estouros que nenhuma regra pegou, e por quê:`);
for (const [k, v] of [...motivos.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${num(v, 3)}  ${k}`);
console.log(`\nconfere: ${certos} pegos + ${semAviso} sem aviso = ${certos + semAviso} de ${estouros} estouros`);
