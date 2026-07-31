// Recalibração dos tempos por peça (plano do fim de semana — 01/08).
//
// Uso: node scripts/recalibrar-tempos.mjs treino.json teste.json
// (os dois JSONs saem de scripts/recalibracao-export.sql, mudando só a janela)
//
// O que faz, em 4 passos:
//   1. TEMPOS POR PEÇA: ajusta minutos/peça contra o tempo REAL de bancada (exec_min)
//      por descida coordenada — começa na mediana das OS mono-peça e refina nas mistas.
//   2. MULTIPLICADOR: refaz a curva por nº de peças (o de hoje foi calibrado pros
//      tempos velhos do cadastro — é por isso que só trocar a mediana não bastou).
//   3. GATILHO: varre limiares no TESTE (piso, Mooca) e imprime precisão × volume.
//   4. SAÍDA: bloco pronto pra colar em src/lib/tempo-pecas.ts + gatilho sugerido.
//
// Regra de decisão de sábado: só sobe se o C3 novo der >= 79% no TESTE com volume
// >= 1/dia. Senão, C3 vira recomendação de baixa confiança e fim.

import { readFileSync } from "fs";

const [treinoF, testeF] = process.argv.slice(2);
if (!testeF) { console.error("uso: node recalibrar-tempos.mjs treino.json teste.json"); process.exit(1); }
const carrega = (f) => JSON.parse(readFileSync(f, "utf8"));

// agrupa linhas (so_id, ig_id, qty, exec_min, dur_min) em OSs
function porOS(linhas) {
  const m = new Map();
  for (const l of linhas) {
    let o = m.get(l.so_id);
    if (!o) m.set(l.so_id, (o = { exec: l.exec_min, dur: l.dur_min, piso: l.is_piso, loc: l.location_id, itens: [] }));
    o.itens.push([l.ig_id, l.qty]);
  }
  return [...m.values()];
}
const treino = porOS(carrega(treinoF));
const teste = porOS(carrega(testeF)).filter((o) => o.piso === 1 && o.loc === 1); // avaliação: piso Mooca

// 1) tempos por peça — mediana mono-peça como ponto de partida
const mediana = (v) => { const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const porPeca = new Map();
for (const o of treino) if (o.itens.length === 1) {
  const [ig, q] = o.itens[0];
  (porPeca.get(ig) ?? porPeca.set(ig, []).get(ig)).push(o.exec / q);
}
const tempo = new Map();
for (const [ig, v] of porPeca) if (v.length >= 8) tempo.set(ig, mediana(v));
const FALLBACK = 15;
const t = (ig) => tempo.get(ig) ?? FALLBACK;

// descida coordenada nas OS mistas: 6 passadas, ajusta cada peça pelo resíduo mediano
for (let passo = 0; passo < 6; passo++) {
  const residuo = new Map();
  for (const o of treino) {
    const soma = o.itens.reduce((a, [ig, q]) => a + q * t(ig), 0);
    if (soma <= 0) continue;
    const razao = o.exec / soma; // >1 = subestimado
    for (const [ig] of o.itens) (residuo.get(ig) ?? residuo.set(ig, []).get(ig)).push(razao);
  }
  for (const [ig, rs] of residuo) if (rs.length >= 12) {
    const alvo = t(ig) * mediana(rs);
    tempo.set(ig, Math.max(1, Math.round((t(ig) + alvo) / 2))); // meio passo, estabiliza
  }
}

// 2) multiplicador por nº de peças: razão real/soma por faixa de contagem
const porN = new Map();
for (const o of treino) {
  const soma = o.itens.reduce((a, [ig, q]) => a + q * t(ig), 0);
  if (soma <= 0) continue;
  const n = Math.min(o.itens.length, 8);
  (porN.get(n) ?? porN.set(n, []).get(n)).push(o.exec / soma);
}
const fator = [];
for (let n = 1; n <= 8; n++) fator[n] = porN.has(n) && porN.get(n).length >= 20 ? +mediana(porN.get(n)).toFixed(2) : (fator[n - 1] ?? 1);
const BASE_MIN = 25;
const estima = (o) => Math.round(o.itens.reduce((a, [ig, q]) => a + q * t(ig), 0) * fator[Math.min(o.itens.length, 8)] + BASE_MIN);

// 3) varredura de gatilho no TESTE (piso Mooca)
console.log(`\ntreino: ${treino.length} OS | teste (piso Mooca): ${teste.length} OS | pecas calibradas: ${tempo.size}`);
console.log("\ngatilho | dispara | por dia | precisao (estoura 3h de verdade)");
for (const g of [140, 150, 160, 170, 180, 200, 220]) {
  const disp = teste.filter((o) => estima(o) > g);
  const ok = disp.filter((o) => o.dur > 180).length;
  console.log(`${String(g).padStart(7)} | ${String(disp.length).padStart(7)} | ${(disp.length / 60).toFixed(2).padStart(7)} | ${disp.length ? ((100 * ok) / disp.length).toFixed(1) : "-"}%`);
}

// 4) bloco pra colar em tempo-pecas.ts
const pares = [...tempo.entries()].sort((a, b) => a[0] - b[0]);
console.log(`\n// gerado por recalibrar-tempos.mjs — ${pares.length} peças, fator=[${fator.slice(1).join(",")}], base=${BASE_MIN}`);
console.log("export const MINUTOS_POR_PECA: Record<number, number> = {");
console.log("  " + pares.map(([ig, m]) => `${ig}: ${Math.round(m)}`).join(", "));
console.log("};");
