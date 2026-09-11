# Decisões do Rivers (log)

Registro append-only de decisões, com justificativa e status. Formato leve de ADR.
Status: ✅ confirmado · 🟡 recomendado/a confirmar · ⏳ aberto.

---

### D1 — Superfície da sugestão (2026-06-22) ✅
**Decisão:** a sugestão vive **no app vammo-reserva** por enquanto. Integração no Maestro
(coluna "Reserva Sugerida") fica pra fase 2.
**Por quê:** o data team é dono e itera rápido, sem depender do tempo de eng do Maestro;
permite medir acurácia já na semana 1. O doc original previa o Maestro, mas Alvaro optou
por começar no app próprio.
**Quem:** Alvaro.

### D2 — Store do log de sugestões (2026-06-22) ✅
**Decisão:** **Supabase (Postgres)**.
**Por quê:** escrita trivial do app, query fácil, federa com ClickHouse depois pra cruzar
com a verdade de campo. ClickHouse exigiria write-access em prod e não é ideal pra
event-log de app; Sheets não escala. O repo já tinha `@supabase/supabase-js` instalado.
**Quem:** Alvaro.

### D3 — Linguagem do motor (2026-06-22) ✅
**Decisão:** motor em **TypeScript no próprio app**; Python só para a parte offline de
calibração e medição de acurácia.
**Por quê:** revisado após ler o repo — o algoritmo (Camadas 1–4), a leitura do ClickHouse
e o Supabase já estão em TS. Reescrever em Python criaria um serviço/deploy a mais e uma
costura Next↔Python por ganho funcional zero na V1. A recomendação inicial (Python) foi
revista quando a evidência mudou.
**Quem:** Alvaro (confirmado 2026-06-22).

### D4 — Escopo da V1 (2026-06-22) 🟡
**Decisão:** V1 **completa**, incluindo a **capacidade agregada de mecânicos** (estimativa
de fila/tempo). **Fora da V1:** alocação por mecânico específico / senioridade.
**Por quê:** Alvaro quer a V1 completa, mas a alocação por mecânico específico depende de
dado de skill que hoje é só um proxy. Adiar reduz risco sem perder o essencial.
**Quem:** Alvaro (escopo) + recomendação de adiar alocação.

### D5 — Absenteísmo / headcount (2026-06-22) 🟡
**Decisão (recomendada):** **medir antes de modelar**. Headcount = mecânicos ativos
observados (atividade real) + escala conhecida (`staff`) + **haircut empírico medido**
(`ativos/escalados`), revisto semanalmente. Só construir modelo preditivo se o dado mostrar
que a falta é alta **e** previsível.
**Por quê:** Alvaro levantou o risco de troca de turno/absenteísmo. Um modelo preditivo na
V1 seria over-engineering e introduz estimativa frágil antes de haver dado pra validar.
**Pendente:** confirmação do Alvaro.

### D6 — Sem RAG (2026-06-22) ✅
**Decisão:** não construir RAG. Contexto persiste via **docs vivos no repo** (este e
`RIVERS.md`) + **Vammo Mind** + memórias do assistente.
**Por quê:** o Vammo Mind já é um RAG sobre os docs da empresa; o algoritmo é determinístico
sobre dado estruturado (não há corpus a recuperar em runtime). Docs versionados dão
rastreabilidade auditável que um índice vetorial não dá.
**Quem:** recomendação aceita.

### D7 — Notificação ao CX (2026-06-22) ✅
**Decisão:** notificar via **Slack**. Por ora, mandar pro **próprio Alvaro** (teste);
canal dedicado criado depois.
**Por quê:** começar simples e validar conteúdo/limiar das notificações antes de envolver o
time de CX e criar canal.
**Quem:** Alvaro.

### D8 — Capacidade de mecânicos: baseline antes de modelo (2026-06-23) 🟡
**Decisão (recomendada):** a capacidade que entra no cálculo de fila é a **esperada** (curva
histórica `base × dia × hora`), **não** a contagem instantânea de quem está mexendo numa OS.
Começa como **baseline** (médias do histórico), recalculado periodicamente; só vira modelo ML
treinado se o baseline não bastar (o log de acurácia decide).
**Por quê:** o sinal instantâneo despenca na troca de turno/almoço (visto nos dados: às 14h a
média no Mooca é ~18 mecânicos, mas teve dia com 4) → usar a contagem do minuto faria o algoritmo
"dar reserva pra tudo" na transição. A curva esperada atravessa a transição.
**Pendente:** confirmação do Alvaro.

