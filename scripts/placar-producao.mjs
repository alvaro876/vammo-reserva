// Placar de PRODUCAO das regras, por regra, a partir dos fixtures diarios ja montados.
//
// Por que existe: o backtest do v0.35 prometeu numeros por regra (90,0% pra "60 min sem
// diagnostico", 83,0% pra "90 min sem execucao", 84,5% pra "a conta nao fecha"). Isso foi
// medido em cima do piloto de 24 dias. Producao e outra coisa, e ate agora ninguem tinha
// comparado. Este script cruza o log do motor com o desfecho real, dia a dia.
//
//   node scripts/placar-producao.mjs 2026-09-11 2026-09-12
//
// Regua igual a de todo o projeto: primeiro alerta de regra SLA por OS, e so conta como
// "a tempo" o que sai com 60+ min de folga. Denominador = os estouros do proprio dia.

import { readFileSync } from "node:fs";

const REGRAS_SLA = new Set(["C3_RELOGIO_150", "C3_TEMPO_COMBINADO", "C3_TEMPO_ALTO",
  "C3_NAO_COMECOU", "C3_SEM_EXECUCAO_90", "C3_CONTA_NAO_FECHA", "C1_FILA_DIAG_LONGA",
  "C1_QA_TARDIA", "C1_ESPERA_SEM_DIAG", "C4_CAPACIDADE"]);
const NOVA = new Set(["C3_SEM_EXECUCAO_90", "C3_CONTA_NAO_FECHA", "C1_FILA_DIAG_LONGA"]);
// o que o backtest do v0.35 prometeu, pra comparar lado a lado
const PROMETIDO = {
  C1_FILA_DIAG_LONGA: { alertas: 20, certos: 18, prec: 90.0 },
  C3_SEM_EXECUCAO_90: { alertas: 88, certos: 73, prec: 83.0 },
  C3_CONTA_NAO_FECHA: { alertas: 71, certos: 60, prec: 84.5 },
};
const LIMITE = 180, ANTEC = 60;

const dias = process.argv.slice(2);
const linhas = new Map();   // regra -> {alertas, certos, leads[]}
let estouros = 0, chegaram = 0, pegosATempo = 0, alertasTotal = 0;
let foraDoAlvo = 0, ficouNaMao = 0, saiuDeReserva = 0;

for (const dia of dias) {
  const f = JSON.parse(readFileSync(`scripts/fixture/diario_${dia}.json`, "utf8"));
  const porOs = new Map(f.linhas.map((r) => [r.os_id, r]));
  const piso = new Set(), primeiro = new Map();
  for (const s of f.log) {
    if (s.is_piso) piso.add(s.os_id);
    if (s.decision !== "RESERVA" || !REGRAS_SLA.has(s.reason_code ?? "")) continue;
    const ts = Math.floor(new Date(s.created_at).getTime() / 1000);
    const a = primeiro.get(s.os_id);
    if (!a || ts < a.ts) primeiro.set(s.os_id, { ts, regra: s.reason_code });
  }
  for (const r of f.linhas) {
    const dur = r.pronta_ts > 0 ? Math.round((r.pronta_ts - r.t0) / 60) : -1;
    if (dur < 0) continue;                       // ainda aberta: fora do denominador
    // O UNIVERSO DA RESERVA (13/09): guincho e OS sem nenhum sinal de cliente na base saem
    // da conta, porque nao existe aviso que resolva. A evidencia de cliente e a UNIAO dos
    // sinais (chamada, oferta, entrega), nunca so a chamada: medido no piloto, 18 de 26 OS
    // sem `called_at` tinham oferta de reserva, ou seja havia cliente e faltava o carimbo.
    const temCliente = r.chamado_ts > 0 || r.ofertou === 1 || r.chamou === 1
      || ["RESERVE_DELIVERED", "BIKE_REPLACED"].includes(r.service_conclusion);
    if (r.guincho === 1 || !temCliente) { if (dur > LIMITE) foraDoAlvo++; continue; }
    chegaram++;
    const estourou = dur > LIMITE;
    if (estourou) {
      estouros++;
      if (["RESERVE_DELIVERED", "BIKE_REPLACED"].includes(r.service_conclusion)) saiuDeReserva++;
      else ficouNaMao++;
    }
    const a = primeiro.get(r.os_id);
    if (!a || !piso.has(r.os_id)) continue;
    const min = Math.round((a.ts - r.t0) / 60);
    const folga = LIMITE - min;
    if (folga < ANTEC) continue;                 // alerta tardio nao conta
    alertasTotal++;
    if (estourou) pegosATempo++;
    const e = linhas.get(a.regra) ?? { alertas: 0, certos: 0, leads: [] };
    e.alertas++; if (estourou) e.certos++; e.leads.push(folga);
    linhas.set(a.regra, e);
  }
}

const med = (v) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const pad = (s, n) => String(s).padEnd(n);
const num = (s, n) => String(s).padStart(n);

console.log(`\n=== PRODUCAO · ${dias.join(" e ")} · alerta com 60+ min de folga ===`);
console.log(`${chegaram} motos no alvo, ${estouros} estouros, ${alertasTotal} alertas = ${pegosATempo} certos + ${alertasTotal - pegosATempo} errados`);
console.log(`estouros ${estouros + foraDoAlvo} = ${ficouNaMao} ficaram na mao + ${saiuDeReserva} sairam de reserva + ${foraDoAlvo} fora do alvo`);
console.log(`precisao ${alertasTotal ? (100 * pegosATempo / alertasTotal).toFixed(1) : "—"}% · alcance ${estouros ? (100 * pegosATempo / estouros).toFixed(1) : "—"}%\n`);

console.log(`${pad("regra", 24)}${num("alertas", 8)}${num("certos", 8)}${num("errados", 8)}${num("precisao", 10)}${num("folga med", 11)}   backtest`);
console.log("─".repeat(94));
for (const [regra, e] of [...linhas.entries()].sort((a, b) => b[1].alertas - a[1].alertas)) {
  const p = PROMETIDO[regra];
  const marca = NOVA.has(regra) ? "* " : "  ";
  const prec = (100 * e.certos / e.alertas).toFixed(1) + "%";
  const bt = p ? `prometia ${p.prec}%` : "—";
  console.log(marca + pad(regra, 22) + num(e.alertas, 8) + num(e.certos, 8) + num(e.alertas - e.certos, 8)
    + num(prec, 10) + num(med(e.leads) + " min", 11) + "   " + bt);
}
console.log("\n* = regra que entrou no v0.35 (10/09)");
console.log("Amostra pequena: com poucos alertas por regra o intervalo e largo e a comparacao");
console.log("com o backtest ainda nao decide nada. Serve pra ver direcao, nao pra concluir.");
