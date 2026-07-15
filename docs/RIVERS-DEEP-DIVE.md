# RIVERS — Deep Dive Técnico (pra virar nerd no assunto)

> Nível: engenharia/data. Tudo que existe no sistema, como funciona por dentro, por que cada decisão foi tomada, e as perguntas difíceis com resposta.
> Plano de estudo no final. Números de bolso na última página.

---

## 1. O sistema em um parágrafo

RIVERS é um serviço web (Next.js/TypeScript, serverless na Vercel) que, a cada chamada, lê as réplicas do ClickHouse, avalia todas as OS de manutenção ativas das 3 bases com um **algoritmo determinístico em camadas**, devolve decisão + motivo legível, grava cada decisão com snapshot completo num Postgres (Supabase) e notifica reservas novas no Slack. Uma API REST expõe as decisões pro Control Tower da mesa. A acurácia é medida cruzando as decisões com o que a oficina registrou no Maestro e com o desfecho real de cada OS.

**Conceito-chave: o motor é REATIVO.** Não tem processo rodando em background — a função serverless executa quando alguém chama uma URL (nossa tela a cada 60s, a tela do Control Tower, ou um agendador). Se ninguém chama, nada roda. Por isso o cron é a pendência nº 1.

---

## 2. Anatomia de uma avaliação (o que acontece quando alguém chama /api/os)

Passo a passo do `runRivers()` (src/lib/rivers-engine.ts):

**Passo 1 — OS_QUERY (uma query, ~6 CTEs):** busca todas as OS ativas (statuses OPEN → AWAITING_VMGMT, criadas nas últimas 24-48h*, asset BIKE, bases 1/34/166) e monta pra cada uma:
- `os_meta`: status atual, minutos desde a abertura, minutos no status, flags de checklist (imobilizada/acidente/guincho via `JSONExtractBool(meta,'checklist_tags','immobilizing')` — args separados, dot-path não funciona no CH)
- `pecas_diag`: nº de peças distintas, **tempo estimado** = `round(sum(qty × coalesce(transform(item_group_id, [ids], [minutos_calibrados], 0) → nullIf → time_target → 15)) + 25)` — os minutos calibrados são injetados no SQL como arrays literais a partir de `tempo-pecas.ts`
- `estoque`/`sem_estoque`: pra cada peça do diagnóstico, se há quantidade AVAILABLE nos depósitos STORAGE/STAGING da base (⚠️ furos conhecidos: NULL vira 0; ignora depósitos MAINTENANCE/PERSON; não vê outras bases)
- `is_piso`: existe check-in MAINTENANCE no Maestro hoje, chamado (called_at), pra essa OS

*\*A janela de 1 dia (`toDate(so.created_at) >= today()-1`) é um filtro de performance que virou bug conhecido: OS de sexta some do radar na segunda. Fix proposto: 7 dias.*

**Passo 2 — CAP_QUERY (capacidade):** mecânicos do setor Oficina **escalados agora** segundo o RHID: `employee_role_history` (último registro por funcionário, `sector_id=1`) → `shift.location_id` (1=SBC, 2=Osasco, 3=Mooca — atenção: IDs diferentes do OMS!) → parse do campo `previsto` ("14:00-16:00 17:00-23:48") em horas via `arrayMap`+`splitByChar`+`range` → conta distintos na hora atual → **× haircut** (0,70 Mooca / 0,84 Osasco / 0,94 SBC).

**Passo 3 — fila por base:** soma do tempo estimado das OS em AWAITING_MECHANIC da base.

**Passo 4 — avaliarOS() por OS** (o algoritmo, seção 3).

**Passo 5 — log:** upsert em `rivers_suggestion` com snapshot das features. **Passo 6 — Slack** (só /api/os e /api/cron): reservas de piso que não têm RESERVA logada nas últimas 48h (dedup via consulta ao próprio log).

---

## 3. O algoritmo (src/lib/algorithm.ts, ALGO_VERSION 0.3.0)

Ordem de avaliação — **a primeira que dispara retorna**:

