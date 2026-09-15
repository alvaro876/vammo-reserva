// Exporta, uma linha por moto, o que o RIVERS DECIDIU de verdade num dia fechado.
//
// Por que existe: quando alguém pede "as regras do RIVERS pra ver quais casos teriam sugestão",
// o caminho curto (ler a regra em prosa e reaplicar) dá resposta diferente do motor. Metade das
// regras depende de histórico com carimbo de hora (quando entrou em cada status, execução
// acumulada, quando cada peça entrou), não do estado final da OS. Então em vez de mandar a regra,
// a gente manda a resposta: o mesmo `avaliarOS` de produção, reexecutado minuto a minuto sobre o
// dia inteiro, com o motivo de cada caso que não pegou.
//
//   node scripts/exporta-rivers-por-moto.mjs saida.csv 2026-09-08 2026-09-09 ...
//
// Sem --base, exporta todas; com `--base=1`, só a Mooca.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const argv = process.argv.slice(2);
const baseArg = argv.find((a) => a.startsWith("--base="));
const baseFiltro = baseArg ? Number(baseArg.split("=")[1]) : null;
const rest = argv.filter((a) => !a.startsWith("--"));
const saida = rest[0];
const dias = rest.slice(1);
if (!saida || dias.length === 0) {
  console.error("uso: node scripts/exporta-rivers-por-moto.mjs saida.csv 2026-09-08 [...] [--base=1]");
  process.exit(2);
}

const out = join(mkdtempSync(join(tmpdir(), "rivers-export-")), "replay.mjs");
await build({
  entryPoints: ["src/lib/diario-replay.ts"],
  bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "warning",
  alias: { "@": "./src" },
  define: { "process.env.RIVERS_GUINCHO": '""', "process.env.RIVERS_REGRA_C4": '""',
            "process.env.RIVERS_REGRA_ESTOQUE": '""' },
});
const { analisaOS } = await import(`file://${out}`);

const REGRAS_SLA = new Set(["C3_RELOGIO_150", "C3_TEMPO_COMBINADO", "C3_TEMPO_ALTO",
  "C3_NAO_COMECOU", "C3_SEM_EXECUCAO_90", "C3_CONTA_NAO_FECHA", "C1_FILA_DIAG_LONGA",
  "C1_QA_TARDIA", "C1_ESPERA_SEM_DIAG", "C4_CAPACIDADE"]);

const COLS = [
  ["dia", (x) => x._dia],
  ["base", (x) => x._base],
  ["placa", (x) => x.placa],
  ["os_id", (x) => x.os_id],
  ["chegou", (x) => x.chegou],
  ["pronta", (x) => x.pronta],
  ["minutos_na_oficina", (x) => x.dur_min],
  ["passou_de_3h", (x) => (x.aberta ? "" : x.estourou ? "sim" : "nao")],
  ["minutos_de_excesso", (x) => (x.estourou ? x.excesso : "")],
  ["rivers_sugeriu", (x) => (x.avisou ? "sim" : "nao")],
  ["hora_da_sugestao", (x) => x.avisou_hora ?? ""],
  ["minuto_da_sugestao", (x) => x.avisou_no_min ?? ""],
  ["regra", (x) => x.regra ?? ""],
  ["folga_ate_as_3h", (x) => x.folga_min ?? ""],
  ["sugeriu_com_60min_de_folga", (x) => (x.a_tempo ? "sim" : "nao")],
  ["porque_nao_pegou", (x) => x.motivo_nao_pegou ?? ""],
  ["detalhe", (x) => x.detalhe ?? ""],
  ["no_alvo_da_reserva", (x) => (x.no_universo ? "sim" : "nao")],
  ["fora_do_alvo_porque", (x) => x.fora_do_universo ?? ""],
  ["recebeu_reserva", (x) => (x.recebeu_reserva ? "sim" : "nao")],
  ["ficou_na_mao", (x) => (x.ficou_na_mao ? "sim" : "nao")],
  ["status_no_min_120", (x) => x.status_120 ?? ""],
  ["execucao_acum_no_min_120", (x) => x.exec_120 ?? ""],
  ["estimativa_no_min_120", (x) => x.est_120 ?? ""],
  ["projecao_no_min_120", (x) => x.proj_120 ?? ""],
  ["peca_que_puxou", (x) => x.peca_que_puxou ?? ""],
  ["minutos_da_peca", (x) => x.peca_que_puxou_min ?? ""],
  ["estimativa_final", (x) => x.est_fim ?? ""],
  ["ainda_aberta_no_fim_do_dia", (x) => (x.aberta ? "sim" : "nao")],
];

const esc = (v) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const linhas = [COLS.map((c) => c[0]).join(",")];
let total = 0, pulados = 0;

for (const dia of dias) {
  const arq = `scripts/fixture/diario_${dia}.json`;
  if (!existsSync(arq)) { console.error(`  [pulado] sem fixture: ${dia}`); pulados++; continue; }
  const f = JSON.parse(readFileSync(arq, "utf8"));
  const primeiroAviso = new Map(), pisoLogado = new Set();
  for (const s of f.log) {
    if (s.is_piso) pisoLogado.add(s.os_id);
    if (s.decision !== "RESERVA") continue;
    if (!s.reason_code || !REGRAS_SLA.has(s.reason_code)) continue;
    const ts = Math.floor(new Date(s.created_at).getTime() / 1000);
    const atual = primeiroAviso.get(s.os_id);
    if (atual && atual.ts <= ts) continue;
    const ft = s.features ?? {};
    primeiroAviso.set(s.os_id, { ts, reason_code: s.reason_code, status_atual: s.status_atual,
      est_no_aviso: typeof ft.tempo_estimado_min === "number" ? ft.tempo_estimado_min : null,
      espera_no_aviso: typeof ft.min_desde_chegada === "number" ? ft.min_desde_chegada : null });
  }
  // dia fechado: o replay para no fim do dia. o teto nunca passa de agora.
  const fimDoDia = Math.floor(new Date(`${dia}T23:59:00-03:00`).getTime() / 1000);
  const agora = Math.min(fimDoDia, Math.floor(Date.now() / 1000));

  for (const r of f.linhas) {
    if (baseFiltro !== null && r.base !== baseFiltro) continue;
    const x = analisaOS(r, primeiroAviso.get(r.os_id) ?? null, pisoLogado.has(r.os_id), agora);
    x._dia = dia; x._base = r.base;
    linhas.push(COLS.map((c) => esc(c[1](x))).join(","));
    total++;
  }
}

writeFileSync(saida, "\ufeff" + linhas.join("\n") + "\n", "utf8");
console.log(`[ok] ${saida}`);
console.log(`     ${total} motos${baseFiltro !== null ? ` da base ${baseFiltro}` : ""}, ${dias.length - pulados} dias`);
