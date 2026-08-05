# RIVERS — visão de dados

*Para o time de dados. Foco: o que o sistema lê, como decide e o que grava. Métricas do piloto (em andamento na Mooca) ficam fora deste doc — falamos delas na retro.*

## O que é

Motor determinístico que roda **a cada 10 minutos** e responde, para cada moto na oficina com cliente esperando: *"esse conserto vai passar de 3h?"* Se sim, sugere moto reserva — algumas regras agem sozinhas, outras vão pra tela do CX decidir. Sem LLM em produção: só regras e thresholds versionados (`ALGO_VERSION` no log permite auditar qualquer decisão histórica).

**Stack**: Next.js/TypeScript na Vercel · ClickHouse (leitura, HTTPS) · Supabase Postgres (log) · agendador pg_cron (job `rivers_tick`, 10min, janela 7h-21h SP).

## Fontes lidas (ClickHouse)

| fonte | pra quê |
|---|---|
| `oms_r.so` + `so_status` | a OS, base, tipo, e a linha do tempo de status (relógio de tudo) |
| `oms_r.so_item` (origin DIAGNOSIS/MECHANIC) | peças → estimativa de tempo; **peça adicionada na rampa recalcula em 10min** |
| `oms_r.so_service` | serviços (ex.: troca de placa → regra própria) |
| `maestro_scheduler_r.checkin` | quem está fisicamente na base ("piso") — check-in do dia + atendimento ainda aberto |
| `maestro_scheduler_r.checkin_event` | oferta de reserva da oficina (RESERVE_OFFERED/CANCELLED) — **fonte viva pós Check-in 2.0** |
| `oms_r.public_so_operational_state` | client_present (2º sinal de piso; a união dos dois cobre o piso real) |
| `ims_r.item_group` | tempo-alvo de peça (fallback do mapa calibrado) |
| `mechanics_r.public_rhid_workday` + role_history | capacidade esperada de mecânicos (hoje só **medidor** na tela, não decide) |

**Estimativa de tempo**: mapa próprio de minutos/peça (recalibrado contra o tempo real de bancada — mediana dos episódios IN_PROGRESS; treino/teste separados no tempo) × fator por nº de peças + 25min fixos. Vive em `src/lib/tempo-pecas.ts`, regenerável por script.

## As regras (ordem de avaliação; a primeira que casa vence — v0.23, 05/08)

**Agem sozinhas** (entrega direta): vistoria de seguro (com gate: só enquanto não há diagnóstico ou a projeção não cabe nas 3h) · **troca de placa** (moto sem placa não circula — régua legal) · moto 4h sem chegar ao mecânico · cliente em piso 1h30 na fila sem diagnóstico · cliente 2h30 sem diagnóstico nenhum.

**Vão pra tela do CX**: moto travada aguardando peça (30min+) · parada em serviço de terceiro/gestão de frota · **relógio 150min com cliente em piso e a moto FORA de qualidade** (o sinal mais forte do sistema: reparo tem cauda lognormal — quem já demorou vai demorar mais, *exceto* se está em QA, que é sinal de fim; 87,3% medido, n=887) · **reprovada na qualidade com 165min+ de relógio** (retrabalho não cabe no prazo; 98,9%, n=91) · serviço grande (estimado >240min) · projeção cruzando as 3h, firme só quando a estimativa é ≥180min.

**Re-estimativa dinâmica**: peça registrada na rampa recalcula em 10min; reprovação de QA soma 45min de retrabalho à projeção (mediana medida).

**Conceito central**: *reserva* é decisão de regra; *aviso ao cliente* é decisão de relógio — todo cliente que cruza 3h reais entra na fila de aviso da tela, independente de regra.

**Desligadas com histórico** (religáveis por env, sem deploy): leitura de saldo de estoque (`C2_SEM_ESTOQUE`) e capacidade/fila (`C4_CAPACIDADE`) — nos dois casos a premissa não sobreviveu ao dado (ver achados abaixo).

**Em sombra**: classificador logístico de P(estourar) — 16 sinais, treinado offline com split temporal e calibração Platt (desenho Lyft/literatura de process monitoring), logado a cada tique em `features.p_estouro`, sem decidir. Promoção prevista após validação ao vivo. Pesos em `calib/classificador-v1.json`, código em `src/lib/classificador.ts`.

