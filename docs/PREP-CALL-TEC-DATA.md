# Preparação — Call com Tec & Data (RIVERS)

> Duas partes: **(1) Roteiro de apresentação** (~12min de fala) e **(2) Material de estudo** — banco de perguntas prováveis com as respostas, organizado por tema, + números de bolso.
> Antes da call, vale reler também `docs/COMO-FUNCIONA.md` (a referência completa).

---

# PARTE 1 — ROTEIRO (~12 min)

## Abertura: o problema (1 min)

"Contexto rápido pra alinhar: quando o cliente deixa a moto na oficina e o conserto vai passar de 3 horas, a política é dar moto reserva. Essa decisão era manual — líder de turno olhando as OS — então variava por pessoa e saía tarde. O RIVERS automatiza: avalia todas as motos em piso continuamente, decide se dá reserva, e **sempre explica o porquê**. E o ponto principal pra essa conversa: a gente **mede** se ele acerta, moto a moto, contra o que a oficina fez de verdade."

## Arquitetura (2 min)

"O desenho é enxuto e serverless. Um app Next.js/TypeScript na Vercel. Ele lê as réplicas do ClickHouse ao vivo — OMS pras OS e peças, IMS pro estoque, Maestro pros check-ins, e o RHID pra escala de mecânicos — com ~1 minuto de lag da replicação. Não tem banco intermediário pra decidir: cada avaliação é calculada na hora, do dado quase ao vivo.

Cada decisão é gravada num Postgres no Supabase com um **snapshot completo do que o algoritmo enxergou** — tempo estimado, fila, capacidade, peças, versão da lógica. Isso é o que permite auditar qualquer decisão individual e medir acurácia depois.

Saídas: a tela do líder, alerta no Slack pra reserva nova (com dedup pra não repetir), e uma **API REST** que o Control Tower da mesa já consome — cada consulta deles executa o algoritmo fresco e devolve JSON.

Detalhe importante: o motor é **reativo** — roda quando alguém chama (nossa tela, o sistema da mesa, ou um agendador). O agendador é a pendência número 1, já volto nisso."

## O algoritmo (3 min)

"É um algoritmo **determinístico de regras** — decisão consciente: a operação precisa auditar e contestar qualquer decisão. Não tem caixa-preta. A parte 'aprendida' está nos insumos, não na decisão.

Na raiz, dois critérios. **Critério tempo**: a moto não fica pronta em 3 horas. A conta é: quanto o cliente já esperou, mais a fila da base dividida pelos mecânicos escalados, mais o serviço restante, mais 8 minutos de QA — passou de 180, reserva. Essa conta tem quatro 'caminhos' no código (serviço estimado longo, tempo total, oficina saturada, e esperando sem diagnóstico — que pega moto parada 2h30 sem ninguém abrir o diagnóstico). **Critério peça**: diagnóstico pede peça sem estoque na base, não conclui hoje, reserva. E os óbvios sem conta: guincho, acidente, imobilizada.

O que a gente **tirou**, com dado: 'peça crítica' e 'quantidade de peças' como critérios — a operação apontou que ter um motor trocado não significa passar de 3h, e o histórico confirmou que o tempo decide melhor.

Agora, os dois insumos que alimentam a conta — que é onde entra a parte de data science."

## Os dois modelos (4 min)

"**Modelo 1 — tempo por peça.** O cadastro de tempos (time_target) estava zerado pra ~29 grupos de peça, então a estimativa era lixo. A gente recalibrou com **regressão não-negativa** sobre ~12.800 OS concluídas de 75 dias: o alvo é o tempo real de rampa, as features são as peças e quantidades, e os coeficientes que saem são os minutos de cada peça, mais um intercepto de ~25 minutos que é o custo fixo por OS. Validação **out-of-sample** com split temporal — teste nos últimos 14 dias: MAE de 31,6 minutos contra 35,1 da fórmula antiga, e o mais importante, dominou na métrica de decisão: classificar quem passa de 3h. Também passou por verificação adversarial — recalculamos casos de produção na mão e bateu exato.

Limitação conhecida e já mapeada: o modelo é **aditivo**, e mecânico não é — numa moto com 10 peças, ele faz várias na mesma desmontagem. Resultado: superestima 1,68× nas motos multi-peça. É a próxima rodada de calibração: desconto sublinear pra OS com muitas peças.