```
1. C1_HARD            imobilizada || acidente || guincho || INSURANCE_QUOTE → RESERVA
2. C1_ANOMALIA        min_open_to_awaiting > 240  (4h sem entrar na oficina) → RESERVA
3. C1_ESPERA_SEM_DIAG is_piso && tempo_estimado==0 && min_desde_open > 150 → RESERVA
4. C2_SEM_ESTOQUE     n_sem_estoque > 0 → RESERVA
5. C3_TEMPO_ALTO      tempo_estimado > 120 → RESERVA
6. C3_TEMPO_COMBINADO min_desde_open + restante + 8(QA) > 180 → RESERVA
7. C4_CAPACIDADE      min_desde_open + (fila/capacidade) + restante + 8 > 180 → RESERVA
8. C4_OK              (com diagnóstico, dentro do prazo — motivo mostra a conta)
9. C5_AGUARDA_DIAG    (sem diagnóstico, sem estimativa)
```

- `restante` = tempo_estimado − minutos já em execução (se IN_PROGRESS), senão tempo_estimado inteiro.
- Sem capacidade (escala zerada — madrugada/almoço) → cai pro C5/C4_OK sem a conta de fila.
- **Racional da ordem:** casos óbvios primeiro (não dependem de estimativa) → estoque (independe de tempo) → tempo. Cada OS aparece numa única categoria por causa disso.
- **Removidas em 27/06** (pedido da operação + dado): C3_PECA_CRITICA e C3_DIVERSAS_AVARIAS. Na época eram bons preditores (~80-90% >3h), mas eram atalhos do que o tempo captura; com o tempo calibrado ficaram redundantes.
- **Versões:** 0.1 original (thresholds de 11/05) → 0.2 (25/06: capacidade plugada, espera-sem-diag em 29/06) → 0.3 (02/07: tempos calibrados). A versão vai no log → dá pra comparar calibrações.

---

## 4. Modelo de tempo — a regressão (o assunto favorito de data)

**Problema:** `time_target` (cadastro) zerado pra ~29 grupos; havia até gambiarra `if(id=308,41,0)` no SQL. Estimativa ruim = decisão ruim.

**Solução (scripts/calibra-tempo.mjs):**
- **Dados:** 12.785 OS concluídas em 75 dias, 3 bases. Alvo `y` = tempo de rampa real = soma dos episódios IN_PROGRESS (mesmo-dia, cada um entre 1-360min, total 10-480min — caps contra "esqueceu aberto de noite"). Features = quantidade por item_group (só grupos com ≥3 OS entram: 181 grupos).
- **Modelo:** NNLS — mínimos quadrados com coeficientes ≥ 0, resolvido por coordinate descent (400 passadas; a cada passada, cada coeficiente é atualizado pra sua solução ótima dado os outros fixos, com clamp em ≥0). **Prior fraco**: cada coeficiente é puxado pro time_target do cadastro (ou 15min se não houver) com força λ=40 — na prática, peça com muitas observações segue o dado, peça rara fica perto do cadastro. Intercepto quase livre → convergiu pra **25min** (custo fixo por OS: setup, deslocamento, finalização).
- **Validação:** split **temporal** (treino = dias antigos, teste = últimos 14 dias — nunca aleatório, senão vaza padrão do mesmo dia). MAE teste: **31,6min vs 35,1** da fórmula antiga. Na métrica de decisão (classificar >180min): acurácia 92,0 vs 91,0, **recall de OS longas 39% vs 27%**, precisão 57% vs 48%. Refit final com tudo (as métricas reportadas seguem sendo as do split).
- **Auditoria adversarial** (3 verificadores independentes): matemática do coordinate descent conferida contra a forma fechada; wiring do SQL validado ao vivo; 3 OS de produção recalculadas na mão — diferença zero.
- **Produção:** os coeficientes viram uma tabela estática em `tempo-pecas.ts`, injetada no SQL via `transform(item_group_id, [ids], [minutos], 0)` com fallback `nullIf → time_target → 15`. **Não há runtime de ML em produção** — é uma soma ponderada; recalibrar = rodar o script de novo.

**Limitações conhecidas (falar antes que perguntem):**
1. **Aditividade**: o modelo soma minutos de peças que o mecânico executa em paralelo na mesma desmontagem. Medido nos excessos: estimado mediano 130min × real 84min = **superestima 1,68×** em moto multi-peça. Fix planejado: termo sublinear no nº de peças (próxima calibração).
2. **Colinearidade**: peças-kit que sempre co-ocorrem (ex: rolamento inferior 308 + pista 359) — a regressão dá o tempo pra uma e zera a outra. Pra predição conjunta é indiferente; caso "peça órfã sozinha" ocorre em 3-7 de milhares de OS. Documentado.
3. **Censura à direita**: o cap de 480min descarta as OS gigantes → coeficientes de peças pesadas puxados pra baixo → parte do motivo de perder serviço complexo de dias.
4. MedAPE piorou (43% vs 38,5%) — esperado: o intercepto de 25min infla erro **percentual** em OS curtinhas (mediana 55min), irrelevantes pro corte de 180. A métrica de decisão é a que manda.

