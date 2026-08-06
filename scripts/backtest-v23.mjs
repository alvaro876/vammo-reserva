// BACKTEST tick-a-tick do RIVERS — instrumenta qualquer configuração de regras
// contra a história real (exports bt-meta/bt-status/bt-itens.json de 92 dias).
//
// Uso: node scripts/backtest-v23.mjs <config> [DIAS=5]
//   config: v22 | f1 | f1p | cls (ver CONFIGS no fim)
//
// Réplica do motor: a cada tique de 10min reconstrói o que o RIVERS veria
// (status vigente, peças registradas até ali, execução acumulada) e roda as
// regras na ordem real. Primeiro RESERVA por OS vence. Score contra o desfecho.
import { readFileSync } from "fs";
import { join } from "path";
const ROOT = join(import.meta.dirname, "..");
const DL = "C:\\Users\\Usuário\\Downloads\\Metabase";

// ── mapa de tempos igual ao motor ────────────────────────────────────────────
const tp = readFileSync(join(ROOT, "src/lib/tempo-pecas.ts"), "utf8");
const MAPA = new Map();
for (const m of tp.slice(tp.indexOf("MINUTOS_POR_PECA")).matchAll(/(\d+):\s*(\d+)/g)) MAPA.set(+m[1], +m[2]);
const FATOR = [null, 1.39, 1.11, 1.04, 1.04, 1.0, 1.03, 0.95, 0.94];
const QA = new Set(["AWAITING_QA", "IN_QA", "QA_REJECTED"]);
globalThis.CFG_ATIVA = {};
const DIRECAO = new Set([229, 240, 340, 359, 228]); // cluster direção/rodante/discos

// ── carga ─────────────────────────────────────────────────────────────────────
const meta = JSON.parse(readFileSync(join(DL, "bt-meta.json"), "utf8"));
const status = JSON.parse(readFileSync(join(DL, "bt-status.json"), "utf8"));
const itens = JSON.parse(readFileSync(join(DL, "bt-itens.json"), "utf8"));
const OS = new Map();
for (const m of meta) OS.set(m.so_id, { ...m, ev: [], it: [] });
for (const s of status) OS.get(s.so_id)?.ev.push([+s.ts, s.status]);
for (const i of itens) OS.get(i.so_id)?.it.push([+i.ts, +i.ig, +i.qty, +i.tt]);
const AGORA = Math.floor(Date.now() / 1000);

for (const o of OS.values()) {
  o.ev.sort((a, b) => a[0] - b[0]);
  o.it.sort((a, b) => a[0] - b[0]);
  o.open = o.ev.find((e) => e[1] === "OPEN")?.[0] ?? 0;
  o.cx = o.ev.find((e) => e[1] === "AWAITING_CX")?.[0] ?? 0;
  o.cancel = o.ev.some((e) => e[1] === "CANCELLED");
  o.rej = o.ev.find((e) => e[1] === "QA_REJECTED")?.[0] ?? 0;
}

// estado da OS no instante t
function estado(o, t) {
  let st = "OPEN", exec = 0, execIni = 0, emExec = false, chegouMec = false;
  let stIni = o.open;
  for (const [ts, s] of o.ev) {
    if (ts > t) break;
    if (s === "AWAITING_MECHANIC") chegouMec = true;
    if (emExec && s !== "IN_PROGRESS") { exec += ts - execIni; emExec = false; }
    if (!emExec && s === "IN_PROGRESS") { emExec = true; execIni = ts; }
    st = s; stIni = ts;
  }
  if (emExec) exec += t - execIni;
  let soma = 0; const grupos = new Set(); let temDirecao = false;
  for (const [ts, ig, qty, tt] of o.it) {
    if (ts > t) break;
    soma += qty * (MAPA.get(ig) ?? (tt > 0 ? tt : 15));
    grupos.add(ig);
    if (DIRECAO.has(ig)) temDirecao = true;
  }
  const n = grupos.size;
  let fat = FATOR[Math.min(n, 8)] ?? 0.94;
  if (CFG_ATIVA.fator9 && n >= 9) fat = n >= 13 ? CFG_ATIVA.fator13 : CFG_ATIVA.fator9;
  const est = n > 0 ? Math.round(soma * fat + 25) : 0;
  return { st, stIni, exec: exec / 60, est, n, temDirecao, chegouMec };
}

