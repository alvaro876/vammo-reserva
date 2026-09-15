// O fator de bancada devia depender do TAMANHO do serviço?
//
// Medido: bancada_real / estimativa é 0,51 na mediana pra quem fica no prazo e 0,99 pra quem
// estoura. O motor usa 0,67 pra todo mundo. Aqui se mede a razão por NÚMERO DE PEÇAS, que é o
// sinal que o atendente usa (182 dos 285 casos que só ele pegou tinham motivo "serviço complexo").
// Se a razão crescer com o número de peças, o fator fixo é a fonte do erro.

import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const argv = process.argv.slice(2);
const baseArg = argv.find((a) => a.startsWith("--base="));
const baseFiltro = baseArg ? Number(baseArg.split("=")[1]) : null;
const dias = argv.filter((a) => !a.startsWith("--"));

const out = join(mkdtempSync(join(tmpdir(), "cf-")), "r.mjs");
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
    const { est, nPecas } = estimativaEm(r.itens, r.pronta_ts);
    const exec = execAcumEm(r.evs, r.pronta_ts);
    if (est <= 0 || exec <= 0 || nPecas <= 0) continue;
    const dur = Math.round((r.pronta_ts - r.t0) / 60);
    linhas.push({ nPecas, razao: exec / est, estouro: dur > 180 });
  }
}

const q = (v, p) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };
const FAIXAS = [[1, 2], [3, 4], [5, 6], [7, 8], [9, 99]];
console.log(`\n=== razão bancada real / estimativa, por nº de peças · ${linhas.length} motos ===\n`);
console.log("peças".padEnd(9) + "n".padStart(5) + "p50".padStart(8) + "p75".padStart(8) + "p90".padStart(8) + "  estouro");
console.log("─".repeat(48));
for (const [a, b] of FAIXAS) {
  const g = linhas.filter((x) => x.nPecas >= a && x.nPecas <= b);
  if (!g.length) continue;
  const rz = g.map((x) => x.razao);
  const rot = b === 99 ? `${a}+` : `${a} a ${b}`;
  console.log(rot.padEnd(9) + String(g.length).padStart(5) +
    q(rz, 0.5).toFixed(2).padStart(8) + q(rz, 0.75).toFixed(2).padStart(8) + q(rz, 0.9).toFixed(2).padStart(8) +
    ("  " + (100 * g.filter((x) => x.estouro).length / g.length).toFixed(0) + "%").padStart(9));
}
console.log(`\no motor usa 0,67 fixo. O p75 por faixa seria o fator honesto de quem a gente quer pegar:`);
console.log("  " + FAIXAS.map(([a, b]) => {
  const g = linhas.filter((x) => x.nPecas >= a && x.nPecas <= b);
  return g.length ? `${b === 99 ? a + "+" : a + "-" + b}: ${q(g.map((x) => x.razao), 0.75).toFixed(2)}` : "";
}).filter(Boolean).join("  ·  "));
