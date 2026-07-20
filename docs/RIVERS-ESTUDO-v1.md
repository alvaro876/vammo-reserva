# RIVERS v1 — guia de estudo

> Um documento para **entender**, do zero, a proposta de virar o RIVERS um produto de verdade.
> Conecta três coisas: **(1)** o que já construímos e aprendemos (o v0), **(2)** o que o time propõe no doc de arquitetura v1, e **(3)** os conceitos de ciência de dados por trás — cada um explicado com um exemplo da oficina.
> Não precisa saber nada de fila ou de machine learning pra ler. Onde aparece uma sigla, ela está no **glossário** no fim, e as **referências** citadas no doc original estão comentadas na última seção.

---

## Como ler

Cada conceito novo aparece no mesmo formato:

> **O que é** (em linguagem simples) · **Exemplo na oficina** · **Como conecta com o que já fizemos**

Se você só tem 10 minutos, leia as Partes 1, 2 e a tabela da Parte 5. O resto é para aprofundar.

---

# Parte 1 — Onde estamos (o RIVERS v0)

## O problema
Quando um cliente deixa a moto na oficina, se o conserto vai passar de **3 horas** ele deveria receber uma moto reserva. Hoje quem decide isso é o líder de turno, no olho. O RIVERS automatiza essa decisão e explica o porquê.

## O que o v0 já faz
É um **algoritmo de regras** (determinístico, sem "IA caixa-preta"). Ele responde uma pergunta — *"fica pronta em 3h?"* — em camadas, e a primeira regra que dispara decide. No fundo, dois critérios: **tempo** (serviço longo ou fila grande) e **peça** (sem estoque). Para calcular o tempo, o v0 usa **dois modelos**:

1. **Tempo de serviço** — aprendido de milhares de OS antigas (uma regressão que estimou quantos minutos cada peça costuma levar).
2. **Capacidade da oficina** — quantos mecânicos estão produzindo por base e hora (via escala do RHID), para estimar a fila.

## O que já provamos no campo (guarde isto — é a nossa força)
Rodando 15 dias e cruzando moto a moto com o que a oficina fez:
- Pegou **~9 de cada 10** reservas que a oficina deu; **chegou antes** do humano na maioria.
- A regra **"esperando sem diagnóstico" acertou 19 de 19** — todas passaram de 3h.
- Achamos que **cliente com reserva não devolve a moto** (fica dias parada) — e que **só ~1 em 5 entregas** tem o motivo registrado.
- O algoritmo **exagera quando a carga muda** (semana de feriado em Osasco: escala menor → ele achou a fila maior do que era).

Por que isso importa: **quase tudo que o doc v1 propõe em teoria, a gente já viu acontecer na prática.** Isso vai reaparecer o tempo todo abaixo.

## Os limites conhecidos do v0
- A estimativa de tempo é **aditiva**: soma o tempo de cada peça. Mas o mecânico faz várias em paralelo → **superestima** moto cheia de peça.
- Não estima a **fila antes do diagnóstico** (a moto que chega e fica esperando pra ser olhada).
- Só roda quando a tela está aberta (falta o agendador 24/7).

---

# Parte 2 — A virada do v1: de "um número" para "uma faixa"

Hoje o v0 cospe **um número**: "essa moto leva ~130 minutos". O v1 propõe cuspir uma **faixa com probabilidade**: "o mais provável é ~90 min, mas tem uma cauda: em 10% dos casos passa de 200 min".

Por que isso muda o jogo? Porque a decisão de reserva é sobre **risco**, não sobre a média. Duas motos podem ter a mesma estimativa média de 150 min, mas uma é super previsível (sempre 150) e a outra é uma incógnita (às vezes 60, às vezes 300). A segunda é muito mais perigosa para o SLA de 3h — e um número só não te conta isso. A **largura da faixa é a incerteza**, e é exatamente o que você precisa para decidir com cabeça quando a reserva é escassa.

Essa é a espinha dorsal do v1. Todo o resto são as peças para fazer essa faixa ser confiável.

---

# Parte 3 — Os conceitos novos, um a um

## 3.1 Regressão quantílica (prever a faixa, não a média)

