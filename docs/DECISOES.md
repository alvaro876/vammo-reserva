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


### D20 — O denominador passa a ser o universo em que a reserva resolve (2026-09-13) ✅
**Decisão:** o alcance deixa de dividir por todo estouro. Ficam de fora **guincho** (o motor foi
mandado ignorar, decisão antiga e medida) e **OS sem nenhum sinal de cliente na base**. E todo
estouro passa a sair quebrado em três: *ficou na mão*, *saiu de reserva*, *fora do alvo*.
**Gatilho:** ordem do Alvaro em 13/09, olhando o relatório do dia: "tomar cuidado pra não incluir
esses caras na análise".
**A primeira versão desta régua estava errada, e a medição pegou.** Eu ia excluir dois grupos que
pareciam óbvios:
- *"cliente saiu antes do minuto 120"* (50 estouros): **43 saíram COM reserva entregue** e 46
  tiveram oferta. Não são clientes ausentes, são o sistema funcionando — o cliente foi embora de
  outra moto e a dele ficou pronta 410 min depois (mediana). Excluir isso seria contar acerto
  como erro.
- *"nunca foi chamado no balcão"* (26 estouros): **18 tiveram oferta de reserva e 10 receberam
  moto**. Havia cliente; o que falta é o carimbo `called_at`. Usar ausência de dado como ausência
  de cliente jogaria fora caso real.

**A régua que ficou:** há cliente quando existe QUALQUER um dos sinais — chamada no balcão, oferta
de reserva (`RESERVE_OFFERED` / `CALL_FOR_RESERVE`) ou entrega (`RESERVE_DELIVERED` /
`BIKE_REPLACED`). Nunca só a chamada.

**O efeito no piloto (1.185 OS, 210 estouros):**

| | |
|---|---|
| fora do alvo | **12** = 6 guincho + 6 sem nenhum sinal de cliente |
| no alvo, mas o cliente saiu de reserva | **99** |
| no alvo e o cliente ficou na mão | **99** |
| soma | **210** |

Metade dos estouros do piloto terminou com o cliente indo embora de outra moto. O denominador do
alcance vai de 210 para **198**; o número que a operação de fato sente é **99**.

**Por que 198 e não 99:** quem recebeu reserva continua no denominador de propósito. O alerta do
RIVERS é parte da razão de ele ter recebido — tirar esses casos removeria justamente os acertos e
inverteria causa e efeito. O 99 é métrica de desfecho, não denominador de alcance.

**Onde mudou:** `src/lib/diario-replay.ts` (campos `no_universo`, `fora_do_universo`,
`recebeu_reserva`, `ficou_na_mao`), `src/app/api/diario/route.ts` (denominador e a quebra),
`src/app/diario/page.tsx` (o card principal agora é "clientes que ficaram na mão", com a quebra
dos três embaixo), `scripts/placar-producao.mjs` e o teste `scripts/testa-diario-replay.mjs`,
que ganhou a invariante "a quebra dos estouros tem que fechar".
**Quem:** Alvaro (ordem), Claude (medição e código). Reprodutível em
`rivers-preditivo/src/rivers_modelo/universo_reserva.py` → `reports/universo/`.

---

## D21 — o conta-minuto sai do ar (15/09, v0.37.0)

**A regra `C3_RELOGIO_150` foi desligada.** Ela esperava o relógio do cliente chegar em 160 min e
disparava. O motivo de desligar não é precisão, é CHEGADA: o aviso nascia tarde demais pra virar
moto na mão de alguém.

Medido em produção na Mooca, 08 a 14/09, com o replay do `/diario` sobre os 22 disparos dela:

```
folga máxima entre TODOS os 22 alertas : 20 min
alertas com 30+ min de folga           :  0 de 22
alertas disparados DEPOIS das 3h       :  6 de 22   (-23, -17, -15, -12, -6, -3)
acertou (a moto de fato passou de 3h)  : 18 de 22   (82%)
```

Entregar uma reserva leva cerca de 30 min (o próprio motor usa isso em `restante_min_reserva`).
Com folga máxima de 20, **nenhum dos 22 avisos dava tempo**. A precisão de 82% é real e é
irrelevante: acertar o diagnóstico depois do enterro não salva ninguém.

