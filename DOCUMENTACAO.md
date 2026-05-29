# Recomendador de Reserva — Documentação Técnica

**Projeto:** vammo-reserva  
**Stack:** Next.js 15 · TypeScript · ClickHouse · Claude Haiku · Vercel  
**Repositório:** https://github.com/alvaro876/vammo-reserva  
**URL produção:** Vercel (vammo-reserva.vercel.app)  
**Última atualização:** 15/05/2026

---

## 1. O que é esse app

O **Recomendador de Reserva** é uma ferramenta para o **líder de turno** da Vammo decidir, em tempo real, quais clientes em piso devem receber uma moto reserva.

Antes: o líder olhava o Retool no feeling, geralmente tarde demais.  
Agora: o app avalia cada OS automaticamente logo após o diagnóstico e mostra se deve reservar ou não — e **por que**.

O app roda na web, se atualiza a cada 60 segundos e separa os clientes em duas tabelas:
- **Tabela principal:** clientes em piso (fisicamente na oficina)
- **Tabela secundária:** demais OS ativas na base (contexto da oficina)

---

## 2. Arquitetura

```
Browser (React / Next.js)
    │
    ├── GET /api/os ──────────────── ClickHouse (lê OS ativas)
    │       │
    │       └── algorithm.ts ──────── Decide C1→C3 determinístico
    │                                  └── C4_PENDING → POST /api/recommendation
    │
    └── POST /api/recommendation ─── Claude Haiku API (casos ambíguos)
```

### Fluxo completo

1. Browser chama `GET /api/os` a cada 60s
2. A rota busca todas as OS ativas no ClickHouse com uma query SQL complexa
3. Para cada OS em status avaliável, chama `avaliarOS()` — o algoritmo em TypeScript
4. Se o algoritmo não decidir (C4_PENDING), o browser chama `POST /api/recommendation` com o contexto da OS + estado atual da oficina
5. Claude Haiku avalia e retorna `RESERVA` ou `SEM_RESERVA` com motivo em português
6. O browser atualiza só aquela linha sem refazer o fetch inteiro

---

## 3. Estrutura de arquivos

```
src/
├── app/
│   ├── page.tsx                   → Frontend: tabela, badges, modal de confirmação
│   └── api/
│       ├── os/route.ts            → GET /api/os: query SQL + chama algoritmo
│       └── recommendation/route.ts → POST /api/recommendation: chama Claude Haiku
├── lib/
│   ├── algorithm.ts               → Algoritmo rule-based (C1–C3.5)
│   └── clickhouse.ts              → Cliente HTTP para o ClickHouse Cloud
└── types/
    └── index.ts                   → Tipos TypeScript compartilhados
```

---

## 4. O algoritmo — Camadas em cascata

O algoritmo avalia cada OS em camadas. **A primeira camada que disparar vence** — não acumula.

```
ENTRADA: dados da OS (do ClickHouse)

├── CAMADA 1 — Regras hard (RESERVA imediata)
│   ├── Moto imobilizada → RESERVA (C1_HARD)
│   ├── Acidente → RESERVA (C1_HARD)
│   ├── Veio de guincho → RESERVA (C1_HARD)
│   ├── Tipo = INSURANCE_QUOTE → RESERVA (C1_HARD)
│   └── min_open_to_awaiting > 240min → RESERVA (C1_ANOMALIA)
│       "moto não entrou na oficina há Xmin"
│
├── CAMADA 2 — Estoque
│   └── Peça sem estoque → RESERVA (C2_SEM_ESTOQUE)
│
├── CAMADA 3 — Complexidade
│   ├── Peça crítica no diag → RESERVA (C3_PECA_CRITICA)
│   │   (Motor, Balança, Caixa direção, Chassi, Garfo)
│   ├── 9+ tipos de peça diferentes → RESERVA (C3_DIVERSAS_AVARIAS)
│   └── Tempo estimado > 120min → RESERVA (C3_TEMPO_ALTO)
│
├── CAMADA 3.5 — Tempo total combinado
│   ├── Para IN_PROGRESS: usa tempo RESTANTE = estimado - já trabalhado
│   ├── Para outros: usa estimado total
│   └── Se min_desde_open + tempo_restante > 180min → RESERVA (C3_TEMPO_COMBINADO)
│       Guard: só avalia se estimado > 0 e OS aberta < 8h
│
└── CAMADA 4 — Claude Haiku (casos ambíguos)
    └── Passa contexto da OS + estado da oficina para o Claude decidir
        (só para OS de clientes em piso)
```

### Thresholds atuais (calibrados em 11/05/2026 contra 865 OS reais)

