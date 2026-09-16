// A PERGUNTA QUE DECIDE: consertar a estimativa melhora a DECISÃO do RIVERS?
//
// Os modelos foram treinados no repo do modelo e exportaram uma previsão de bancada por OS. Aqui
// cada previsão entra no lugar da estimativa e o motor de verdade roda de 10 em 10 minutos, pela
// cascata inteira, com as mesmas travas (janela do cron, status avaliáveis, piso). É a única forma
// honesta de saber se o modelo vale: erro médio menor não vira decisão melhor sozinho.
//
// Só as OS do PERÍODO DE TESTE são pontuadas. As de treino o modelo decorou, e medir nelas é
// mentir pra si mesmo.
//
// Régua: primeiro alerta de SLA por OS, 60+ min de folga conta como salvo, denominador único.
//
//   node scripts/testa-estimativa.mjs --base=1 2026-08-11 ...

import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const PREV = "C:/Users/Usuário/Desktop/rivers-preditivo/data/processed/estimativa_previsoes.json";
const argv = process.argv.slice(2);
const baseFiltro = Number((argv.find((a) => a.startsWith("--base=")) ?? "--base=1").split("=")[1]);
const dias = argv.filter((a) => !a.startsWith("--")).sort();
const LIMITE = 180, ANTEC = 60;
const RES = ["RESERVE_DELIVERED", "BIKE_REPLACED"];

const prev = JSON.parse(readFileSync(PREV, "utf8"));
const soTeste = new Set(prev.teste);

const out = join(mkdtempSync(join(tmpdir(), "est-")), "r.mjs");
await build({
  entryPoints: ["src/lib/diario-replay.ts"],
  bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "warning",
  alias: { "@": "./src" },
  define: { "process.env.RIVERS_GUINCHO": '""', "process.env.RIVERS_REGRA_C4": '""',
            "process.env.RIVERS_REGRA_ESTOQUE": '""', "process.env.RIVERS_REGRA_RELOGIO": '""',
            "process.env.RIVERS_REGRA_EXP": '""' },
});
const { replay, TETO_REPLAY_MIN } = await import(`file://${out}`);

const motos = [];
for (const dia of dias) {
  const arq = `scripts/fixture/diario_${dia}.json`;
  if (!existsSync(arq)) continue;
  const f = JSON.parse(readFileSync(arq, "utf8"));
  if (!f.linhas || !f.linhas.length) continue;
  for (const r of f.linhas) {
    if (r.base !== baseFiltro || r.guincho === 1 || r.pronta_ts <= 0) continue;
    if (!soTeste.has(r.os_id)) continue;                       // só o período de teste
    const temCliente = r.chamado_ts > 0 || r.ofertou === 1 || r.chamou === 1 || RES.includes(r.service_conclusion);
    if (!temCliente) continue;
    motos.push({ r, dur: Math.round((r.pronta_ts - r.t0) / 60) });
  }
}
const estouros = motos.filter((m) => m.dur > LIMITE).length;

function placar(nomeModelo) {
  const mapa = nomeModelo ? prev.modelos[nomeModelo] : null;
  let alertas = 0, certos = 0, salvos = 0;
  const folgas = [];
  for (const m of motos) {
    const ov = mapa ? mapa[String(m.r.os_id)] ?? null : null;
    const rp = replay(m.r, Math.min(TETO_REPLAY_MIN, m.dur), ov);
    const sla = (rp.disparos || []).filter((d) => d.sla).sort((a, b) => a.min - b.min)[0] ?? null;
    if (!sla) continue;
    alertas++;
    const estourou = m.dur > LIMITE;
    if (estourou) {
      certos++;
      const folga = LIMITE - sla.min;
      if (folga >= ANTEC) { salvos++; folgas.push(folga); }
    }
  }
  folgas.sort((a, b) => a - b);
  return {
    alertas, certos, salvos,
    prec: alertas ? 100 * certos / alertas : 0,
    alc: estouros ? 100 * salvos / estouros : 0,
    folga: folgas.length ? folgas[Math.floor(folgas.length / 2)] : 0,
  };
}

// ── o corte tem que andar junto com a estimativa ──────────────────────────────
// A fórmula de hoje PREVÊ 23% A MAIS que a bancada real. Isso deixa o motor nervoso e o corte de
// 230 foi calibrado em cima desse exagero. Estimativa honesta + corte antigo = motor calado.
// Aqui o corte volta a ser varrido pra cada modelo, que é a única comparação justa.
const pad = (s, n) => String(s).padEnd(n), p2 = (s, n) => String(s).padStart(n);
console.log(`\n=== só o período de teste: ${motos.length} motos, ${estouros} estouros ===`);
console.log(`(treino até ${prev.corte_teste}; estas OS o modelo nunca viu)\n`);
console.log(pad("estimativa usada", 30) + p2("alertas", 9) + p2("certos", 8) + p2("precisão", 10) +
  p2("salvos", 8) + p2("alcance", 9) + p2("folga med", 11));
console.log("─".repeat(85));

const base = placar(null);
const linha = (rot, r) => console.log(pad(rot, 30) + p2(r.alertas, 9) + p2(r.certos, 8) +
  p2(r.prec.toFixed(1) + "%", 10) + p2(r.salvos, 8) + p2(r.alc.toFixed(1) + "%", 9) +
  p2(r.folga + " min", 11) +
  (rot.startsWith("hoje") ? "   <- o motor de hoje" :
   `   ${r.salvos - base.salvos >= 0 ? "+" : ""}${r.salvos - base.salvos} salvos, ${(r.prec - base.prec) >= 0 ? "+" : ""}${(r.prec - base.prec).toFixed(1)}pp`));

linha(`hoje: fórmula, corte ${process.env.CORTE_ROT ?? "230"}`, base);
for (const nome of Object.keys(prev.modelos)) linha(nome, placar(nome));