---

## 5. Modelo de capacidade — a saga completa (a melhor história de método)

**O problema:** pra conta da fila, precisamos de "quantos mecânicos disponíveis nesta base, agora".

**Iteração 1 — proxy (v0.1):** inferir mecânicos a partir das OS ativas ("quem está mexendo em moto agora"). Quebrava no almoço e na troca de turno (parecia que não tinha ninguém → reserva à toa). Descartado.

**Iteração 2 — curva histórica:** média de mecânicos **realmente ativos** por base × dia-da-semana × hora (medido por eventos de OS com janela leadInFrame). Suave, captura almoço/turno naturalmente.

**Iteração 3 — escala do RHID:** o `previsto` do ponto (quem está escalado), parseado por hora, × fator de presença.

**O backtest (out-of-sample, leave-one-out por dia):** baseline histórico **ganhou** — MAE em mec/h: Mooca 3,3 (baseline) vs 5,2 (escala); Osasco 2,3 vs 5,5; SBC 1,1 vs 0,8 (única onde a escala ganhou; amostra pequena). **Por que a escala perde:** ela mede "quem bateu ponto", não "quem está na rampa" — tem pico falso às 13-14h (sobreposição de turnos), buraco às 12h (almoço), e o haircut (fração escalado→rampa) importa esses artefatos.

**A decisão final (29/06): RHID mesmo assim.** Racional da operação: o quadro cresceu ~72 → ~115 mecânicos em 3 meses; média histórica fica sempre atrasada em relação a mudanças de quadro, e a escala é o "fato" que a operação controla. Trade-off aceito e documentado (~2 mec/h de precisão a menos). **Haircuts medidos no histórico:** Mooca 0,70 / Osasco 0,84 / SBC 0,94 (razão entre ativos-na-rampa e escalados, por base).

**O efeito colateral previsto que aconteceu:** semana do feriado (09/07) → escala reduzida → capacidade calculada caiu → fila/capacidade explodiu → C4 disparou 39 excessos só em Osasco. É a recalibração nº 1 (revisar haircut de Osasco + a composição da fila, que soma estimativas ainda infladas).

### O monitor /capacidade (a tela dos gestores) — como funciona por dentro

É a página https://vammo-reserva.vercel.app/capacidade — o **medidor público do modelo de presença**: mostra, por base, quantos mecânicos o modelo previu pra cada hora × quantos estiveram ativos de verdade. Serve pra qualquer gestor auditar a previsão sem confiar na nossa palavra.

**Como o "REAL" é calculado** (a linha cheia): a partir dos eventos de status das OS, montamos as janelas em que cada mecânico esteve com uma OS **em execução (rampa)** — do evento IN_PROGRESS até o evento seguinte (janela fechada no mesmo dia, capada). "Real da hora H" = nº de **mecânicos distintos** com janela ativa naquela hora, naquela base. Só dias úteis, horas 6h-22h. Importante: depois do feedback dos gerentes, conta **só rampa** (tirado diagnóstico e QA), porque o tempo estimado das OS é tempo de rampa — numerador e denominador na mesma unidade.

**Como o "ESTIMADO" é calculado** (a linha tracejada): pra cada hora do dia exibido, a média do REAL **nas mesmas horas dos outros mesmos-dias-da-semana** da janela de 14 dias — **excluindo o próprio dia** (leave-one-out). Esse detalhe é o que torna o gráfico honesto: se incluísse o próprio dia, estimado e real seriam quase iguais e o "acerto" seria falso. Segunda é comparada com segundas, sábado com sábados (o padrão de escala muda por dia da semana). Janela de 14 dias porque o quadro de mecânicos cresce rápido — 60 dias atrás havia ~40 mecânicos a menos, e janela longa subestimava.

