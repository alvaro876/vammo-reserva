// COMPÕE O CONJUNTO: mede o que acontece quando as candidatas do garimpo entram junto das
// regras de hoje.
//
// Por que não basta olhar regra por regra: duas regras de 90% que disparam nas MESMAS motos não
// somam alcance nenhum, e a que entra depois pode roubar o primeiro disparo da que já existia e
// piorar a folga. Só a união diz a verdade.
//
// Régua: primeiro alerta por OS, 60+ min de folga conta como salvo, teto de aviso no minuto 120,
// denominador único (estouros com cliente na base, sem guincho). Partição por data em tudo.
//
//   node scripts/compoe-conjunto.mjs --base=1 2026-08-11 ...

import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const argv = process.argv.slice(2);
const baseFiltro = Number((argv.find((a) => a.startsWith("--base=")) ?? "--base=1").split("=")[1]);
const dias = argv.filter((a) => !a.startsWith("--")).sort();
const LIMITE = 180, ANTEC = 60, TETO = 120, GRADE = 10;
const PRE_EXEC = new Set(["OPEN", "IN_DIAGNOSIS", "AWAITING_MECHANIC", "AWAITING_PARTS", "PAUSED"]);
const QA_ST = new Set(["AWAITING_QA", "IN_QA", "QA_REJECTED"]);

const out = join(mkdtempSync(join(tmpdir(), "comp-")), "r.mjs");
await build({
  entryPoints: ["src/lib/diario-replay.ts"],
  bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "warning",
  alias: { "@": "./src" },
  define: { "process.env.RIVERS_GUINCHO": '""', "process.env.RIVERS_REGRA_C4": '""',
            "process.env.RIVERS_REGRA_ESTOQUE": '""', "process.env.RIVERS_REGRA_RELOGIO": '""' },
});
const { replay, statusEm, execAcumEm, estimativaEm, TETO_REPLAY_MIN } = await import(`file://${out}`);

const RES = ["RESERVE_DELIVERED", "BIKE_REPLACED"];
const motos = [];
for (const dia of dias) {
  const arq = `scripts/fixture/diario_${dia}.json`;
  if (!existsSync(arq)) continue;
  const f = JSON.parse(readFileSync(arq, "utf8"));
  if (!f.linhas || !f.linhas.length) continue;
  for (const r of f.linhas) {
    if (r.base !== baseFiltro || r.guincho === 1 || r.pronta_ts <= 0) continue;
    const temCliente = r.chamado_ts > 0 || r.ofertou === 1 || r.chamou === 1 || RES.includes(r.service_conclusion);
    if (!temCliente) continue;
    const dur = Math.round((r.pronta_ts - r.t0) / 60);
    const rp = replay(r, Math.min(TETO_REPLAY_MIN, dur));
    const hoje = (rp.disparos || []).filter((d) => d.sla).sort((a, b) => a.min - b.min)[0] ?? null;

    const fotos = [];
    for (let m = GRADE; m <= TETO; m += GRADE) {
      const T = r.t0 + m * 60;
      if (r.pronta_ts > 0 && T > r.pronta_ts) break;
      const { status } = statusEm(r.evs, T);
      const { est } = estimativaEm(r.itens, T);
      const exec = execAcumEm(r.evs, T);
      const emQa = QA_ST.has(status);
      const piso = (r.chamado_ts > 0 && r.chamado_ts <= T && (r.saiu_ts <= 0 || T < r.saiu_ts)) ? 1 : 0;
      fotos.push({
        min: m, emQa: emQa ? 1 : 0, preExec: PRE_EXEC.has(status) ? 1 : 0, piso,
        nEv: (r.evs || []).filter((e) => e[0] <= T).length,
        conta: m + Math.round((emQa ? 0 : Math.max(0, est - exec)) * 0.9) + 14,
        parado30: (exec - execAcumEm(r.evs, T - 1800)) < 5 ? 1 : 0,
      });
    }
    motos.push({ dia, dur, estourou: dur > LIMITE, hojeMin: hoje ? hoje.min : null, fotos });
  }
}