## O que gravamos (Supabase — pode interessar ingerir no DW)

- **`rivers_suggestion`** — toda decisão de todo tique: `os_id, placa, location_id, is_piso, decision, fired_layer, motivo, algo_version, features (jsonb com os insumos), created_at`. Idempotente (primeiro instante de cada decisão). ~2 semanas de história já.
- **`rivers_cx_aviso`** — clique "avisei o cliente" da tela do CX (os_id, quem, quando).
- **`rivers_feedback`** — aceite/recusa humana com motivo.

## Performance

**Backtest (Mooca, 60 dias, clientes de piso, treino/teste separados no tempo):**

| regra | precisão | n |
|---|---|---|
| 1h30 na fila sem diagnóstico (automática) | 98,1% | 159 |
| 2h30 sem diagnóstico (automática) | 94,4% | 177 |
| serviço grande (>240min estimados) | 87,5% | 72 |
| projeção cruzando as 3h | ~80% | 344 |

*Precisão = % dos avisos em que a moto realmente passou de 3h. Linha de base: ~21% dos clientes de piso estouram.*

**Piloto (Mooca, desde 31/07):** cobertura é o ponto forte — **zero clientes estouraram sem marca prévia do RIVERS desde os ajustes do dia 1**, com o aviso pelo relógio às 3h como rede de fato. A primeira semana expôs as fontes de erro de precisão (disparo na trave, fila fictícia, viés em OS grande), todas corrigidas com medição.

**Backtest da configuração vigente (v0.23, replay tick-a-tick de 92 dias, `scripts/backtest-v23.mjs`):** precisão **88,7%** com recall-antes-da-linha de 84% e aviso mediano 50min antes; nos últimos 5 dias do replay, todos os dias ≥80% (80,0 / 81,8 / 100 / 100 / 100 / 83,3). A configuração anterior media 73,2% no mesmo replay. Validação em produção em andamento (placar diário automático às 20h40).

## Achados de dados no caminho (os que valem pro DW)

1. **`ims_r.request.created_at` é endógeno** — o mecânico só pede a peça depois que ela está na prateleira ("pedido→entrega p50 7min" mede o balcão, não a espera). Âncora honesta: `so_item.created_at` do diagnóstico.
2. **Ledger não mede transporte** — TRANSFER é partida dobrada atômica (saída Osasco/entrada Mooca no mesmo segundo, 8.4k casos). O dado só nasce quando o estoquista registra.
3. **Saldo zero local ≠ atraso** — a reposição intraday via Osasco resolve; foi por isso que a regra de estoque saiu da decisão.
4. **A fila da Mooca não gera espera pro piso** — espera real até o mecânico: mediana 4-9min **independente da profundidade da fila** (0 a 6+ motos na frente; n=1.864, 60d). A oficina paraleliza. Regra de capacidade não tem fenômeno pra prever.
5. **Pós Check-in 2.0 (21/07)**: `checkin.reserve_offered_at` subconta 2-3x; oferta = `checkin_event`. `checklist_tags` morreu; incidente = `triage.incidents.{accident,immobilizing,towing}`.
6. **`FINAL` em JOIN direto não deduplica** (ClickHouse) — sempre subquery com alias; e `minIf` sobre DateTime devolve epoch 1970 sem match.
7. **`so_item.time`** (nasceu 28/07, ~89% cobertura, corr 0,576 com execução real) — candidata a melhorar a estimativa de tempo; na fila da retro.

## Pendências onde o time de dados ajuda

- **Saldo point-in-time de peças** (estilo `int_cabinet_temporal_state`): existe/vale criar?
- Cadência das transferências Osasco→Mooca (programada × sob demanda) — conversa iniciada, Almir Alves sugerido.
- Longo prazo: mover a leitura de SLA de hardcode pra `maestro_scheduler_r.sla_config`.

*Código: github.com/alvaro876/vammo-reserva — motor em `src/lib/algorithm.ts` (regras) e `src/lib/rivers-engine.ts` (SQL). Histórico de decisões de produto em `docs/DECISOES.md`.*
