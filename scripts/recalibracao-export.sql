-- RECALIBRAÇÃO DOS TEMPOS (rodar no fim de semana — plano de 01/08)
--
-- Exportar via Metabase (database 137) em DOIS arquivos JSON:
--   1) TREINO: trocar o filtro de t_open para  >= now()-150 DAY  e  < now()-60 DAY
--   2) TESTE:  trocar o filtro de t_open para  >= now()-60 DAY
-- Depois: node scripts/recalibrar-tempos.mjs treino.json teste.json
--
-- Uma linha por (OS, peça): tempo real de bancada + desfecho. O script ajusta os
-- tempos por peça, refaz o multiplicador por nº de peças e varre o gatilho.
-- POR QUE NÃO BASTA TROCAR A MEDIANA: simulado em 31/07 — só trocar cadastro por
-- mediana histórica dá 63% (58% hoje); o multiplicador e o gatilho foram calibrados
-- pros tempos velhos e precisam ser reajustados juntos.

WITH ev AS (
  SELECT so_id, status, created_at,
    leadInFrame(created_at) OVER (PARTITION BY so_id ORDER BY created_at
      ROWS BETWEEN CURRENT ROW AND 1 FOLLOWING) AS prox
  FROM oms_r.so_status FINAL WHERE _peerdb_is_deleted=0
),
os AS (
  SELECT so_id,
    toUnixTimestamp(minIf(created_at,status='OPEN')) AS t_open,
    toUnixTimestamp(minIf(created_at,status='AWAITING_CX')) AS t_ready,
    toUnixTimestamp(minIf(created_at,status='CANCELLED')) AS t_cancel,
    sumIf(dateDiff('minute',created_at,prox), status='IN_PROGRESS' AND prox>created_at) AS exec_min
  FROM ev GROUP BY so_id
),
piso AS (
  SELECT DISTINCT so_id FROM maestro_scheduler_r.checkin FINAL
  WHERE _peerdb_is_deleted=0 AND checkin_type='MAINTENANCE' AND so_id IS NOT NULL
    AND status NOT IN ('NO_SHOW','CANCELLED','DROPOUT') AND called_at IS NOT NULL
    AND created_at >= now() - INTERVAL 150 DAY
)
SELECT o.so_id AS so_id, s.location_id AS location_id,
  if(p.so_id IS NOT NULL, 1, 0) AS is_piso,
  o.exec_min AS exec_min,
  round((o.t_ready - o.t_open)/60) AS dur_min,
  si.item_group_id AS ig_id, toFloat64(si.quantity) AS qty
FROM os o
INNER JOIN (SELECT id, location_id FROM oms_r.so FINAL WHERE _peerdb_is_deleted=0) s ON s.id=o.so_id
LEFT JOIN piso p ON p.so_id=o.so_id
INNER JOIN oms_r.so_item si FINAL ON si.so_id=o.so_id
WHERE si._peerdb_is_deleted=0 AND si.origin IN ('DIAGNOSIS','MECHANIC')
  AND si.deleted_at IS NULL AND si.quantity>0 AND si.item_group_id>0
  AND o.t_ready>0 AND o.t_cancel=0 AND o.exec_min BETWEEN 1 AND 600
  -- >>> JANELA: treino = entre 150 e 60 dias atrás | teste = últimos 60 dias <<<
  AND o.t_open >= toUnixTimestamp(now()-INTERVAL 150 DAY)
  AND o.t_open <  toUnixTimestamp(now()-INTERVAL 60 DAY)
