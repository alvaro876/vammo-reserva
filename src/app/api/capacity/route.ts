// GET /api/capacity?base=1|34|166
//
// Alimenta a tela "Capacidade": estimado vs real por hora (último dia útil) +
// o erro do modelo por dia. Tudo calculado ao vivo no ClickHouse.
// O "estimado" é a média dos OUTROS dias do mesmo dia-da-semana (não usa o
// próprio dia) — senão estimado e real seriam idênticos e o acerto seria falso.

import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/clickhouse";

const BASES: Record<string, string> = { "1": "Mooca", "34": "Osasco", "166": "SBC" };

// CTEs compartilhados: atividade real (mecânico ativo numa OS) por dia/hora, dias úteis.
const prefix = (base: string, dias: number) => `WITH ev AS (
  SELECT e.os_id, e.user_email, toTimeZone(e.event_at,'America/Sao_Paulo') AS event_at, e.canonical_status AS st,
    toTimeZone(leadInFrame(e.event_at) OVER (PARTITION BY e.os_id ORDER BY e.event_at ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING),'America/Sao_Paulo') AS next_at
  FROM analytics.int_os_status_events_unified e WHERE e.event_at >= now() - INTERVAL ${dias} DAY
),
active AS (SELECT os_id,user_email,event_at AS start_at, event_at + INTERVAL least(ifNull(dateDiff('minute',event_at,next_at),720),720) MINUTE AS end_at FROM ev WHERE st = 'IN_PROGRESS' AND next_at IS NOT NULL AND user_email!=''),
b AS (SELECT a.user_email,a.start_at,a.end_at FROM active a INNER JOIN oms_r.so AS so FINAL ON so.id=toInt64OrNull(a.os_id) WHERE so._peerdb_is_deleted=0 AND so.location_id = ${base} AND toDate(a.start_at)=toDate(a.end_at)),
expanded AS (SELECT toDate(start_at) AS d, toDayOfWeek(toDate(start_at)) AS dow, arrayJoin(range(toHour(start_at), toHour(end_at - INTERVAL 1 SECOND)+1)) AS H, user_email FROM b WHERE toDayOfWeek(toDate(start_at)) <= 5),
real_h AS (SELECT d, dow, H, uniqExact(user_email) AS mecs FROM expanded GROUP BY d, dow, H)`;

function curvaSQL(base: string) {
  return `${prefix(base, 14)},
tgt AS (SELECT max(d) AS td, toDayOfWeek(max(d)) AS tdow FROM real_h WHERE d < today())
SELECT H AS hora,
  round(avgIf(mecs, d != (SELECT td FROM tgt)),1) AS estimado,
  round(sumIf(mecs, d = (SELECT td FROM tgt)),1) AS real,
  (SELECT toString(td) FROM tgt) AS dia
FROM real_h WHERE dow = (SELECT tdow FROM tgt) AND H BETWEEN 6 AND 22 GROUP BY hora ORDER BY hora`;
}

function errosSQL(base: string) {
  return `${prefix(base, 14)},
loo AS (SELECT d, dow, H, mecs, (sum(mecs) OVER (PARTITION BY dow,H) - mecs)/nullIf(count() OVER (PARTITION BY dow,H)-1,0) AS modelo FROM real_h)
SELECT toString(d) AS dia, round(avg(abs(modelo-mecs)),2) AS erro, round(avg(mecs),1) AS real_medio
FROM loo WHERE H BETWEEN 6 AND 22 GROUP BY d HAVING real_medio >= 1 ORDER BY d`;
}

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("base") ?? "1";
  const base = BASES[raw] ? raw : "1";
  try {
    const curva = await query<{ hora: number; estimado: number; real: number; dia: string }>(curvaSQL(base));
    const erros = await query<{ dia: string; erro: number; real_medio: number }>(errosSQL(base));
    return NextResponse.json({ base, baseName: BASES[base], dia: curva[0]?.dia ?? null, curva, erros });
  } catch (e) {
    console.error("[capacity] erro:", e);
    return NextResponse.json({ error: "Erro ao calcular capacidade" }, { status: 500 });
  }
}