> **O que é.** Um modelo comum de regressão prevê a **média** (ou um valor central). A regressão quantílica prevê **percentis**: o P50 (mediana — metade dos casos fica abaixo), o P80, o P90. Treinando três desses de uma vez, você desenha o formato da distribuição: onde ela costuma cair (P50) e quão feia é a cauda (P90).
>
> **Exemplo na oficina.** Para uma troca de kit de freio, o modelo diz: P50 = 70 min, P80 = 110 min, P90 = 180 min. Leitura: "na metade das vezes sai em ~70 min, mas 1 em 10 vezes chega perto de 3h." A distância P90−P50 (110 min) é o tamanho da incerteza daquele tipo de serviço.
>
> **Como conecta.** Nosso v0 já faz uma regressão — mas de **um ponto só** (o tempo médio por peça). O v1 é a mesma família de modelo (gradient boosting), só que treinado para responder três percentis em vez de um. O custo extra é pequeno; o ganho é enxergar a cauda, que é onde as reservas moram.

**A mecânica (para quem quer o detalhe): pinball loss.** Um modelo "aprende" minimizando um erro. Para acertar a média, usa-se o erro quadrático. Para acertar um percentil, usa-se a **pinball loss** (perda de quantil), que é *assimétrica*: quando você quer o P90 e erra prevendo baixo demais, ela pune muito mais do que errar prevendo alto. Esse desequilíbrio proposital é o que empurra a previsão para o percentil certo. (O doc nota que a DoorDash achou que uma *asymmetric loss* customizada bateu a pinball padrão em ~10% na cauda — refinamento para depois.)

## 3.2 O gatilho: `disparar se P_τ(total) > k`

> **O que é.** Separar a decisão em dois números que qualquer um entende:
> - **k** = o limite de política, **por cliente**. Um cliente comum tem k = 180 min. Um acidentado, ou alguém que já esperou muito, pode ter k menor (é mais fácil ganhar reserva). É uma **tabela que a Operação controla**.
> - **τ (tau)** = o **quão confiante** você exige estar de que vai estourar o k, antes de disparar. É o "botão de risco".
>
> **Exemplo na oficina.** k = 180 min para todo mundo. Se as reservas estão **escassas**, você sobe a régua de confiança: só dá reserva quando estiver **bem seguro** de que passa de 3h (dispara pouco, evita desperdício). Se há reserva **de sobra**, você abaixa a régua: dá reserva na dúvida (dispara mais, prioriza o cliente).
>
> **Como conecta.** Isso é **exatamente a arquitetura que já temos**, só renomeada: nossos thresholds (os 180 min, os cortes) são o **k**; nosso "haircut" e a folga que damos são o embrião do **τ**. O v1 formaliza os dois e deixa a Operação girar o botão sem mexer no modelo.

> ⚠️ **Armadilha de notação (importante — confirme com o time).** A frase do doc — "reserva escassa → gate on P90; sobra → P60" — é ambígua e pode inverter na implementação. O que importa operacionalmente é: **reserva escassa = ser conservador = só disparar com alta confiança de furar** (exige que até um percentil baixo já passe de k). **Sobra = ser generoso = disparar na dúvida.** Escreva a direção do botão de forma explícita, ou o Ops pode configurar ao contrário e o sistema vira do avesso. Vale um exemplo numérico combinado antes de codar.

## 3.3 Duas camadas: o modelo estima, o produto decide

> **O que é.** Separar em duas peças independentes: uma que só **estima o tempo** (o modelo) e outra que só **toma a decisão** de reservar (regra de produto). O modelo nunca diz "reserva"; ele diz "P90 = 200 min". A decisão lê isso e aplica a política.
>
> **Por que importa.** Auditabilidade. A empresa pediu decisão explicável (por isso tiramos o LLM). Com duas camadas, a parte "inteligente" fica confinada ao *tempo*; a *decisão* continua uma regra clara que qualquer um contesta. **Não estamos voltando para a caixa-preta.**
>
> **Como conecta.** Já é assim: `algorithm.ts` calcula o tempo, e uma regra separada decide. É a mesma arquitetura de produção da DoorDash citada no doc. Boa notícia — não precisamos reescrever nada estrutural.

## 3.4 Resíduo sobre baseline (o truque da DeepETA/Uber)

