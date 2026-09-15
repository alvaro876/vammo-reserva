// Testa todas as configurações candidatas do C3_CONTA_NAO_FECHA contra a régua do projeto.
//
// Hoje: fator de bancada 0,67 fixo, corte 210. Medido esta semana: a razão real bancada/estimativa
// cresce com o número de peças (p75 de 0,61 em 1-2 peças até 0,94 em 9+), então o fator fixo
// encurta demais a projeção justo no serviço grande, que é onde o cliente fura o prazo.
//
// Régua: primeiro alerta de SLA por OS, 60+ min de folga conta como "a tempo", denominador único
// (estouros com cliente na base, sem guincho). Toda config roda no conjunto inteiro e partida por
// data, porque corte escolhido no mesmo dado que mede sempre parece melhor do que é.

import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const argv = process.argv.slice(2);
const baseArg = argv.find((a) => a.startsWith("--base="));
const baseFiltro = baseArg ? Number(baseArg.split("=")[1]) : null;
const dias = argv.filter((a) => !a.startsWith("--"));
const LIMITE = 180, ANTEC = 60, QA = 14, MIN_RESTANTE = 30, TETO_RELOGIO = 480;

const out = join(mkdtempSync(join(tmpdir(), "tt-")), "r.mjs");
await build({
  entryPoints: ["src/lib/diario-replay.ts"],
  bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "warning",
  alias: { "@": "./src" },
  define: { "process.env.RIVERS_GUINCHO": '""', "process.env.RIVERS_REGRA_C4": '""',
            "process.env.RIVERS_REGRA_ESTOQUE": '""', "process.env.RIVERS_REGRA_RELOGIO": '""' },
});
const { estimativaEm, execAcumEm, statusEm, replay, TETO_REPLAY_MIN } = await import(`file://${out}`);

const RES = ["RESERVE_DELIVERED", "BIKE_REPLACED"];
const QA_ST = new Set(["AWAITING_QA", "IN_QA", "QA_REJECTED"]);

const motos = [];
for (const dia of dias) {
  const arq = `scripts/fixture/diario_${dia}.json`;
  if (!existsSync(arq)) continue;
  for (const r of JSON.parse(readFileSync(arq, "utf8")).linhas) {
    if (baseFiltro !== null && r.base !== baseFiltro) continue;
    if (r.guincho === 1 || r.pronta_ts <= 0) continue;
    const temCliente = r.chamado_ts > 0 || r.ofertou === 1 || r.chamou === 1 || RES.includes(r.service_conclusion);
    if (!temCliente) continue;
    const dur = Math.round((r.pronta_ts - r.t0) / 60);
    const rp = replay(r, Math.min(TETO_REPLAY_MIN, dur));
    const outras = (rp.disparos || []).filter((d) => d.sla && d.regra !== "C3_CONTA_NAO_FECHA")
      .sort((a, b) => a.min - b.min)[0] ?? null;
    motos.push({ r, dia, dur, estourou: dur > LIMITE, outras });
  }
}

// ── as configurações ────────────────────────────────────────────────────────
const fixo = (f) => () => f;
const porPecas = (tabela) => (n) => {
  for (const [ate, f] of tabela) if (n <= ate) return f;
  return tabela[tabela.length - 1][1];
};
const CONFIGS = [
  { nome: "hoje: 0,67 fixo · 210",        fator: fixo(0.67), corte: 210 },
  { nome: "0,90 fixo · 230",              fator: fixo(0.90), corte: 230 },
  { nome: "0,80 fixo · 210",              fator: fixo(0.80), corte: 210 },
  { nome: "peças suave · 210",            fator: porPecas([[4, 0.70], [8, 0.85], [99, 0.95]]), corte: 210 },
  { nome: "peças suave · 230",            fator: porPecas([[4, 0.70], [8, 0.85], [99, 0.95]]), corte: 230 },
  { nome: "peças fina · 210",             fator: porPecas([[2, 0.60], [4, 0.75], [6, 0.85], [8, 0.85], [99, 0.95]]), corte: 210 },
  { nome: "peças fina · 230",             fator: porPecas([[2, 0.60], [4, 0.75], [6, 0.85], [8, 0.85], [99, 0.95]]), corte: 230 },
  { nome: "peças forte · 230",            fator: porPecas([[4, 0.75], [8, 0.95], [99, 1.10]]), corte: 230 },
  { nome: "peças forte · 240",            fator: porPecas([[4, 0.75], [8, 0.95], [99, 1.10]]), corte: 240 },
];

