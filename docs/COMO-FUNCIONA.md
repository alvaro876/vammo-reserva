# RIVERS — Como tudo funciona

> Documento de referência do sistema completo. Atualizado em **10/07/2026**.
> Complementa `RIVERS.md` (roadmap/auditoria) e `DECISOES.md` (log de decisões).
> Se você está chegando agora: leia este arquivo primeiro.

---

## 1. O que é

O RIVERS decide **automaticamente e cedo** quais clientes com moto em manutenção ("em piso") devem receber uma **moto reserva** — e explica o porquê de cada decisão em texto legível.

**O problema que resolve:** a regra da Vammo é dar reserva quando o conserto passa de **3 horas**. Antes, essa decisão era manual (líder de turno olhando Retool), variava por pessoa e saía tarde. O RIVERS faz a conta continuamente pra todas as motos das 3 bases (Mooca=1, Osasco=34, SBC=166).

**Decisão de projeto central:** é um **algoritmo determinístico de regras** (não LLM, não caixa-preta) — por exigência de auditabilidade da operação. A parte "aprendida" está nos **insumos** (tempos por peça calibrados com histórico; capacidade via escala real).

---

## 2. Arquitetura

```
ClickHouse (réplicas peerdb: oms_r, ims_r, maestro_scheduler_r, mechanics_r)
        │  leitura ao vivo (HTTPS API, ~1min de lag da replicação)
        ▼
App Next.js/TypeScript na Vercel  ──►  https://vammo-reserva.vercel.app
  ├─ Motor de decisão (src/lib/rivers-engine.ts + src/lib/algorithm.ts)
  ├─ Tela do líder (/)  ·  Monitor de capacidade (/capacidade)  ·  Acurácia (/acuracia)
  ├─ Log de decisões ──► Supabase (Postgres: rivers_suggestion, rivers_feedback)
  ├─ Notificação ──► Slack (Incoming Webhook, só reservas novas, com dedup)
  └─ API externa ──► /api/recomendacoes (Control Tower do Henrique consome)
```

**Rotas da API:**
| Rota | O que faz |
|---|---|
| `GET /api/os` | Avalia todas as OS ativas + loga no Supabase + dispara Slack das novas (é o que a tela chama a cada 60s) |
| `GET /api/cron` | Mesmo motor, pensado pra agendador externo. Protegido por `Authorization: Bearer <CRON_SECRET>`; só roda 7h–21h SP; `?test=1` ignora dedup/horário |
| `GET /api/recomendacoes` | JSON enxuto pra consumo externo (os_id, placa, base, reservar, motivo, regra, tempo_previsto). Protegido por header `x-api-key` = env `RIVERS_API_KEY` |
| `GET /api/capacity?base=` | Curva estimado×real de mecânicos (alimenta /capacidade) |
| `GET /api/accuracy` | Cruzamento sugestões×Maestro (alimenta /acuracia) |
| `POST /api/feedback` | Botões aceitar/rejeitar da tela → rivers_feedback |

