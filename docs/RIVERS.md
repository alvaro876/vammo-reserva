# RIVERS — Sugestão Automática de Reserva

> Documento vivo. Fonte de verdade do projeto entre sessões.
> Última atualização: 2026-06-22.

## O que é

Rivers decide **automaticamente e cedo** se um cliente que está na oficina (em piso)
deve receber uma **moto reserva**, e mostra **o porquê**. Hoje essa decisão é manual,
feita pelo líder de turno olhando o Retool, e chega tarde — com o cliente esperando.
Rivers antecipa a decisão assim que o diagnóstico fecha (~15 min), via **algoritmo
determinístico em camadas** (sem LLM em produção).

Origem: doc "Gestão de Piso & RIVERS" (`Rivers/Gestão de piso e Rivers.docx`).

## Decisões travadas

Ver histórico e justificativas em [`DECISOES.md`](./DECISOES.md).

| # | Decisão | Status |
|---|---|---|
| Superfície | A sugestão vive **no app vammo-reserva** por enquanto; integração no Maestro fica pra fase 2 | ✅ confirmado (Alvaro) |
| Store do "porquê" | **Supabase (Postgres)** | ✅ confirmado (Alvaro) |
| Linguagem do motor | **TypeScript no próprio app**; Python só pra calibração/análise offline | 🟡 recomendado, a confirmar |
| Escopo V1 | Completa, incluindo **capacidade agregada de mecânicos**; alocação por mecânico específico (senioridade) **fora da V1** | 🟡 alinhado |
| Absenteísmo | **Medir antes de modelar** — haircut empírico, não modelo preditivo na V1 | 🟡 recomendado |
| Sem RAG | Contexto persiste via estes docs + Vammo Mind + memórias | ✅ recomendado |
| Remover o LLM | Tirar o fallback de IA generativa, deixar 100% determinístico | ✅ pedido do Alvaro |

## Como funciona hoje (estado atual do código)

- **`GET /api/os`** (`src/app/api/os/route.ts`): roda uma query grande no ClickHouse
  (validada manualmente em 11/mai), monta o estado dos mecânicos em memória, e roda
  `avaliarOS` em cada OS ativa. Devolve JSON pro browser.
- **`src/lib/algorithm.ts`**: `avaliarOS` com as **Camadas 1–4** determinísticas.
  A primeira camada que dispara manda.
- **`src/app/api/recommendation/route.ts`** (removido): fallback que chamava um **LLM** para
  os casos `C4_PENDING` (combinações sutis).