### D9 — A régua é a linha das 3h, e a sugestão dispara nela (2026-07-31) ✅
**Decisão:** o gatilho da projeção fica na própria linha do SLA (180min), não numa linha de
convicção mais alta; a faixa incerta sai marcada **NA TRAVE** pra confirmação no piso.
**Por quê:** ordem do Alvaro ("se der estimado mais de 3h, tem que disparar") após o caso
TMB8G64 (12min da linha sem aviso). Trade-off medido e aceito: mais alarme na trave em troca
de nenhum cliente cruzar as 3h em silêncio. Complemento estrutural: *aviso* é decisão de
relógio (sempre, às 3h, pela tela); *reserva* é decisão de regra.
**Quem:** Alvaro.

### D10 — Capacidade/fila (C4) e estoque (C2) fora da decisão (2026-08-03) ✅
**Decisão:** `C4_CAPACIDADE` e `C2_SEM_ESTOQUE` não disparam reserva (seguem como medidores;
religáveis por env).
**Por quê:** as premissas não sobreviveram ao dado. Estoque: saldo zero local se resolve por
transferência intraday (0 acerto em 7+9 disparos). Fila: a espera real do cliente de piso não
cresce com a profundidade da fila (mediana 4-9min com 0 a 6+ motos na frente, n=1.864) — a
oficina paraleliza; a contribuição única do C4 media 6 acertos × 11 erros.
**Quem:** Alvaro (meta de 80% de precisão/dia).

### D11 — O relógio condicionado vira gatilho principal; estimador vira coadjuvante (2026-08-05) ✅
**Decisão:** as regras de maior peso passam a ser fatos do relógio, não projeções: piso +
150min **fora de QA** (87,3%, n=887, recall 95%) e rejeição de QA com 165min+ (98,9%, n=91);
retrabalho pós-rejeição entra como 45min na projeção. A projeção cedo só vira reserva com
estimativa ≥180 (80,8%); vistoria de seguro ganha gate; fator de 9+ peças corrigido
(0,85/0,80). Validação: backtest tick-a-tick de 92d (73,2% → 88,7%; últimos 5 dias todos
≥80%) — `scripts/backtest-v23.mjs`.
**Por quê:** diagnóstico duplo (indústria + 92d de dado próprio): reparo tem cauda lognormal
— quem já demorou vai demorar mais, exceto em QA; e o MAE do estimador (~30min) já é estado
da arte, então o ganho estava no *decisor*, não na estimativa.
**Quem:** Alvaro ("roda as três fases, quero backtests, calibra até acertar").

### D12 — Classificador em sombra antes de decidir (2026-08-05) 🟡
**Decisão:** o classificador logístico de P(estourar) (desenho Lyft; 16 sinais; split
temporal; Platt) roda **em sombra**: logado a cada tique (`features.p_estouro`), sem decidir.
Promoção a decisor só com 3+ dias de validação ao vivo ≥85% — o placar diário compara sombra
× regras automaticamente.
**Por quê:** teste honesto deu 89,3%/96,2% (n=28) — forte, mas pequeno e treinado de
madrugada; a diferença entre "parece melhor" e "é melhor" é produção. Custo de esperar: zero.
**Pendente:** decisão do Alvaro quando a sombra acumular os 3 dias.

### D13 — Sintomas do cliente como contexto, não como decisor (2026-08-10) 🟡
**Decisão:** os sintomas relatados pelo cliente (feature nova do Maestro, 05/08) entram no
RIVERS como **contexto na tela do CX** — selo com o histórico do sintoma quando ele é ruim
(≥50% de estouro). NÃO decidem reserva ainda.
**Por quê:** o sinal é forte e chega no minuto zero da OS, que é exatamente onde o RIVERS é
cego hoje (moto em execução sem peça lançada = estimativa em branco). Medido em 90d/Mooca
por ponte indireta (sintoma → symptom_component → public_diagnosis_component → item_group
por nome; 26 dos 33 sintomas casam, 110 grupos), a faixa vai de **15% a 70%** de estouro
contra base de ~27%: carenagem quebrada 70% (n=476, mediana 4h52), farol 65%, moto sem
força 58%, contra bolha/para-brisa 15% e USB 31%.
**Por que não decide ainda:** só existem ~28 OSs com sintoma real; a medição DIRETA deu
n=10/n=14 com sinal invertido — ruído puro. A ponte histórica mede a *peça trocada*, não o
*sintoma relatado*, e isso pode divergir (cliente que diz "freio fraco" às vezes só precisa
de regulagem). Promoção depende de ~3 semanas de volume real.
**Achado que contraria o catálogo:** o campo `symptom.is_complex_service` NÃO prevê tempo.
"Carenagem quebrada" é marcada como simples e é a pior (70%); "suspensão batendo seco" é
marcada como complexa e dá 40%. Complexidade de diagnóstico ≠ tempo de reparo — não usar
essa flag como atalho.
**Onde vive:** calibração em `src/lib/sintomas.ts` (regenerável), coleta na CTE `sintomas`
do rivers-engine, exposição em `/api/cx`, selo em `src/app/cx/page.tsx`.
**Pendente:** medir em ~3 semanas se o sintoma relatado se comporta como a peça trocada; se
sim, virar estimativa inicial (resolve a estimativa em branco pré-diagnóstico).

