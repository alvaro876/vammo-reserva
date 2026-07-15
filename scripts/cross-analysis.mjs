import { fileURLToPath as __furl } from "url";
const ROOT = __furl(new URL("..", import.meta.url)).replace(/[\\/]$/, "");
const DL = process.env.METABASE_DIR || (ROOT + "\\data");
// Análise cruzada RIVERS × Oficina (Maestro) — v3, com desfecho real embutido.
//
// Fontes (mesmo snapshot):
//   A. rivers_suggestion (Supabase) — log do algoritmo desde 25/06 (toda decisão, por OS/versão)
//   B. Downloads/Metabase/rivers-cross-v3.json — check-ins de manutenção do Maestro
//      + reserva (ofertada/entregue/motivo) + desfecho real (concluída? permanência em min)
//
// Definições:
//   RIVERS mandou   = existe ao menos 1 log RESERVA pra OS (qualquer versão; 1ª ocorrência)
//   Oficina decidiu = reserve_offered_at OU reserve_delivered_at preenchido no check-in
//   Desfecho real   = permanência da OS (abertura→COMPLETED); NULL = ainda aberta
//   Universo        = OS de check-in QUE o RIVERS avaliou (aparecem no log)
//
// Saída: calib/cross-dashboard.json + checagens de qualidade no stdout.

import { readFileSync, writeFileSync } from "fs";

