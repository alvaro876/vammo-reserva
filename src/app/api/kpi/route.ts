// GET /api/kpi
//
// Painel de KPI do piloto. Cruza O QUE O RIVERS MANDOU (log no Supabase) com
// O QUE ACONTECEU DE VERDADE (Maestro + OMS no ClickHouse) e devolve os
// indicadores já agregados.
//
// ─────────────────────────────────────────────────────────────────────────────
// TRÊS DECISÕES QUE ESTA ROTA CORRIGE em relação ao /api/accuracy antigo.
// Elas são a razão de existir deste arquivo — não mexa sem ler.
//
// 1) VERDADE DE CAMPO. O antigo definia acerto como "a oficina entregou moto"
//    (tp = algo_reserva && oficina_entregue). Isso mede ADESÃO, não precisão:
//    se o RIVERS avisa certo e ninguém entrega, contava como erro do RIVERS.
//    Aqui acerto = O CLIENTE DE FATO PASSOU DE 180 MIN na régua do cliente.
//
// 2) FONTE DA OFERTA. As colunas checkin.reserve_offered_at / reserve_delivered_at
//    não são a fonte viva depois do Check-in 2.0 — subcontam muito (medido em
//    26/08: 31 ofertas pela coluna contra 86 pelos eventos, na mesma população).
//    A fonte é maestro_scheduler_r.checkin_event, event_type RESERVE_OFFERED /
//    RESERVE_CANCELLED / CALL_FOR_RESERVE. É o que a tela do CX já usa.
//
// 3) DIA CORRENTE FORA. O dado é vivo: rodar a mesma query duas vezes no mesmo
//    dia dá totais diferentes porque ainda entra check-in. O painel corta no
//    último dia FECHADO, senão o número se mexe embaixo de quem está olhando.
// ─────────────────────────────────────────────────────────────────────────────

import { NextResponse } from "next/server";
import { query } from "@/lib/clickhouse";
import { getSuggestionsSince } from "@/lib/supabase";
import { basesTeste } from "@/lib/autonomia";

// Marco do piloto: dia em que o RIVERS passou a rodar junto com o time.
const INICIO = "2026-08-13";
// Régua do SLA prometido ao cliente.
const LIMITE_MIN = 180;

// Regras que são PREVISÃO de estouro de SLA. Ficam fora:
//   política  → C1_PLACA, C1_HARD, C2_TRAVADA_SEM_PECA, C2_PARADA_TERCEIRO
//               (a moto não pode circular; não é previsão, é lei)
//   anomalia  → C1_ANOMALIA (dispara sem cliente na base; polui qualquer contagem)
const REGRAS_SLA = new Set([
  "C3_RELOGIO_150",
  "C3_TEMPO_COMBINADO",
  "C3_TEMPO_ALTO",
  "C3_NAO_COMECOU",
  "C3_SEM_EXECUCAO_90",
  "C3_CONTA_NAO_FECHA",
  "C1_FILA_DIAG_LONGA",
  "C1_QA_TARDIA",
  "C1_ESPERA_SEM_DIAG",
  "C4_CAPACIDADE",
]);

const NOME_REGRA: Record<string, string> = {
  C3_RELOGIO_150: "Relógio de 2h40",
  C3_TEMPO_COMBINADO: "Soma dos tempos",
  C3_TEMPO_ALTO: "Serviço grande (4h+)",
  C3_NAO_COMECOU: "Conserto nem começou",
  C3_SEM_EXECUCAO_90: "90 min sem execução",
  C3_CONTA_NAO_FECHA: "Conta corrigida passa de 3h30",
  C1_FILA_DIAG_LONGA: "Parada sem triar (60 min)",
  C1_QA_TARDIA: "Reprovou no QA tarde",
  C1_ESPERA_SEM_DIAG: "Espera sem diagnóstico",
  C4_CAPACIDADE: "Oficina saturada",
};

