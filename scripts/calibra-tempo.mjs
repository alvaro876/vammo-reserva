// Calibração dos minutos-por-peça do RIVERS.
//
// O que faz:
//  1. Puxa do ClickHouse as OS concluídas (~75d, bases 1/34/166): tempo REAL de rampa
//     (soma dos períodos IN_PROGRESS, mesmo-dia, episódio capado em 360min) + peças do diag.
//  2. Ajusta uma regressão não-negativa (NNLS via coordinate descent, com shrink pra um
//     prior): tempo_rampa ≈ base + Σ(qtd_peça × minutos_peça).
//  3. Valida OUT-OF-SAMPLE (teste = últimos 14 dias) contra a fórmula atual
//     (sum(qty*time_target) com gambiarra do 308 + 12).
//  4. Gera src/lib/tempo-pecas.ts com os coeficientes + relatório JSON em calib/.
//
// Rodar: node scripts/calibra-tempo.mjs

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DL = process.env.METABASE_DIR || join(ROOT, "data");

// ── 1. dados de treino (exportados do ClickHouse via Metabase) ───────────────
// A extração está documentada em calib/ (query no relatório): OS concluídas em 75d,
// bases 1/34/166, y = tempo de rampa (episódios IN_PROGRESS mesmo-dia, 1-360min,
// total 10-480min), 1 linha por OS×peça (origin DIAGNOSIS/MECHANIC, qty capada em 10).
console.log("1/4 lendo exports do Metabase…");

const flat = JSON.parse(readFileSync(join(DL, "rivers-calib-train.json"), "utf8"));
const names = JSON.parse(readFileSync(join(DL, "rivers-calib-catalogo.json"), "utf8"));
const nameById = new Map(names.map((n) => [Number(n.id), { name: n.name, tt: Number(n.time_target) || 0 }]));

// agrupa linhas achatadas → 1 registro por OS { y, dcomp, pecas: [[id, qty], ...] }
const byOS = new Map();
for (const r of flat) {
  const id = Number(r.os_id);
  if (!byOS.has(id)) byOS.set(id, { y: Number(r.y), dcomp: String(r.dcomp), pecas: [] });
  byOS.get(id).pecas.push([Number(r.item_group_id), Number(r.qty)]);
}
const rows = [...byOS.values()].filter((r) => r.pecas.length >= 1 && r.pecas.length <= 25);
console.log(`   ${flat.length} linhas → ${rows.length} OSs de treino, ${nameById.size} grupos no catálogo`);

// ── 2. montar matriz e ajustar NNLS ─────────────────────────────────────────
console.log("2/4 ajustando regressão (NNLS com prior)…");

// frequência por peça
const freq = new Map();
for (const r of rows) for (const [id] of r.pecas) freq.set(id, (freq.get(id) || 0) + 1);

// só calibra peças com >= 3 OSs; o resto cai no fallback (time_target ou 15)
const featIds = [...freq.entries()].filter(([, n]) => n >= 3).map(([id]) => id).sort((a, b) => a - b);
const idx = new Map(featIds.map((id, j) => [id, j]));
const P = featIds.length;
console.log(`   ${P} peças com >=3 OSs entram na calibração`);

// prior: time_target quando existe, senão 15min; lambda = força do prior (em "pseudo-OSs")
const prior = featIds.map((id) => (nameById.get(id)?.tt > 0 ? nameById.get(id).tt : 15));
const LAMBDA = 40;
const PRIOR_BASE = 12, LAMBDA_BASE = 1; // intercepto quase livre

function buildXY(subset) {
  return subset.map((r) => ({
    y: Number(r.y),
    feats: r.pecas.filter(([id]) => idx.has(id)).map(([id, q]) => [idx.get(id), Number(q)]),
  }));
}

function fit(data, iters = 400) {
  const b = prior.slice(); // começa no prior
  let b0 = PRIOR_BASE;
  const yhat = data.map((d) => b0 + d.feats.reduce((s, [j, q]) => s + q * b[j], 0));
  // pré-computa listas por feature
  const byFeat = Array.from({ length: P }, () => []);
  data.forEach((d, i) => d.feats.forEach(([j, q]) => byFeat[j].push([i, q])));
  for (let it = 0; it < iters; it++) {
    // intercepto
    {
      let num = LAMBDA_BASE * PRIOR_BASE, den = LAMBDA_BASE;
      for (let i = 0; i < data.length; i++) { num += data[i].y - (yhat[i] - b0); den += 1; }
      const nb = Math.max(0, num / den);
      const diff = nb - b0;
      if (diff !== 0) for (let i = 0; i < data.length; i++) yhat[i] += diff;
      b0 = nb;
    }
    // cada peça
    for (let j = 0; j < P; j++) {
      let num = LAMBDA * prior[j], den = LAMBDA;
      for (const [i, q] of byFeat[j]) {
        num += q * (data[i].y - (yhat[i] - q * b[j]));
        den += q * q;
      }
      const nb = Math.max(0, Math.min(300, num / den));
      const diff = nb - b[j];
      if (diff !== 0) for (const [i, q] of byFeat[j]) yhat[i] += q * diff;
      b[j] = nb;
    }
  }
  return { b, b0 };
}