function primeiroAlerta(m, cfg) {
  const { r, dur } = m;
  let minCNF = null;
  for (let min = 10; min <= Math.min(TETO_REPLAY_MIN, dur); min += 10) {
    const T = r.t0 + min * 60;
    const { status } = statusEm(r.evs, T);
    if (QA_ST.has(status)) continue;
    const piso = r.chamado_ts > 0 && r.chamado_ts <= T && (r.saiu_ts <= 0 || T < r.saiu_ts);
    if (!piso) continue;
    if (min >= TETO_RELOGIO) break;
    const { est, nPecas } = estimativaEm(r.itens, T);
    if (est <= 0) continue;
    const restante = Math.max(0, est - execAcumEm(r.evs, T));
    const corrigido = Math.round(restante * cfg.fator(nPecas));
    if (corrigido + QA < MIN_RESTANTE) continue;
    if (min + corrigido + QA > cfg.corte) { minCNF = min; break; }
  }
  const cands = [];
  if (minCNF !== null) cands.push(minCNF);
  if (m.outras) cands.push(m.outras.min);
  return cands.length ? Math.min(...cands) : null;
}

function placar(sub, cfg) {
  let alertas = 0, certos = 0, aTempo = 0;
  const est = sub.filter((m) => m.estourou).length;
  for (const m of sub) {
    const min = primeiroAlerta(m, cfg);
    if (min === null) continue;
    alertas++;
    if (m.estourou) { certos++; if (LIMITE - min >= ANTEC) aTempo++; }
  }
  return { alertas, certos, aTempo, est,
           prec: alertas ? 100 * certos / alertas : 0, alc: est ? 100 * aTempo / est : 0 };
}

const metade = Math.ceil(dias.length / 2);
const A = new Set(dias.slice(0, metade)), B = new Set(dias.slice(metade));
const subA = motos.filter((m) => A.has(m.dia)), subB = motos.filter((m) => B.has(m.dia));
const estouros = motos.filter((m) => m.estourou).length;

const pad = (s, n) => String(s).padEnd(n);
const num = (s, n) => String(s).padStart(n);
console.log(`\n=== ${motos.length} motos no alvo · ${estouros} estouros · ${dias.length} dias ===`);
console.log(`metade A: ${subA.length} motos, ${subA.filter((m) => m.estourou).length} estouros`);
console.log(`metade B: ${subB.length} motos, ${subB.filter((m) => m.estourou).length} estouros\n`);
console.log(pad("configuração", 24) + num("alertas", 8) + num("precisão", 10) + num("a tempo", 9) + num("alcance", 9) + num("prec A", 8) + num("alc A", 7) + num("prec B", 8) + num("alc B", 7));
console.log("─".repeat(90));
for (const cfg of CONFIGS) {
  const t = placar(motos, cfg), a = placar(subA, cfg), b = placar(subB, cfg);
  console.log(pad(cfg.nome, 24) + num(t.alertas, 8) + num(t.prec.toFixed(1) + "%", 10) +
    num(t.aTempo, 9) + num(t.alc.toFixed(1) + "%", 9) +
    num(a.prec.toFixed(0) + "%", 8) + num(a.alc.toFixed(0) + "%", 7) +
    num(b.prec.toFixed(0) + "%", 8) + num(b.alc.toFixed(0) + "%", 7));
}
