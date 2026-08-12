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
