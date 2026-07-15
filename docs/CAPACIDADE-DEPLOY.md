# Capacidade de mecânicos — backtest OOS + plano de deploy (2026-06-23)

> Backtest out-of-sample (leave-one-day-out em 3 camadas) e plano de deploy, ambos verificados
> de forma adversarial (confiança final: **alta** nos agregados).

## Achado central (honesto): o modelo de escala PERDE pro baseline simples
Medido out-of-sample (50 dia-base, real médio ~17,7 mec/h, horas 6-22):

| Modelo | MAE (OOS) |
|---|---|
| Escala RHID suavizada × haircut (o que prototipamos) | **3,25** |
| **Baseline: média da atividade REAL por (base, dia-da-semana, hora)** | **2,84** ✅ |
| Escala in-sample (referência) | ~3,1–3,2 |

- O **baseline ganha em 37/50 dias e em TODAS as 12 células base × dia-da-semana.** Pior caso pro modelo: Osasco segunda (3,16 vs 1,52).
- O método foi confirmado genuinamente OOS (sem vazamento). O "MAE ~2" reportado na rodada anterior **não reproduziu** (real ~3,1–3,2) — era janela/horas diferentes.
- **Tradução:** a curva de escala (`previsto`) × haircut **não adiciona poder preditivo** sobre simplesmente usar a média histórica do que de fato acontece naquela base/hora/dia-da-semana.

## Decisão recomendada para a V1
**Adotar o baseline como o modelo de capacidade:** `capacidade_esperada(base, dow, hora) = média da atividade real (mecânicos distintos ativos/hora) nas últimas ~N semanas para aquele (base, dow, hora).**
- É **mais simples** (sem parse de escala, sem haircut) e **mais preciso** (2,84 < 3,25).
- **Ainda captura almoço e troca de turno** — porque é a média do real, que já tem esses fenômenos embutidos.
- A escala (`previsto`) fica como **candidata a refinamento futuro** (pode ajudar em dias atípicos — feriado, falta em massa — onde a média histórica erra; testar haircut por dow ou blend). Só promover se bater o 2,84.

## Onde "subir" (plano de deploy)
**Cérebro = dbt/ClickHouse · Vitrine = Metabase · Consumidor = Rivers.** Um lugar só gera a verdade (o mart), todos leem.

**1. dbt (schema `analytics`)** — modelos agendados (refresh diário de madrugada):
- `int_mechanic_active_real` — curva REAL: mecânicos distintos ativos/hora por (base, work_date, hora), de `int_os_status_events_unified` + `oms_r.so` (base por location_id).
- `mart_mechanic_capacity_curve` — **o modelo publicado** = média do real por (base, dow, hora). É o que o Rivers lê.
- `fct_capacity_accuracy_daily` — monitor OOS: por (base, dia), MAE do modelo vs real (LOO), + real_medio. É a tabela honesta de erro/drift.
- `seed_capacity_params.csv` — knobs ajustáveis (janela de dias, horas operacionais) versionados em git → time ajusta via PR, não no banco.
- (Os modelos da escala — `stg_rhid__workday_windows`, `int_mechanic_capacity_smoothed` — ficam como experimento, fora do caminho da V1.)

**2. Metabase (db 137)** — dashboard "Capacidade de Mecânicos — Curva & Acurácia":
- Curva de capacidade hoje por base (linha por hora).
- Modelo vs Real hoje (combo: linha prevista + barra real).
- MAE diário por base (21d) com linha de referência ~4.
- MAE por dia-da-semana × base (heatmap — quinta/sexta erram mais).
- Big number: MAE 7d por base (verde <3 / amarelo 3-5 / vermelho >5).
- Saúde do dado: cobertura de escala e real por base (pega quebra de ETL).

⚠️ **O conector do Metabase é READ-ONLY** (só `execute/list/search/retrieve/export`; sem `create_card`/`create_dashboard`). Então **o dashboard é criado manualmente** (Alvaro, ~5 min, apontando pros marts) — posso **pré-validar cada SQL de card** rodando via `execute` antes de você salvar.

**3. Rivers** — lê `analytics.mart_mechanic_capacity_curve` ao vivo (mesma conexão CH read-only), no job da Fase 3: `SELECT base, hora, capacidade_esperada WHERE base=? AND dow=toDayOfWeek(today())`. Não recalcula nada. Opcional: cachear o snapshot do dia no Supabase pra resiliência.

## Ressalvas
- O **repo dbt do `analytics` é seu** (não tenho ele aqui) → entrego o SQL validado + a spec dos modelos; você sobe via PR.
- Quinta/sexta e dias cheios têm MAE maior (~4); sábado baixo. SBC tem amostra pequena (~5/dia) → janela maior (60-90d).
- O monitor deve alertar se MAE 7d de uma base passar de ~5 por 3 dias (drift de escala ou ETL quebrado, tipo OPS-235).

## SQL validado — monitor de acurácia OOS (roda hoje no db 137)
```sql
WITH
prev_base AS (
  SELECT loc.name AS base, w.work_date AS work_date, toDayOfWeek(w.work_date) AS dow,
         arrayFilter(s -> s != '', splitByChar(' ', trim(w.previsto))) AS janelas
  FROM mechanics_r.public_rhid_workday w FINAL
  INNER JOIN mechanics_r.attendance att FINAL ON att.employee_id=w.employee_id AND att.work_date=w.work_date
  INNER JOIN mechanics_r.shift sh FINAL ON sh.id=att.shift_id
  INNER JOIN mechanics_r.location loc FINAL ON loc.id=sh.location_id
  WHERE w._peerdb_is_deleted=0 AND att._peerdb_is_deleted=0 AND sh._peerdb_is_deleted=0 AND loc._peerdb_is_deleted=0
    AND w.previsto!='' AND loc.name IN ('Mooca','Osasco') AND w.work_date BETWEEN today()-31 AND today()-1),