// População "cliente esperando na base", com o desfecho e o que o CX fez.
//
// Guardas do casamento check-in ↔ OS: o check-in tem que ser ANTES da abertura da
// OS e no máximo 4h antes (senão casa com uma visita anterior do mesmo cliente).
// Mesmo dia de calendário: se virou o dia, o cliente foi pra casa e a régua de 3h
// não se aplica — é agenda, não espera.
//
// A base vem do location_id da OS, NUNCA do check-in: o Check-in 2.0 (17/08) trocou
// o espaço de IDs do location_id do check-in (apareceram 100/199).
const CAMPO_QUERY = (bases: number[], de: string, ate: string) => `
WITH
ev AS (
  -- CANCELAMENTO TEM DOIS SABORES e misturá-los inflava "recusa" em 40%:
  --   OPERATOR  → pessoa cancelou, mediana 15min após a oferta, moto ainda a ~79min de
  --               ficar pronta. É RECUSA (ou não tinha moto disponível).
  --   KAFKA_OMS → o OMS encerra sozinho quando a moto fica pronta (metadata.so_status =
  --               'AWAITING_CX', 0min entre o cancel e a moto pronta). NÃO é recusa.
  SELECT toInt32(so_id) AS os_id,
         maxIf(1, event_type = 'RESERVE_OFFERED')   AS ofertou,
         maxIf(1, event_type = 'RESERVE_CANCELLED' AND source =  'OPERATOR') AS recusou,
         maxIf(1, event_type = 'RESERVE_CANCELLED' AND source != 'OPERATOR') AS encerrou,
         maxIf(1, event_type = 'CALL_FOR_RESERVE')  AS chamou,
         argMaxIf(coalesce(reason, ''), created_at, event_type = 'RESERVE_OFFERED') AS motivo_cx,
         minIf(toUnixTimestamp(created_at), event_type = 'RESERVE_OFFERED') AS ofertou_ts
  FROM maestro_scheduler_r.checkin_event FINAL
  WHERE _peerdb_is_deleted = 0 AND so_id IS NOT NULL
    AND created_at >= toDate('${de}') - INTERVAL 2 DAY
  GROUP BY so_id
),
awx AS (
  SELECT so_id AS os_id, min(created_at) AS pronta_at
  FROM oms_r.so_status FINAL
  WHERE _peerdb_is_deleted = 0 AND status = 'AWAITING_CX'
  GROUP BY so_id
),
os AS (
  SELECT id AS os_id, created_at AS aberta_at, location_id, coalesce(asset_code, '') AS asset_code
  FROM oms_r.so FINAL
  WHERE _peerdb_is_deleted = 0
    AND location_id IN (${bases.join(",")})
    AND so_type IN ('CORRECTIVE','IMPROVEMENT')
    AND created_at >= toDate('${de}') - INTERVAL 2 DAY
),
ck AS (
  SELECT toInt32(so_id) AS os_id, created_at AS chegou_at, service_conclusion
  FROM maestro_scheduler_r.checkin FINAL
  WHERE _peerdb_is_deleted = 0 AND so_id IS NOT NULL
    AND checkin_type = 'MAINTENANCE' AND status != 'DROPOUT'
    AND created_at >= toDate('${de}') - INTERVAL 2 DAY
)
SELECT
  ck.os_id                                                      AS os_id,
  os.asset_code                                                 AS placa,
  toDate(ck.chegou_at)                                          AS dia,
  os.location_id                                                AS base,
  dateDiff('minute', ck.chegou_at, awx.pronta_at)               AS dur_min,
  if(ck.service_conclusion = 'RESERVE_DELIVERED', 1, 0)         AS entregue,
  coalesce(ev.ofertou, 0)                                       AS ofertou,
  coalesce(ev.recusou, 0)                                       AS recusou,
  coalesce(ev.encerrou, 0)                                      AS encerrou,
  coalesce(ev.chamou, 0)                                        AS chamou,
  coalesce(ev.motivo_cx, '')                                    AS motivo_cx,
  coalesce(ev.ofertou_ts, 0)                                    AS ofertou_ts,
  toUnixTimestamp(ck.chegou_at)                                 AS chegou_ts
FROM os
INNER JOIN ck  ON ck.os_id  = os.os_id
INNER JOIN awx ON awx.os_id = os.os_id
LEFT  JOIN ev  ON ev.os_id  = os.os_id
WHERE ck.chegou_at <= os.aberta_at
  AND dateDiff('minute', ck.chegou_at, os.aberta_at) <= 240
  AND toDate(ck.chegou_at) = toDate(awx.pronta_at)
  AND toDate(ck.chegou_at) BETWEEN toDate('${de}') AND toDate('${ate}')
`;

interface CampoRow {
  os_id: number;
  placa: string;
  dia: string;
  base: number;
  dur_min: number;
  entregue: number;
  ofertou: number;
  recusou: number;
  encerrou: number;
  chamou: number;
  motivo_cx: string;
  ofertou_ts: number;
  chegou_ts: number;
}

interface Caso extends CampoRow {
  estourou: boolean;
  excesso: number;
  avisou: boolean;
  regra: string | null;
  submotivo: string | null; // status da OS no instante do disparo
  avisou_ts: number | null;
  folga_min: number | null;     // minutos entre o aviso e a linha das 3h
  espera_no_aviso: number | null; // do check-in até o aviso (features.min_desde_chegada)
  estimado_min: number | null;   // estimativa da oficina no instante do aviso
  aviso_ate_oferta: number | null; // do aviso do RIVERS até o CX ofertar
  checkin_ate_oferta: number | null; // do check-in até o CX ofertar — mede se o
                                     // humano viu antes, "de olho" na moto
}