> **O que é.** Em vez de o modelo prever o tempo do zero, você começa com uma **estimativa-base simples e barata** (um "chute bom") e o modelo aprende só a **correção** em cima dela. Tempo final = base + correção aprendida.
>
> **Exemplo na oficina.** Base = "kit de freio costuma levar 60 min" (mediana histórica). O modelo então aprende: "mas se for na Mooca, numa sexta de pico, some 25 min". Ele só carrega o *ajuste*, não o tempo inteiro.
>
> **Como conecta.** É de novo o que já fazemos, sem ter batizado: nossa tabela de minutos-por-peça é a base; a parte de fila/capacidade é o ajuste pelo contexto. O v1 só deixa isso explícito e deixa o ML cuidar do ajuste, que é a parte difícil. A Uber faz isso no ETA (um roteirizador dá a base, o ML corrige o erro sistemático).

## 3.5 Decompor o alvo: intrínseco + fila + handback

> **O que é.** Não pedir para **um** modelo prever o tempo total de uma vez. Quebrar o total em pedaços com naturezas diferentes e tratar cada um do jeito certo:
> - **Intrínseco** (tempo de chave-de-boca + diagnóstico) — depende da moto/serviço. É **aprendível e estável**.
> - **Fila** — depende de quantas motos e quantos mecânicos. É **volátil** (muda hora a hora).
> - **Handback** — o tempo entre "moto pronta" e "moto entregue". Tempo morto.
>
> **Por que.** Se você força um modelo só a prever o total, ele fica dividido entre duas fontes de variação muito diferentes (a moto e a fila) e vai mal nas duas. Melhor: regressão quantílica no intrínseco, e a fila estimada por outro caminho (o baseline de fila).
>
> **Como conecta.** É **exatamente a nossa separação** entre o modelo de tempo (intrínseco) e o modelo de capacidade (fila). O v1 acrescenta um terceiro pedaço que a gente já achou mas não modelava: o **handback**.

## 3.6 O relógio de 6 segmentos (e os dois gargalos escondidos)

O tempo total que o cliente espera não é só "o conserto". São seis pedaços:

```
chegada → [1] fila até diagnóstico → [2] diagnóstico → [3] fila até mecânico
        → [4] execução (+ pausas) → [5] qualidade (+ retrabalho) → [6] handback → entrega
```

O doc aposta que os 3h estouram em dois pedaços que **ninguém mede**:
- **[1] Fila de diagnóstico** — a moto chega e fica esperando *só para ser olhada*. Gargalo de entrada.
- **[6] Handback** — a moto está pronta mas ninguém entrega. Tempo morto silencioso.

> **Como conecta (forte).** Os dois já apareceram para nós:
> - A fila de diagnóstico é o que a regra **"esperando sem diagnóstico" (19/19)** captura — nossa evidência de que esse gargalo é real e perigoso.
> - O handback é o nosso achado de **"tempo até ficar pronta ≠ tempo até a retirada"** + os **18% com motivo registrado**.
>
> É por isso que o **próximo passo nº 1 do doc é decompor esses 6 segmentos no Maestro** — medir onde os 3h se perdem, por base. "Meça primeiro."

## 3.7 Re-estimar nos marcos (a estimativa fica mais afiada com o tempo)

> **O que é.** Não estimar uma vez e esquecer. Re-calcular a cada momento em que aparece informação nova:
> - **Check-in** — sabe-se pouco (só a fila e o tipo declarado) → estimativa **grossa**.
> - **Pós-diagnóstico** — já se conhece peças e serviços → estimativa **afiada** (é aqui que o v0 age hoje).
> - **Durante a execução** — progresso ao vivo → **ajuste contínuo**.
>
> **Exemplo na oficina.** Ao chegar: "provavelmente 1–3h, não sei". Depois do diagnóstico: "troca de rolamento + garfo, ~2h20, provável reserva". Meia hora depois: "já passou da metade, deve fechar no prazo".
>
> **Como conecta.** O v0 só age no marco do meio (pós-diagnóstico). O v1 acrescenta o marco do **check-in** (estimar a fila antes do diagnóstico — que hoje nos falta) e o **durante**. A referência é o QRF de Arora et al. (2023), que refina a previsão conforme a informação se revela.

## 3.8 Features (variáveis) importam mais que o modelo

> **O que é.** Escolher **boas variáveis de entrada** rende mais que escolher um algoritmo sofisticado. Um estudo de pronto-socorro com 177 mil casos testou 5 modelos diferentes (regressão logística, floresta, XGBoost, rede neural, SVM) e **todos deram quase o mesmo** (~0,75 de acurácia). O que separou os bons dos ruins foram as **variáveis de estado do sistema** (o quão congestionado estava), não os atributos individuais.
>
> **Tradução para nós.** Gastar energia nas variáveis operacionais — carga da oficina, mecânicos escalados, profundidade da fila, histórico recente de chegadas, throughput dos últimos 20 min — e **não** perseguir o modelo da moda.
>
> **Como conecta.** É a lição que a gente já tinha aprendido: o modelo de capacidade (RHID) e a calibração viveram de features operacionais. O v1 dá nome científico ao que a gente já pratica.