const env = {};
for (const line of readFileSync(ROOT + "\\.env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const URL = env.NEXT_PUBLIC_SUPABASE_URL;
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY };

// ── A. log do RIVERS (paginado, com versão) ──────────────────────────────────
const sugg = [];
for (let from = 0; ; from += 1000) {
  const r = await fetch(
    `${URL}/rest/v1/rivers_suggestion?select=os_id,decision,fired_layer,created_at,algo_version&created_at=gte.2026-06-25&order=created_at.asc,id.asc`,
    { headers: { ...H, Range: `${from}-${from + 999}` } }
  );
  const page = await r.json();
  if (!Array.isArray(page)) throw new Error("supabase: " + JSON.stringify(page).slice(0, 150));
  sugg.push(...page);
  if (page.length < 1000) break;
}

// ── B. Maestro (carrega antes pra derivar o instante do snapshot) ────────────
// v5: além de permanencia_min (→COMPLETED), traz pronta_min (→1º AWAITING_CX = serviço
// pronto). O tempo que importa pro cliente é ATÉ FICAR PRONTA — depois disso a moto
// costuma estar esperando o cliente buscar (que, com reserva na mão, não tem pressa).
const maestro = JSON.parse(readFileSync(DL + "\\rivers-cross-v7.json", "utf8"));
// tempo útil = o que ocorrer primeiro entre "pronta" e "concluída"
const tempoUtil = (m) =>
  m.pronta_min != null && m.permanencia_min != null ? Math.min(m.pronta_min, m.permanencia_min)
  : m.pronta_min != null ? m.pronta_min
  : m.permanencia_min;

// AGORA = instante do snapshot do Maestro (maior timestamp presente no export).
// O log do Supabase é cortado nesse mesmo instante — as duas fontes ficam alinhadas.
const AGORA = Math.max(
  ...maestro.map((m) => Date.parse(m.os_criada_em) || 0),
  ...maestro.map((m) => (m.ofertada_em ? Date.parse(m.ofertada_em) : 0))
);

const algo = new Map(); // os_id -> { reserva, ts (1ª RESERVA), regra, versoes }
for (const s of sugg) {
  if (Date.parse(s.created_at) > AGORA) continue; // além do snapshot do Maestro
  const a = algo.get(s.os_id) ?? { reserva: false, ts: null, regra: null, versoes: new Set() };
  a.versoes.add(s.algo_version);
  if (s.decision === "RESERVA" && !a.reserva) {
    a.reserva = true; a.ts = Date.parse(s.created_at); a.regra = s.fired_layer;
  }
  algo.set(s.os_id, a);
}

// ── C. cruzamento ────────────────────────────────────────────────────────────
// Serviço especial (awaiting_special_service) fica FORA do universo (decisão da
// operação, 03/07): é um fluxo próprio, com decisão de reserva própria — não é
// papel do RIVERS cobrir. A exclusão vale pros DOIS lados (acertos e furos).
const ESPECIAL = "awaiting_special_service";
const tp = [], fp = [], miss = []; let tn = 0; const foraDoRadar = []; const especiais = [];
for (const m of maestro) {
  const a = algo.get(Number(m.os_id));
  const oficina = m.ofertada === 1 || m.entregue === 1;
  if (oficina && m.motivo_oficina === ESPECIAL) { especiais.push(m); continue; }
  if (!a) { if (oficina) foraDoRadar.push(m); continue; }
  if (a.reserva && oficina) tp.push({ m, a });
  else if (a.reserva && !oficina) fp.push({ m, a });
  else if (!a.reserva && oficina) miss.push({ m, a });
  else tn++;
}

const conta = (arr, key) => {
  const o = {};
  for (const x of arr) { const k = key(x) ?? "(sem)"; o[k] = (o[k] || 0) + 1; }
  return o;
};

// desfecho real de um grupo. 3 estados: COMPLETED (permanência real), CANCELLED
// (sem desfecho — moto normalmente segue em outra OS; fora das contas de espera),
// demais = em atendimento (espera até o snapshot conta pro ">3h").
// mensurável = ficou pronta ou concluiu (tempo útil conhecido); cancelada sem tempo
// útil fica fora; "em atendimento" = ainda sendo trabalhada (idade conta pro >3h).
function desfecho(arr) {
  const mens = arr.filter(({ m }) => tempoUtil(m) != null);
  const cancel = arr.filter(({ m }) => tempoUtil(m) == null && m.status_atual === "CANCELLED");
  const abertas = arr.filter(({ m }) => tempoUtil(m) == null && m.status_atual !== "CANCELLED");
  const tempos = mens.map(({ m }) => tempoUtil(m)).sort((a, b) => a - b);
  const abertas3h = abertas.filter(({ m }) => (AGORA - Date.parse(m.os_criada_em)) / 60000 > 180).length;
  return {
    n: arr.length,
    mensuraveis: mens.length,
    passou_3h_mensuraveis: mens.filter(({ m }) => tempoUtil(m) > 180).length,
    canceladas: cancel.length,
    em_atendimento: abertas.length,
    em_atendimento_ja_passou_3h: abertas3h,
    passou_3h_total: mens.filter(({ m }) => tempoUtil(m) > 180).length + abertas3h,
    validas: arr.length - cancel.length,
    mediana_min: tempos.length ? tempos[Math.floor(tempos.length / 2)] : null,
  };
}

// timing (1ª RESERVA do RIVERS × oferta da oficina), com regra
const timing = tp
  .filter(({ m }) => m.ofertada_em)
  .map(({ m, a }) => ({ delta: Math.round((Date.parse(m.ofertada_em) - a.ts) / 60000), regra: a.regra }));

// evolução por dia (dia SP), com quebra por base no lado do RIVERS
// (pergunta do Guida: "40/dia me preocupa — quebra por base, deve ser a Mooca")
const diaSP = (ts) => new Date(ts - 3 * 3600e3).toISOString().slice(5, 10);
const porDia = {};
const diaVazio = () => ({ oficina: 0, rivers: 0, rivers_mooca: 0, rivers_osasco: 0, rivers_sbc: 0 });
for (const { m } of [...tp, ...miss]) {
  if (!m.ofertada_em) continue;
  const d = diaSP(Date.parse(m.ofertada_em));
  (porDia[d] = porDia[d] || diaVazio()).oficina++;
}
for (const { m, a } of [...tp, ...fp]) {
  const d = diaSP(a.ts);
  const pd = (porDia[d] = porDia[d] || diaVazio());
  pd.rivers++;
  if (Number(m.base) === 1) pd.rivers_mooca++;
  else if (Number(m.base) === 34) pd.rivers_osasco++;
  else pd.rivers_sbc++;
}

// A QUEBRA que o Guida pediu: os "só RIVERS" (FP) por regra × desfecho real.
// Responde "por que ele sugeriu e o que aconteceu com a moto?"
const fpQuebra = {};
for (const { m, a } of fp) {
  const q = (fpQuebra[a.regra] = fpQuebra[a.regra] || { passou_3h: 0, nao_passou: 0, em_atendimento: 0 });
  const t = tempoUtil(m);
  if (t != null) (t > 180 ? q.passou_3h++ : q.nao_passou++);
  else if (m.status_atual !== "CANCELLED" && (AGORA - Date.parse(m.os_criada_em)) / 60000 > 180) q.passou_3h++;
  else q.em_atendimento++;
}

// piores furos (miss): concluídas por permanência real; em-atendimento por idade;
// canceladas EXCLUÍDAS (sem desfecho medível — a moto normalmente segue em outra OS)
const pioresMiss = miss
  .filter(({ m }) => tempoUtil(m) != null || m.status_atual !== "CANCELLED")
  .map(({ m }) => ({
    os_id: m.os_id, placa: m.placa, base: Number(m.base), motivo: m.motivo_oficina,
    horas: tempoUtil(m) != null
      ? Math.round(tempoUtil(m) / 6) / 10
      : Math.round((AGORA - Date.parse(m.os_criada_em)) / 360000) / 10,
    em_atendimento: tempoUtil(m) == null,
  }))
  .sort((a, b) => b.horas - a.horas);

// ── D. checagens de qualidade ────────────────────────────────────────────────
const nAval = tp.length + fp.length + miss.length + tn;
const oficinaTotal = tp.length + miss.length;

// segmentação por versão do algoritmo (disclosure: v0.3 só existe desde 02/07 à tarde)
const reservaPorVersao = { so_v02: 0, so_v03: 0, ambas: 0 };
for (const [, a] of algo) {
  if (!a.reserva) continue;
  const v2 = a.versoes.has("0.2.0"), v3 = a.versoes.has("0.3.0");
  if (v2 && v3) reservaPorVersao.ambas++;
  else if (v3) reservaPorVersao.so_v03++;
  else reservaPorVersao.so_v02++;
}

const check = {
  snapshot: new Date(AGORA).toISOString(),
  especiais_excluidas: especiais.length,
  checkins_total: maestro.length,
  cobertura_rivers_pct: Math.round((100 * nAval) / maestro.length),
  ofertadas_sem_entrega: [...tp, ...miss].filter(({ m }) => m.ofertada === 1 && m.entregue === 0).length,
  entregues: [...tp, ...miss].filter(({ m }) => m.entregue === 1).length,
  recall_sistema_incl_fora_radar: Math.round((100 * tp.length) / (oficinaTotal + foraDoRadar.length)),
  reservaPorVersao,
};

const out = {
  gerado_em: new Date(AGORA).toISOString(),
  definicoes: "oficina=ofertada|entregue; rivers=1º log RESERVA; desfecho=abertura→COMPLETED",
  contagens: {
    universo: nAval, tp: tp.length, fp: fp.length, miss: miss.length, tn,
    oficina_total: oficinaTotal, rivers_total: tp.length + fp.length,
    fora_do_radar: foraDoRadar.length,
    recall: Math.round((100 * tp.length) / oficinaTotal),
  },
  desfechos: { fp: desfecho(fp), miss: desfecho(miss), tp: desfecho(tp) },
  tpRegra: conta(tp, ({ a }) => a.regra),
  fpRegra: conta(fp, ({ a }) => a.regra),
  tpMotivo: conta(tp, ({ m }) => m.motivo_oficina),
  missMotivo: conta(miss, ({ m }) => m.motivo_oficina),
  porBase: Object.fromEntries([1, 34, 166].map((b) => [b, {
    tp: tp.filter(({ m }) => Number(m.base) === b).length,
    fp: fp.filter(({ m }) => Number(m.base) === b).length,
    miss: miss.filter(({ m }) => Number(m.base) === b).length,
  }])),
  timing, porDia, pioresMiss, fpQuebra,
  check,
  amostras: {
    tp: tp.slice(0, 3).map(({ m, a }) => ({ os: m.os_id, placa: m.placa, regra: a.regra, motivo_ofc: m.motivo_oficina, rivers_ts: new Date(a.ts).toISOString(), oferta: m.ofertada_em })),
    fp_passou3h: fp.filter(({ m }) => m.status_atual === "COMPLETED" && m.permanencia_min > 180).slice(0, 3).map(({ m, a }) => ({ os: m.os_id, placa: m.placa, regra: a.regra, permanencia_min: m.permanencia_min })),
    miss: miss.slice(0, 3).map(({ m }) => ({ os: m.os_id, placa: m.placa, motivo: m.motivo_oficina, permanencia_min: m.permanencia_min, status: m.status_atual })),
  },
};
writeFileSync(ROOT + "\\calib\\cross-dashboard.json", JSON.stringify(out, null, 1));

console.log("CONTAGENS:", JSON.stringify(out.contagens));
console.log("CHECK:", JSON.stringify(out.check));
console.log("DESFECHO FP:", JSON.stringify(out.desfechos.fp));
console.log("DESFECHO MISS:", JSON.stringify(out.desfechos.miss));
console.log("TIMING: n=" + timing.length + " antes=" + timing.filter((t) => t.delta > 0).length);
console.log("PIORES MISS:", JSON.stringify(pioresMiss.slice(0, 6)));
console.log("FP QUEBRA:", JSON.stringify(fpQuebra));
console.log("PORBASE:", JSON.stringify(out.porBase));
console.log("AMOSTRAS:", JSON.stringify(out.amostras, null, 1));