| Constante | Valor | Significado |
|---|---|---|
| `anomalia_min` | 240 min | C1: OS aberta > 4h sem entrar na oficina |
| `diversas_avarias` | 9 peças | C3: 9+ tipos de peça = complexidade alta |
| `tempo_estimado_max` | 120 min | C3: trabalho > 2h |
| `tempo_total_max` | 180 min | C3.5: espera + execução > 3h |

### Peças críticas (C3_PECA_CRITICA)

Qualquer uma dessas peças no diagnóstico gera reserva imediata:

| Grupo | IDs |
|---|---|
| Motor | 257, 258, 259, 260 |
| Balança | 184, 357 |
| Caixa de direção | 250, 308, 340, 359 |
| Chassi | 296 |
| Garfo | 240 |

---

## 5. Quais OS são avaliadas

### Statuses avaliados pelo algoritmo

```typescript
const STATUSES_AVALIAVEIS = new Set([
  "OPEN",              // OS aberta, aguardando diagnóstico
  "IN_DIAGNOSIS",      // Diagnóstico em andamento
  "AWAITING_MECHANIC", // Aguardando mecânico de rampa
  "IN_PROGRESS",       // Mecânico trabalhando
  "PAUSED",            // OS pausada (mecânico parou)
  "AWAITING_VMGMT",    // Aguardando gestão de frota/veículo
]);
```

### Statuses ignorados (recomendacao = null)

`AWAITING_QA`, `IN_QA`, `QA_REJECTED` — trabalho já finalizado, reserva não ajuda mais.

---

## 6. Detecção de "piso" (cliente na oficina)

O app usa a tabela `maestro_scheduler_r.checkin` para detectar se o cliente está fisicamente na oficina:

```sql
is_piso AS (
    SELECT c.so_id AS os_id
    FROM maestro_scheduler_r.checkin c FINAL
    WHERE c.checkin_type = 'MAINTENANCE'
      AND c.so_id IS NOT NULL
      AND c.status NOT IN ('NO_SHOW', 'CANCELLED', 'DROPOUT')
      AND c.called_at IS NOT NULL
      AND toDate(c.created_at, 'America/Sao_Paulo') = toDate(now('America/Sao_Paulo'))
)
```

Somente OS com `is_piso = 1` aparecem na tabela principal e são enviadas ao Claude para avaliação C4.

---

## 7. Integração Claude (C4)

### Quando o Claude é chamado

Somente quando:
1. A OS é de um cliente em piso (`is_piso = 1`)
2. Nenhuma regra C1–C3.5 disparou (`rule_triggered = "C4_PENDING"`)

### O que o Claude recebe

Além dos dados da OS (placa, modelo, peças, tempo, mecânico, apontamento CX), o Claude recebe o **estado atual da oficina na mesma base**:

```json
{
  "mecanicos_em_os": 8,
  "tempo_medio_restante_min": 35,
  "outras_os_aguardando_mec": 2
}
```

Isso permite o Claude raciocinar sobre fila: uma OS simples pode precisar de reserva se a oficina está sobrecarregada.

### Modelo e configuração

- **Modelo:** `claude-haiku-4-5-20251001` (rápido, ~1s)
- **max_tokens:** 150 (resposta curta = só o JSON)
- **Formato de resposta:** `{"decision": "RESERVA", "motivo": "frase curta em português"}`

---

## 8. Query SQL — O que o ClickHouse retorna

A query principal em `GET /api/os` retorna uma linha por OS com:

| Campo | Fonte | Descrição |
|---|---|---|
| `os_id` | `oms_r.so.id` | ID da OS |
| `status_atual` | `argMax(ss.status, ss.created_at)` | Status mais recente |
| `min_desde_open` | `dateDiff('minute', so.created_at, now())` | Minutos desde abertura |
| `min_no_status` | `dateDiff('minute', max(ss.created_at), now())` | Minutos no status atual |
| `min_open_to_awaiting` | `dateDiff(open, first AWAITING_MECHANIC)` | Para C1_ANOMALIA |
| `n_pecas` | `count(DISTINCT item_group_id)` | Tipos de peça no diag |
| `tempo_estimado_min` | `SUM(qty × time_target) + 12` | Estimativa total |
| `complexidade_max` | `max(skill_level)` | Complexidade da peça mais difícil |
| `n_pecas_criticas` | `sumIf(1, item_group_id IN (...))` | Contagem de peças críticas |
| `n_sem_estoque` | Comparação com `ims_r.inventory` | Peças em falta |
| `is_piso` | `maestro_scheduler_r.checkin` | Cliente na oficina? |
| `imobilizada` | `checklist_tags.immobilizing` (JSON) | Flag de imobilização |
| `acidente` | `checklist_tags.accident` (JSON) | Flag de acidente |
| `guincho` | `checklist_tags.towing` (JSON) | Flag de guincho |

---

## 9. Interface AlgoritmoInput (contrato SQL → algoritmo)