**Modelo 2 — capacidade da oficina.** Essa é uma boa história de método. Precisávamos saber quantos mecânicos estão disponíveis por base e hora — pra conta da fila. Testamos duas abordagens em backtest out-of-sample: **(a)** a escala oficial do RHID (quem está escalado, ajustada por um fator de presença real) e **(b)** um baseline estatístico simples: a média de mecânicos realmente ativos por base, dia-da-semana e hora. O baseline **ganhou** — erro de ~2,3 a 3,3 mecânicos/hora contra ~5,2 da escala, porque a escala tem artefatos (pico falso na troca de turno, buraco no almoço). Mas a operação pediu a escala mesmo assim, porque ela reflete o quadro **atual** — e o quadro cresceu 60% em três meses, o que contamina qualquer média histórica. Decisão documentada: seguimos com o RHID (escala do dia × fator de rampa por base), sabendo do trade-off. E o dado já cobrou: na semana do feriado a escala encolheu e a regra de saturação disparou demais em Osasco — é a recalibração em curso."

## Como medimos (2 min)

"Acurácia não é opinião aqui. Cruzamos três coisas por OS: o que o RIVERS sugeriu (nosso log), o que a oficina decidiu (campos de reserva do check-in no Maestro), e o desfecho real — o tempo **até a moto ficar pronta**. Esse 'até ficar pronta' importa: medir até a retirada distorce, porque cliente com reserva na mão demora dias pra buscar a moto pronta — tivemos moto pronta em 1h26 que ficou 7 dias esperando retirada. Também tiramos OS canceladas e o fluxo de serviço especial, que tem decisão própria.

Resultado de 15 dias: pegou 88% das reservas da oficina, aponta antes do humano na maioria (70% na última semana), e teve 6 furos — que a gente autopsiou um a um: nenhum foi a conta errando, foi o motor não olhando na hora certa. E dos casos em que só ele sugeriu, 1 em cada 4 a moto passou mesmo de 3h — ou seja, ele pega coisa que passava batido."

## Fecho: o que falta e onde vocês entram (1 min)

"Três coisas: **agendador** — o motor é reativo, falta um cron chamando a cada 10min (a rota existe, protegida por secret; pendurar no n8n resolve — é a ajuda mais valiosa que vocês podem dar). **Recalibração** — o desconto multi-peça e a fila de Osasco. E **governança de dado** — descobrimos que só 18% das entregas reais de reserva têm motivo registrado no sistema; se quisermos medir e melhorar o processo inteiro, isso precisa virar campo obrigatório. Perguntas?"

---

# PARTE 2 — MATERIAL DE ESTUDO (banco de perguntas prováveis)

## A) Produto e lógica

**"Por que 3 horas?"**
É a política operacional da Vammo pra reserva (SLA de piso). O algoritmo parametriza isso (180min) — se a política mudar, muda um número.

**"Por que regras e não ML?"**
Requisito da operação: auditabilidade e explicabilidade. Cada decisão sai com o motivo em texto e o snapshot dos inputs. O ML entra onde agrega sem virar caixa-preta: nos **insumos** (regressão pros tempos). E regras calibradas com dado batem ML opaco em confiança operacional. Já houve um fallback com LLM no início — foi **removido** por decisão da empresa.

**"Por que tiraram peça crítica/diversas avarias?"**
Pedido da operação ("ter Motor não significa >3h"). Na época o dado mostrava que eram bons preditores (80-90% passavam de 3h), mas eram **atalhos** pro que o tempo deveria capturar. Com a estimativa recalibrada, o tempo captura — e as regras viraram redundantes. Removidas em 27/06; o histórico delas aparece nos relatórios como "regra antiga".

**"O que é serviço especial e por que está fora?"**
Setor próprio (funilaria/serviços longos) com decisão de reserva própria, fora do fluxo do piso. Decisão da operação (03/07): fora do universo de medição, **pros dois lados** (tiramos acertos e furos). Hoje só identificamos ex-post (pelo motivo da reserva); pra filtrar ex-ante precisaria de um sinal no OMS.

**"O que acontece se a OS não tem diagnóstico?"**
Sem diagnóstico não há estimativa → cai em "aguardando diagnóstico" (sem reserva). MAS se for piso e passar de 2h30 sem diagnóstico → reserva (regra criada em 29/06 depois de um caso real de 3h; é a regra mais certeira: 19/19 nos dados).

## B) Algoritmo e engenharia

**"Qual a ordem das regras?"**
Camadas, a primeira que dispara decide: casos críticos (guincho/acidente/imobilizada/vistoria) → anomalia (+4h sem entrar) → espera sem diagnóstico (+2h30) → sem estoque → serviço longo (>120min) → tempo total (>180) → saturação (fila/capacidade). Senão: "dentro do prazo" com a conta exposta.

**"Como evita spam no Slack?"**
Dedup: antes de notificar, consulta as reservas já logadas nas últimas 48h (mesma versão) — só avisa OS nova. O log usa upsert idempotente em (os_id, versão, decisão), que guarda o **primeiro instante** de cada decisão (é a métrica de antecipação).