// Nome amigável do status da OS — é o submotivo: onde a moto estava travada.
const NOME_STATUS: Record<string, string> = {
  OPEN: "aberta, sem triagem",
  IN_DIAGNOSIS: "em diagnóstico",
  AWAITING_MECHANIC: "na fila da bancada",
  IN_PROGRESS: "em execução",
  PAUSED: "pausada",
  AWAITING_PARTS: "aguardando peça",
  AWAITING_SERVICE: "em serviço externo",
  AWAITING_VMGMT: "com gestão de frota",
  AWAITING_QA: "na fila do QA",
  IN_QA: "em conferência",
  QA_REJECTED: "reprovada no QA",
};

function pct(parte: number, total: number): number | null {
  return total > 0 ? Math.round((1000 * parte) / total) / 10 : null;
}

function mediana(v: number[]): number | null {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

// Data de hoje em São Paulo (UTC-3). O servidor roda em UTC.
function hojeSP(): string {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
function somaDias(d: string, n: number): string {
  const t = new Date(`${d}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
// Segunda-feira da semana de uma data.
function segundaDe(d: string): string {
  const t = new Date(`${d}T12:00:00Z`);
  const dow = t.getUTCDay(); // 0=dom
  return somaDias(d, dow === 0 ? -6 : 1 - dow);
}

// Presets de janela. O dia corrente é PARCIAL: ainda entra check-in, então o total
// muda entre refreshes. Por isso o default para em ontem — mas dá para pedir hoje
// de propósito, e o painel marca como parcial em vez de esconder.
function resolveJanela(p: URLSearchParams): { de: string; ate: string; preset: string; parcial: boolean } {
  const hoje = hojeSP();
  const ontem = somaDias(hoje, -1);
  const preset = p.get("j") ?? "tudo";
  const de = p.get("de");
  const ate = p.get("ate");
  if (de && ate) return { de, ate, preset: "custom", parcial: ate >= hoje };
  switch (preset) {
    case "hoje":       return { de: hoje, ate: hoje, preset, parcial: true };
    case "ontem":      return { de: ontem, ate: ontem, preset, parcial: false };
    case "7d":         return { de: somaDias(ontem, -6), ate: ontem, preset, parcial: false };
    case "semana":     return { de: segundaDe(hoje), ate: ontem, preset, parcial: false };
    case "semana_ant": {
      const segAnt = somaDias(segundaDe(hoje), -7);
      return { de: segAnt, ate: somaDias(segAnt, 6), preset, parcial: false };
    }
    case "tudo_hoje":  return { de: INICIO, ate: hoje, preset, parcial: true };
    default:           return { de: INICIO, ate: ontem, preset: "tudo", parcial: false };
  }
}

const TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { ts: number; payload: unknown }>();

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const j = resolveJanela(params);
  const chave = `${j.de}|${j.ate}`;
  const hit = cache.get(chave);
  if (hit && Date.now() - hit.ts < TTL_MS) {
    return NextResponse.json(hit.payload);
  }
  try {
    const bases = [...basesTeste()];
    const ate = j.ate;
    const inicio = j.de;
    // busca as sugestões desde 2 dias antes da janela: a OS pode ter sido avisada
    // no dia anterior ao check-in entrar na conta
    const desdeISO = new Date(`${somaDias(inicio, -2)}T00:00:00-03:00`).toISOString();

    const [campo, sugestoes] = await Promise.all([
      query<CampoRow>(CAMPO_QUERY(bases, inicio, ate)),
      getSuggestionsSince(desdeISO),
    ]);

    // Primeira sugestão de SLA por OS, só com cliente na base e na base do teste.
    // A TV reloga a mesma decisão a cada 45s — por isso "a primeira".
    const numF = (f: Record<string, unknown> | null, k: string): number | null => {
      const v = f?.[k];
      const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
      return Number.isFinite(n) ? n : null;
    };

    interface Aviso {
      regra: string; ts: number; status: string | null;
      espera: number | null; estimado: number | null;
    }
    const avisoPorOs = new Map<number, Aviso>();
    const pisoPorOs = new Map<number, boolean>();
    for (const s of sugestoes) {
      if (s.is_piso) pisoPorOs.set(s.os_id, true);
      if (!s.reason_code || !REGRAS_SLA.has(s.reason_code)) continue;
      if (s.location_id != null && !bases.includes(s.location_id)) continue;
      const ts = Math.floor(Date.parse(s.created_at) / 1000);
      const atual = avisoPorOs.get(s.os_id);
      if (!atual || ts < atual.ts) {
        avisoPorOs.set(s.os_id, {
          regra: s.reason_code,
          ts,
          status: s.status_atual,
          espera: numF(s.features, "min_desde_chegada"),
          estimado: numF(s.features, "tempo_estimado_min"),
        });
      }
    }

    const casos: Caso[] = campo.map((r) => {
      const a = avisoPorOs.get(r.os_id);
      // exige cliente na base no momento do aviso: sem isso entra inspeção de
      // retorno e cotação de seguro, onde o cliente vai embora e a régua não vale
      const avisou = Boolean(a && pisoPorOs.get(r.os_id));
      const linha = r.chegou_ts + LIMITE_MIN * 60;
      const av = a as Aviso | undefined;
      return {
        ...r,
        estourou: r.dur_min > LIMITE_MIN,
        excesso: r.dur_min - LIMITE_MIN,
        avisou,
        regra: avisou ? (av as Aviso).regra : null,
        submotivo: avisou ? (av as Aviso).status : null,
        avisou_ts: avisou ? (av as Aviso).ts : null,
        folga_min: avisou ? Math.round((linha - (av as Aviso).ts) / 60) : null,
        espera_no_aviso: avisou ? (av as Aviso).espera : null,
        estimado_min: avisou ? (av as Aviso).estimado : null,
        // do aviso do RIVERS até o CX registrar a oferta. Negativo = o CX chegou antes.
        aviso_ate_oferta:
          avisou && r.ofertou_ts > 0
            ? Math.round((r.ofertou_ts - (av as Aviso).ts) / 60)
            : null,
        checkin_ate_oferta:
          r.ofertou_ts > 0 ? Math.round((r.ofertou_ts - r.chegou_ts) / 60) : null,
      };
    });

    const estouros = casos.filter((c) => c.estourou);
    const avisos = casos.filter((c) => c.avisou);
    const A = casos.filter((c) => c.avisou && c.estourou); // avisou e estourou
    const B = casos.filter((c) => c.avisou && !c.estourou); // avisou e não estourou
    const C = casos.filter((c) => !c.avisou && c.estourou); // calado e estourou
    const D = casos.filter((c) => !c.avisou && !c.estourou);

    // ── topo ──────────────────────────────────────────────────────────────────
    const topo = {
      clientes: casos.length,
      estouros: estouros.length,
      taxa_estouro: pct(estouros.length, casos.length),
      avisos: avisos.length,
      precisao: pct(A.length, avisos.length),
      alcance: pct(A.length, estouros.length),
      adesao: pct(A.filter((c) => c.ofertou === 1).length, A.length),
      entregas: casos.filter((c) => c.entregue === 1).length,
      ofertas: casos.filter((c) => c.ofertou === 1).length,
      recusas: casos.filter((c) => c.ofertou === 1 && c.entregue !== 1 && c.recusou === 1).length,
      escapes: C.filter((c) => c.ofertou === 0).length,
      folga_mediana: mediana(avisos.map((c) => c.folga_min as number).filter((x) => x != null)),
      excesso_mediano: mediana(estouros.map((c) => c.excesso)),
    };

    // ── funil: o que aconteceu com os casos que o RIVERS acertou ──────────────
    // Cada linha é um subconjunto da ANTERIOR. O denominador vem escrito (de_nome) porque a leitura
    // "58 = 63%" sem dizer "de quê" gerou interpretação errada (06/09). `perdeu` = quantos saíram do
    // caminho nesta etapa, com o motivo típico em `perda`.
    const A_of = A.filter((c) => c.ofertou === 1);
    const A_ch = A.filter((c) => c.chamou === 1);
    const A_en = A.filter((c) => c.entregue === 1);
    const A_rec = A.filter((c) => c.recusou === 1 && c.entregue !== 1).length;
    const funil = [
      { etapa: "Estouraram as 3h", n: estouros.length, de: estouros.length, de_nome: "clientes que estouraram", perdeu: 0, perda: "" },
      { etapa: "O RIVERS avisou antes (regra de tempo, cliente na base)", n: A.length, de: estouros.length, de_nome: `dos ${estouros.length} que estouraram`,
        perdeu: estouros.length - A.length, perda: "estouraram sem aviso do RIVERS" },
      { etapa: "O CX registrou oferta de reserva", n: A_of.length, de: A.length, de_nome: `dos ${A.length} avisados`,
        perdeu: A.length - A_of.length, perda: "avisados que ficaram sem oferta" },
      { etapa: "Chamou o cliente pra retirar a reserva", n: A_ch.length, de: A.length, de_nome: `dos ${A.length} avisados`,
        perdeu: A_of.length - A_ch.length, perda: "ofertas que não viraram chamada (recusa do cliente ou a moto ficou pronta antes)" },
      { etapa: "Cliente saiu com a reserva", n: A_en.length, de: A.length, de_nome: `dos ${A.length} avisados`,
        perdeu: A_ch.length - A_en.length, perda: "chamados que não saíram com a reserva (recusou no balcão ou a moto ficou pronta)" },
    ];
    // recusa acontece antes OU depois da chamada — por isso não cabe numa etapa só do funil
    const funil_nota = `Entre os ${A.length} avisados, ${A_rec} recusaram a reserva em algum momento (antes ou depois de serem chamados).`;

    // ── o que aconteceu com cada oferta feita (os três desfechos) ─────────────
    // Sobre TODAS as ofertas do período, não só as que o RIVERS avisou: a pergunta
    // "quantas o cliente recusou" é sobre a oferta, não sobre o aviso.
    const ofertadas = casos.filter((c) => c.ofertou === 1);
    const desfecho_da_oferta = [
      {
        desfecho: "Cliente saiu com a reserva",
        n: ofertadas.filter((c) => c.entregue === 1).length,
        nota: "a oferta virou moto na mão do cliente",
      },
      {
        desfecho: "Cliente recusou",
        n: ofertadas.filter((c) => c.entregue !== 1 && c.recusou === 1).length,
        nota: "operador cancelou com a moto ainda longe de pronta",
      },
      {
        desfecho: "Encerrada: a moto ficou pronta",
        n: ofertadas.filter((c) => c.entregue !== 1 && c.recusou !== 1 && c.encerrou === 1).length,
        nota: "o sistema fechou sozinho — não é recusa",
      },
      {
        desfecho: "Em aberto ou outro fim",
        n: ofertadas.filter(
          (c) => c.entregue !== 1 && c.recusou !== 1 && c.encerrou !== 1
        ).length,
        nota: "sem cancelamento e sem entrega registrada",
      },
    ];

    // ── magnitude do estouro × ação do CX (pergunta do Guida) ─────────────────
    const FAIXAS: { rot: string; teste: (c: Caso) => boolean }[] = [
      { rot: "Não estourou", teste: (c) => !c.estourou },
      { rot: "Até 30 min", teste: (c) => c.estourou && c.excesso <= 30 },
      { rot: "31 a 60 min", teste: (c) => c.estourou && c.excesso > 30 && c.excesso <= 60 },
      { rot: "61 a 120 min", teste: (c) => c.estourou && c.excesso > 60 && c.excesso <= 120 },
      { rot: "Mais de 2h", teste: (c) => c.estourou && c.excesso > 120 },
    ];
    // Intervalo de Wilson (95%) pra taxa: faixa com 10 casos e 100% pode estar em 72%. Sem o
    // intervalo a tabela parecia dizer que o CX "prevê" atraso grande; o efeito é de exposição no
    // tempo (mais atraso = mais tempo pra ofertar), e faixas pequenas são pouco confiáveis.
    const wilson = (k: number, n: number): [number, number] => {
      if (!n) return [0, 0];
      const z = 1.96, p = k / n, den = 1 + (z * z) / n;
      const c = (p + (z * z) / (2 * n)) / den;
      const m = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
      return [Math.round(100 * Math.max(0, c - m)), Math.round(100 * Math.min(1, c + m))];
    };
    const magnitude = FAIXAS.map((f) => {
      const sub = avisos.filter(f.teste);
      const of = sub.filter((c) => c.ofertou === 1).length;
      const [ic_lo, ic_hi] = wilson(of, sub.length);
      return { faixa: f.rot, casos: sub.length, ofertou: of, taxa: pct(of, sub.length), ic_lo, ic_hi,
               entregue: sub.filter((c) => c.entregue === 1).length };
    });

    // ── as quatro caixas: RIVERS × desfecho, com o que o CX fez ───────────────
    const caixa = (rot: string, sub: Caso[]) => ({
      caixa: rot,
      casos: sub.length,
      ofertou: sub.filter((c) => c.ofertou === 1).length,
      entregue: sub.filter((c) => c.entregue === 1).length,
      // mesma definição do topo e do bloco de desfecho: cancelamento de operador que
      // NÃO terminou em entrega. Sem o "entregue !== 1" a coluna somava 39 contra os 37
      // do card — 2 casos foram cancelados e a moto saiu mesmo assim.
      recusou: sub.filter((c) => c.recusou === 1 && c.entregue !== 1).length,
      taxa_oferta: pct(sub.filter((c) => c.ofertou === 1).length, sub.length),
    });
    const caixas = [
      caixa("Avisou · estourou", A),
      caixa("Avisou · saiu no prazo", B),
      caixa("Calado · estourou", C),
      caixa("Calado · saiu no prazo", D),
    ];

    // ── quebra por regra ─────────────────────────────────────────────────────
    const porRegra = new Map<string, Caso[]>();
    for (const c of avisos) {
      const k = c.regra as string;
      porRegra.set(k, [...(porRegra.get(k) ?? []), c]);
    }
    const motivos = [...porRegra.entries()]
      .map(([regra, sub]) => {
        const acertos = sub.filter((c) => c.estourou);
        return {
          regra,
          nome: NOME_REGRA[regra] ?? regra,
          avisos: sub.length,
          estourou: acertos.length,
          errou: sub.length - acertos.length,
          precisao: pct(acertos.length, sub.length),
          ofertou: sub.filter((c) => c.ofertou === 1).length,
          entregue: sub.filter((c) => c.entregue === 1).length,
          folga_mediana: mediana(sub.map((c) => c.folga_min as number).filter((x) => x != null)),
          excesso_mediano: mediana(acertos.map((c) => c.excesso)),
        };
      })
      .sort((a, b) => b.avisos - a.avisos);

    // ── submotivo: onde a moto estava travada quando a regra disparou ────────
    const porSub = new Map<string, Caso[]>();
    for (const c of avisos) {
      const k = `${c.regra}||${c.submotivo ?? "?"}`;
      porSub.set(k, [...(porSub.get(k) ?? []), c]);
    }
    const submotivos = [...porSub.entries()]
      .map(([k, sub]) => {
        const [regra, status] = k.split("||");
        return {
          regra,
          nome: NOME_REGRA[regra] ?? regra,
          submotivo: status,
          submotivo_nome: NOME_STATUS[status] ?? status,
          avisos: sub.length,
          estourou: sub.filter((c) => c.estourou).length,
          precisao: pct(sub.filter((c) => c.estourou).length, sub.length),
          ofertou: sub.filter((c) => c.ofertou === 1).length,
          espera_mediana: mediana(
            sub.map((c) => c.espera_no_aviso as number).filter((x) => x != null)
          ),
        };
      })
      .sort((a, b) => b.avisos - a.avisos);

    // ── sugestão seguida ou não ──────────────────────────────────────────────
    const seguidas = [
      {
        situacao: "Seguida — o CX ofertou reserva",
        n: avisos.filter((c) => c.ofertou === 1).length,
      },
      {
        situacao: "Não seguida — mas o cliente estourou",
        n: A.filter((c) => c.ofertou !== 1).length,
      },
      {
        situacao: "Não seguida — e o cliente saiu no prazo",
        n: B.filter((c) => c.ofertou !== 1).length,
      },
    ];

    // ── tempos ───────────────────────────────────────────────────────────────
    const faixaTempo = (
      vals: number[],
      cortes: { rot: string; ate: number }[]
    ) =>
      cortes.map((f, i) => {
        const de = i === 0 ? -Infinity : cortes[i - 1].ate;
        return { faixa: f.rot, n: vals.filter((v) => v > de && v <= f.ate).length };
      });

    const esperas = avisos
      .map((c) => c.espera_no_aviso as number)
      .filter((x) => x != null);
    const tempo_checkin_ate_aviso = {
      mediana: mediana(esperas),
      n: esperas.length,
      faixas: faixaTempo(esperas, [
        { rot: "Até 60 min de espera", ate: 60 },
        { rot: "61 a 120 min", ate: 120 },
        { rot: "121 a 155 min", ate: 155 },
        { rot: "Mais de 155 min", ate: Infinity },
      ]),
    };

    const reacoes = avisos
      .map((c) => c.aviso_ate_oferta as number)
      .filter((x) => x != null);
    const tempo_aviso_ate_oferta = {
      mediana: mediana(reacoes.filter((v) => v >= 0)),
      n: reacoes.length,
      cx_veio_antes: reacoes.filter((v) => v < 0).length,
      faixas: faixaTempo(reacoes.filter((v) => v >= 0), [
        { rot: "Até 10 min", ate: 10 },
        { rot: "11 a 30 min", ate: 30 },
        { rot: "31 a 60 min", ate: 60 },
        { rot: "Mais de 60 min", ate: Infinity },
      ]),
    };

    // ── estimado pela oficina × real, nos casos que o RIVERS avisou ──────────
    const comEst = avisos.filter((c) => (c.estimado_min ?? 0) > 0);
    const estimado_vs_real = {
      n: comEst.length,
      estimado_mediano: mediana(comEst.map((c) => c.estimado_min as number)),
      real_mediano: mediana(comEst.map((c) => c.dur_min)),
      // quanto o real passou do estimado, em pontos percentuais do estimado
      erro_mediano_pct: mediana(
        comEst.map((c) =>
          Math.round((100 * (c.dur_min - (c.estimado_min as number))) / (c.estimado_min as number))
        )
      ),
      subestimou: comEst.filter((c) => c.dur_min > (c.estimado_min as number)).length,
      superestimou: comEst.filter((c) => c.dur_min < (c.estimado_min as number)).length,
    };

    // ── antecedência CRUZADA com o tamanho do atraso ─────────────────────────
    // A pergunta do Guida: "pra uma moto que ia levar 3h15, o aviso saiu quando?"
    // Se saiu às 2h40, avisar não serviu de nada — buscar reserva leva ~16min.
    // Cada linha é uma faixa de duração REAL; as colunas dizem com quanta folga o
    // RIVERS falou nesses casos.
    const BANDAS = [
      { rot: "Saiu no prazo (até 3h)", teste: (c: Caso) => !c.estourou },
      { rot: "3h a 3h15", teste: (c: Caso) => c.estourou && c.excesso <= 15 },
      { rot: "3h15 a 3h30", teste: (c: Caso) => c.excesso > 15 && c.excesso <= 30 },
      { rot: "3h30 a 4h", teste: (c: Caso) => c.excesso > 30 && c.excesso <= 60 },
      { rot: "4h a 5h", teste: (c: Caso) => c.excesso > 60 && c.excesso <= 120 },
      { rot: "Mais de 5h", teste: (c: Caso) => c.excesso > 120 },
    ];
    const antecedencia_por_atraso = BANDAS.map((b) => {
      const sub = avisos.filter(b.teste);
      const folgas = sub.map((c) => c.folga_min as number).filter((x) => x != null);
      const uteis = folgas.filter((f) => f >= 30).length; // dá tempo de buscar a moto
      return {
        faixa: b.rot,
        avisos: sub.length,
        folga_mediana: mediana(folgas),
        // "avisou em cima da hora": menos de 30min de folga, ou já passado
        em_cima_da_hora: folgas.filter((f) => f < 30).length,
        com_tempo_util: uteis,
        pct_util: pct(uteis, sub.length),
        ofertou: sub.filter((c) => c.ofertou === 1).length,
        entregue: sub.filter((c) => c.entregue === 1).length,
      };
    });

    // ── DEEP DIVE: o que o RIVERS não viu, e quando o CX agiu ────────────────
    // Hipótese a testar: nos casos em que o RIVERS ficou calado e o cliente estourou,
    // o CX ofertou CEDO? Se sim, ele viu com os olhos algo que o sistema não enxerga
    // (moto visivelmente ruim, histórico do cliente, conversa no balcão) — e isso é
    // exatamente o que o modelo precisa aprender.
    const ofertaCx = (sub: Caso[]) =>
      sub.map((c) => c.checkin_ate_oferta as number).filter((x) => x != null);

    const sem_aviso_detalhe = {
      // os que estouraram sem o RIVERS falar
      total: C.length,
      cx_ofertou: C.filter((c) => c.ofertou === 1).length,
      passou_em_branco: C.filter((c) => c.ofertou !== 1).length,
      // quando o CX ofertou nesses casos, contando do check-in
      mediana_checkin_ate_oferta: mediana(ofertaCx(C.filter((c) => c.ofertou === 1))),
      // comparação: quando o RIVERS avisa, ele fala com quantos minutos de visita
      mediana_rivers_avisa: mediana(
        avisos.map((c) => c.espera_no_aviso as number).filter((x) => x != null)
      ),
      // e quando o CX oferta em caso que o RIVERS TAMBÉM viu
      mediana_checkin_ate_oferta_com_aviso: mediana(
        ofertaCx(A.filter((c) => c.ofertou === 1))
      ),
      faixas: [
        { rot: "O CX ofertou na 1ª hora", teste: (m: number) => m <= 60 },
        { rot: "Entre 1h e 2h", teste: (m: number) => m > 60 && m <= 120 },
        { rot: "Entre 2h e 2h40", teste: (m: number) => m > 120 && m <= 160 },
        { rot: "Depois de 2h40", teste: (m: number) => m > 160 },
      ].map((f) => ({
        faixa: f.rot,
        n: ofertaCx(C.filter((c) => c.ofertou === 1)).filter(f.teste).length,
      })),
      // lista caso a caso, do que o CX pegou mais cedo para o mais tarde
      casos: C.filter((c) => c.ofertou === 1)
        .sort((a, b) => (a.checkin_ate_oferta ?? 0) - (b.checkin_ate_oferta ?? 0))
        .slice(0, 25)
        .map((c) => ({
          placa: c.placa,
          os_id: c.os_id,
          dia: String(c.dia).slice(0, 10),
          cx_ofertou_em: c.checkin_ate_oferta,
          motivo_cx: c.motivo_cx,
          ficou_min: c.dur_min,
          excesso: c.excesso,
          entregue: c.entregue === 1,
          recusou: c.recusou === 1,
        })),
      // e os que ninguém pegou — nem o sistema nem o humano
      em_branco: C.filter((c) => c.ofertou !== 1)
        .sort((a, b) => b.excesso - a.excesso)
        .slice(0, 15)
        .map((c) => ({
          placa: c.placa,
          os_id: c.os_id,
          dia: String(c.dia).slice(0, 10),
          ficou_min: c.dur_min,
          excesso: c.excesso,
        })),
    };

    // ── insights que o Guida pediu, escritos como frase ──────────────────────
    const soPor15 = A.filter((c) => c.excesso <= 15);
    const tardeDemais = A.filter((c) => (c.folga_min ?? 999) < 30);
    const insights = [
      {
        n: C.length,
        texto: `${C.length} OS estouraram o prazo e o RIVERS não avisou`,
        detalhe:
          C.length > 0
            ? `dessas, ${C.filter((c) => c.ofertou === 1).length} o CX pegou sozinho e ${C.filter((c) => c.ofertou !== 1).length} passaram em branco`
            : "",
        tom: "ruim",
      },
      {
        n: B.length,
        texto: `${B.length} OS não estouraram e o RIVERS avisou`,
        detalhe:
          B.length > 0
            ? `o CX não caiu em ${B.filter((c) => c.ofertou !== 1).length} delas — filtrou o erro do sistema`
            : "",
        tom: "ruim",
      },
      {
        n: soPor15.length,
        texto: `${soPor15.length} OS que o RIVERS avisou estouraram por 15 minutos ou menos`,
        detalhe:
          "acertou no papel, mas 15 min de atraso quase não justifica mobilizar uma reserva — candidato a subir o limiar",
        tom: "atencao",
      },
      {
        n: tardeDemais.length,
        texto: `${tardeDemais.length} avisos certos saíram com menos de 30 min de folga`,
        detalhe:
          "buscar uma reserva leva ~16 min: avisar aqui é tecnicamente certo e operacionalmente inútil",
        tom: "atencao",
      },
    ];

    // ── dia a dia ────────────────────────────────────────────────────────────
    const porDia = new Map<string, Caso[]>();
    for (const c of casos) {
      const d = String(c.dia).slice(0, 10);
      porDia.set(d, [...(porDia.get(d) ?? []), c]);
    }
    const dia_a_dia = [...porDia.entries()]
      .map(([dia, sub]) => {
        const est = sub.filter((c) => c.estourou);
        const av = sub.filter((c) => c.avisou);
        const ok = sub.filter((c) => c.avisou && c.estourou);
        return {
          dia,
          clientes: sub.length,
          estouros: est.length,
          avisos: av.length,
          acertos: ok.length,
          precisao: pct(ok.length, av.length),
          alcance: pct(ok.length, est.length),
          ofertas: sub.filter((c) => c.ofertou === 1).length,
          entregas: sub.filter((c) => c.entregue === 1).length,
        };
      })
      .sort((a, b) => (a.dia < b.dia ? 1 : -1));

    // ── por que o CX ofertou, nas palavras dele ──────────────────────────────
    // O evento RESERVE_OFFERED vem com reason preenchido em 100% dos casos.
    const razoes = new Map<string, number>();
    for (const c of casos) {
      if (c.ofertou === 1 && c.motivo_cx) {
        razoes.set(c.motivo_cx, (razoes.get(c.motivo_cx) ?? 0) + 1);
      }
    }
    const motivo_do_cx = [...razoes.entries()]
      .map(([motivo, n]) => ({ motivo, n }))
      .sort((a, b) => b.n - a.n);

    const payload = {
      janela: {
        de: inicio, ate, dias: porDia.size, bases,
        preset: j.preset,
        parcial: j.parcial,       // true = inclui o dia de hoje, que ainda está entrando
        inicio_piloto: INICIO,
      },
      topo,
      funil,
      funil_nota,
      desfecho_da_oferta,
      seguidas,
      submotivos,
      tempo_checkin_ate_aviso,
      tempo_aviso_ate_oferta,
      antecedencia_por_atraso,
      sem_aviso_detalhe,
      estimado_vs_real,
      insights,
      magnitude,
      caixas,
      motivos,
      motivo_do_cx,
      dia_a_dia,
      gerado_em: new Date().toISOString(),
    };

    cache.set(chave, { ts: Date.now(), payload });
    return NextResponse.json(payload);
  } catch (e) {
    console.error("[kpi] erro:", e);
    return NextResponse.json({ error: "Erro ao calcular KPIs" }, { status: 500 });
  }
}