```typescript
export interface AlgoritmoInput {
  os_id: number;
  so_type: string;
  location_id: number;
  asset_model: string;
  placa: string;
  descricao_cx: string;
  status_atual: string;
  imobilizada: number;
  acidente: number;
  guincho: number;
  min_open_to_awaiting: number;
  min_desde_open: number;       // ← crítico para C3_TEMPO_COMBINADO
  min_no_status: number;        // ← tempo já trabalhado (para IN_PROGRESS)
  n_pecas: number;
  tempo_estimado_min: number;
  complexidade_max: number;
  n_pecas_criticas: number;
  n_sem_estoque: number;
  pecas_sem_estoque: string;
  pecas_criticas: string;
  is_piso: number;
}
```

**Atenção:** todos os campos usados no algoritmo precisam estar declarados aqui. Se um campo estiver ausente da interface, TypeScript pode compilar sem erro mas o valor em runtime será `undefined`, quebrando as comparações silenciosamente.

---

## 10. Deploy e configuração

### Variáveis de ambiente (Vercel)

| Variável | Onde configurar | Descrição |
|---|---|---|
| `CLICKHOUSE_HOST` | Vercel Environment Variables | URL HTTPS do ClickHouse Cloud |
| `CLICKHOUSE_USER` | Vercel Environment Variables | Usuário read-only |
| `CLICKHOUSE_PASSWORD` | Vercel Environment Variables | Senha |
| `ANTHROPIC_API_KEY` | Vercel Environment Variables | Chave da API Claude |

### next.config.ts

```typescript
const nextConfig: NextConfig = {
  typescript: {
    ignoreBuildErrors: true,  // Permite deploy mesmo com erros de tipo
  },
};
```

### Deployment

O app faz deploy automático no Vercel a cada push no branch `master`.  
Tempo típico de build: 1–2 minutos.

---

## 11. Histórico de bugs corrigidos

| Bug | Causa | Fix aplicado |
|---|---|---|
| "—" para todos os status exceto AWAITING_MECHANIC | `ReservaBadge` tinha gate `if (status !== "AWAITING_MECHANIC") return "—"` | Removido o gate (commit a1d9ccc) |
| C3_TEMPO_COMBINADO nunca disparava | `min_desde_open` não estava na interface `AlgoritmoInput` → valor `undefined` em runtime | Adicionado à interface (commit ec8e13d) |
| AWAITING_VMGMT não era avaliado | Status ausente de `STATUSES_AVALIAVEIS` | Adicionado (commit 52dff6b) |
| PAUSED não era avaliado | Status ausente de `STATUSES_AVALIAVEIS` | Adicionado (commit 78a9165) |
| OS IN_PROGRESS com trabalho quase pronto recebia reserva errada | C3_TEMPO_COMBINADO usava `tempo_estimado_min` total em vez do restante | Usa `max(0, estimado - min_no_status)` para IN_PROGRESS (commit 52dff6b) |
| Claude ficava girando eternamente em caso de erro | Catch silencioso não atualizava estado | Adicionado C4_ERRO com mensagem (commit 20d07cc) |
| Spinner infinito não mostrava erro | `if (!r.ok) return;` sem atualizar estado | Corrigido para setar `C4_ERRO` |

---

## 12. O que falta (próximos passos)

| Feature | Prioridade | Descrição |
|---|---|---|
| **Supabase feedback loop** | Alta | Salvar decisão do líder (confirmou/rejeitou reserva) para medir acurácia do algoritmo |
| **Calibrar thresholds** | Alta | Sentar com Billy/Chalela e ajustar os valores de 180min, 9 peças, etc. com dados reais |
| **Camada 4-6 determinística** | Média | Mecânicos disponíveis no turno + backlog da rampa (hoje o Claude cobre esse gap) |
| **Auto-refresh ajustável** | Baixa | Permitir o líder escolher o intervalo (hoje fixo em 60s) |
| **Histórico de recomendações** | Média | Log de todas as sugestões + decisão real para validação semanal |

---

## 13. Regra de negócio: por que reserva?

Análise de 101 sugestões reais do líder Victor mostrou:

| Motivo | % | Mapeado em |
|---|---|---|
| Peça em falta | 38% | C2_SEM_ESTOQUE |
| Diversas avarias / complexidade | 22% | C3_DIVERSAS_AVARIAS + C3_TEMPO_ALTO |
| Ocupação da oficina | 16% | C4 Claude |
| Peça crítica (motor, caixa...) | 14% | C3_PECA_CRITICA |
| Anomalias de fluxo | 6% | C1_ANOMALIA |
| Serviço especial | 1% | C1_HARD |

~90% das decisões são determinísticas — por isso a abordagem V1 é rule-based, não ML.