**"O app roda quando?"**
Serverless na Vercel, **reativo**: executa quando alguém chama — nossa tela (a cada 60s, e ela também loga+notifica), a API do Control Tower (cada consulta calcula fresco e loga; não notifica Slack), ou o cron (rota pronta, agendador pendente). Se ninguém chama, nada roda — por isso fins de semana/feriado ficaram no escuro e o cron é a prioridade.

**"Autenticação?"**
API externa: header x-api-key. Cron: Authorization Bearer com secret. Credenciais de banco só server-side (env da Vercel). Supabase via service key no servidor.

**"Fontes de dado?"**
Réplicas peerdb no ClickHouse: `oms_r` (OS, status, itens), `ims_r` (estoque, depósitos, item_group), `maestro_scheduler_r.checkin` (piso e campos de reserva), `mechanics_r` (RHID: escala, cargos, turnos). Sempre com `FINAL` + `_peerdb_is_deleted=0`. Lag ~1min.

**"Bugs/gotchas que vocês pegaram?"** (contar com orgulho — mostra rigor)
1. `JSONExtractBool(meta,'a.b')` não navega JSON aninhado no CH → flags de guincho/acidente sempre 0 → camada crítica morta. Fix: args separados.
2. `minIf` sem match retorna **epoch 1970**, não NULL → OS canceladas pareciam "abertas há 170h". Fix: `min(if(cond,x,NULL))`.
3. `JOIN tabela FINAL` direto duplica linhas → subquery com FINAL dentro.
4. Janela de 1 dia no OS_QUERY (`>= today()-1`) → OS de sexta sumia do radar na segunda → causa de 5 dos 6 furos. Fix proposto: 7 dias.

## C) Modelo de tempo (a parte que data vai cutucar)

**"Como calibrou?"**
NNLS (regressão não-negativa, coordinate descent) sobre 12.785 OS concluídas (75d, 3 bases). Alvo: tempo de rampa real (soma dos períodos IN_PROGRESS, episódios mesmo-dia 1-360min, total 10-480min). Features: quantidade por grupo de peça (181 grupos com ≥3 OS). Prior fraco pro cadastro (λ=40) pra estabilizar peças raras; intercepto quase livre (~25min = custo fixo por OS).

**"Validação?"**
Split **temporal** (não aleatório): treino = dias antigos, teste = últimos 14 dias. MAE 31,6 vs 35,1 da fórmula antiga. E na métrica que importa (classificar >180min): acurácia 92,0 vs 91,0, recall de OS longas 39 vs 27%, precisão 57 vs 48%. Depois refit com tudo (métricas reportadas seguem as OOS). Verificação adversarial independente: matemática conferida, wiring validado ao vivo, 3 OS de produção recalculadas na mão = exatas.

**"MedAPE piorou (43% vs 38%) — problema?"**
Não pro uso: o intercepto de 25min infla erro **percentual** nas OS curtinhas (mediana 55min), que são irrelevantes pro corte de 180. Na métrica de decisão o modelo novo domina. (Se insistirem: censura à direita existe — cap de 480min — e puxa peças pesadas pra baixo; documentado.)

**"Por que superestima multi-peça?"**
Modelo aditivo: soma minutos de peças que o mecânico executa em paralelo na mesma desmontagem (caixa de direção + freios + rodas). Excessos medidos: estimado mediano 130min × real 84min (1,68×). Fix na fila: termo sublinear pro nº de peças.

**"Colinearidade?"**
Sim, e conhecida: peças-kit que sempre vêm juntas (rolamento inferior + pista) — a regressão dá o tempo pra uma e zera a outra. Pra predição conjunta tanto faz; casos "peça órfã sozinha" são 3-7 em milhares. Documentado.

**"Por que não Python/sklearn em produção?"**
Calibração é **offline** (script) → gera uma tabela estática de minutos-por-peça que o app injeta no SQL. Produção não precisa de runtime de ML pra fazer uma soma ponderada. Recalibrar = rodar o script de novo.

## D) Modelo de capacidade / oficina

**"Como funciona hoje?"**
Escala real do dia (RHID): mecânicos do setor Oficina escalados na hora corrente (parse do campo `previsto`), por base, × fator de rampa (fração dos escalados que fica de fato em rampa, medida no histórico: Mooca 0,70 / Osasco 0,84 / SBC 0,94).

