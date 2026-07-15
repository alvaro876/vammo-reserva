# Rivers — Modelo de presença de mecânicos (2026-06-23)

> Construído com dados reais (RHID `previsto` + atividade em OS) e verificado de forma adversarial.
> **Status honesto:** modelo promissor e **direcionalmente validado**, mas a acurácia reportada ainda é
> **IN-SAMPLE** (falta o backtest out-of-sample). Ver "Acurácia" abaixo.

## O que ficou PROVADO (com dado)
- O **vale do almoço** e o **degrau da troca de turno** são reais na curva de **atividade** (a verdade):
  Mooca 10h=24,0 → 11h=22,7 → 12h=21,2 (vale) → 13h=28,6 (degrau) → 14h=31,6 (pico). **Nunca zera.**
- A escala crua (`previsto`) tem **2 artefatos perigosos**: H=12 = **0** (almoço 100% sincronizado na escala)
  e um **pico falso** às 13-14h (~51 em Mooca = sobreposição de turno, não 51 produzindo).
- ⚠️ **Por isso o modelo OBRIGATORIAMENTE suaviza o bloco 12-16h.** Com `previsto` cru, o Rivers veria
  capacidade = 0 no almoço → "oficina vazia" → reserva pra todo mundo. **(É exatamente o risco que você levantou — confirmado e resolvido.)**

## O modelo
`capacidade_esperada(base, dia_semana, hora) = previsto_suavizado(base,dow,hora) × haircut(base)`
- **previsto_suavizado**: curva de escalados do RHID, com média móvel de 3 pontos **só no bloco 12-16h**
  (remove o zero do almoço e o pico falso da sobreposição).
- **haircut(base)**: fator combinado presença×ocupação. ~**0,74 Mooca / ~0,88 Osasco** (varia com a atribuição de base — ver ressalvas).
- **Granularidade**: tabela `base × dow × hora` (~200 linhas). Dia útil e sábado separados (domingo = fechado).

## Curvas (dia útil, mecânicos por hora)
| Hora | Mooca escala crua | Mooca real | Osasco escala crua | Osasco real |
|---|---|---|---|---|
| 11h | 34,1 | 22,7 | 24,0 | 20,2 |
| **12h (almoço)** | **0,0** | 21,2 | **0,0** | 17,5 |
| **13h (troca)** | 45,9 | 28,6 | 39,3 | 26,9 |
| **14h (pico)** | 51,0 | 31,6 | 39,7 | 30,5 |
| 15h | 31,1 | 31,2 | 19,4 | 30,4 |

(escala crua = `previsto` com os artefatos; real = mecânicos distintos ativos numa OS)

## Acurácia — status HONESTO
- Erro do modelo (suavizado × haircut por base) vs real: **MAE ~2 mecânicos/hora** por base.
  Por horário: almoço MAE ~1, pico MAE ~1, troca 13h MAE ~4 (subestima um pouco), 15-16h MAE ~5-6 (subestima = lado seguro).
- ⚠️ **MAS é ajuste IN-SAMPLE, não backtest:** o haircut foi calibrado na MESMA janela onde o erro foi medido
  (sem hold-out) → número **otimista por construção**. E o MAPE "11-13%" **não reproduziu** (erro % por hora
  real ~27-35%, inflado pelas horas de pouco movimento). **Usar MAE, não MAPE.**
- → **Acurácia de verdade ainda PENDENTE:** calibrar o haircut em N dias e medir o erro em dias **FORA** da
  janela (out-of-sample), e medir **por dia-da-semana** (não só "dia útil médio").

## Como o Rivers vai consumir
Tabela materializada `capacidade_esperada(base, dow, hora)`, atualizada semanal (janela móvel ~30d).
Na decisão, o Rivers lê `cap[base, dow(now), hora(now)]` (SP) e compara com a carga atual da base; se
carga ≥ cap → oficina saturada → reserva. Como a tabela já preenche o almoço e suaviza o pico, o Rivers
nunca conclui "vazio" na transição. Acurácia contínua: rodar a curva real diária e logar MAE por (base,hora);
alertar se drift sustentado (recalibra antes do ciclo semanal).

## Ressalvas / próximos passos
1. **Backtest out-of-sample** (calibra em N dias, testa em dias de fora) + por dia-da-semana — pra ter acurácia real.
2. **Atribuição de base do real**: usar `oms_r.so.location_id` (onde a OS rodou; 1=Mooca/34=Osasco/166=SBC) — bate
   com a base do mecânico em 98,7%. Documentar o de-para (é load-bearing pro haircut; muda os números ~10-15%).
3. Confirmar a suavização (média móvel 3pts no bloco 12-16h foi a melhor das variantes testadas).
4. SBC: amostra baixa (~5/dia útil) → usar janela maior (60-90d).

