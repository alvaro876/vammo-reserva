// O que a semana vira com a C3_RELOGIO_150 desligada.
//
// Reexecuta o motor minuto a minuto sobre os dias fechados (o mesmo replay do /diario) e
// compara duas configurações: com a regra do relógio ligada (RIVERS_REGRA_RELOGIO=on) e
// desligada, que é o padrão a partir da v0.37. A pergunta não é "quantos alertas a menos",
// é "quantos avisos A TEMPO a menos" — alerta que chega sem folga não vira moto na mão de
// ninguém e não deveria contar como alcance.
//
//   node scripts/impacto-sem-relogio.mjs 2026-09-08 2026-09-09 ... --base=1

import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const argv = process.argv.slice(2);
const baseArg = argv.find((a) => a.startsWith("--base="));
const baseFiltro = baseArg ? Number(baseArg.split("=")[1]) : null;
const dias = argv.filter((a) => !a.startsWith("--"));

const LIMITE = 180, ANTEC = 60, ENTREGA = 30;

async function carrega(relogioLigada) {
  const out = join(mkdtempSync(join(tmpdir(), "impacto-")), "r.mjs");
  await build({
    entryPoints: ["src/lib/diario-replay.ts"],
    bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "warning",
    alias: { "@": "./src" },
    define: {
      "process.env.RIVERS_GUINCHO": '""',
      "process.env.RIVERS_REGRA_C4": '""',
      "process.env.RIVERS_REGRA_ESTOQUE": '""',
      "process.env.RIVERS_REGRA_RELOGIO": relogioLigada ? '"on"' : '""',
    },
  });
  return import(`file://${out}`);
}

function roda(mod, dias) {
  const { replay, TETO_REPLAY_MIN } = mod;
  const r = { motos: 0, estouros: 0, alertas: 0, aTempo: 0, comEntrega: 0, porRegra: new Map(), pegos: new Set() };
  for (const dia of dias) {
    const arq = `scripts/fixture/diario_${dia}.json`;
    if (!existsSync(arq)) continue;
    const f = JSON.parse(readFileSync(arq, "utf8"));
    for (const linha of f.linhas) {
      if (baseFiltro !== null && linha.base !== baseFiltro) continue;
      if (linha.guincho === 1) continue;
      const dur = linha.pronta_ts > 0 ? Math.round((linha.pronta_ts - linha.t0) / 60) : -1;
      if (dur < 0) continue;
      r.motos++;
      const estourou = dur > LIMITE;
      if (estourou) r.estouros++;
      const rp = replay(linha, Math.min(TETO_REPLAY_MIN, dur));
      const sla = (rp.disparos || []).filter((d) => d.sla).sort((a, b) => a.min - b.min)[0];
      if (!sla) continue;
      const folga = LIMITE - sla.min;
      r.alertas++;
      const e = r.porRegra.get(sla.regra) ?? { n: 0, folgas: [], certos: 0 };
      e.n++; e.folgas.push(folga); if (estourou) e.certos++;
      r.porRegra.set(sla.regra, e);
      if (folga >= ANTEC && estourou) { r.aTempo++; r.pegos.add(linha.os_id); }
      if (folga >= ENTREGA && estourou) r.comEntrega++;
    }
  }
  return r;
}

const med = (v) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };

const ligada = roda(await carrega(true), dias);
const desligada = roda(await carrega(false), dias);

const pad = (s, n) => String(s).padEnd(n);
const num = (s, n) => String(s).padStart(n);

console.log(`\n=== ${dias.length} dias${baseFiltro !== null ? `, base ${baseFiltro}` : ""}, ${ligada.motos} motos fechadas, ${ligada.estouros} passaram de 3h ===\n`);
console.log(`${pad("", 34)}${num("com relógio", 13)}${num("sem relógio", 13)}`);
console.log("─".repeat(60));
for (const [rot, a, b] of [
  ["alertas no total", ligada.alertas, desligada.alertas],
  ["pegos com 60+ min de folga", ligada.aTempo, desligada.aTempo],
  ["pegos com 30+ min (dá pra entregar)", ligada.comEntrega, desligada.comEntrega],
]) console.log(pad(rot, 34) + num(a, 13) + num(b, 13));

console.log(`\nregra                       alertas  certos  precisão  folga med`);
console.log("─".repeat(66));
for (const [regra, e] of [...desligada.porRegra.entries()].sort((a, b) => b[1].n - a[1].n))
  console.log(pad(regra, 26) + num(e.n, 8) + num(e.certos, 8) + num((100 * e.certos / e.n).toFixed(1) + "%", 10) + num(med(e.folgas) + " min", 11));

const perdidos = [...ligada.pegos].filter((x) => !desligada.pegos.has(x));
console.log(`\nmotos que eram pegas a tempo e deixam de ser: ${perdidos.length}`);