## 3.9 A congestão atrasa em relação às chegadas (o efeito Osasco/feriado)

> **O que é.** A fila não fica cheia no instante em que chegam muitas motos — ela fica cheia **um pouco depois** (defasagem ≈ o tempo médio de um serviço). Então usar a taxa de chegada **do instante** para estimar a fila engana nos picos.
>
> **Exemplo na oficina.** Chegam 8 motos às 9h; a oficina só "sente" o congestionamento por volta das 10h30, quando o acúmulo pesa. Se você olhar só "quantas chegaram agora", subestima o aperto que vem.
>
> **Como conecta.** É **literalmente o nosso bug de Osasco no feriado**: a capacidade quebrou quando a carga/escala mudou de patamar. A correção proposta — **alimentar o histórico recente de chegadas** (não só o instante) — ataca exatamente essa falha. Base teórica: Whitt (filas variáveis no tempo) e a aproximação PSA.

## 3.10 Censura: por que treinar só com OS concluídas engana

> **O que é.** "Censura" é quando você não observa o valor final de alguns casos porque eles **ainda não terminaram**. As OS abertas agora não têm tempo final. Se você treina o modelo **só com as concluídas**, você joga fora justamente as que estão demorando mais (ainda abertas) → o modelo aprende que tudo é mais rápido do que é → **subestima a cauda** (as demoradas).
>
> **Exemplo na oficina.** Às 17h você monta o dataset de treino. As OS rápidas do dia já fecharam e entram; a moto complexa que abriu de manhã e vai virar a noite ainda está aberta e **não entra**. Treinar assim ensina o modelo a ignorar as motos-problema.
>
> **Como conecta.** É provavelmente parte da causa dos nossos **6 furos** (serviços complexos de vários dias que a calibração não capturava). A solução é usar técnicas de **análise de sobrevivência** (feitas para dados censurados) ou o modelo subchama a cauda.

## 3.11 Calibração conformal (obrigatória antes de prometer uma faixa)

> **O que é.** Um problema chato: se você treina um modelo para dar um intervalo de 90%, na prática ele costuma **acertar menos** (tipo 80%) em dados novos. A **calibração conformal** é um passo extra que usa um pedaço separado de dados para **ajustar a largura** do intervalo até ele *de fato* cobrir 90% das vezes. É uma garantia estatística, independente do modelo.
>
> **Exemplo na oficina.** O modelo diz "90% das motos ficam prontas em até 200 min". Você confere no histórico: na verdade só 80% ficaram. A conformal alarga o limite para, digamos, 240 min, até bater os 90% reais. Só depois disso você pode **prometer** a faixa para o cliente ou usá-la no gatilho.
>
> **Como conecta.** É um passo novo que ainda não temos — e é **obrigatório** antes de o τ (o botão de risco) significar o que diz. Sem conformal, "90% de confiança" é mentira. É um dos "não se queime" do doc.

---

# Parte 4 — Os workstreams (frentes) para explorar

## A. Clusterizar as OS em arquétipos
> **Ideia.** Agrupar as OS corretivas em tipos naturais (por sintoma, componente, peças) → cada grupo ganha sua própria distribuição de tempo (a mediana do grupo vira o baseline). Também diz **o que a OS vai precisar** (peças, skill) → alimenta pré-separação de peças.
>
> **Por que pode ajudar já.** Um baseline por cluster **pode corrigir nossa superestimação multi-peça**: em vez de somar peça a peça (que infla), o cluster "revisão de freios + rolamentos" carrega a mediana **real** daquele combo.
>
> **Armadilhas (do doc).** Não vazar (agrupar só pelo que se sabe *na hora da previsão*, nunca pela duração final); provavelmente dois agrupamentos (grosso no check-in, fino pós-diagnóstico); e **validar que os grupos têm tempos diferentes** — se todos têm a mesma mediana, clusterizar não serviu de nada.