hours AS (SELECT arrayJoin(range(0,24)) AS H),
cov AS (SELECT base, work_date, dow, H, least(1.0,(arraySum(arrayMap(s -> greatest(0, least((H+1)*60, toInt32OrZero(splitByChar(':',splitByChar('-',s)[2])[1])*60+toInt32OrZero(splitByChar(':',splitByChar('-',s)[2])[2])) - greatest(H*60, toInt32OrZero(splitByChar(':',splitByChar('-',s)[1])[1])*60+toInt32OrZero(splitByChar(':',splitByChar('-',s)[1])[2]))), janelas))/60.0)) AS frac FROM prev_base CROSS JOIN hours),
esc_raw AS (SELECT base, work_date, dow, H, sum(frac) AS escalados FROM cov GROUP BY base, work_date, dow, H),
esc_smooth AS (SELECT base, work_date, dow, H, CASE WHEN H BETWEEN 12 AND 16 THEN avg(escalados) OVER (PARTITION BY base, work_date ORDER BY H ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) ELSE escalados END AS prev_smooth FROM esc_raw),
esc_dow AS (SELECT base, dow, H, work_date, prev_smooth, sum(prev_smooth) OVER (PARTITION BY base, dow, H) AS s_all, count() OVER (PARTITION BY base, dow, H) AS n_all FROM esc_smooth),
expected_loo AS (SELECT base, work_date, dow, H, (s_all - prev_smooth)/nullIf(n_all-1,0) AS prev_esperado_oos FROM esc_dow),
ev AS (SELECT e.os_id, e.user_email, toTimeZone(e.event_at,'America/Sao_Paulo') AS event_at, e.canonical_status AS st, toTimeZone(leadInFrame(e.event_at) OVER (PARTITION BY e.os_id ORDER BY e.event_at ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING),'America/Sao_Paulo') AS next_at FROM analytics.int_os_status_events_unified e WHERE e.event_at >= now() - INTERVAL 45 DAY),
active AS (SELECT os_id, user_email, event_at AS start_at, event_at + INTERVAL least(ifNull(dateDiff('minute',event_at,next_at),720),720) MINUTE AS end_at FROM ev WHERE st IN ('IN_DIAGNOSIS','IN_PROGRESS','IN_QA') AND next_at IS NOT NULL AND user_email!=''),
real_base AS (SELECT a.user_email, a.start_at, a.end_at, so.location_id FROM active a INNER JOIN oms_r.so AS so FINAL ON so.id=toInt64OrNull(a.os_id) WHERE so._peerdb_is_deleted=0 AND so.location_id IN (1,34) AND toDate(a.start_at)=toDate(a.end_at)),
expanded AS (SELECT location_id, user_email, toDate(start_at) AS d, arrayJoin(range(toHour(start_at), toHour(end_at - INTERVAL 1 SECOND)+1)) AS H FROM real_base),
real_h AS (SELECT multiIf(location_id=1,'Mooca',location_id=34,'Osasco','?') AS base, d AS work_date, H, uniqExact(user_email) AS mecs_real FROM expanded GROUP BY base, d, H),
joined AS (SELECT e.base, e.work_date, e.dow, e.H, e.prev_esperado_oos, ifNull(r.mecs_real,0) AS mecs_real FROM expected_loo e LEFT JOIN real_h r ON r.base=e.base AND r.work_date=e.work_date AND r.H=e.H WHERE e.H BETWEEN 6 AND 22 AND e.prev_esperado_oos IS NOT NULL),
day_tot AS (SELECT base, work_date, sum(mecs_real) AS r_d, sum(prev_esperado_oos) AS p_d FROM joined GROUP BY base, work_date),
base_tot AS (SELECT base, sum(r_d) AS R, sum(p_d) AS P FROM day_tot GROUP BY base),
haircut_loo AS (SELECT d.base, d.work_date, (b.R - d.r_d)/nullIf(b.P - d.p_d,0) AS haircut_oos FROM day_tot d INNER JOIN base_tot b ON b.base=d.base),
real_dow AS (SELECT base, dow, H, work_date, mecs_real, sum(mecs_real) OVER (PARTITION BY base, dow, H) AS rs_all, count() OVER (PARTITION BY base, dow, H) AS rn_all FROM joined),
baseline_loo AS (SELECT base, work_date, dow, H, (rs_all - mecs_real)/nullIf(rn_all-1,0) AS naive_pred FROM real_dow),
scored AS (SELECT j.base, j.work_date, j.H, j.mecs_real, j.prev_esperado_oos * h.haircut_oos AS modelo_oos, bl.naive_pred FROM joined j INNER JOIN haircut_loo h ON h.base=j.base AND h.work_date=j.work_date INNER JOIN baseline_loo bl ON bl.base=j.base AND bl.work_date=j.work_date AND bl.H=j.H)
SELECT base, work_date,
  round(avg(abs(modelo_oos - mecs_real)),3) AS mae_modelo_oos,
  round(avg(abs(naive_pred - mecs_real)),3) AS mae_baseline_naive,
  round(avg(mecs_real),2) AS real_medio
FROM scored GROUP BY base, work_date HAVING real_medio >= 1 ORDER BY base, work_date;
```
(O `mart_mechanic_capacity_curve` da V1 é o `baseline_loo`/`real_dow` agregado por (base,dow,hora); o `modelo_oos` da escala fica só como comparação.)