## SQL — curva PREVISTA (escala, do RHID)
```sql
WITH base AS (
  SELECT loc.name AS base, w.work_date AS work_date, toDayOfWeek(w.work_date) AS dow,
    arrayFilter(s -> s != '', splitByChar(' ', trim(w.previsto))) AS janelas
  FROM mechanics_r.public_rhid_workday w FINAL
  INNER JOIN mechanics_r.attendance att FINAL ON att.employee_id=w.employee_id AND att.work_date=w.work_date
  INNER JOIN mechanics_r.shift sh FINAL ON sh.id=att.shift_id
  INNER JOIN mechanics_r.location loc FINAL ON loc.id=sh.location_id
  WHERE w._peerdb_is_deleted=0 AND att._peerdb_is_deleted=0 AND sh._peerdb_is_deleted=0 AND loc._peerdb_is_deleted=0
    AND w.previsto!='' AND w.work_date>=toDate('2026-05-24') AND w.work_date<=toDate('2026-06-22')
),
hours AS (SELECT arrayJoin(range(0,24)) AS H),
cov AS (
  SELECT b.base, b.work_date, b.dow, h.H,
    least(1.0,(arraySum(arrayMap(s ->
      greatest(0, least((h.H+1)*60, toInt32OrZero(splitByChar(':',splitByChar('-',s)[2])[1])*60+toInt32OrZero(splitByChar(':',splitByChar('-',s)[2])[2]))
        - greatest(h.H*60, toInt32OrZero(splitByChar(':',splitByChar('-',s)[1])[1])*60+toInt32OrZero(splitByChar(':',splitByChar('-',s)[1])[2])))
    , b.janelas))/60.0)) AS frac
  FROM base b CROSS JOIN hours h
),
per_day AS (SELECT base, work_date, dow, H, sum(frac) AS escalados_hora FROM cov GROUP BY base, work_date, dow, H)
SELECT base, multiIf(dow IN (6,7),'fim_de_semana','dia_util') AS tipo_dia, H,
  round(avg(escalados_hora),2) AS media_escalados, countDistinct(work_date) AS n_dias
FROM per_day
WHERE multiIf(dow IN (6,7),'fim_de_semana','dia_util')='dia_util' AND base IN ('Mooca','Osasco') AND H>=6 AND H<=22
GROUP BY base, tipo_dia, H ORDER BY base, H;
```

## SQL — curva REAL (atividade em OS)
```sql
WITH ev AS (
  SELECT e.os_id AS os_id, e.user_email AS user_email,
    toTimeZone(e.event_at, 'America/Sao_Paulo') AS event_at, e.canonical_status AS st,
    toTimeZone(leadInFrame(e.event_at) OVER (PARTITION BY e.os_id ORDER BY e.event_at
      ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING), 'America/Sao_Paulo') AS next_at
  FROM analytics.int_os_status_events_unified e
  WHERE e.event_at >= now() - INTERVAL 30 DAY
),
active AS (
  SELECT os_id, user_email, event_at AS start_at,
    event_at + INTERVAL least(ifNull(dateDiff('minute', event_at, next_at), 720), 720) MINUTE AS end_at
  FROM ev WHERE st IN ('IN_DIAGNOSIS','IN_PROGRESS','IN_QA') AND next_at IS NOT NULL AND user_email != ''
),
base AS (
  SELECT a.user_email, a.start_at, a.end_at, so.location_id AS location_id
  FROM active a INNER JOIN oms_r.so AS so FINAL ON so.id = toInt64OrNull(a.os_id)
  WHERE so._peerdb_is_deleted = 0 AND so.location_id IN (1, 34, 166) AND toDate(a.start_at) = toDate(a.end_at)
),
expanded AS (
  SELECT location_id, user_email, toDate(start_at) AS d,
    arrayJoin(range(toHour(start_at), toHour(end_at - INTERVAL 1 SECOND) + 1)) AS H,
    if(toDayOfWeek(toDate(start_at)) <= 5, 'util', 'fds') AS classe
  FROM base
),
per_day AS (SELECT location_id, classe, H, d, uniqExact(user_email) AS mecs_dia FROM expanded GROUP BY location_id, classe, H, d)
SELECT multiIf(location_id=1,'Mooca', location_id=34,'Osasco', location_id=166,'SBC','outro') AS base, classe, H,
  round(avg(mecs_dia),1) AS media_mecs, count(DISTINCT d) AS n_dias
FROM per_day WHERE classe='util' AND location_id IN (1,34) AND H BETWEEN 6 AND 22
GROUP BY base, classe, H ORDER BY base, H;
```
