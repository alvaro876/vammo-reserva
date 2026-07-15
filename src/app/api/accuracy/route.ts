// GET /api/accuracy
//
// Painel de acurácia do RIVERS: cruza O QUE O ALGORITMO MANDOU (log no Supabase,
// `rivers_suggestion`, por os_id) com O QUE A OFICINA FEZ DE VERDADE (Maestro
// `maestro_scheduler_r.checkin`, por so_id) — e mede o TEMPO (o algoritmo apontou
// a reserva antes do humano?).
//
// É cross-banco (Supabase = Postgres, Maestro = ClickHouse), então o JOIN é feito
// aqui no código, casando os_id = so_id.

import { NextResponse } from "next/server";
import { query } from "@/lib/clickhouse";
import { getRecentSuggestions } from "@/lib/supabase";

const DIAS = 7;

// Verdade de campo: por OS de check-in de manutenção (piso), se teve reserva ofertada/
// entregue, o motivo, e o tempo real de permanência (abertura → COMPLETED).
const CHECKIN_QUERY = `
WITH comp AS (
  SELECT so_id, minIf(created_at, status = 'COMPLETED') AS completed_at
  FROM oms_r.so_status FINAL WHERE _peerdb_is_deleted = 0 AND status = 'COMPLETED' GROUP BY so_id
)
SELECT c.so_id AS os_id,
  any(c.plate) AS placa,
  any(c.location_id) AS base,
  minIf(toUnixTimestamp(c.reserve_offered_at), c.reserve_offered_at IS NOT NULL) AS ofertada_ts,
  max(c.reserve_delivered_at IS NOT NULL) AS entregue,
  any(c.reserve_reason) AS motivo_oficina,
  anyIf(dateDiff('minute', so.created_at, comp.completed_at), comp.completed_at > so.created_at) AS tempo_real_min
FROM maestro_scheduler_r.checkin c FINAL
JOIN oms_r.so so FINAL ON so.id = c.so_id
LEFT JOIN comp ON comp.so_id = c.so_id
WHERE c._peerdb_is_deleted = 0 AND c.checkin_type = 'MAINTENANCE' AND c.so_id IS NOT NULL
  AND c.created_at >= now() - INTERVAL ${DIAS} DAY
GROUP BY c.so_id
`;

interface CheckinRow {
  os_id: number;
  placa: string;
  base: number;
  ofertada_ts: number;
  entregue: number;
  motivo_oficina: string;
  tempo_real_min: number | null;
}

function mediana(arr: number[]): number | null {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

export async function GET() {
  try {
    const [checkins, suggestions] = await Promise.all([
      query<CheckinRow>(CHECKIN_QUERY),
      getRecentSuggestions(DIAS),
    ]);

    // Agrega a decisão do algoritmo por OS: disse RESERVA? quando foi a 1ª vez? por quê?
    const algo = new Map<number, { reserva: boolean; emTs: number | null; motivo: string | null }>();
    for (const s of suggestions) {
      const a = algo.get(s.os_id) ?? { reserva: false, emTs: null, motivo: null };
      if (s.decision === "RESERVA") {
        const ts = Date.parse(s.created_at) / 1000;
        if (a.emTs === null || ts < a.emTs) {
          a.emTs = ts;
          a.motivo = s.motivo;
        }
        a.reserva = true;
      }
      algo.set(s.os_id, a);
    }

    // Universo = OS que passaram pelo check-in de manutenção E o algoritmo avaliou
    const casos = [];
    for (const ck of checkins) {
      const a = algo.get(ck.os_id);
      if (!a) continue;
      const ofertadaTs = ck.ofertada_ts > 0 ? ck.ofertada_ts : null;
      const antecipMin =
        a.reserva && a.emTs && ofertadaTs ? Math.round((ofertadaTs - a.emTs) / 60) : null;
      casos.push({
        os_id: ck.os_id,
        placa: ck.placa,
        base: ck.base,
        algo_reserva: a.reserva,
        algo_motivo: a.motivo,
        algo_ts: a.emTs,
        oficina_entregue: ck.entregue === 1,
        oficina_ts: ofertadaTs,
        motivo_oficina: ck.motivo_oficina,
        antecip_min: antecipMin,
        tempo_real_min: ck.tempo_real_min,
      });
    }

    const entregues = casos.filter((c) => c.oficina_entregue);
    const algoReservas = casos.filter((c) => c.algo_reserva);
    const tp = casos.filter((c) => c.algo_reserva && c.oficina_entregue);
    const antecips = tp.map((c) => c.antecip_min).filter((x): x is number => x !== null);

    return NextResponse.json({
      dias: DIAS,
      resumo: {
        n_casos: casos.length,
        n_entregues: entregues.length,
        n_algo_reserva: algoReservas.length,
        n_acertos: tp.length,
        recall: entregues.length ? Math.round((100 * tp.length) / entregues.length) : null,
        precisao: algoReservas.length ? Math.round((100 * tp.length) / algoReservas.length) : null,
        antecip_mediana_min: mediana(antecips),
        n_com_antecip: antecips.length,
      },
      casos: casos
        .sort((a, b) => (b.oficina_ts ?? b.algo_ts ?? 0) - (a.oficina_ts ?? a.algo_ts ?? 0))
        .slice(0, 80),
    });
  } catch (e) {
    console.error("[accuracy] erro:", e);
    return NextResponse.json({ error: "Erro ao calcular acurácia" }, { status: 500 });
  }
}