**Custo medido de desligar: zero.** Com a regra ligada a semana dá 47 alertas e 19 motos pegas com
60+ min de folga; sem ela, 37 alertas e as mesmas 19. Nenhuma moto que era pega a tempo deixa de
ser. No piloto inteiro, dos 122 disparos dela 118 já tinham sido pegos por outra regra com 75 min
de antecedência na mediana, e os 4 exclusivos tiveram a moto pronta no minuto 1.838 na mediana.

O código já reconhecia o problema em `REGRAS_ESTRUTURALMENTE_TARDIAS` (`src/lib/regras-sla.ts`),
onde ela está listada com `C1_QA_TARDIA` (165) e `C1_ESPERA_SEM_DIAG` (150). A gente documentou e
manteve ligada.

**Religa com `RIVERS_REGRA_RELOGIO=on`, sem deploy.**
**Quem:** Alvaro (ordem, repetida várias vezes), Claude (medição e código).
Reprodutível em `scripts/impacto-sem-relogio.mjs`.

---

## D22 — a conta da regra passa a usar o fator de quem estoura (15/09, v0.37.1)

**`fator_bancada` 0,67 → `fator_bancada_regra` 0,90, e `conta_folga_min` 30 → 50 (corte 210 → 230).**

O motor corrigia o restante de execução multiplicando por 0,67, assumindo que a bancada entrega
mais rápido que a estimativa. Na média está certo. Na cauda, que é exatamente a população que a
regra precisa pegar, está invertido. Medido em 352 motos da Mooca (bancada real ÷ estimativa):

```
grupo              n     p25   mediana   p75    p90    acima de 1
todas            352    0,42    0,58    0,84   1,11      14%
ficou no prazo   281    0,38    0,51    0,68   0,92       6%
passou de 3h      71    0,78    0,99    1,30   1,45      46%
```

Dos 71 que estouraram, **60 tiveram bancada acima de 0,67 do estimado** e 33 levaram mais que a
estimativa inteira. O 0,67 encurtava a projeção justo em quem ia furar o prazo.

**A tela continua no 0,67 de propósito.** Lá o que importa é acertar o caso típico; 0,90 deixaria
todo "pronta em ~" pessimista. Por isso a constante é separada.

**O par fator × corte** foi escolhido varrendo as duas dimensões nas 338 motos da semana (68
estouros), com a régua do projeto (primeiro alerta por OS, 60+ min de folga, denominador único):

```
                 alertas  precisão  a tempo  alcance
0,67 × 210 (antes)    37     78,4%      19    31,7%
0,90 × 230 (agora)    34     76,5%      22    36,7%
0,80 × 210            49     73,5%      29    42,6%
```

O par escolhido é o único que melhora os dois lados: **3 alertas a menos e 3 motos a mais salvas**.
O `0,80 × 210` compra mais alcance por 4 pontos de precisão e fica como próximo passo.

**Partido por data** pra conferir que não é corte pescado no mesmo dado: metade A (55 estouros) vai
de 79% para 77% de precisão com alcance de 27% para 35%; metade B (13 estouros) fica em 73% e 54%
nas duas. A metade B é pequena e não discrimina.

**REPROVADO no caminho: fator por número de peças.** A razão real cresce com o tamanho do serviço
(p75 de 0,61 em 1-2 peças até 0,94 em 9+), o que sugeria um fator por faixa. Não funciona: o número
de peças **já está dentro da estimativa**, então corrigir por peça conta duas vezes. Deu 46 alertas
/ 71,7% / 26 a tempo, contra 42 / 76,2% / 26 do fator fixo. Perdeu em precisão e em volume pelo
mesmo alcance.

**O que continua aberto:** a régua do balcão. No histórico da Mooca, dos 808 estouros o atendente
avisou 399 a tempo e a regra 174; em 285 casos só ele pegou, e em 182 deles (64%) o motivo que ele
escreveu foi "serviço complexo", em motos cuja estimativa dizia 124 min e que ficaram 422 min. O
sinal que ele usa é o tamanho do serviço, que o motor removeu como critério em julho. Corrigir o
fator ataca o mesmo buraco por dentro da conta; se não bastar, a lista de motivos do atendente é o
próximo lugar pra olhar.