**Os cartões do topo:**
- **Acerto da previsão** = 1 − (erro típico ÷ média real). Ex: erro de 3 mecânicos num nível médio de 20 → 85%. É erro relativo, **não** "taxa de acerto de eventos".
- **Erro médio** = média, entre os dias, do erro absoluto |previsto − real| por hora (cada dia avaliado out-of-sample via leave-one-out).
- **Filtro de dias plenos:** o acerto só considera dias com média real ≥ 8 mecânicos — dia esvaziado (feriado/domingo emendado) distorceria. Em SBC (base pequena, ~5 mecânicos) nenhum dia passa do filtro → a tela mostra **"amostra baixa"** em vez de um número enganoso (já mostrou "100%" falso por um bug de divisão; corrigido).

**A pegadinha que TODO tech vai perguntar: "a tela usa uma conta e o motor usa outra?"** Sim, e é proposital saber disso: a **tela** mostra o baseline estatístico (média do real, LOO) — que é a régua mais precisa que temos e serve de **monitor**. O **motor** usa o RHID (escala do dia × haircut) — decisão da operação, por refletir o quadro atual. O baseline da tela é justamente o benchmark que o RHID tem que perseguir: se um dia o RHID passar a régua, ótimo; enquanto isso, a tela denuncia quando a previsão descola do real. Unificar as duas contas num mart (dbt) é refinamento pendente.

**Histórico de bugs dessa tela (transparência):** (1) o "100%" falso da SBC (filtro esvaziava a amostra e a conta devolvia 1 − 0/x); (2) a versão inicial contava diagnóstico e QA no "real" — corrigido pra só rampa a pedido dos gerentes, o que inclusive MELHOROU o acerto de Osasco (79→84%).

---

## 6. Dados: tabelas, semântica e gotchas de ClickHouse

**Fontes (réplicas peerdb, sempre `FINAL` + `_peerdb_is_deleted=0`):**
| Tabela | O que fornece |
|---|---|
| `oms_r.so` / `so_status` / `so_item` | OS, histórico de status, peças (origin DIAGNOSIS/MECHANic, qty>0, item_group_id>0) |
| `ims_r.item_group` / `inventory` / `deposit` | catálogo de peças (time_target), estoque por depósito |
| `maestro_scheduler_r.checkin` | check-in de piso; campos de reserva: reserve_offered_at / delivered_at / reason / estimated_hours; join por so_id (1:1 verificado) |
| `mechanics_r.public_rhid_workday` / `employee_role_history` / `shift` / `sector` | escala (previsto/punches/dia_falta), cargo (sector 1=Oficina, 2=Qualidade), turno→base |
| `vammo_r.user_had_bike` | atribuições reais de moto (assignation_type: rental/reserve) — a fonte do estudo do Vinicius |

**Gotchas que a gente pagou pra aprender (contar com orgulho):**
1. `JSONExtractBool(meta,'a.b')` NÃO navega JSON aninhado → flags sempre 0 → camada crítica ficou morta semanas. Fix: `JSONExtractBool(meta,'a','b')`.
2. `minIf(x, cond)` sem match retorna **epoch 1970**, não NULL → OS canceladas apareceram como "abertas há 170h". Fix: `min(if(cond, x, NULL))` (agregações ignoram NULL).
3. `JOIN tabela FINAL` direto pode duplicar linhas (versões não mescladas) → usar subquery com FINAL dentro.
4. IDs de base diferem entre sistemas: OMS 1=Mooca/34=Osasco/166=SBC × RHID location 1=SBC/2=Osasco/3=Mooca. De-para hardcoded no CAP_QUERY.
5. Paginação PostgREST precisa de tiebreaker único no order (`created_at,id`) — timestamps empatam em lote.

**Log (Supabase):** `rivers_suggestion(os_id, algo_version, decision, fired_layer, motivo, features jsonb, created_at)` com `UNIQUE(os_id, algo_version, decision)` e upsert ignore-duplicates → **guarda o primeiro instante de cada decisão** (semântica escolhida: é a métrica de antecipação). Consequência: reavaliações que mantêm a decisão não geram linha nova (o log não é um histórico de execuções — é um histórico de mudanças de decisão). `rivers_feedback` = botões da tela.

---

## 7. Medição de acurácia — método e números

**O cruzamento (scripts/cross-analysis.mjs):** por os_id, 3 fontes: log do RIVERS (1ª decisão RESERVA) × checkin do Maestro (ofertou/entregou + motivo) × desfecho real do CH.

