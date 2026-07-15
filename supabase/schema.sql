-- RIVERS — schema do log de sugestões (Supabase / Postgres)
--
-- Aplicar manualmente no SQL editor do Supabase. NÃO é aplicado automaticamente.
-- Objetivo: registrar CADA sugestão com tudo que o algoritmo viu (pra medir acurácia)
-- + o feedback do líder (acatou ou não). É o que destrava a calibração de tudo.
--
-- Mantém as tabelas acessíveis só pela service-role key (servidor). Não expor no client.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) Sugestão emitida pelo motor.
--    Append-only. 1 linha por (OS, versão, decisão) — ver UNIQUE no fim.
--    O motor roda a cada 5–10 min; pra não duplicar, o INSERT usa
--    "on conflict do nothing" → guarda o PRIMEIRO instante em que decidiu aquilo
--    (que é exatamente a métrica do doc: tempo até a sugestão).
create table if not exists rivers_suggestion (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),  -- quando a sugestão foi emitida
  algo_version  text        not null,                -- versão da lógica (p/ comparar calibrações)
  os_id         bigint      not null,
  placa         text,
  location_id   int,                                 -- 1 Mooca · 34 Osasco · 166 SBC
  asset_model   text,                                -- CPX / Comfort (p/ regra de match)
  is_piso       boolean,
  status_atual  text,
  decision      text        not null,                -- RESERVA / SEM_RESERVA
  fired_layer   text,                                -- C1_HARD, C2_SEM_ESTOQUE, C3_..., C4_...
  reason_code   text,                                -- motivo normalizado (enum)
  motivo        text,                                -- texto pro humano
  arrival_at    timestamptz,                         -- chegada do cliente (check-in) — P2
  min_arrival_to_suggestion int,                     -- métrica-chave do doc — P2
  features      jsonb       not null default '{}',   -- SNAPSHOT completo dos inputs do algoritmo
  unique (os_id, algo_version, decision)
);
create index if not exists idx_rivers_suggestion_os      on rivers_suggestion (os_id);
create index if not exists idx_rivers_suggestion_created on rivers_suggestion (created_at);

-- O que vai em features (jsonb) — tudo que o algoritmo leu, pra reconstruir o "porquê":
--   min_desde_chegada, min_desde_open, n_pecas, n_pecas_criticas, pecas_criticas,
--   n_sem_estoque, pecas_sem_estoque, complexidade_max, tempo_estimado_min,
--   tempo_total_estimado, n_mec_ativos, ocupacao_oficina, thresholds_usados {...}

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) Feedback do líder de turno (human-in-the-loop).
--    Liga aos botões aceitar/rejeitar que hoje estão soltos na tela.
create table if not exists rivers_feedback (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  suggestion_id uuid references rivers_suggestion(id),
  os_id         bigint      not null,
  aceitou       boolean     not null,                -- acatou a sugestão?
  actor         text,                                -- quem deu o feedback
  motivo_humano text                                 -- por que rejeitou, quando for o caso
);
create index if not exists idx_rivers_feedback_os on rivers_feedback (os_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- VERDADE DE CAMPO (desfecho real) — NÃO vira tabela agora.
-- Calculada na análise (Python/SQL) cruzando com o ClickHouse:
--   (a) reserva de fato liberada p/ a OS  → concordância com o humano
--   (b) tempo real de permanência da moto → o algoritmo acertou o ">3h"?
-- Vira tabela materializada só quando montarmos o dashboard de acurácia.