**Quem:** Alvaro (ordem), Claude (medição e código).
Reprodutível em `scripts/testa-tudo.mjs`, `scripts/fator-bancada-real.mjs` e
`scripts/calibra-fator-pecas.mjs`.


---

## D23 — o teto do motor, medido em 30 dias (15/09)

**Não existe regra nova que ganhe alcance sem pagar precisão.** Medido com 1.594 motos e 322
estouros da Mooca (5 semanas, 11/08 a 15/09), pelo motor de verdade e não por reimplementação.

O motor hoje: **176 alertas, 76,1% de precisão, 113 clientes salvos de 322 (35,1%)**.

A fronteira, testando candidatas no slot `RIVERS_REGRA_EXP` (que fica DEPOIS de todas as regras,
então o ganho é marginal por construção):

```
candidata                                alertas  precisão  salvos   efeito
hoje                                         176     76,1%     113      -
piso,status_pre,relogio>=100                 176     76,1%     113   dispara 0 vezes
piso,status_pre,relogio>=110                 176     76,1%     113   dispara 0 vezes
piso,fora_qa,conta>=215,relogio>=90          237     67,9%     130   +17 salvos, -8,2pp
piso,fora_qa,conta>=200,relogio>=110         303     60,7%     150   +37 salvos, -15,4pp
piso,fora_qa,est>=160,relogio>=90            227     65,2%     132   +19 salvos, -10,9pp
piso,fora_qa,pecas>=8,relogio>=90            424     43,2%     172   +59 salvos, -33,0pp
piso,fora_qa,restante>=60,relogio>=100       413     46,0%     181   +68 salvos, -30,1pp
```

**O câmbio é de cerca de 1 ponto de precisão a cada 2 clientes a mais.** E a família "ainda não
entrou na bancada" dispara ZERO vezes no slot, porque a `C3_SEM_EXECUCAO_90` já cobre ela inteira
aos 90 minutos. Não sobrou espaço ali.

No único botão que existe (`sem_execucao_min`), a troca é a mesma:

```
sem_execucao_min   alertas  precisão  salvos  alcance
90 (hoje)              176     76,1%     113    35,1%
110                    163     79,8%     108    33,5%
120                    159     80,5%     106    32,9%
```

Chegar em 80% custa 7 clientes em 30 dias.

**UM ERRO QUE EU COMETI E QUE FICA REGISTRADO.** A primeira varredura foi feita numa
reimplementação das regras por fora do motor, e ela prometeu +30 clientes salvos. Eram falsos: a
reimplementação ignorava a janela do cron (7h–21h), a lista de status avaliáveis e as exclusões do
piso (NO_SHOW, CANCELLED, DROPOUT, RETURN_INSPECTION). Os "novos" eram moto que chegava de
madrugada, quando o motor nem roda. Daí nasceu o slot `RIVERS_REGRA_EXP`: **candidata que não passa
pelas mesmas travas do motor não é candidata.**

**O que de fato quebra o teto, e não é regra:**

1. **A estimativa.** Ela é o único insumo real de quase toda regra, e erra de forma previsível:
   a razão bancada real ÷ estimativa é 0,51 na mediana em quem fica no prazo e 0,99 em quem
   estoura. As regras são formas cada vez mais elaboradas de compensar um número errado.
2. **O atendente.** No histórico da Mooca, 808 estouros: ele avisa 399 a tempo, a regra 174. Em
   285 casos só ele pega, e em 182 deles (64%) o motivo que ele escreve é "serviço complexo", em
   motos cuja estimativa dizia 124 min e que ficaram 422 min.

**A base de medição que passou a existir:** 32 fixtures diários (11/08 a 15/09), 1.594 motos e 322
estouros. Antes disso toda decisão saía de 60 a 70 estouros, e nesse tamanho a diferença entre 76%
e 83% não é distinguível.

**Quem:** Alvaro (ordem), Claude (medição e código).
Reprodutível em `scripts/mina-regras.mjs` (garimpo de condições) e
`scripts/testa-candidatas.mjs` (teste pelo motor real via slot).