## B. Matriz de disponibilidade de dados (pré-requisito, não opcional)
> **Ideia.** Antes de qualquer modelo, mapear **o que se sabe em cada marco**. Não dá para estimar no check-in usando dado que só existe pós-diagnóstico (isso é "vazamento"). A matriz cruza cada variável (fila, mecânicos, tipo de OS, peças, serviços, skill, histórico de chegadas, sinais de IoT) contra os três marcos (check-in / pós-diagnóstico / execução), com a fonte e a taxa de preenchimento.
>
> **Por que já.** É barato, é pré-requisito de tudo, e a gente conhece as tabelas do Maestro. Preencher as células "?" a partir do Maestro é a base honesta para saber qual modelo é sequer viável em cada marco.

## C. Correlação com sinais de IoT
> **Ideia.** Ver se a telemetria da moto (código de falha, bateria/motor, frequência de erro) **prevê** tempo de serviço mais longo. Dois usos: **(1)** entra como variável — e está disponível **antes mesmo do cliente chegar** → estimativa mais cedo possível; **(2)** detecção de "lemon" (moto-problema recorrente) → candidata a **reserva pró-ativa**.
>
> **Cuidado.** Fazer um estudo de correlação primeiro, checando vazamento (um sinal que só aparece *porque* o mecânico está mexendo não é preditivo, é consequência).

---

# Parte 5 — O plano: o que aproveitar já vs. deixar para depois

| # | Ideia do v1 | Aproveitar já? | Por quê |
|---|---|---|---|
| 1 | **Decompor os 6 segmentos** no Maestro | ✅ **Já** | Temos os dados; é o passo nº1 do doc; vira número os insights que já temos |
| 2 | **Matriz de disponibilidade de dados** | ✅ **Já** | Barato, pré-requisito, conhecemos as tabelas |
| 3 | **Estimar a fila de pré-diagnóstico** | ✅ **Já** | O v0 não tem; temos os timestamps |
| 4 | **Clusterizar OS corretivas** | ✅ **Já** | Pode corrigir a superestimação multi-peça |
| 5 | **Renomear thresholds → política k / haircut → dial τ** | ✅ **Já** | Não muda código; alinha a linguagem com o produto |
| 6 | **Modelo quantílico (GBM) + pinball** | 🟡 Depois | É o v1 de fato; precisa da decomposição + volume. É a direção do modelo do Ian |
| 7 | **Calibração conformal** | 🟡 Depois | Vem junto do modelo quantílico |
| 8 | **Tratamento de censura (sobrevivência)** | 🟡 Depois | Junto do modelo; ataca a cauda dos furos |
| 9 | **Fila M/M/c com prioridade, Weibull, neural, RL, IoT** | 🔴 Scale-gated | Precisam de volume/dado que talvez não tenhamos ainda |
| 10 | **Economia do gatilho** (custo reserva vs. custo furar) | 🟡 Precisa do Ops | É a função de perda da decisão; ninguém definiu ainda |

---

# Parte 6 — Perguntas em aberto (do próprio doc)
- **Economia do gatilho** — quanto custa uma reserva vs. quanto custa furar o SLA? É a função de perda da camada de decisão. Precisa disso antes de calibrar o limite.
- **Volume de dados** — RL / neural / distribuição completa assumem muito dado. Site único, volume moderado talvez só sustente fila + GBM. *O que temos de verdade?*
- **Ponta-a-ponta vs. por-etapa** — um modelo do total, ou um por segmento re-estimado nos marcos? A evidência favorece re-estimar nos marcos.
- **Calibrar sob chegadas não-estacionárias** — combinar o sinal de congestão defasado (PSA) com a calibração conformal é sugerido, mas ninguém demonstrou como método integrado.

---

# Parte 7 — Glossário