// ── regras (retornam nome da regra ou null) ───────────────────────────────────
function regrasBase(o, t, e, cfg, mem) {
  const min = (t - o.open) / 60;
  const minSt = (t - e.stIni) / 60;
  const emQa = QA.has(e.st);
  const restanteBruto = emQa ? (cfg.qaRej && e.st === "QA_REJECTED" ? 45 : 0) : Math.max(0, e.est - e.exec);
  if (o.so_type === "INSURANCE_QUOTE") {
    // gate: vistoria com diagnóstico pequeno já feito não trava a moto
    if (!cfg.hardGate || e.est === 0 || min + restanteBruto + 8 > 180) return "HARD";
  }
  if (o.tem_placa) return "PLACA";
  if (!e.chegouMec && e.st === "OPEN" && min > 240) return "ANOMALIA";
  if (e.est === 0 && min > 150) return "ESPERA_SEM_DIAG";
  if (e.st === "OPEN" && min > 90) return "FILA_DIAG";
  if (e.st === "AWAITING_PARTS" && minSt >= 30 && min >= 90 && min <= 480) return "TRAVADA_PECA";
  if ((e.st === "AWAITING_SERVICE" || e.st === "AWAITING_VMGMT") && minSt >= 30 && min >= 90 && min <= 480) return "TERCEIRO";

  // fase 1 novas
  if (cfg.relogio150 && !emQa && min >= (cfg.relogioMin ?? 150)) {
    // gate: moto em execução com restante curto está terminando — não é caso de reserva.
    // v2 (05/08): o gate original usava só o restante ESTIMADO (est-exec), que é
    // exatamente o número que infla — 4 erros do dia 05/08 tinham restante estimado
    // de 40-71min com restante REAL de 9-24min. Duas defesas extras, testáveis:
    //  (a) subir o limiar do gate (relogioGateMin, default 30)
    //  (b) exigir ritmo de execução: exec_feita/min_desde_open >= relogioGateRatio
    //      (mecânico com a moto na mão a maior parte do tempo tende a estar perto do fim)
    const limiarGate = cfg.relogioGateMin ?? 30;
    const ritmo = min > 0 ? e.exec / min : 0;
    const quaseProntaPorEstimativa = e.st === "IN_PROGRESS" && e.est > 0 && restanteBruto + 8 < limiarGate;
    const quaseProntaPorRitmo = cfg.relogioGateRatio != null && e.st === "IN_PROGRESS" && ritmo >= cfg.relogioGateRatio;
    if (!cfg.relogioGate || !(quaseProntaPorEstimativa || quaseProntaPorRitmo)) return "RELOGIO_150";
  }
  if (cfg.qaRej && o.rej && t >= o.rej && (o.rej - o.open) / 60 >= 165) return "QA_REJ_165";

  // tempo
  let restante = restanteBruto;
  const proj = min + restante + 8;
  const persistOk = (nome) => {
    if (!cfg.persist) return true;
    const ok = mem.last === nome; mem.last = nome; return ok;
  };
  if (!emQa && e.est > 240 && persistOk("ALTO")) return "ALTO";
  if (e.est > 0 && min < 480 && proj > 180 && restante + 8 >= 30) {
    if (!cfg.combFirmeEst || e.est >= 180) { if (persistOk("COMB")) return "COMB"; }
  }
  mem.last = null;
  return null;
}

// ── replay ────────────────────────────────────────────────────────────────────
function roda(cfg, diasJanela) {
  const corte = AGORA - diasJanela * 86400;
  const porDia = new Map();
  let agg = { fired: 0, tp: 0, fp: 0, blows: 0, caught180: 0, leads: [], porRegra: {} };
  for (const o of OS.values()) {
    if (!o.open || o.cancel || o.open < corte) continue;
    const dur = o.cx > 0 ? (o.cx - o.open) / 60 : (AGORA - o.open) / 60;
    if (o.cx === 0 && dur < 180) continue; // ainda em aberto e sem desfecho
    const blew = dur > 180;
    const fim = o.cx > 0 ? Math.min(o.cx, o.open + 8 * 3600) : Math.min(AGORA, o.open + 8 * 3600);
    let fire = null; const mem = { last: null };
    for (let t = o.open + 600; t <= fim; t += 600) {
      const e = estado(o, t);
      const r = regrasBase(o, t, e, cfg, mem);
      if (r) { fire = { t, r }; break; }
    }
    const dia = new Date((o.open - 3 * 3600) * 1000).toISOString().slice(0, 10);
    if (!porDia.has(dia)) porDia.set(dia, { fired: 0, tp: 0, fp: 0, blows: 0, caught180: 0 });
    const d = porDia.get(dia);
    if (blew) { agg.blows++; d.blows++; }
    if (fire) {
      agg.fired++; d.fired++;
      const pr = (agg.porRegra[fire.r] ??= { tp: 0, fp: 0 });
      if (blew) { agg.tp++; d.tp++; pr.tp++; } else {
        agg.fp++; d.fp++; pr.fp++;
        if (process.env.DUMP && o.open >= AGORA - 6 * 86400)
          console.log(`  FP ${dia} os=${o.so_id} regra=${fire.r} disparo@${((fire.t - o.open) / 60).toFixed(0)}min real=${dur.toFixed(0)}min est_fim=${estado(o, fim).est} n=${estado(o, fim).n}`);
      }
      if (blew && (fire.t - o.open) / 60 < 180) {
        agg.caught180++; d.caught180++;
        agg.leads.push(180 - (fire.t - o.open) / 60);
      }
    }
  }
  return { porDia, agg };
}

