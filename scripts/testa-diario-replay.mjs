// Teste do miolo do relatório diário com DADO REAL de produção.
//
// Por que existe: o "por que não pegou" é a coluna mais cara do relatório e a que o
// Alvaro vai olhar todo dia. Ela não pode estrear com bug em produção. Aqui o
// src/lib/diario-replay.ts roda contra um fixture de um dia inteiro (montado por
// metabase_work/fixture_diario.py) e o teste checa as invariantes que importam:
// a quebra fecha, todo estouro sem aviso tem motivo, e nenhum motivo é "OUTRO".
//
//   python metabase_work/fixture_diario.py 2026-09-09     (no repo call-processor)
//   node scripts/testa-diario-replay.mjs 2026-09-09
//
// O bundle é feito na hora com o esbuild que já vem no node_modules do Next.

import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const dia = process.argv[2] ?? "2026-09-09";
const fixture = JSON.parse(readFileSync(`scripts/fixture/diario_${dia}.json`, "utf8"));

const out = join(mkdtempSync(join(tmpdir(), "diario-")), "replay.mjs");
await build({
  entryPoints: ["src/lib/diario-replay.ts"],
  bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "warning",
  alias: { "@": "./src" },
  define: { "process.env.RIVERS_GUINCHO": '""', "process.env.RIVERS_REGRA_C4": '""',
            "process.env.RIVERS_REGRA_ESTOQUE": '""' },
});
const { analisaOS } = await import(`file://${out}`);

// ── monta o que a rota monta ────────────────────────────────────────────────
const REGRAS_SLA = new Set(["C3_RELOGIO_150", "C3_TEMPO_COMBINADO", "C3_TEMPO_ALTO",
  "C3_NAO_COMECOU", "C3_SEM_EXECUCAO_90", "C3_CONTA_NAO_FECHA", "C1_FILA_DIAG_LONGA",
  "C1_QA_TARDIA", "C1_ESPERA_SEM_DIAG", "C4_CAPACIDADE"]);
const bases = [1, 34, 166];
const primeiroAviso = new Map(), pisoLogado = new Set();
for (const s of fixture.log) {
  if (s.is_piso) pisoLogado.add(s.os_id);
  if (s.decision !== "RESERVA") continue;
  if (!s.reason_code || !REGRAS_SLA.has(s.reason_code)) continue;
  if (s.location_id != null && !bases.includes(s.location_id)) continue;
  const ts = Math.floor(new Date(s.created_at).getTime() / 1000);
  const atual = primeiroAviso.get(s.os_id);
  if (atual && atual.ts <= ts) continue;
  const f = s.features ?? {};
  primeiroAviso.set(s.os_id, { ts, reason_code: s.reason_code, status_atual: s.status_atual,
    est_no_aviso: typeof f.tempo_estimado_min === "number" ? f.tempo_estimado_min : null,
    espera_no_aviso: typeof f.min_desde_chegada === "number" ? f.min_desde_chegada : null });
}

// dia fechado: usa o fim do dia. dia de hoje: usa AGORA, senão o replay simula o futuro.
const fimDoDia = Math.floor(new Date(`${dia}T23:59:00-03:00`).getTime() / 1000);
const agora = Math.min(fimDoDia, Math.floor(Date.now() / 1000));
const t0 = Date.now();
const saida = fixture.linhas.map((r) =>
  analisaOS(r, primeiroAviso.get(r.os_id) ?? null, pisoLogado.has(r.os_id), agora));
const ms = Date.now() - t0;

const n = (f) => saida.filter(f).length;
const cx = { A: n((x) => x.caixa === "A"), B: n((x) => x.caixa === "B"),
             C: n((x) => x.caixa === "C"), D: n((x) => x.caixa === "D"), E: n((x) => x.caixa === "E") };

console.log(`\n=== RELATÓRIO DE ${dia} · ${saida.length} motos · replay em ${ms}ms ===\n`);
console.log(`chegaram ${saida.length} = ${n((x) => !x.aberta)} fechadas + ${cx.E} ainda na oficina`);
console.log(`estouraram ${n((x) => x.estourou)} · avisou ${n((x) => x.avisou)} · a tempo ${n((x) => x.a_tempo)}`);
console.log(`\ncaixas: A ${cx.A} + B ${cx.B} + C ${cx.C} + D ${cx.D} + E ${cx.E} = ${cx.A + cx.B + cx.C + cx.D + cx.E}`);

