// O fator de bancada (0,67) vale pra quem estoura?
//
// O motor corrige o restante de execução multiplicando por 0,67: assume que a bancada entrega
// mais rápido que a estimativa. Na média está certo. A pergunta é se vale na CAUDA, que é
// justamente a população que estoura. Se na cauda a bancada leva MAIS que o estimado, o 0,67
// empurra a projeção pra baixo exatamente nos casos que a gente precisa pegar.

import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const argv = process.argv.slice(2);
const baseArg = argv.find((a) => a.startsWith("--base="));
const baseFiltro = baseArg ? Number(baseArg.split("=")[1]) : null;
const dias = argv.filter((a) => !a.startsWith("--"));
const LIMITE = 180;

const out = join(mkdtempSync(join(tmpdir(), "fb-")), "r.mjs");
await build({
  entryPoints: ["src/lib/diario-replay.ts"],
  bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "warning",
  alias: { "@": "./src" },
  define: { "process.env.RIVERS_GUINCHO": '""', "process.env.RIVERS_REGRA_C4": '""',
            "process.env.RIVERS_REGRA_ESTOQUE": '""', "process.env.RIVERS_REGRA_RELOGIO": '""' },
});
const { estimativaEm, execAcumEm } = await import(`file://${out}`);

const linhas = [];
for (const dia of dias) {
  const arq = `scripts/fixture/diario_${dia}.json`;
  if (!existsSync(arq)) continue;
  for (const r of JSON.parse(readFileSync(arq, "utf8")).linhas) {
    if (baseFiltro !== null && r.base !== baseFiltro) continue;
    if (r.guincho === 1 || r.pronta_ts <= 0) continue;
    const dur = Math.round((r.pronta_ts - r.t0) / 60);
    const execReal = execAcumEm(r.evs, r.pronta_ts);          // bancada de verdade
    const estFim = estimativaEm(r.itens, r.pronta_ts).est;     // estimativa com todas as peças
    if (estFim <= 0 || execReal <= 0) continue;
    linhas.push({ placa: r.placa, dur, estouro: dur > LIMITE, execReal, estFim, razao: execReal / estFim });
  }
}

const q = (v, p) => { const s = [...v].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const fmt = (x) => x.toFixed(2);
const grupo = (nome, arr) => {
  const rz = arr.map((x) => x.razao);
  console.log(
    nome.padEnd(22) + String(arr.length).padStart(5) +
    fmt(q(rz, 0.25)).padStart(9) + fmt(q(rz, 0.50)).padStart(9) +
    fmt(q(rz, 0.75)).padStart(9) + fmt(q(rz, 0.90)).padStart(9) +
    (100 * arr.filter((x) => x.razao > 1).length / arr.length).toFixed(0).padStart(9) + "%"
  );
};

console.log(`\n=== bancada real dividida pela estimativa · ${linhas.length} motos ===\n`);
console.log("grupo".padEnd(22) + "n".padStart(5) + "p25".padStart(9) + "mediana".padStart(9) + "p75".padStart(9) + "p90".padStart(9) + "acima de 1".padStart(10));
console.log("─".repeat(72));
grupo("todas", linhas);
grupo("ficou no prazo", linhas.filter((x) => !x.estouro));
grupo("passou de 3h", linhas.filter((x) => x.estouro));

console.log(`\no motor usa fator_bancada = 0,67 pra TODAS.`);
const est = linhas.filter((x) => x.estouro);
console.log(`nos ${est.length} que passaram de 3h, ${est.filter((x) => x.razao > 0.67).length} tiveram bancada acima de 0,67 da estimativa`);
console.log(`e ${est.filter((x) => x.razao > 1).length} levaram MAIS tempo que a estimativa inteira.`);

console.log(`\nos 10 casos em que a bancada mais passou da estimativa:`);
for (const x of [...linhas].sort((a, b) => b.razao - a.razao).slice(0, 10))
  console.log(`  ${x.placa}  estimado ${String(x.estFim).padStart(4)}min  bancada ${String(x.execReal).padStart(4)}min  razão ${fmt(x.razao).padStart(5)}  ficou ${x.dur}min${x.estouro ? "  (estourou)" : ""}`);