const CONFIGS = {
  v22: {},
  f1: { relogio150: true, qaRej: true, combFirmeEst: true },
  f2: { relogio150: true, qaRej: true, combFirmeEst: true, relogioGate: true, hardGate: true, fator9: 0.8, fator13: 0.75 },
  f2b: { relogio150: true, qaRej: true, combFirmeEst: true, relogioGate: true, hardGate: true, fator9: 0.85, fator13: 0.8 },
  f2c: { relogio150: true, qaRej: true, combFirmeEst: true, relogioGate: true, hardGate: true, fator9: 0.75, fator13: 0.7 },
  f2p: { relogio150: true, qaRej: true, combFirmeEst: true, relogioGate: true, hardGate: true, fator9: 0.8, fator13: 0.75, persist: true },
  f2r160: { relogio150: true, relogioMin: 160, qaRej: true, combFirmeEst: true, relogioGate: true, hardGate: true, fator9: 0.8, fator13: 0.75 },
  g45: { relogio150: true, qaRej: true, combFirmeEst: true, relogioGate: true, hardGate: true, fator9: 0.85, fator13: 0.8, relogioGateMin: 45 },
  g60: { relogio150: true, qaRej: true, combFirmeEst: true, relogioGate: true, hardGate: true, fator9: 0.85, fator13: 0.8, relogioGateMin: 60 },
  g90: { relogio150: true, qaRej: true, combFirmeEst: true, relogioGate: true, hardGate: true, fator9: 0.85, fator13: 0.8, relogioGateMin: 90 },
  gr70: { relogio150: true, qaRej: true, combFirmeEst: true, relogioGate: true, hardGate: true, fator9: 0.85, fator13: 0.8, relogioGateRatio: 0.70 },
  gr75: { relogio150: true, qaRej: true, combFirmeEst: true, relogioGate: true, hardGate: true, fator9: 0.85, fator13: 0.8, relogioGateRatio: 0.75 },
  gr80: { relogio150: true, qaRej: true, combFirmeEst: true, relogioGate: true, hardGate: true, fator9: 0.85, fator13: 0.8, relogioGateRatio: 0.80 },
  g60r75: { relogio150: true, qaRej: true, combFirmeEst: true, relogioGate: true, hardGate: true, fator9: 0.85, fator13: 0.8, relogioGateMin: 60, relogioGateRatio: 0.75 },
  g75: { relogio150: true, qaRej: true, combFirmeEst: true, relogioGate: true, hardGate: true, fator9: 0.85, fator13: 0.8, relogioGateMin: 75 },
  g85: { relogio150: true, qaRej: true, combFirmeEst: true, relogioGate: true, hardGate: true, fator9: 0.85, fator13: 0.8, relogioGateMin: 85 },
};
const nome = process.argv[2] || "f1";
const dias = +(process.argv[3] || 92);
const cfg = CONFIGS[nome] ?? CONFIGS.f1;
globalThis.CFG_ATIVA = cfg;
const { porDia, agg } = roda(cfg, dias);
const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) + "%" : "-");
console.log(`\nCONFIG ${nome} | janela ${dias}d | universo piso Mooca`);
console.log(`geral: marcou ${agg.fired} | TP ${agg.tp} | FP ${agg.fp} | precisao ${pct(agg.tp, agg.tp + agg.fp)} | estouros ${agg.blows} | recall<180 ${pct(agg.caught180, agg.blows)} | lead mediano ${agg.leads.sort((a, b) => a - b)[Math.floor(agg.leads.length / 2)]?.toFixed(0) ?? "-"}min`);
console.log("por regra:", Object.entries(agg.porRegra).map(([k, v]) => `${k} ${v.tp}/${v.tp + v.fp} (${pct(v.tp, v.tp + v.fp)})`).join(" · "));
const ult = [...porDia.keys()].sort().slice(-6);
console.log("dia         marcou  TP  FP  prec    estouros  recall<180");
for (const k of ult) {
  const d = porDia.get(k);
  console.log(`${k}  ${String(d.fired).padStart(4)} ${String(d.tp).padStart(4)} ${String(d.fp).padStart(3)}  ${pct(d.tp, d.tp + d.fp).padStart(6)}  ${String(d.blows).padStart(5)}     ${pct(d.caught180, d.blows).padStart(6)}`);
}
