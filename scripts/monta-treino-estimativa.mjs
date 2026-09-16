// Monta a tabela de treino pra CONSERTAR A ESTIMATIVA.
//
// O problema medido: a estimativa é o único insumo real de quase toda regra do RIVERS, e ela erra
// de forma previsível. A razão entre a bancada real e a estimativa é 0,51 na mediana em quem fica
// no prazo e 0,99 em quem estoura. Ou seja, ela mente exatamente na moto que precisa ser pega.
//
// Aqui sai uma linha por OS com:
//   - o ALVO: os minutos de bancada que a moto de fato consumiu (soma dos episódios IN_PROGRESS)
//   - o que a FÓRMULA DE HOJE chutou no momento do diagnóstico
//   - as features conhecidas NO DIAGNÓSTICO (nada do futuro)
//   - as peças, uma coluna por id, pra quem quiser aprender peça a peça
//
// Corte temporal honesto: quem for treinar separa por data, nunca aleatório.
//
//   node scripts/monta-treino-estimativa.mjs --base=1 --out=../rivers-preditivo/data/processed/estimativa.csv 2026-08-11 ...

import { readFileSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const argv = process.argv.slice(2);
const baseFiltro = Number((argv.find((a) => a.startsWith("--base=")) ?? "--base=1").split("=")[1]);
const saida = (argv.find((a) => a.startsWith("--out=")) ?? "--out=scripts/_treino_estimativa.csv").split("=")[1];
const dias = argv.filter((a) => !a.startsWith("--")).sort();

const out = join(mkdtempSync(join(tmpdir(), "treino-")), "r.mjs");
await build({
  entryPoints: ["src/lib/diario-replay.ts"],
  bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "warning",
  alias: { "@": "./src" },
  define: { "process.env.RIVERS_GUINCHO": '""', "process.env.RIVERS_REGRA_C4": '""',
            "process.env.RIVERS_REGRA_ESTOQUE": '""', "process.env.RIVERS_REGRA_RELOGIO": '""' },
});
const { estimativaEm, execAcumEm, statusEm, horaSP } = await import(`file://${out}`);

const linhas = [];
const idsVistos = new Map();   // item_group_id -> quantas OS usaram

for (const dia of dias) {
  const arq = `scripts/fixture/diario_${dia}.json`;
  if (!existsSync(arq)) continue;
  const f = JSON.parse(readFileSync(arq, "utf8"));
  if (!f.linhas || !f.linhas.length) continue;

  for (const r of f.linhas) {
    if (baseFiltro !== null && r.base !== baseFiltro) continue;
    if (r.guincho === 1 || r.pronta_ts <= 0) continue;

    // O INSTANTE DO DIAGNÓSTICO: é quando a estimativa passa a existir e é o momento em que a
    // previsão precisa ser feita. Sem diagnóstico não há o que prever.
    const tDiag = r.diag_ts > 0 ? r.diag_ts : 0;
    if (!tDiag) continue;
    // primeira foto em que já há peça lançada (a estimativa nasce)
    let T0 = 0;
    for (let m = 0; m <= 300; m += 10) {
      const T = r.t0 + m * 60;
      if (T > r.pronta_ts) break;
      if (estimativaEm(r.itens, T).est > 0) { T0 = T; break; }
    }
    if (!T0) continue;

    const { est, nChaves, nPecas } = estimativaEm(r.itens, T0);
    const execReal = execAcumEm(r.evs, r.pronta_ts);
    if (execReal <= 0) continue;

    const dur = Math.round((r.pronta_ts - r.t0) / 60);
    const { status } = statusEm(r.evs, T0);
    const itensNoDiag = (r.itens || []).filter((it) => it[0] <= T0 && it[1] > T0);

    for (const it of itensNoDiag) idsVistos.set(it[7], (idsVistos.get(it[7]) ?? 0) + 1);

    linhas.push({
      dia, os_id: r.os_id, placa: r.placa,
      // ALVO
      bancada_real: Math.round(execReal),
      dur_total: dur,
      estourou: dur > 180 ? 1 : 0,
      // O QUE A FÓRMULA DE HOJE DIZ
      est_formula: est,
      razao: +(execReal / est).toFixed(3),
      // FEATURES DO DIAGNÓSTICO (nada do futuro)
      n_chaves: nChaves, n_pecas: nPecas,
      minuto_do_diag: Math.round((T0 - r.t0) / 60),
      hora: horaSP(T0),
      dow: new Date(T0 * 1000).getUTCDay(),
      status_no_diag: status,
      so_type: r.so_type ?? "",
      asset_model: r.asset_model ?? "",
      n_checkins: r.n_checkins ?? 0,
      acidente: r.acidente ?? 0,
      imobilizada: r.imobilizada ?? 0,
      troca_placa: r.troca_placa ?? 0,
      // as peças, pra quem quiser aprender peça a peça
      _ids: itensNoDiag.map((it) => it[7]),
    });
  }
}

// só peças que aparecem em 15+ OS viram coluna; o resto vira "outras"
const idsUteis = [...idsVistos.entries()].filter(([, n]) => n >= 15).map(([id]) => id).sort((a, b) => a - b);
const cols = ["dia", "os_id", "placa", "bancada_real", "dur_total", "estourou", "est_formula", "razao",
  "n_chaves", "n_pecas", "minuto_do_diag", "hora", "dow", "status_no_diag", "so_type", "asset_model",
  "n_checkins", "acidente", "imobilizada", "troca_placa", "n_outras",
  ...idsUteis.map((id) => `p_${id}`)];

const esc = (v) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const linhasCsv = [cols.join(",")];
for (const L of linhas) {
  const conta = new Map();
  for (const id of L._ids) conta.set(id, (conta.get(id) ?? 0) + 1);
  const outras = L._ids.filter((id) => !idsUteis.includes(id)).length;
  linhasCsv.push(cols.map((c) => {
    if (c === "n_outras") return outras;
    if (c.startsWith("p_")) return conta.get(Number(c.slice(2))) ?? 0;
    return esc(L[c]);
  }).join(","));
}
writeFileSync(saida, "﻿" + linhasCsv.join("\n") + "\n", "utf8");

const rz = linhas.map((L) => L.razao).sort((a, b) => a - b);
const q = (p) => rz[Math.floor(p * rz.length)];
console.log(`\n[ok] ${saida}`);
console.log(`     ${linhas.length} OS · ${cols.length} colunas · ${idsUteis.length} peças com coluna própria`);
console.log(`     dias: ${linhas[0]?.dia} a ${linhas[linhas.length - 1]?.dia}`);
console.log(`\nA fórmula de hoje, contra a bancada real:`);
console.log(`  razão real/estimado   p25 ${q(0.25).toFixed(2)}   mediana ${q(0.5).toFixed(2)}   p75 ${q(0.75).toFixed(2)}   p90 ${q(0.9).toFixed(2)}`);
console.log(`  estouros na amostra   ${linhas.filter((L) => L.estourou).length} de ${linhas.length}`);