// ── o universo da reserva: a quebra tem que fechar ──
const totalEst = n((x) => x.estourou);
const naMao = n((x) => x.ficou_na_mao);
const comReserva = n((x) => x.estourou && x.no_universo && x.recebeu_reserva);
const foraUniv = n((x) => x.estourou && !x.no_universo);
console.log(`
estouros ${totalEst} = ${naMao} ficaram na mão + ${comReserva} saíram de reserva + ${foraUniv} fora do alvo`);
const fu = {};
for (const x of saida.filter((y) => y.estourou && !y.no_universo)) fu[x.fora_do_universo] = (fu[x.fora_do_universo] ?? 0) + 1;
for (const [k, v] of Object.entries(fu)) console.log(`  fora: ${v} ${k}`);

const porMotivo = {};
for (const x of saida.filter((y) => y.caixa === "C" && y.no_universo)) porMotivo[x.motivo_nao_pegou] = (porMotivo[x.motivo_nao_pegou] ?? 0) + 1;
console.log(`\npor que não pegou os ${n((x) => x.caixa === "C" && x.no_universo)} estouros do alvo:`);
for (const [k, v] of Object.entries(porMotivo).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(3)}  ${k}`);

console.log(`\nexemplos (os 6 piores estouros sem aviso a tempo):`);
for (const x of saida.filter((y) => y.caixa === "C" && y.no_universo).sort((a, b) => b.excesso - a.excesso).slice(0, 6)) {
  console.log(`  ${x.placa} ${x.chegou}→${x.pronta} ${x.dur_min}min (+${x.excesso})`);
  console.log(`     ${x.motivo_nao_pegou}: ${x.detalhe}`);
  console.log(`     no min 120: ${x.status_120} · exec ${x.exec_120} · est ${x.est_120} · conta ${x.proj_120}`
            + (x.min_conta_fecha !== null ? ` · fecharia aos ${x.min_conta_fecha}` : " · nunca fecha"));
  console.log(`     peça: ${x.peca_que_puxou || "(nenhuma)"} ${x.peca_que_puxou_min}min · est final ${x.est_fim}`);
}

console.log(`\nexemplos (avisos certos):`);
for (const x of saida.filter((y) => y.caixa === "A").slice(0, 4)) {
  console.log(`  ${x.placa} ${x.regra} às ${x.avisou_hora} (min ${x.avisou_no_min}, folga ${x.folga_min}) · ficou ${x.dur_min}min`);
}

// ── invariantes ─────────────────────────────────────────────────────────────
const erros = [];
if (cx.A + cx.B + cx.C + cx.D + cx.E !== saida.length) erros.push("as caixas não somam o total");
const cNoUniverso = n((x) => x.caixa === "C" && x.no_universo);
const somaMotivos = Object.values(porMotivo).reduce((a, b) => a + b, 0);
if (somaMotivos !== cNoUniverso) erros.push(`os motivos somam ${somaMotivos}, deviam somar ${cNoUniverso}`);
if (naMao + comReserva + foraUniv !== totalEst) erros.push(`a quebra dos estouros não fecha: ${naMao}+${comReserva}+${foraUniv} != ${totalEst}`);
if (porMotivo.OUTRO) erros.push(`${porMotivo.OUTRO} motos caíram em OUTRO (não classificadas)`);
for (const x of saida) {
  // moto ainda na oficina (caixa E) nao leva motivo: o dia dela nao acabou
  if (!x.a_tempo && !x.aberta && !x.motivo_nao_pegou) erros.push(`OS ${x.os_id} sem aviso a tempo e sem motivo`);
  if (x.aberta && x.motivo_nao_pegou) erros.push(`OS ${x.os_id} ainda aberta e ja tem motivo`);
  if (x.a_tempo && x.motivo_nao_pegou) erros.push(`OS ${x.os_id} avisou a tempo e mesmo assim tem motivo`);
  if (x.folga_min !== null && x.avisou_no_min !== null && x.folga_min !== 180 - x.avisou_no_min)
    erros.push(`OS ${x.os_id} folga não bate com o minuto do aviso`);
}
const divT0 = saida.filter((x) => x.avisou_no_min !== null && x._espera_no_log !== null
  && Math.abs(x._espera_no_log - x.avisou_no_min) > 3);
const semLog = saida.filter((x) => x._replay_a_tempo && !x.a_tempo);
const semReplay = saida.filter((x) => x.a_tempo && !x._replay_a_tempo);
console.log(`\nconferência: relógio divergente do log em ${divT0.length}`
          + ` · replay diz que dava e o log não tem: ${semLog.length}`
          + ` · log tem e o replay não acha: ${semReplay.length}`);
if (semLog.length) {
  console.log("  replay sem log (amostra):");
  for (const x of semLog.slice(0, 5))
    console.log(`    ${x.placa} replay ${x.replay_regra} aos ${x.replay_min} min · log: ${x.regra ?? "nada"}`);
}

console.log(erros.length ? `\n✗ ${erros.length} PROBLEMAS:` : "\n✓ todas as invariantes passaram");
for (const e of erros.slice(0, 12)) console.log("   " + e);
process.exit(erros.length ? 1 : 0);