// fórmula ATUAL (pra comparar): sum(qty * coalesce(nullif(tt,0), id==308?41:0)) + 12
function oldEstimate(pecas) {
  let s = 12;
  for (const [id, q] of pecas) {
    const tt = nameById.get(id)?.tt || 0;
    s += q * (tt > 0 ? tt : id === 308 ? 41 : 0);
  }
  return s;
}
function newEstimate(pecas, b, b0) {
  let s = b0;
  for (const [id, q] of pecas) {
    if (idx.has(id)) s += q * b[idx.get(id)];
    else {
      const tt = nameById.get(id)?.tt || 0;
      s += q * (tt > 0 ? tt : 15); // fallback igual ao que vai pro SQL
    }
  }
  return s;
}
const mae = (pairs) => pairs.reduce((s, [a, b2]) => s + Math.abs(a - b2), 0) / pairs.length;
const medape = (pairs) => {
  const v = pairs.map(([y, p]) => Math.abs(y - p) / y).sort((a, b2) => a - b2);
  return v[Math.floor(v.length / 2)];
};

// split temporal: teste = últimos 14 dias
const cut = new Date(Date.now() - 14 * 86400e3).toISOString().slice(0, 10);
const trainRows = rows.filter((r) => r.dcomp < cut);
const testRows = rows.filter((r) => r.dcomp >= cut);
console.log(`   treino ${trainRows.length} OSs (< ${cut}) | teste ${testRows.length} OSs`);

const { b: bT, b0: b0T } = fit(buildXY(trainRows));
const testPairsNew = testRows.map((r) => [Number(r.y), newEstimate(r.pecas, bT, b0T)]);
const testPairsOld = testRows.map((r) => [Number(r.y), oldEstimate(r.pecas)]);
const trainPairsNew = trainRows.map((r) => [Number(r.y), newEstimate(r.pecas, bT, b0T)]);

const metrics = {
  n_treino: trainRows.length,
  n_teste: testRows.length,
  mae_teste_novo: +mae(testPairsNew).toFixed(1),
  mae_teste_formula_atual: +mae(testPairsOld).toFixed(1),
  medape_teste_novo: +(medape(testPairsNew) * 100).toFixed(1),
  medape_teste_formula_atual: +(medape(testPairsOld) * 100).toFixed(1),
  mae_treino_novo: +mae(trainPairsNew).toFixed(1),
};
console.log("   OOS  → novo MAE", metrics.mae_teste_novo, "min | fórmula atual MAE", metrics.mae_teste_formula_atual, "min");
console.log("   OOS  → novo MedAPE", metrics.medape_teste_novo + "%", "| atual", metrics.medape_teste_formula_atual + "%");

// refit final com TUDO (métricas reportadas seguem sendo as OOS do split)
console.log("3/4 refit final com todos os dados…");
const { b, b0 } = fit(buildXY(rows));

// ── relatório ────────────────────────────────────────────────────────────────
const tabela = featIds
  .map((id, j) => ({
    id,
    nome: nameById.get(id)?.name ?? "?",
    n_os: freq.get(id),
    antigo_time_target: nameById.get(id)?.tt || 0,
    calibrado_min: +b[j].toFixed(1),
  }))
  .sort((a, c) => c.n_os - a.n_os);

// âncoras pra sanity-check (caso do Marcelo: OS 34732)
const OS_34732 = [[308, 1], [340, 1], [359, 1], [240, 1], [228, 1], [273, 1], [274, 1]];
const anchors = {
  os_34732_novo: +newEstimate(OS_34732, b, b0).toFixed(0),
  os_34732_formula_atual: oldEstimate(OS_34732),
  os_34732_marcelo: 74,
  intercepto_base_min: +b0.toFixed(1),
};

mkdirSync(join(ROOT, "calib"), { recursive: true });
writeFileSync(
  join(ROOT, "calib", "tempo-calibracao-2026-07-01.json"),
  JSON.stringify({ metrics, anchors, cut_teste: cut, tabela }, null, 2)
);

// ── 4. gerar src/lib/tempo-pecas.ts ─────────────────────────────────────────
console.log("4/4 gerando src/lib/tempo-pecas.ts…");
const mapa = featIds.map((id, j) => `  ${id}: ${Math.max(1, Math.round(b[j]))},`).join("\n");
const ts = `// GERADO por scripts/calibra-tempo.mjs em 2026-07-01 — não editar na mão; rode o script.
//
// Minutos de RAMPA por peça, aprendidos de ${rows.length} OSs concluídas (75 dias, Mooca/Osasco/SBC)
// via regressão não-negativa: tempo_rampa ≈ base + Σ(qtd × minutos_peça).
// Validação out-of-sample (últimos 14d): MAE ${metrics.mae_teste_novo}min vs ${metrics.mae_teste_formula_atual}min da fórmula antiga
// (time_target com gambiarra do 308 + 12). Peças com <3 OSs não entram — caem no fallback
// (time_target do cadastro, senão 15min), aplicado no SQL do rivers-engine.

// Tempo fixo por OS (setup, deslocamento, finalização) — o intercepto da regressão.
export const TEMPO_BASE_MIN = ${Math.round(b0)};

// Fallback pra peça fora do mapa e sem time_target no cadastro.
export const TEMPO_FALLBACK_MIN = 15;

export const MINUTOS_POR_PECA: Record<number, number> = {
${mapa}
};
`;
writeFileSync(join(ROOT, "src", "lib", "tempo-pecas.ts"), ts);

console.log("\n== ÂNCORAS ==");
console.log(JSON.stringify(anchors, null, 1));
console.log("\n== TOP 15 PEÇAS (por frequência) ==");
for (const t of tabela.slice(0, 15))
  console.log(` ${String(t.id).padStart(4)} ${t.nome.slice(0, 42).padEnd(42)} n=${String(t.n_os).padStart(5)} antigo=${String(t.antigo_time_target).padStart(3)} novo=${t.calibrado_min}`);
console.log("\nok — relatório em calib/tempo-calibracao-2026-07-01.json");
