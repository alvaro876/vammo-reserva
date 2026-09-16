// GARIMPO DE REGRAS sobre o estado reconstruído minuto a minuto.
//
// Por que existe: até agora toda regra do RIVERS nasceu de alguém olhando um caso e propondo uma
// condição. Isso achou o óbvio e parou. Aqui o programa monta, pra cada moto e cada tique de 10
// minutos até o 120 (último instante que ainda deixa 60 de folga), a foto do que o motor sabia
// naquele momento, e varre combinações de 1 e 2 condições procurando fatia com precisão alta.
//
// A régua é a do projeto: a moto entra uma vez só (o primeiro tique em que a condição vale), só
// conta o que dispara até o minuto 120, e o ganho é MARGINAL — quantos estouros a candidata traz
// que as regras de hoje já não pegam a tempo. Regra que repete o que já existe não serve.
//
//   node scripts/mina-regras.mjs --base=1 2026-08-11 2026-08-12 ...

import { readFileSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const argv = process.argv.slice(2);
const baseFiltro = Number((argv.find((a) => a.startsWith("--base=")) ?? "--base=1").split("=")[1]);
const minN = Number((argv.find((a) => a.startsWith("--minN=")) ?? "--minN=25").split("=")[1]);
const dias = argv.filter((a) => !a.startsWith("--")).sort();
const LIMITE = 180, ANTEC = 60, TETO = 120, GRADE = 10;
const PRE_EXEC = new Set(["OPEN", "IN_DIAGNOSIS", "AWAITING_MECHANIC", "AWAITING_PARTS", "PAUSED"]);
const QA_ST = new Set(["AWAITING_QA", "IN_QA", "QA_REJECTED"]);

const out = join(mkdtempSync(join(tmpdir(), "mina-")), "r.mjs");
await build({
  entryPoints: ["src/lib/diario-replay.ts"],
  bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "warning",
  alias: { "@": "./src" },
  define: { "process.env.RIVERS_GUINCHO": '""', "process.env.RIVERS_REGRA_C4": '""',
            "process.env.RIVERS_REGRA_ESTOQUE": '""', "process.env.RIVERS_REGRA_RELOGIO": '""' },
});
const { replay, statusEm, execAcumEm, estimativaEm, TETO_REPLAY_MIN } = await import(`file://${out}`);

// ── monta as fotos ──────────────────────────────────────────────────────────
const RES = ["RESERVE_DELIVERED", "BIKE_REPLACED"];
const motos = [];
let diasUsados = 0;
for (const dia of dias) {
  const arq = `scripts/fixture/diario_${dia}.json`;
  if (!existsSync(arq)) continue;
  const f = JSON.parse(readFileSync(arq, "utf8"));
  if (!f.linhas || !f.linhas.length) continue;
  diasUsados++;
  // termômetro da oficina: duração mediana das que ficaram prontas nas 2h anteriores
  const prontas = f.linhas.filter((r) => r.pronta_ts > 0)
    .map((r) => ({ ts: r.pronta_ts, dur: (r.pronta_ts - r.t0) / 60 })).sort((a, b) => a.ts - b.ts);
  const termometroEm = (T) => {
    const j = prontas.filter((p) => p.ts <= T && p.ts > T - 7200).map((p) => p.dur).sort((a, b) => a - b);
    return j.length >= 3 ? j[Math.floor(j.length / 2)] : null;
  };
  for (const r of f.linhas) {
    if (r.base !== baseFiltro || r.guincho === 1 || r.pronta_ts <= 0) continue;
    const temCliente = r.chamado_ts > 0 || r.ofertou === 1 || r.chamou === 1 || RES.includes(r.service_conclusion);
    if (!temCliente) continue;
    const dur = Math.round((r.pronta_ts - r.t0) / 60);
    const rp = replay(r, Math.min(TETO_REPLAY_MIN, dur));
    const sla = (rp.disparos || []).filter((d) => d.sla).sort((a, b) => a.min - b.min)[0] ?? null;
    const jaPego = sla !== null && (LIMITE - sla.min) >= ANTEC;   // as regras de hoje já salvam?

    const fotos = [];
    for (let m = GRADE; m <= TETO; m += GRADE) {
      const T = r.t0 + m * 60;
      if (r.pronta_ts > 0 && T > r.pronta_ts) break;
      const { status, desde } = statusEm(r.evs, T);
      const { est, nPecas } = estimativaEm(r.itens, T);
      const exec = execAcumEm(r.evs, T);
      const emQa = QA_ST.has(status);
      const restante = emQa ? 0 : Math.max(0, est - exec);
      const nEv = (r.evs || []).filter((e) => e[0] <= T).length;
      const execAntes = execAcumEm(r.evs, T - 1800);              // execução 30 min atrás
      fotos.push({
        min: m,
        piso: (r.chamado_ts > 0 && r.chamado_ts <= T && (r.saiu_ts <= 0 || T < r.saiu_ts)) ? 1 : 0,
        emQa: emQa ? 1 : 0,
        preExec: PRE_EXEC.has(status) ? 1 : 0,
        desde, est, exec, nPecas, nEv,
        conta: m + Math.round(restante * 0.9) + 14,
        progresso: est > 0 ? exec / est : null,
        parado30: (exec - execAntes) < 5 ? 1 : 0,
        semDiag: est <= 0 ? 1 : 0,
        termo: termometroEm(T),
        pecaNova: (r.itens || []).some((it) => it.ts_add > r.t0 + 3600 && it.ts_add <= T) ? 1 : 0,
      });
    }
    motos.push({ dia, placa: r.placa, dur, estourou: dur > LIMITE, jaPego, fotos });
  }
}

const estouros = motos.filter((m) => m.estourou).length;
const jaSalvos = motos.filter((m) => m.estourou && m.jaPego).length;
console.log(`\n=== ${motos.length} motos · ${estouros} estouros · ${diasUsados} dias com dado ===`);
console.log(`as regras de hoje já salvam ${jaSalvos}. O garimpo procura os outros ${estouros - jaSalvos}.\n`);

// ── o espaço de busca ───────────────────────────────────────────────────────
const num = (nome, campo, vals, op) => vals.map((v) => ({
  nome: `${nome} ${op || ">="} ${v}`,
  testa: (f) => f[campo] !== null && f[campo] !== undefined &&
    ((op === "<=") ? f[campo] <= v : f[campo] >= v),
}));
const CONDS = [
  { nome: "cliente no balcao", testa: (f) => f.piso === 1 },
  { nome: "fora do QA", testa: (f) => f.emQa === 0 },
  { nome: "nao entrou na bancada", testa: (f) => f.preExec === 1 },
  { nome: "sem diagnostico", testa: (f) => f.semDiag === 1 },
  { nome: "parada ha 30 min", testa: (f) => f.parado30 === 1 },
  { nome: "peca nova depois da 1a hora", testa: (f) => f.pecaNova === 1 },
  ...num("relogio", "min", [60, 70, 80, 90, 100, 110, 120]),
  ...num("a conta", "conta", [190, 200, 210, 220, 230, 240, 250]),
  ...num("estimativa", "est", [100, 130, 160, 200, 240]),
  ...num("pecas", "nPecas", [4, 6, 8, 10]),
  ...num("min no status", "desde", [30, 45, 60, 90]),
  ...num("eventos de status", "nEv", [5, 7, 9]),
  ...num("eventos de status", "nEv", [3, 4], "<="),
  ...num("progresso do servico", "progresso", [0.15, 0.3, 0.5], "<="),
  ...num("termometro da oficina", "termo", [110, 130, 150, 170]),
];

// primeira foto (até o minuto 120) em que a conjunção vale
const dispara = (m, conds) => {
  for (const f of m.fotos) if (conds.every((c) => c.testa(f))) return f.min;
  return null;
};
const wilson = (k, n) => {
  if (!n) return [0, 0];
  const p = k / n, z = 1.96, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d;
  const e = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [100 * (c - e), 100 * (c + e)];
};
function avalia(conds, sub) {
  const pop = sub || motos;
  let n = 0, certos = 0, novos = 0;
  for (const m of pop) {
    if (dispara(m, conds) === null) continue;
    n++;
    if (m.estourou) { certos++; if (!m.jaPego) novos++; }
  }
  const [lo, hi] = wilson(certos, n);
  return { n, certos, novos, prec: n ? 100 * certos / n : 0, lo, hi };
}

// partição por data, pra não vender corte pescado no mesmo dado
const corte = dias[Math.floor(dias.length / 2)];
const subA = motos.filter((m) => m.dia < corte), subB = motos.filter((m) => m.dia >= corte);

// ── varre 1 e 2 condições ───────────────────────────────────────────────────
const achados = [];
for (let i = 0; i < CONDS.length; i++) {
  const a = avalia([CONDS[i]]);
  if (a.n >= minN && a.prec >= 80 && a.novos >= 3) achados.push({ regra: CONDS[i].nome, conds: [i], ...a });
  for (let j = i + 1; j < CONDS.length; j++) {
    const b = avalia([CONDS[i], CONDS[j]]);
    if (b.n >= minN && b.prec >= 80 && b.novos >= 3)
      achados.push({ regra: `${CONDS[i].nome} E ${CONDS[j].nome}`, conds: [i, j], ...b });
  }
}
achados.sort((x, y) => y.novos - x.novos || y.prec - x.prec);

const pad = (s, n) => String(s).padEnd(n), p2 = (s, n) => String(s).padStart(n);
console.log(`varridas ${CONDS.length} condicoes, ${CONDS.length * (CONDS.length + 1) / 2} combinacoes`);
console.log(`candidatas com n>=${minN}, precisao>=80% e 3+ estouros novos: ${achados.length}\n`);
console.log(pad("condicao", 54) + p2("n", 5) + p2("certos", 8) + p2("precisao", 10) + p2("IC95", 13) +
  p2("novos", 7) + p2("prec A", 8) + p2("prec B", 8));
console.log("─".repeat(113));
for (const a of achados.slice(0, 25)) {
  const cs = a.conds.map((i) => CONDS[i]);
  const ra = avalia(cs, subA), rb = avalia(cs, subB);
  console.log(pad(a.regra, 54) + p2(a.n, 5) + p2(a.certos, 8) + p2(a.prec.toFixed(1) + "%", 10) +
    p2(`[${a.lo.toFixed(0)};${a.hi.toFixed(0)}]`, 13) + p2(a.novos, 7) +
    p2(ra.n ? ra.prec.toFixed(0) + "%" : "-", 8) + p2(rb.n ? rb.prec.toFixed(0) + "%" : "-", 8));
}
if (!achados.length) console.log("  (nenhuma passou. o teto e o teto.)");
writeFileSync("scripts/_mina.json", JSON.stringify({ motos: motos.length, estouros, jaSalvos, achados }, null, 1));
console.log(`\n[ok] scripts/_mina.json`);