### D14 — Calibração tem prazo de validade: trava da combinada 180→240 e escape revertido (2026-08-12) ✅
**Contexto:** depois de uma semana estável (07-10/08 entre 87% e 100%), o dia 11/08 caiu
para 50% e o 12/08 rodava a 70% — meta é 80%. Os 7 erros dos dois dias eram TODOS da
combinada disparando cedo (27-74min de relógio) em motos que ficaram prontas em 143-174min.
**Causa raiz (medida, não chutada):** a oficina ACELEROU depois do release de sintomas do
Maestro — a bancada que fazia mediana de 73-96min na semana anterior passou a 48-57min em
11-12/08 — e as estimativas por peça ficaram paradas no mundo antigo. Estimativa de
182-227min passou a terminar em menos de 3h. Não foi inflação de peças (grupos/OS estável
em ~6): foi o denominador que mudou.
**Decisão dupla:**
1. **Trava da combinada sobe de 180 para 240** (est_firme_min). Backtest nos dados frescos
   (config rEst240): dias 11-12/08 saem de 75-78% para **86-100%**; conjunto 96,7%; recall
   74,3→73,1% — o relógio-160 pega o que a combinada solta, ~20min depois.
2. **Escape por projeção (v0.28) REVERTIDO** com 2 dias de vida: produziu 3 falsos
   positivos (est 158-171) e zero acertos confirmados — incluindo a própria TIS7A04 que o
   motivou, pronta em 156min. O backtest dizia 89,5%; produção disse não. Produção > backtest.
**Lição operacional:** quando o processo embaixo muda (release do Maestro, contratação,
mudança de rampa), a calibração por estimativa envelhece EM DIAS. O sinal robusto é o
relógio real; estimativa é coadjuvante (reafirma D11). Vigiar a mediana da bancada no
placar diário — se ela mexer >20min, recalibrar sem esperar a precisão cair.
**Onde vive:** v0.29.0 em `src/lib/algorithm.ts`; sweep em `scripts/backtest-v23.mjs`
(configs r28atual/rSemEscape/rEst210/220/240). Log de features agora grava
`min_desde_chegada` (a régua do cliente ficava fora do log desde a v0.26).

### D15 — Motivo da recusa registrado na tela do CX, não no Maestro (2026-09-04) ✅
**Decisão:** a tela `/cx` ganha a seção "Recusou a reserva hoje: por quê?" — lista as recusas
do dia (cancelamento de oferta por operador, base do piloto) e pede um clique num motivo de
lista fechada (`src/lib/recusa.ts`), gravado em `rivers_recusa_motivo` (Supabase, uma linha por
OS, upsert). Rota `POST /api/cx/recusa`, protegida pelo mesmo token da tela.
**Por quê:** no piloto 13/08–03/09, 79 das 170 ofertas foram recusadas e o Maestro não guarda
motivo em nenhuma (RESERVE_CANCELLED vem sem `reason`). Sem isso não dá pra saber se o problema
é o algoritmo, a oferta ou o cliente. O campo certo é no fluxo de cancelamento do Maestro
(eng da Vammo); enquanto não existe, o dado nasce aqui. A lista separa "cliente recusou" de
"não foi o cliente" (cancelamento interno), porque a taxa de recusa hoje mistura os dois.
**Como fica na tela:** o cliente que recusou continua FORA da fila de ação (D de 20/08); a
seção nova fica no fim da página, é a única parte clicável (computador do CX, não TV) e mostra
quantas recusas do dia estão sem motivo.
**Revisto em 08/09 — ver D17:** a posição no fim da página foi trocada.
**Quem:** Alvaro (pedido em 04/09, pra levar pronto à conversa com o Billy).

