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