**Variáveis de ambiente (painel da Vercel):**
- `CLICKHOUSE_HOST/USER/PASSWORD` — leitura dos dados (⚠️ a senha do `.env.local` local está DESATUALIZADA; a válida está só no painel)
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` — log de decisões
- `SLACK_WEBHOOK_URL` — notificação
- `RIVERS_API_KEY` — chave da API externa · `CRON_SECRET` — proteção do cron

**Deploy:** `npx --yes vercel --prod --yes --cwd <repo>` (sobe arquivos locais direto; logado como alvaro876, projeto alvaro12/vammo-reserva). Sempre rodar `tsc --noEmit` antes.

---

## 3. O algoritmo (ALGO_VERSION 0.3.0)

Arquivo: `src/lib/algorithm.ts`. Regras em camadas, **a primeira que dispara decide**. Na raiz são **dois critérios** + os casos óbvios:

### 🚨 Reserva imediata (sem conta)
| Regra | Dispara quando |
|---|---|
| `C1_HARD` | Moto imobilizada, acidente, guincho ou vistoria de seguro (flags do checklist — pouco preenchidas na prática) |
| `C1_ANOMALIA` | +4h sem a moto nem entrar na oficina |
| `C1_ESPERA_SEM_DIAG` | Cliente em piso + OS aberta há **+2h30 sem diagnóstico iniciado** (criada em 29/06 — é a regra mais certeira do sistema: 19/19 nos dados) |

### 🔩 Critério PEÇA
| Regra | Dispara quando |
|---|---|
| `C2_SEM_ESTOQUE` | O diagnóstico pede peça sem estoque na base (⚠️ tem furos de dado conhecidos: estoque NULL lido como 0, ignora depósitos MAINTENANCE/PERSON, não vê cross-base) |

### ⏱ Critério TEMPO — "não fica pronta em 3h"
A conta: `já esperou + fila + serviço restante + 8min QA > 180min`
| Regra | Dispara quando |
|---|---|
| `C3_TEMPO_ALTO` | Serviço estimado > **120min** (⚠️ corte largo — superestima 1,68× em moto multi-peça; em recalibração) |
| `C3_TEMPO_COMBINADO` | Já esperado + restante + QA > 180min |
| `C4_CAPACIDADE` | (fila da base ÷ mecânicos escalados) + serviço + espera > 180min (⚠️ fila superestimada em Osasco; em recalibração) |

Sem nada disso: `C4_OK` (dentro do prazo, mostra a conta) ou `C5_AGUARDA_DIAG` (sem diagnóstico ainda, sem estimativa).

**Regras REMOVIDAS em 27/06** (pedido da operação, validado com dado): `C3_PECA_CRITICA` e `C3_DIVERSAS_AVARIAS` — "ter Motor ou muitas peças não significa >3h; quem decide é o tempo".

**Thresholds atuais:** 3h=180min · serviço longo=120min · espera sem diag=150min · anomalia=240min · QA=8min (pedido da operação; medição do status IN_QA dá ~2min — status não captura o QA real).

### Os dois insumos calibrados

**a) Tempo por peça** (`src/lib/tempo-pecas.ts`, gerado por `scripts/calibra-tempo.mjs`):
Regressão não-negativa (NNLS) sobre **12.785 OS concluídas** (75 dias): tempo de rampa ≈ 25min fixos + Σ(qtd × minutos-da-peça). 181 peças calibradas; fallback = time_target do cadastro, senão 15min. Injetado no SQL via `transform()`. Validação out-of-sample: MAE 31,6min (fórmula antiga: 35,1) e domina na métrica de decisão @180min. Verificado por auditoria adversarial (3/3, recálculo manual exato em produção).
⚠️ **Limitação conhecida:** modelo é aditivo — soma tempos que o mecânico faz em paralelo na mesma desmontagem → superestima moto multi-peça (mediana estimada 130min × real 84min nos excessos). Próxima calibração: desconto sublinear.

**b) Capacidade de mecânicos** (CAP_QUERY em `rivers-engine.ts`):
**Escala real do dia (RHID)** — mecânicos do setor Oficina (`employee_role_history.sector_id=1`) escalados na hora atual (parse do campo `previsto` de `mechanics_r.public_rhid_workday`), × haircut por base (fração que fica de fato na rampa: Mooca 0,70 / Osasco 0,84 / SBC 0,94).
Histórico da decisão: testamos escala×haircut vs média histórica — o histórico era ~2 mec/h mais preciso, mas a operação escolheu o RHID por refletir o quadro atual (que cresceu de ~72 pra ~115 mecânicos em 3 meses). ⚠️ Semana de feriado reduz escala → fila superestimada (visto em 09/07, Osasco).
A tela `/capacidade` mostra outra conta (média real 14d, leave-one-out) — mesma ideia, números não idênticos; unificar é refinamento pendente.

---

## 4. O registro de decisões (a base da medição)

Toda avaliação grava em `rivers_suggestion` (Supabase): os_id, decisão, regra, motivo, versão do algoritmo e um **snapshot das features** (tempo estimado, fila, capacidade, peças...). Upsert idempotente em (os_id, algo_version, decision) → guarda **o primeiro instante** de cada decisão (a métrica de antecipação). Feedback humano (botões da tela) vai pra `rivers_feedback`.

Versões: `0.1.0` original → `0.2.0` (25/06, capacidade plugada) → `0.3.0` (02/07, tempos calibrados). O log carrega a versão — dá pra comparar calibrações.

---

## 5. Como medimos se funciona (o método)

Cruzamos **três coisas por OS** (join por os_id = so_id):
1. **O que o RIVERS sugeriu** (log do Supabase, primeira decisão RESERVA)
2. **O que a oficina decidiu** (`maestro_scheduler_r.checkin`: reserve_offered_at / reserve_delivered_at / reserve_reason)
3. **O desfecho real** (ClickHouse: tempo **até a moto ficar pronta**)

**Definições que importam (aprendidas com erro):**
- ⏱ **Tempo = até ficar PRONTA** (abertura → 1º AWAITING_CX ou COMPLETED, o que vier primeiro). Medir até a retirada distorce: **cliente com reserva na mão demora dias pra buscar a moto pronta** (ex. real: moto pronta em 1h26 que ficou 7 dias aguardando retirada).
- 🗑 **OS canceladas ficam fora** das contas de espera (a moto segue em outra OS).
- ✂️ **Serviço especial excluído** do universo (decisão da operação, 03/07): fluxo com decisão de reserva própria; exclusão vale pros dois lados.
- ⚠️ Cuidado ClickHouse: `minIf` sem match retorna epoch 1970, não NULL — usar `min(if(cond, x, NULL))`.

**Resultados (25/06–10/07, 1.396 OS):** recall 88% (pegou 115 das 130 decisões da oficina) · aponta antes do humano em 58% (70% na última semana) · 6 furos reais (todos por "não estar olhando", não por conta errada) · dos 245 "só RIVERS", 61 passaram mesmo de 3h (a oficina que não deu) e 180 foram excesso (mediana 131min — na trave).

**Relatórios publicados:**
- Principal (executivo, com "mapa dos números"): https://claude.ai/code/artifact/f8259103-9194-4052-91ba-42857f47f72c
- Investigação (furos, excessos, conciliações): https://claude.ai/code/artifact/6311c2f4-0176-46d3-be24-6778e804f543

**Scripts de análise** (rodam com Node; dados via export do Metabase em Downloads/Metabase/):
- `scripts/cross-analysis.mjs` — cruzamento completo → calib/cross-dashboard.json
- `scripts/cross-weekly.mjs` — comparativo semana × semana anterior
- `scripts/excessos.mjs` + `excessos-merge.mjs` — autópsia dos excessos (peças, estimado×real) → calib/excessos-detalhe.csv
- `scripts/calibra-tempo.mjs` — recalibração dos tempos por peça

---

## 6. Conciliação dos números (pra ninguém se perder)

- **360 sugestões do RIVERS** = 115 confirmadas pela oficina + 245 "só RIVERS" (= 61 com razão + 180 excesso + 4 em aberto).
- **130 "a oficina decidiu"** = ofertas registradas no **fluxo formal do check-in de piso** (75 entregues + 55 só ofertadas). **NÃO é o total da Vammo**: no mesmo período houve **~670 entregas reais** de reserva (query do Vinicius sobre `vammo_r.user_had_bike` tipo `reserve`) — rua, devolução, placa, fins de semana... **Só ~18% das entregas têm motivo registrado** → gap de governança (SOP do Guida).
- Estudo do Vinicius (mesmo período): mediana **3 dias** com a reserva, p90 10 dias, 261 ativas — os indicadores do SOP saem daí.

---

## 7. Estado atual e o que falta

### ✅ Funcionando em produção
Motor decidindo nas 3 bases · tela do líder (auto-refresh 60s, que também loga e notifica) · monitor de capacidade · painel de acurácia · log no Supabase · Slack de reservas novas (com dedup) · API pro Control Tower.

### 🔴 Pendências (em ordem de prioridade)
1. **Cron (agendador)** — hoje o motor SÓ RODA COM TELA ABERTA. Fins de semana e feriados ficam no escuro. A rota `/api/cron` está pronta e testada; falta o agendador (cron-job.org a cada 10min com o Bearer secret, ou n8n). É o desbloqueio nº 1.
2. **Janela de busca 1→7 dias** — o motor só avalia OS criadas hoje/ontem (`toDate(so.created_at) >= today()-1` no OS_QUERY). Causa direta de 5 dos 6 furos. Fix de 1 linha, aguardando aval.
3. **Recalibração em 3 frentes** — desconto multi-peça no tempo (1,68×) · fila do C4 (Osasco primeiro) · dado de estoque do C2.
4. **Governança (SOP)** — obrigar registro de motivo na entrega da reserva (82% sem motivo hoje).
5. Refinamentos: unificar as duas contas de capacidade · materializar curva · limpar labels antigos da UI · `ignoreBuildErrors:true` no next.config · rotacionar chaves antigas do .env.local.

### 📁 Onde estão as coisas
```
src/lib/algorithm.ts       ← as regras (o "cérebro")
src/lib/rivers-engine.ts   ← query das OS + capacidade + orquestração + log
src/lib/tempo-pecas.ts     ← minutos por peça (GERADO — não editar na mão)
src/lib/supabase.ts        ← log + dedup + leitura p/ acurácia
src/lib/slack.ts           ← notificação
src/app/api/*              ← rotas (os, cron, recomendacoes, capacity, accuracy, feedback)
scripts/*                  ← calibração e análises
calib/*                    ← relatórios HTML, JSONs e CSVs das análises
docs/*                     ← este arquivo + RIVERS.md + DECISOES.md + achados datados
supabase/schema.sql        ← DDL das tabelas de log
```

---

## 8. Linha do tempo (o que foi feito, na ordem)

| Quando | O quê |
|---|---|
| ~11/05 | Primeira versão do algoritmo (thresholds calibrados contra 865 OS) |
| 22-23/06 | Reboot: Claude/LLM removido (100% determinístico) · Supabase logando · bug do JSONExtractBool corrigido (C1 estava morto) · modelo de presença estudado |
| 24/06 | Deploy na Vercel (vammo-reserva.vercel.app) |
| 25/06 | Capacidade plugada no algoritmo (v0.2.0) · Supabase em prod · Slack funcionando · **início da medição** |
| 27/06 | Feedback dos gerentes aplicado: só rampa, janela curta, +8min QA, **removidas peça-crítica/diversas-avarias** |
| 29/06 | Decisão: capacidade = **RHID** (escala real, pedido da operação) · regra **espera-sem-diagnóstico** criada (validada num caso real de 3h) |
| 01/07 | **Calibração dos tempos por peça** (regressão, 12,8 mil OS, v0.3.0) — auditada adversarialmente · API externa pro Control Tower |
| 02-03/07 | Análise cruzada RIVERS×Maestro (auditada, recontagem independente) · métrica corrigida pra "até ficar pronta" · serviço especial excluído · dashboard executivo publicado |
| 07/07 | Call com Guida → relatório reformulado (regras explicadas, quebra dos excessos, glossário, volume por base) |
| 10/07 | Autópsia dos 6 furos e dos 180 excessos · query do Vinicius rodada (670 entregas) · conciliações documentadas · doc de investigação publicado |