- **`src/lib/clickhouse.ts`**: cliente HTTP read-only (Basic Auth), zero-dep.
- **`src/app/page.tsx`**: UI. Tem botões de aceitar/rejeitar **soltos** ("Feedback salvo
  no Supabase em breve").

**A avaliação acontece sob demanda (quando alguém abre a tela). Nada é persistido.**

### Dados que a query já puxa (read path — o difícil já está feito)

| Bloco | Fonte ClickHouse |
|---|---|
| OS + timeline de status | `oms_r.so`, `oms_r.so_status` |
| Flags imobilizada/acidente/guincho | `so.maintenance_metadata` (checklist_tags) |
| Mecânico atual | `oms_r.so_status` (IN_PROGRESS) + `ims_r."user"` |
| Peças do diagnóstico + tempo + complexidade | `oms_r.so_item` + `ims_r.item_group` |
| Estoque por base | `ims_r.inventory` + `ims_r.item` + `ims_r.deposit` |
| Cliente em piso (check-in) | `maestro_scheduler_r.checkin` |

- **Bases**: `location_id` 1 = Mooca, 34 = Osasco, 166 = São Bernardo.
- **Tabela de skill das peças** está **colada dentro do SQL** (um `UNION ALL`), mapeando
  `item_group_id` → skill 1–7. Default 1 para peças não mapeadas.
- **Peças críticas** (IDs fixos, duplicados em SQL e TS):
  motor `257,258,259,260` · balança `184,357` · caixa direção `250,308,340,359` ·
  chassi `296` · garfo `240`.

## O que é real vs o que falta (auditoria)

1. **Nada é salvo** — sem persistência, sem `algo_version`, sem comparação com desfecho.
   Os botões aceitar/rejeitar não estão ligados. **Bloqueia medir acurácia.**
2. **Não roda sozinho nem notifica CX** — só avalia ao abrir a tela. Falta o motor
   agendado (varredura 5–10 min) + notificação.
3. **Estimativa de tempo furada na fonte** — vem de `ig.time_target`, zerado/ausente pra
   maioria das peças (gambiarra no SQL: `if(ig.id = 308, 41, 0)`). Camadas 3 e 5 dependem
   disso. Precisa medir cobertura e reconstruir do histórico.
4. **Capacidade de mecânico é proxy** — skill inferido da complexidade da OS atual do
   mecânico; sem registro real de skill, sem escala, sem absenteísmo.
5. **Insight central do doc não implementado** — doc manda medir *desde a chegada*
   (check-in); código usa `min_desde_open` (abertura da OS). O dado de chegada está na
   query, mas só vira flag `is_piso`, não minutos.
6. **Escopo "só piso" não é aplicado** — `is_piso` é calculado mas o algoritmo avalia
   todas as OS ativas, não só as de piso.
7. **Números na mão e divergentes do doc** (ver abaixo).

### Divergências doc × código

| Tema | Doc | Código | Ação |
|---|---|---|---|
| Anomalia de espera | >90min sem entrar p/ diag; >60min desde chegada | `anomalia_min = 240` sobre open→awaiting | diverge valor **e** semântica |
| Base de medição | desde a **chegada** (check-in) | `min_desde_open` (abertura OS) | implementar (dado existe) |
| Diversas avarias | ≥ 6 peças | `diversas_avarias = 9` | calibrar |
| Multiplicador ineficiência | × 1.3 | ausente (só `+ 12`) | decidir/aplicar |
| Corte de tempo de serviço | (não claro) | `tempo_estimado_max = 120` | validar se deve existir |
| Tempo total | > 180 min | `tempo_total_max = 180` | ✅ bate |
| Peças críticas | motor, caixa, balança, chassi | + garfo; IDs fixos | validar no catálogo |
| Skill do mecânico | `staff_mecanicos` real | proxy pela OS atual | aterrar em dado |
| Escopo | só cliente em piso | `is_piso` não filtrado | aplicar filtro |

## Roteiro (fases) — fonte única, até ficar pronto

> Fio condutor: **instrumentar primeiro** (não dá pra calibrar o que não se mede),
> depois aterrar inputs, depois capacidade, depois rodar sozinho, depois medir e iterar.

### Fase 0 — Fundação
- [x] **0.1 Remover o LLM** — algoritmo 100% determinístico (fallback `C5_DENTRO_PRAZO`).
- [x] **0.2 Criar Supabase + rodar `schema.sql`** — feito (tabelas criadas).
- [x] **0.3 Instrumentação** — sugestões gravando na `rivers_suggestion` (verificado: 133 linhas);
  botões aceitar/rejeitar ligados (`/api/feedback`, popula ao primeiro clique).
- **Pronto quando:** toda avaliação fica registrada com o porquê, sem IA no loop. ✅ ATINGIDO (2026-06-23)

### Fase 1 — Aterrar os inputs que já temos (barato, alto impacto)
- [ ] **1.1 "Desde a chegada"** — usar `checkin` p/ medir desde a chegada (não desde a OS) +
  aplicar o filtro de piso (`is_piso`).
- [ ] **1.2 Estimativa de tempo** — validar `time_target` vs tempo real, aplicar/calibrar o ×1.3,
  preencher os ~29 grupos sem alvo.
- [ ] **1.3 Skill real do mecânico** — usar MasterTEAM (`stg_mechanics_r__level`) no lugar do proxy;
  resolver o de-para de base (OS 1/34/166 ↔ MasterTEAM 1/2/3) e `employee_id`↔email.
- **Pronto quando:** inputs das camadas 1–3 e 5 corretos e medidos.

### Fase 2 — Capacidade (resolve a troca de turno)
- [~] **2.1 Curva de capacidade esperada** — BACKTEST OOS feito (ver [`CAPACIDADE-DEPLOY.md`](./CAPACIDADE-DEPLOY.md)).
  Achado (verificado, alta confiança): o modelo de escala (`previsto`×haircut) **PERDE** pro baseline simples
  (média da atividade REAL por base×dow×hora): MAE **3,25 vs 2,84** (baseline ganha nas 12 células). →
  **V1 = baseline** (mais simples e mais preciso; já captura almoço/troca de turno por ser média do real).
  Escala = refinamento futuro só se bater 2,84. Deploy = modelo **dbt** no `analytics` + dashboard **Metabase**
  (MCP read-only → Alvaro cria, eu pré-valido SQL) + **Rivers lê o mart** ao vivo.
- [ ] **2.2 Vazão** — curva × produtividade real (`fct_mechanic_day`) → tempo de fila.
- [ ] **2.3 Correção por absenteísmo** — MasterTEAM `attendance` (retrospectivo) ajusta a curva.
- **Pronto quando:** o cálculo de fila usa capacidade ESPERADA (não a contagem do minuto) e
  atravessa a troca de turno sem surtar.

### Fase 3 — Rodar sozinho (diário) + avisar
- [ ] **3.1 Motor agendado** — varredura a cada 5–10 min no horário de operação; avalia, grava, dispara.
- [ ] **3.2 Notificação** — Slack pro Alvaro (por ora).
- [ ] **3.3 Recalcular a curva** diariamente/semanal (o "modelo roda sozinho").
- **Pronto quando:** roda todo dia sem ninguém abrir a tela, grava tudo e avisa.

### Fase 4 — Acurácia + iteração (o loop que você pediu)
- [ ] **4.1 Verdade de campo** — cruzar com reserva real + tempo real de permanência.
- [ ] **4.2 Painel de acurácia** — precisão/recall vs humano; erro do tempo; erro da curva.
- [ ] **4.3 Calibrar thresholds** com base nos dados.
- [ ] **4.4 Revisão semanal** — decidir o que mudar quando estiver errado.
- **Pronto quando:** toda semana a gente vê o quanto acerta e ajusta com fundamento.

## Perguntas abertas

- Notificação ao CX: **Slack** (`#liberação-reserva-oz`), **na tela do app**, ou **os dois**?
- Onde roda o cron / onde o app é hospedado (Vercel Cron?).
- Verdade de campo: confirmar a tabela de "reserva associada" no Metabase.
- Devolução da reserva / cobrança por não-devolução (RASCUNHO do doc) — fora da V1?
- Confirmar D4/D5 (D3 e D7 confirmados em 2026-06-22).

## Diligência de dados (2026-06-22)

> Atualiza a auditoria acima — **item 3 corrigido**.

- **Cobertura de diagnóstico (OS de piso, últimos 14d): ~55–70% em dia útil (~60% típico),
  NÃO ~100%.** A premissa do doc não é atendida: ~40% das OS de piso não têm diagnóstico →
  pra essas o algoritmo só tem as camadas "óbvias" (checklist imobilizada/acidente/placa) +
  tempo de espera. **É o maior risco de assertividade.** Acompanhar como métrica viva.
- **`time_target` tem ~95% de cobertura** (30.485 de 32.129 linhas de diagnóstico; 157 de
  186 grupos de peça). Correção do achado anterior: NÃO está "furado pra maioria". O P3 vira
  **validar se o `time_target` bate com o tempo real + preencher os ~29 grupos faltantes +
  aplicar/calibrar o ×1.3** — não reconstruir do zero.
- **MasterTEAM/mecânicos EXISTE no ClickHouse** (schema `mechanics_r` + modelos dbt `analytics.*`).
  Achados (colunas confirmadas): `stg_mechanics_r__shift` (turnos por base), `stg_mechanics_r__level`
  (**skill MEC real** → conserta o proxy do C4), **`stg_mechanics_r__attendance` + `__attendance_status`
  (presença real por mecânico/dia → absenteísmo MEDIDO, não estimado)**, `fct_mechanic_day`
  (produtividade diária), `int_mechanic_roster_weekly` (escala semanal agregada). **P5 desbloqueado.**
  A confirmar: chave de join `employee_id` ↔ `user_id`/email da atividade de OS, e a frescura do
  `attendance`. **Gotcha:** `valid_to` duplo-sentinela (1970 *e* 1900) no MasterTEAM — filtrar os dois.
- Metabase: ClickHouse replicado = **database_id 137** ("Vammo Replicated").

## Achados verificados (2026-06-23) — investigação das 4 frentes
Detalhe completo em [`ACHADOS-2026-06-23.md`](./ACHADOS-2026-06-23.md). Resumo:
- 🐛 **BUG corrigido** em `os/route.ts:44-46`: flags C1 (imobilizada/acidente/guincho) liam JSON com
  caminho pontilhado e retornavam 0 SEMPRE (C1 hard estava morto). Fix = args separados. Mesmo assim
  `checklist_tags` só existe em ~10% do piso → quem segura o piso é **C3** (peça crítica ~141/14d + diversas ~95/14d).
- **Acurácia — a verdade existe:** `maestro_scheduler_r.checkin.reserve_delivered_at` + `reserve_reason` (por `so_id`);
  tempo real via `called_at` → `so_status` COMPLETED. Dá pra medir já (receita no doc). Cobertura de diagnóstico ~86% (não ~60%).
- **Capacidade (Fase 2) viável:** join = email (employee ↔ ims_r.user ↔ fct_mechanic_day, 126/129); skill+turno em
  `employee_role_history`; de-para base via `mechanics_r.location` (1=SBC/2=Osasco/3=Mooca). Gotchas: dual-sentinela 1970+1900;
  `stg_mechanics_r__employee.is_active` quebrado.
- **Estoque (C2) — 3 furos:** NULL→0 (11% dos disparos), ignora depósitos MAINTENANCE/PERSON, e não vê estoque cross-base.
  Campeãs de falta = ACESSÓRIOS (Baú/USB/Peso do guidão), não disco.