**Definições (cada uma tem uma história):**
- **Tempo até ficar PRONTA** = abertura → 1º AWAITING_CX ou COMPLETED, o que vier primeiro. Por quê: medir até retirada distorce — **cliente com reserva não tem pressa de devolver** (caso real: pronta em 1h26, retirada 7 dias depois). Descoberta que também é insight operacional (fila de devolução de reservas).
- **Canceladas fora** das contas de espera (a moto segue em outra OS).
- **Serviço especial excluído** dos dois lados (decisão da operação 03/07 — fluxo com decisão de reserva própria).
- "Oficina decidiu" = ofertou OU entregou. Viés conhecido: a oficina só oferta quando **há moto reserva disponível** — então "só RIVERS" ≠ erro dele.
- Snapshot único (log cortado no instante do export do Maestro), recontagem independente bateu 12/12 números.

**Números (25/06 → 10/07, 1.396 OS):** oficina 130 (75 entregues + 55 só ofertadas) · RIVERS 360 · **TP 115 / só-RIVERS 245 / furos 15 (6 reais) / recall 88%** · dos 245: 61 passaram de 3h (RIVERS certo), 180 excesso (mediana 131min — na trave), 4 em aberto · corrida: RIVERS antes em 67×48 (58%; 70% na última semana) · melhor regra: espera-sem-diag 19/19.

**Conciliações que confundem todo mundo:** 360 = 115 + 245 (total = confirmadas + só-RIVERS). E 130 ≠ total da Vammo: houve **670 entregas reais** no período (todos os fluxos; query do Vinicius) — só ~18% com motivo registrado → gap de governança pro SOP.

**A autópsia dos 6 furos:** 3 = janela de 1 dia (abriram sexta, diagnosticadas segunda); 2 = nunca diagnosticadas (a regra das 2h30 não reavaliou por tela fechada + janela); 1 = avaliada 12min antes do diag fechar (era fórmula v0.2). **Zero erros de conta** — problema de presença.

---

## 8. Integrações e operação

- **Tela do líder (/):** auto-refresh 60s; cada refresh executa o motor, loga e notifica. Card de cada OS mostra decisão + motivo + a conta.
- **Slack:** Incoming Webhook (`SLACK_WEBHOOK_URL`); só reservas de piso NOVAS (dedup 48h); mensagem = placa/base/motivo/link.
- **API do Control Tower (`/api/recomendacoes`):** JSON enxuto por OS (reservar, motivo, regra, tempo previsto); header `x-api-key`; cada consulta calcula fresco e **loga** (não notifica Slack). Se nossa API cair, o front deles engole o erro silenciosamente (o alerta some sem aviso — combinado monitorar).
- **Cron (`/api/cron`):** avalia + loga + notifica; Bearer `CRON_SECRET`; janela 7h-21h SP; `?test=1` bypassa dedup/horário. **Falta só o agendador** (n8n ou cron-job.org, 10/10min).
- **Deploy:** `npx vercel --prod` (sobe arquivos locais); typecheck antes; env no painel da Vercel (a senha CH do .env.local local está desatualizada — a válida é a do painel).
- **Observabilidade (resposta honesta):** logs da Vercel + o próprio log de decisões no Supabase (que é auditoria completa). Sem APM/alerting formal — aceito pro estágio; o log de decisões é o que importa pro produto.

---

## 9. Por que é assim — tabela de decisões

| Decisão | Racional | Quando |
|---|---|---|
| Regras determinísticas, sem LLM | Operação exige auditar/contestar cada decisão; LLM removido a pedido da empresa | 22/06 |
| Log com snapshot + versão | Auditoria por decisão + comparar calibrações | 23/06 |
| Capacidade = RHID (mesmo perdendo backtest) | Reflete quadro atual (quadro +60% em 3 meses); escala é o "fato" que a operação controla | 29/06 |
| Só rampa no numerador, janela curta, +8min QA | Pedidos da operação (call gerentes) | 27/06 |
| Remover peça-crítica/diversas-avarias | "Tempo decide"; dado confirmou redundância pós-calibração | 27/06 |
| Tempos por regressão, não cadastro | time_target quebrado; validado OOS + auditoria | 01/07 |
| Tempo até PRONTA (não retirada) | Reserva tira a pressa do cliente de buscar | 03/07 |
| Serviço especial fora do universo | Fluxo com decisão própria; exclusão nos 2 lados | 03/07 |
| Medição antes de autonomia total | Acumular evidência antes de virar 100% oficial | contínuo |