### D16 — Peça única conta uma vez na estimativa (2026-09-06) ✅
**Decisão:** na conta de tempo por peça (v0.34.0, CTE `pecas_tempo` em `rivers-engine.ts`), peça
que a moto só tem UMA (pneu, garfo, guidão, carenagem por lado, roda, controladora, motor, farol,
lanterna, banco, descanso, tampa do motor… 99 ids em `src/lib/pecas-unicas.ts`, 10 famílias) conta 1 por OS,
mesmo lançada com quantidade 2 ou em duas linhas; e duas VARIANTES da mesma peça física na mesma
OS (Roda traseira _v1 + _v2, Tampa do motor v1 + v2, Controladora 3500W + 4000W) contam como uma,
a de maior tempo, inclusive no nº de peças do fator multi-peça. Mesma família da regra de fixação
da v0.33.
**Por quê:** pedido do Alvaro (06/09), a partir do levantamento pro Billy. Medido em 3 bases,
01/06–05/09 (11.742 OS com itens): 1,0% das OS têm esse erro de lançamento; inflação da estimativa
mediana 13 min, p90 30, máx 72; 8 OS cruzaram a trava de reserva (230/240) só por isso. Na Mooca
desde 13/08 nenhuma sugestão do RIVERS mudaria — é higiene de cadastro, não correção de regra. A
correção definitiva é validação no Maestro (quantidade máxima 1 e uma variante por família; lista
em `Downloads\Metabase\pecas_unicas_regra_maestro.csv`); enquanto não existe, o motor neutraliza.
**Fora da lista, de propósito:** Seta LD/LE (duas por lado), Conjunto de seta, Amortecedor
traseiro genérico (dupla suspensão usa dois), pedaleiras, pastilhas, rolamentos, retentores.
**Validação:** CTE isolada bateu com recálculo independente em Python nos 24 casos conhecidos
(inclusive OS sem duplicidade, paridade com a conta antiga); query completa executada no
ClickHouse antes do deploy; revisão adversarial do código.
**Quem:** Alvaro.

### D17 — O motivo da recusa sobe pra junto da fila de ação, em bloco dobrável (2026-09-08) ✅
**Decisão:** a seção de motivo da recusa sai do fim da página e passa a ficar imediatamente
depois de "Precisa avisar o cliente". Ela é um `<details>` fechado por padrão: a faixa sempre
visível traz o título, o total de recusas do dia e o selo "N sem motivo"; a lista de linhas com
os botões e o campo de nome ficam dentro do aberto. Nenhuma cor de zona no bloco.
**Por quê:** no fim da página ninguém via (pedido do Alvaro em 08/09, apontando os cards).
**Por que não dentro do card do cliente:** `clientes` filtra `!c.recusada` (D de 20/08), então
não existe card de quem recusou. Além disso `recusas_hoje` vem do contexto do check-in e inclui
OS que já saíram do motor (cliente recusou e foi embora, ou a moto ficou pronta), que nunca
teriam card. Pendurar no card cobriria só parte do dia e o selo "N sem motivo" deixaria de
fechar a conta. Fica bloco autônomo.
**Por que dobrável e sem cor:** medido no ClickHouse, o pico foi de 13 recusas em 02/09, com 5
dias de 9+ nas últimas 3 semanas. Como card aberto cada recusa ocupa ~200px (os 7 rótulos de
motivo quebram em 3 linhas), 13 delas dariam ~2.800px contra ~930px úteis na TV, e as seções
"Cliente já avisado" e "no prazo" sairiam da tela. Fechado, o custo na TV é uma faixa de ~56px.
O filete âmbar que a 1ª versão usou para "falta motivo" foi barrado: âmbar e vermelho são do
relógio do SLA e o rodapé da tela promete isso ao CX; sinal de pendência aqui é slate.
**Ressalva:** a lógica de gravação (upsert, "outro", "trocar") não foi tocada, é a de D15.
**Correção no mesmo dia:** a 1ª versão mantinha o `return null` em dia sem recusa, e o Alvaro
abriu a tela duas vezes sem achar o campo (08/09 fechou com zero recusa). Feature que não se
acha não está entregue: a faixa passou a aparecer SEMPRE, com o estado vazio explicando quando
o cliente aparece ali. Custa 46px na TV.

