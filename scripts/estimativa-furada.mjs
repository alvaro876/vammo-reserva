// A moto que já furou a própria estimativa: quantas são, e o motor avisa?
//
// `restanteParaPronta` devolve null quando exec_acum já passou da estimativa (tipo "vencida"),
// e o cron trata null como "não dá pra prever" e não emite pré-aviso. Ou seja: a moto que já
// provou que a estimativa estava errada é exatamente a que sai do radar. Aqui se mede quantas
// são, quantas estouram, e em que minuto o furo já era visível.

import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const argv = process.argv.slice(2);
const baseArg = argv.find((a) => a.startsWith("--base="));
const baseFiltro = baseArg ? Number(baseArg.split("=")[1]) : null;
const dias = argv.filter((a) => !a.startsWith("--"));
const LIMITE = 180, ANTEC = 60;

const out = join(mkdtempSync(join(tmpdir(), "ef-")), "r.mjs");
await build({
  entryPoints: ["src/lib/diario-replay.ts"],
  bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "warning",
  alias: { "@": "./src" },
  define: { "process.env.RIVERS_GUINCHO": '""', "process.env.RIVERS_REGRA_C4": '""',
            "process.env.RIVERS_REGRA_ESTOQUE": '""', "process.env.RIVERS_REGRA_RELOGIO": '""' },
});
const { estimativaEm, execAcumEm, statusEm, replay, TETO_REPLAY_MIN } = await import(`file://${out}`);

const RES = ["RESERVE_DELIVERED", "BIKE_REPLACED"];
let estouros = 0, furadas = 0, furadasEstouro = 0, pegasATempo = 0, furadasPegas = 0;
const minutoDoFuro = [];
const casos = [];

for (const dia of dias) {
  const arq = `scripts/fixture/diario_${dia}.json`;
  if (!existsSync(arq)) continue;
  for (const r of JSON.parse(readFileSync(arq, "utf8")).linhas) {
    if (baseFiltro !== null && r.base !== baseFiltro) continue;
    if (r.guincho === 1 || r.pronta_ts <= 0) continue;
    const temCliente = r.chamado_ts > 0 || r.ofertou === 1 || r.chamou === 1 || RES.includes(r.service_conclusion);
    if (!temCliente) continue;
    const dur = Math.round((r.pronta_ts - r.t0) / 60);
    const estourou = dur > LIMITE;
    if (estourou) estouros++;

    // em que minuto a execução acumulada passou da estimativa daquele instante?
    let furoEm = null;
    for (let m = 10; m <= Math.min(TETO_REPLAY_MIN, dur); m += 10) {
      const T = r.t0 + m * 60;
      const est = estimativaEm(r.itens, T).est;
      const exec = execAcumEm(r.evs, T);
      if (est > 0 && exec > est) { furoEm = m; break; }
    }
    const rp = replay(r, Math.min(TETO_REPLAY_MIN, dur));
    const sla = (rp.disparos || []).filter((d) => d.sla).sort((a, b) => a.min - b.min)[0];
    const aTempo = sla && (LIMITE - sla.min) >= ANTEC;
    if (estourou && aTempo) pegasATempo++;

    if (furoEm !== null) {
      furadas++;
      if (estourou) {
        furadasEstouro++;
        minutoDoFuro.push(furoEm);
        if (aTempo) furadasPegas++;
        else casos.push({ placa: r.placa, dur, furoEm, regra: sla ? sla.regra : null,
                          folga: sla ? LIMITE - sla.min : null });
      }
    }
  }
}

const med = (v) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
console.log(`\n=== a moto que furou a própria estimativa ===\n`);
console.log(`estouros no alvo                         ${estouros}`);
console.log(`motos que furaram a estimativa            ${furadas}`);
console.log(`  dessas, estouraram                      ${furadasEstouro}   (${(100 * furadasEstouro / furadas).toFixed(0)}% das furadas)`);
console.log(`  ou seja, ${furadasEstouro} de ${estouros} estouros = ${(100 * furadasEstouro / estouros).toFixed(0)}% passaram por aqui`);
console.log(`\nminuto em que o furo já era visível: mediana ${med(minutoDoFuro)}, mínimo ${Math.min(...minutoDoFuro)}`);
console.log(`quantos furaram ANTES do minuto 120 (dá 60+ de folga): ${minutoDoFuro.filter((m) => m <= 120).length} de ${minutoDoFuro.length}`);
console.log(`\ndessas ${furadasEstouro}, o motor pegou a tempo: ${furadasPegas}. Não pegou: ${furadasEstouro - furadasPegas}.`);
console.log(`\nas que furaram e o motor não pegou a tempo:`);
for (const c of casos.sort((a, b) => a.furoEm - b.furoEm).slice(0, 14))
  console.log(`  ${c.placa}  furou aos ${String(c.furoEm).padStart(3)} min  ficou ${String(c.dur).padStart(4)} min  ${c.regra ? `${c.regra} com folga ${c.folga}` : "nenhuma regra disparou"}`);