---

## 10. Sabatina — perguntas difíceis de tec/data (com resposta)

**"E se o ClickHouse cair?"** → /api/os retorna 500, a tela mostra erro, o Control Tower engole (alerta some). Sem retry/circuit breaker hoje — aceito pro estágio; o cron reavalia no ciclo seguinte.

**"Race condition no log? Duas chamadas simultâneas?"** → O upsert é idempotente na chave (os_id, versão, decisão) com ignore-duplicates — corrida vira no-op. O pior caso teórico é Slack duplicado se duas execuções passam no dedup ao mesmo tempo; janela de ms, nunca observado, e o custo é uma mensagem repetida.

**"Por que calcular na leitura em vez de materializar?"** → Volume pequeno (centenas de OS), queries agregadas respondem em ~1-3s, e decisão precisa do dado de agora. Materialização (mart dbt) está no roadmap pra curva de capacidade, não pra decisão.

**"Testes automatizados?"** → Honesto: typecheck estrito + verificação em produção a cada mudança + auditorias adversariais nas análises (recontagem independente). Suite de testes unitários do algoritmo é débito reconhecido — e é fácil de escrever porque o algoritmo é função pura (input → decisão).

**"Como sabem que a regressão não tá overfitando?"** → Split temporal (não aleatório), prior que regulariza peças raras, e a prova final: métricas estáveis semana a semana em produção (recall subiu 87→91 com mais dados).

**"Por que mediana e não média nas análises?"** → Distribuições de tempo de oficina têm cauda pesada (OS de dias); média mente, mediana descreve o caso típico. Média aparece só onde faz sentido somar (fila).

**"O 88% não é inflado porque a oficina define o gabarito?"** → Pergunta boa — por isso medimos TAMBÉM contra o desfecho real (a moto passou de 3h?), que independe da decisão humana. É essa segunda régua que mostra que 1 em 4 'excessos' do RIVERS eram acertos que a oficina perdeu.

**"Escala? Custo?"** → Serverless, paga por invocação, volume baixíssimo. Custo hoje ≈ zero (free tiers). O gargalo teórico é o CH, que responde agregações dessas em segundos.

**"Por que Supabase e não gravar no próprio CH?"** → Log transacional pequeno com upsert e unique constraint = Postgres é a ferramenta certa; CH é ruim pra upsert pontual. E separa o log (nosso) do warehouse (compartilhado).

**"Quem mantém isso?"** → Código no repo com docs vivos (COMO-FUNCIONA.md, DECISOES.md), calibração reprodutível por script, log auditável. Handoff pra eng é viável — e bem-vindo.

---

## 11. Plano de estudo pra hoje (45 min)

1. **(15 min)** Leia as seções 2, 3 e 5 deste doc — fluxo da avaliação, algoritmo e a saga da capacidade. São o coração.
2. **(10 min)** Seção 4 (regressão) — decore: 12,8 mil OS, NNLS com prior, split temporal, 31,6 vs 35,1, limitação aditiva 1,68×.
3. **(10 min)** Seção 10 (sabatina) em voz alta — uma vez só já assenta.
4. **(5 min)** Números de bolso abaixo.
5. **(5 min)** Abra o app e clique em 2-3 OS — nada convence mais que mostrar uma decisão real com o motivo na tela.

## Números de bolso

**180min** (SLA) · **120/150/240min** (cortes: serviço longo / espera sem diag / anomalia) · **8min** QA · **25min** custo fixo por OS · **12.785 OS / 181 peças** (calibração) · **31,6 vs 35,1** (MAE novo vs antigo) · **1,68×** (superestimação multi-peça) · **0,70/0,84/0,94** (haircuts M/O/S) · **3,3 vs 5,2** (MAE baseline vs escala, Mooca — o backtest que a escala perdeu) · **88% recall · 67×48 corrida · 6 furos (0 por conta errada) · 61/245 excessos com razão · mediana 131min** · **360=115+245** · **670 entregas reais / 18% com motivo** · **~1min** lag CH · versões **0.1→0.2→0.3**.

**Links:** app vammo-reserva.vercel.app · relatórios em `calib/` · referência: docs/COMO-FUNCIONA.md