### D18 — Três regras pra avisar antes das 2h40 e estimativa corrigida pela bancada (2026-09-10) ✅
**Decisão:** ALGO_VERSION 0.35.0. Entram três regras e um fator, todos medidos no piloto da
Mooca (1.185 OS com cliente na base, check-in de 13/08 a 06/09, 210 estouros das 3h):
1. `C1_FILA_DIAG_LONGA` cai de 90 pra 60 min: cliente na base há 1h e a moto ainda em OPEN.
2. `C3_SEM_EXECUCAO_90` (nova): 90 min de relógio e a moto ainda não entrou em execução
   (OPEN, IN_DIAGNOSIS, AWAITING_MECHANIC, AWAITING_PARTS ou PAUSED), sem olhar estimativa.
3. `C3_CONTA_NAO_FECHA` (nova): fora de QA, relógio + restante × 0,67 + 14 de QA passa de 210
   (3h mais 30 min de folga). É a "soma dos tempos" sem a trava de estimativa ≥ 230.
4. `fator_bancada = 0,67`: o restante de execução entra corrigido no "pronta em ~" da tela e do
   bot (`restanteParaPronta`), no `tempo_previsto_min` e na regra 3. QA não comprime.
**Por quê:** o motor no ar avisava com 60 min ou mais de antecedência em 69 casos do piloto
(52 certos + 17 errados, 75,4%) e pegava 52 dos 210 estouros (24,8%). O resto saía no relógio
de 2h40, tarde demais pra reserva servir. Pedido do Alvaro em 08/09 depois da cobrança do Billy.
**O que foi medido (mesmas OS, 1º disparo por OS, só alertas com 60 min ou mais de antecedência,
denominador sempre os 210 estouros):**
| regra | alertas | certos | errados | precisão | estouros pegos |
|---|---|---|---|---|---|
| motor em produção (log) | 69 | 52 | 17 | 75,4% | 52 de 210 |
| 60 min sem diagnóstico, sozinha | 20 | 18 | 2 | 90,0% | 18 |
| 90 min sem execução, sozinha | 88 | 73 | 15 | 83,0% | 73 |
| conta corrigida > 210, sozinha | 73 | 62 | 11 | 84,9% | 62 |
| **v0.35 = produção + as três** | **142** | **106** | **36** | **74,6%** | **106 de 210 (50,5%)** |
Quem dispara primeiro nos 142: sem diagnóstico 20 (18 + 2), sem execução 50 (38 + 12), conta
corrigida 23 (17 + 6), regras antigas 49 (33 + 16). Soma: 142 = 106 + 36.
Volume: 5,9 alertas/dia e 1,5 errados/dia (era 2,9 e 0,7); mediana 6 por dia, máximo 15.
Sem filtro de antecedência o conjunto pega 162 dos 210 (209 = 162 + 47, 77,5%); era 125 de 210.
Os 104 estouros que continuam sem alerta a tempo têm estimativa mediana de 126 min aos 36 min
de relógio: são serviços grandes feitos em ritmo normal, que só a hora mostra.
**Por que 0,67 e por que 210:** 0,67 é a mediana (real ÷ estimado) do restante de execução,
calculada de forma prospectiva semana a semana (variou de 0,664 a 0,688). Com ela o viés da
estimativa cai de +28 pra +2 min e o MAE de 52 pra 40. O corte 210 foi escolhido entre 190
(67,8% na regra sozinha), 200 (79,8%) e 210 (84,9%); 200 acrescentava 8 certos por 7 errados.
**O que foi testado e ficou de fora:** fator por fase (QA 0,18 / execução 0,69 / esperando
mecânico 1,14) perde pro global no conjunto (62,8% contra 74,6%) porque dispara cedo demais
em "esperando mecânico"; multiplicador pela razão histórica do mecânico piora (53,8%); o
modelo LightGBM não supera a regra na régua de 60 min. Regra e fator ficam; modelo segue em
sombra, com o Ian.
**Ressalvas:** (1) o escape por projeção da 0.28 foi revertido em 12/08 com 3 falsos em 2 dias;
este usa estimativa corrigida e exige 30 min de folga, o caso que derrubou a 0.28 (est 160 aos
30 min) projeta 151 e não dispara. (2) O motor não vê check-in sem OS; os 3 disparos do
backtest em PRE_OS (0 certos) foram excluídos da conta acima. (3) Backtest é backtest: a
precisão real das regras novas será lida em `/kpi` a partir de 11/09.
**Quem:** Alvaro (pedido), Claude (medição e código). Reprodutível em
`rivers-preditivo/src/rivers_modelo/backtest_v035_final.py` → `reports/v035_final.csv`.