- **Regressão quantílica** — modelo que prevê percentis (P50/P80/P90) em vez da média.
- **P50 / P80 / P90** — percentis. P90 = valor abaixo do qual caem 90% dos casos (a "quase pior" hipótese).
- **Pinball loss (perda de quantil)** — a função de erro assimétrica que faz o modelo mirar um percentil específico.
- **GBM / GBR / gradient boosting** — família de modelos que combina muitas árvores de decisão fracas; forte para dados tabulares. XGBoost é uma implementação famosa.
- **QRF (Quantile Regression Forest)** — floresta aleatória que devolve quantis; usada para refinar estimativa ao longo do tempo.
- **Baseline / resíduo** — estimativa-base simples; o modelo aprende só a correção (resíduo) sobre ela.
- **Censura (à direita)** — casos ainda não terminados, sem valor final observado; enviesa treino se ignorados.
- **Análise de sobrevivência** — estatística feita para dados censurados (originalmente "tempo até um evento").
- **Calibração conformal** — passo que ajusta intervalos de previsão até cobrirem de fato a % prometida, com garantia estatística.
- **k (limite de política)** — o alvo de tempo por cliente (ex.: 180 min); tabela que a Operação controla.
- **τ (tau, dial de confiança)** — o quão seguro exigir estar antes de disparar a reserva; o "botão de risco".
- **SLA** — o compromisso de serviço (aqui, as 3 horas).
- **Fila M/M/c** — modelo clássico de fila: chegadas aleatórias (M), tempos de serviço exponenciais (M), c servidores (mecânicos). "Com prioridade" = alguns clientes furam a fila (o piso).
- **PSA (Pointwise Stationary Approximation)** — aproximar uma fila que varia no tempo usando as fórmulas de fila estável, instante a instante.
- **TVQ (Time-Varying Queues)** — filas cujo ritmo de chegada muda ao longo do dia (o caso real da oficina).
- **Weibull** — uma distribuição boa para modelar tempos com cauda longa (serviços que às vezes demoram muito).
- **PIT / CRPS** — formas de medir se uma previsão de distribuição inteira está bem calibrada.
- **PPO (Proximal Policy Optimization)** — um algoritmo de aprendizado por reforço (RL).
- **RL (Reinforcement Learning)** — aprendizado por tentativa/recompensa; aqui, para alocar reservas dinamicamente.
- **DeepETA** — sistema de ETA da Uber; origem do padrão "resíduo sobre baseline".
- **Handback** — tempo entre a moto ficar pronta e ser entregue ao cliente.
- **Leakage (vazamento)** — usar, no treino, informação que não existiria no momento real da previsão; infla o resultado falsamente.

---

# Parte 8 — Referências (as fontes do doc, comentadas)

> Todas foram citadas no doc de arquitetura do time. Abaixo, o que cada uma sustenta na nossa proposta.

- **Whitt — Time-Varying Queues (Columbia).** Base do PSA e do efeito "a congestão atrasa em relação às chegadas". → sustenta usar histórico recente de chegadas (nosso caso Osasco/pico).
- **Schwarz, Selinka, Stolletz (2016), *Omega* 63:170–189.** Taxonomia de filas não-estacionárias. → arcabouço para tratar a oficina como fila que varia no dia.
- **Kim, Kim, Bueker (2021), *Computers & Industrial Engineering* 160.** Fila M/M/m exata com prioridade + "férias" do servidor (mecânico que pausa). → o upgrade analítico do modelo de fila, para depois.
- **Wang et al. (2025), *BMC Health Services Research* 25:403.** ML de tempo de espera em pronto-socorro (177k casos). → a evidência de que **features importam mais que o modelo**.
- **Arora, Taylor, Mak (2023), *MSOM* 25(4):1489–1508.** QRF para atualizar a estimativa conforme a informação se revela. → o blueprint da re-estimação nos marcos.
- **DoorDash Engineering — NextGen ETA.** Arquitetura de duas camadas em produção + previsão probabilística + truque de *asymmetric loss* na cauda. → sustenta o two-layer e as dicas de cauda longa.
- **Uber Engineering / arXiv:2206.02127 — DeepETA.** Resíduo sobre baseline com self-attention. → o padrão "base simples + ML corrige".
- **scikit-learn — documentação de Quantile GBR.** A ressalva de que o intervalo quantílico cru não cobre a % prometida. → o porquê da conformal ser obrigatória.
- **Dai, Gluzman (2022), *Stochastic Systems*.** Controle de rede de filas via deep RL. → justificativa do RL para alocação de reserva (scale-gated).
- **Bertsimas, Kim (arXiv:2307.12405).** Índice de prioridade ótimo em rede de fluidos. → base teórica para roteamento por prioridade entre as etapas da oficina.

---

## Em uma frase, para levar
O v1 pega o que o v0 já faz (estimar tempo + separar a decisão) e o eleva de **um número** para **uma faixa com probabilidade calibrada**, medida por segmento e re-estimada nos marcos — e quase toda a teoria dele já bate com o que a gente viu no campo. O caminho para começar não é o modelo chique: é **medir onde os 3h se perdem** (os 6 segmentos) e mapear **que dado existe quando**.