**"Vocês testaram alternativas?"** (história boa de contar)
Sim, backtest OOS honesto: escala×haircut vs baseline (média do real por base×dow×hora). Baseline ganhou — MAE Mooca 3,3 vs 5,2, Osasco 2,3 vs 5,5 — porque a escala tem artefatos (pico falso 13-14h na sobreposição de turno, buraco no almoço = "quem bateu ponto" ≠ "quem está na rampa"). **A operação escolheu o RHID mesmo assim**: reflete o quadro atual (cresceu ~72→115 mecânicos em 3 meses, o que contamina médias históricas). Trade-off documentado e monitorado.

**"E o efeito colateral?"**
Apareceu no dado: semana de feriado → escala menor → fila superestimada → regra de saturação disparou 39 excessos só em Osasco. Recalibração nº 1 da fila. (Possível causa adicional: haircut de Osasco alto e fila somando estimativas infladas.)

**"O que a tela /capacidade mostra?"**
Outra conta do mesmo conceito (média do real, 14d, leave-one-out) pra monitorar estimado×real por hora. Duas contas coexistem (a da tela e a do motor) — unificação é refinamento pendente.

## E) Medição de acurácia

**"Definições?"**
Universo: OS com check-in de manutenção que o RIVERS avaliou, sem serviço especial. "Oficina decidiu" = ofertou ou entregou reserva no check-in. TP = os dois; "só RIVERS" = ele marcou, oficina não; furo = oficina deu, ele não. Desfecho: tempo até ficar pronta (1º "aguardando cliente" ou conclusão); canceladas fora.

**"Números de 15 dias?"** → ver cheat sheet abaixo.

**"Por que 'só RIVERS' não é falso positivo?"**
Dois vieses: a oficina só oferta quando **tem moto reserva disponível** na base; e 1 em cada 4 "só RIVERS" a moto passou mesmo de 3h (a oficina que sub-reservou). O resto errou na trave (mediana 131min vs corte 180).

**"E os 130 vs 670?"**
Funis diferentes: 130 = ofertas registradas no fluxo formal do check-in (nosso escopo); 670 = todas as entregas reais de moto reserva (query do Vinicius sobre user_had_bike), todos os fluxos — rua, devolução, placa, fds. Só ~18% das entregas têm motivo registrado → gap de governança, não divergência de dado.

**"Antecipação: como mede e qual o viés?"**
Delta entre o 1º log RESERVA do RIVERS e o reserve_offered_at da oficina, nos casos em que ambos reservaram. Viés conhecido: sem cron, o log depende de tela aberta → o número atual (58% acumulado, 70% última semana) é um **piso**; melhora com o cron.

## F) Roadmap (se perguntarem "e agora?")

1. **Cron** (n8n ou cron-job.org → GET /api/cron a cada 10min com Bearer secret) — presença 24/7.
2. **Janela 1→7 dias** no OS_QUERY — mata a causa dos furos (1 linha, aguardando aval).
3. **Recalibração**: desconto multi-peça · fila C4 (Osasco) · dado de estoque C2 (NULL→0, depósitos, cross-base).
4. **Governança**: motivo obrigatório na entrega da reserva (SOP com o Guida).
5. Visão (Billy): expor ETA de ponta a ponta pro CX já na abertura da OS, mesmo sem reserva.
6. Futuro data: mart dbt da curva de capacidade, dash consolidado de reservas.

---

# NÚMEROS DE BOLSO (decorar esses)

| Número | O que é |
|---|---|
| **3h / 180min** | O SLA que define reserva |
| **12.785 OS / 181 peças / 25min** | Base da calibração de tempo / peças calibradas / custo fixo por OS |
| **1,68×** | Superestimação em moto multi-peça (o fix em curso) |
| **0,70 / 0,84 / 0,94** | Fator de rampa Mooca / Osasco / SBC |
| **88%** | Recall — pegou 115 das 130 decisões da oficina (15 dias, 1.396 OS) |
| **70%** | Aponta antes do humano (última semana; 58% acumulado) |
| **6 furos** | Todos por "não estar olhando" (janela 1 dia + tela fechada), zero por conta errada |
| **1 em 4** | Dos "só RIVERS", fração que passou mesmo de 3h |
| **360 = 115 + 245** | Sugestões totais = confirmadas + só-RIVERS |
| **670 / 18%** | Entregas reais de reserva em 15d / fração com motivo registrado |
| **3 dias (p90 10)** | Mediana de tempo do cliente com a reserva |
| **~1 min** | Lag da replicação ClickHouse |

# LINKS PRA TER À MÃO NA CALL
- App: https://vammo-reserva.vercel.app (home = decisões · /capacidade · /acuracia)
- Relatório executivo: https://claude.ai/code/artifact/f8259103-9194-4052-91ba-42857f47f72c
- Investigação (furos/excessos/conciliações): https://claude.ai/code/artifact/6311c2f4-0176-46d3-be24-6778e804f543
- Referência completa: docs/COMO-FUNCIONA.md