### D19 — A moto na fila da qualidade para de ser invisível, e a tela para de prometer (2026-09-11) ✅
**Gatilho:** o Alvaro apontou um card do /cx: moto com 2h42, "na fila da qualidade", debaixo do
título NO PISO, DENTRO DO PRAZO, dizendo "faltam 18min".
**O que a medição achou, e é pior do que o card:**
1. **Nenhuma regra de reserva alcança moto em QA.** `C3_RELOGIO_150`, `C3_CONTA_NAO_FECHA` e
   `C3_TEMPO_ALTO` exigem `!emQa`; `C3_SEM_EXECUCAO_90` exige status de pré-execução;
   `C3_TEMPO_COMBINADO` morre porque em QA o restante é 0 e `0 + 14 >= 30` é falso; `C1_QA_TARDIA`
   só dispara se a moto **já foi reprovada**. Moto esperando conferência não existe pro motor.
2. **46 dos 210 estouros do piloto passaram pela fila do QA ainda dentro das 3h sem ninguém falar.**
   Entraram na fila com 21 min de prazo (mediana) e a conferência levou 33.
3. **A tela mentia.** Moto na fila do QA aos 165 min estoura em 18 de 39 casos (46%). Aos 135, 13%;
   aos 150, 11%; até 120, 1 a 4%. O título dizia "dentro do prazo" para um caso de quase moeda.
4. **O QA não leva 14 minutos.** Da entrada na fila até a moto pronta (n=1.177): mediana 13, p75 19,
   p90 30, p95 45. Passa dos 14 em **42%** dos casos. Com reprovação (n=70) a mediana é 39 e o p90, 105.

**O que NÃO entrou, e por quê.** Um gatilho de reserva para QA foi construído e **reprovado na
medição**: 39 alertas = 18 certos + 21 errados (**46,2%**, IC 32–61) com antecedência mediana de
**15 min**. Pior que o humano (55,9%) e derrubaria a precisão do conjunto de 82,0% para 67,8% sem
mudar nada na régua de 60 min (128 = 102 + 26 com ou sem ela). Motivo físico: essas motos já estavam
perdidas quando chegaram no QA, porque ficaram na bancada até o minuto 159. É o mesmo buraco dos 83
estouros que nenhuma regra pega, aparecendo em outro lugar.

**O que entrou:**
- `THRESHOLDS.qa_fila_min = 19` (o p75 medido), usado só pelo `restanteParaPronta` quando a moto
  **já está** na fila do QA ou em conferência. O `qa_min` de 14 continua intacto nas projeções,
  porque lá a pergunta é outra ("quanto ainda vai sobrar de QA no fim", e aí a mediana serve).
  Efeito: o card sobe pra fila de atenção do CX aos 162 min em vez de 167. **Nenhuma decisão de
  reserva muda**, porque as regras calculam o restante por outro caminho (`tempoRestanteC3`).
- O título da seção sai de "No piso, dentro do prazo" para **"No piso, sem aviso do RIVERS"**, e o
  contador do topo de "no prazo" para "sem aviso". A tela passa a afirmar um fato que ela conhece
  em vez de uma previsão que ela não tem como fazer.
- O relógio do card sai de "faltam" para **"prazo vence em"**. O número sempre foi `180 − relógio`,
  uma contagem regressiva do prazo, mas "faltam 18min" lia como "falta pouco serviço". Numa moto que
  precisa de 60 min de bancada e tem 46 de prazo, a tela mostrava 46 e não dizia nada.

**Ressalva:** o p75 é uma escolha de risco, não uma verdade. Com a mediana (13) a moto só subiria aos
167; com o p90 (30), aos 151, e aí entrariam 80 cards de que 19 estouram (23,8%). O 19 foi escolhido
por ser o percentil em que a moto que **não** cabe começa a ser maioria na faixa, e é revisável.
**Quem:** Alvaro (achou o caso), Claude (mediu e implementou). Reprodutível em
`rivers-preditivo/src/rivers_modelo/{buraco_do_qa,regra_qa}.py` → `reports/qa/`.