// TODAS exigem o cliente carimbado no balcao, que e o que o cron de fato notifica. Sem isso o
// ganho e ilusao: os disparos sem carimbo sao, na maioria, moto que ficou DIAS na oficina e cujo
// cliente ja tinha ido embora de reserva (o check-in fecha justamente por causa da entrega).
const CANDIDATAS = [
  { nome: "piso E nao entrou na bancada E rel >= 100", f: (x) => x.piso === 1 && x.preExec === 1 && x.min >= 100 },
  { nome: "piso E nao entrou na bancada E rel >= 110", f: (x) => x.piso === 1 && x.preExec === 1 && x.min >= 110 },
  { nome: "piso E nao entrou na bancada E rel >= 120", f: (x) => x.piso === 1 && x.preExec === 1 && x.min >= 120 },
  { nome: "piso E rel >= 110 E ate 3 eventos",         f: (x) => x.piso === 1 && x.min >= 110 && x.nEv <= 3 },
  { nome: "piso E parada ha 30 min E rel >= 120",      f: (x) => x.piso === 1 && x.parado30 === 1 && x.min >= 120 },
  { nome: "piso E parada ha 30 min E a conta >= 220",  f: (x) => x.piso === 1 && x.parado30 === 1 && x.conta >= 220 },
  { nome: "piso E a conta >= 220",                     f: (x) => x.piso === 1 && x.emQa === 0 && x.conta >= 220 },
];

const primeiro = (m, sel) => {
  const cands = [];
  if (m.hojeMin !== null && m.hojeMin <= TETO) cands.push(m.hojeMin);
  for (const c of sel) for (const x of m.fotos) if (c.f(x)) { cands.push(x.min); break; }
  return cands.length ? Math.min(...cands) : null;
};
const placar = (sub, sel) => {
  let alertas = 0, certos = 0, salvos = 0;
  const est = sub.filter((m) => m.estourou).length;
  for (const m of sub) {
    const min = primeiro(m, sel);
    if (min === null) continue;
    alertas++;
    if (m.estourou) { certos++; if (LIMITE - min >= ANTEC) salvos++; }
  }
  return { alertas, certos, salvos, est, prec: alertas ? 100 * certos / alertas : 0,
           alc: est ? 100 * salvos / est : 0 };
};

const corte = dias[Math.floor(dias.length / 2)];
const subA = motos.filter((m) => m.dia < corte), subB = motos.filter((m) => m.dia >= corte);
const pad = (s, n) => String(s).padEnd(n), p2 = (s, n) => String(s).padStart(n);
const nDias = new Set(motos.map((m) => m.dia)).size;

console.log(`\n=== ${motos.length} motos · ${motos.filter((m) => m.estourou).length} estouros · ${nDias} dias ===`);
console.log(`metade A: ate ${corte} · metade B: de ${corte} em diante\n`);
console.log(pad("conjunto", 46) + p2("alertas", 9) + p2("precisao", 10) + p2("salvos", 8) +
  p2("alcance", 9) + p2("/dia", 7) + p2("A", 6) + p2("B", 6));
console.log("─".repeat(101));

const linha = (rot, sel) => {
  const t = placar(motos, sel), a = placar(subA, sel), b = placar(subB, sel);
  console.log(pad(rot, 46) + p2(t.alertas, 9) + p2(t.prec.toFixed(1) + "%", 10) + p2(t.salvos, 8) +
    p2(t.alc.toFixed(1) + "%", 9) + p2((t.alertas / nDias).toFixed(1), 7) +
    p2(a.prec.toFixed(0) + "%", 6) + p2(b.prec.toFixed(0) + "%", 6));
  return t;
};

const base = linha("hoje (v0.37.1)", []);
console.log("");
for (const c of CANDIDATAS) linha("+ " + c.nome, [c]);

// guloso: entra a que mais sobe o alcance, enquanto a precisao do conjunto ficar >= 80
console.log("");
const sel = [];
const restantes = [...CANDIDATAS];
for (let passo = 0; passo < 4; passo++) {
  let melhor = null;
  for (const c of restantes) {
    const t = placar(motos, [...sel, c]);
    if (t.prec < 80) continue;
    if (!melhor || t.salvos > melhor.t.salvos) melhor = { c, t };
  }
  if (!melhor) break;
  sel.push(melhor.c);
  restantes.splice(restantes.indexOf(melhor.c), 1);
  linha(`conjunto com ${sel.length}: +${melhor.c.nome.slice(0, 28)}`, sel);
}
console.log("");
console.log(`hoje salva ${base.salvos} de ${base.est}; o conjunto escolhido salva ${placar(motos, sel).salvos}.`);
console.log(`regras escolhidas, em ordem de entrada:`);
sel.forEach((c, i) => console.log(`  ${i + 1}. ${c.nome}`));
