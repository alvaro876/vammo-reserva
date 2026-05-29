# Como o Recomendador de Reserva foi feito

Notas técnicas sobre **como** o app `vammo-reserva` foi construído — pra que outros times possam usar o mesmo padrão.

**Stack final:** Next.js 15 · TypeScript · ClickHouse Cloud · Claude Haiku · Vercel
**Repo:** https://github.com/alvaro876/vammo-reserva
**Build solo:** ~2 semanas (do zero ao app rodando em produção, lendo dado ao vivo)

---

## 1. O problema

O líder de turno decidia reserva no feeling, olhando o Retool. Geralmente tarde — depois que o cliente já estava 2-3h esperando. A meta era decidir **logo após o diagnóstico** (~15min de OS), antes da moto entrar na rampa.

Análise de 101 sugestões reais do líder Victor mostrou que **~90% das decisões eram determinísticas**:

| Motivo real | % | Mapeável em regra? |
|---|---|---|
| Peça em falta | 38% | Sim — consulta estoque |
| Diversas avarias / complexidade | 22% | Sim — contagem de peças |
| Ocupação da oficina | 16% | Parcial — depende de contexto |
| Peça crítica (motor, caixa...) | 14% | Sim — lista de IDs |
| Anomalia de fluxo | 6% | Sim — delta de tempo |
| Especial | 1% | Sim — `so_type` |

**Conclusão:** não precisa ML. Regras determinísticas cobrem o grosso; LLM cobre a cauda ambígua.

---

## 2. A arquitetura em uma linha

```
ClickHouse (dado ao vivo) → Algoritmo C1-C3.5 (TS puro, regras em cascata) → Claude Haiku (só casos ambíguos)
```

Três camadas, três níveis de custo/latência:
- **SQL:** caro de escrever, barato de rodar
- **TS puro:** barato de escrever, instantâneo, testável
- **LLM:** caro por chamada, ótimo pra casos cinza

A regra de ouro foi: **empurrar tudo que dá pra cima na cascata**. Cada decisão que vira regra é uma decisão que não custa token nem latência.

---

## 3. Decisões de stack — por que cada peça

### Next.js 15 (App Router)
- Frontend + API no mesmo repo, deploy num clique
- Server Actions / Route Handlers escondem credenciais do browser
- `next dev` com hot reload já entrega DX bom o suficiente
- Vercel free tier cobre o uso interno

### TypeScript
- Algoritmo fica em um arquivo só (`src/lib/algorithm.ts`), legível como receita
- Interfaces (`AlgoritmoInput`) garantem que SQL e código TS não saiam de sincronia
- **Gotcha real:** se um campo está na query mas falta na interface, TS compila sem erro e o valor vira `undefined` em runtime. Isso virou bug e foi consertado depois. Lição: a interface é o contrato — todo campo usado no algoritmo precisa estar lá.

### ClickHouse direto via HTTPS API
- Sem SDK, sem ORM — só `fetch()` + Basic Auth
- `body: sql + "\nFORMAT JSONEachRow"` retorna uma linha JSON por linha de texto
- Total: 50 linhas em `src/lib/clickhouse.ts`. Zero deps extras.

```typescript
// src/lib/clickhouse.ts (essência)
export async function query<T>(sql: string): Promise<T[]> {
  const response = await fetch(`${CLICKHOUSE_HOST}/?output_format_json_quote_64bit_integers=0`, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain",
      Authorization: "Basic " + Buffer.from(`${USER}:${PASSWORD}`).toString("base64"),
    },
    body: sql + "\nFORMAT JSONEachRow",
    cache: "no-store",
  });
  const text = await response.text();
  return text.trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as T);
}
```

### Claude Haiku (não Sonnet)
- Latência: ~1s por chamada (Sonnet seria 3-5s)
- Custo: ordens de grandeza menor
- Pra um JSON `{decision, motivo}` em PT-BR, Haiku resolve com `max_tokens: 150`
- Modelo: `claude-haiku-4-5-20251001`

### Vercel
- Push pro `master` → build em 1-2min → deploy automático
- Env vars (`CLICKHOUSE_*`, `ANTHROPIC_API_KEY`) configuradas no dashboard
- Zero infra pra manter

---

## 4. O padrão: cascata determinística + LLM no fim

Esse é o ponto que vale replicar em outros casos.

```
ENTRADA → CAMADA 1 (hard rules) → vence? RETORNA
        → CAMADA 2 (...) → vence? RETORNA
        → ...
        → CAMADA N-1 (tudo determinístico) → vence? RETORNA
        → CAMADA N (LLM) → contexto adicional → RETORNA
```

**Regras:**
1. **Primeira camada que dispara vence** — não acumula, não pondera
2. Cada camada tem nome (`C1_HARD`, `C2_SEM_ESTOQUE`, `C3_PECA_CRITICA`...) que vira `rule_triggered` no output. Auditável.
3. LLM só é chamado quando **nenhuma regra disparou** (`C4_PENDING`)
4. LLM recebe contexto que regras não conseguem capturar — estado da oficina, apontamento do CX em texto livre, etc.

Esse padrão tem 3 vantagens:
- **Performance:** ~90% das OS nem chegam no LLM
- **Auditabilidade:** o líder vê a regra que disparou e pode contestar
- **Calibração barata:** ajustar threshold = mudar um número, não retreinar modelo

---

## 5. Algoritmo em camadas (código real)

`src/lib/algorithm.ts` — núcleo da decisão. Cada `if` é uma camada.

```typescript
const THRESHOLDS = {
  anomalia_min: 240,         // C1: OS aberta há >4h sem entrar oficina
  diversas_avarias: 9,       // C3: 9+ tipos de peça
  tempo_estimado_max: 120,   // C3: trabalho >2h
  tempo_total_max: 180,      // C3.5: espera + execução >3h
};

const PECAS_CRITICAS = new Set([
  257, 258, 259, 260,  // Motor
  184, 357,            // Balança
  250, 308, 340, 359,  // Caixa direção
  296,                 // Chassi
  240,                 // Garfo
]);

export function avaliarOS(input: AlgoritmoInput): Recomendacao {
  // ── CAMADA 1: regras duras
  if (input.imobilizada === 1)      return reserva("C1_HARD", "moto imobilizada");
  if (input.acidente === 1)         return reserva("C1_HARD", "acidente");
  if (input.guincho === 1)          return reserva("C1_HARD", "veio de guincho");
  if (input.so_type === "INSURANCE_QUOTE") return reserva("C1_HARD", "vistoria de seguro");
  if (input.min_open_to_awaiting > THRESHOLDS.anomalia_min) {
    return reserva("C1_ANOMALIA", `moto não entrou na oficina há ${input.min_open_to_awaiting}min`);
  }

  // ── CAMADA 2: estoque
  if (input.n_sem_estoque > 0) {
    return reserva("C2_SEM_ESTOQUE", `sem estoque: ${input.pecas_sem_estoque}`);
  }

  // ── CAMADA 3: complexidade
  if (input.n_pecas_criticas > 0)
    return reserva("C3_PECA_CRITICA", `peça crítica: ${input.pecas_criticas}`);
  if (input.n_pecas >= THRESHOLDS.diversas_avarias)
    return reserva("C3_DIVERSAS_AVARIAS", `${input.n_pecas} tipos de peça`);
  if (input.tempo_estimado_min > THRESHOLDS.tempo_estimado_max)
    return reserva("C3_TEMPO_ALTO", `trabalho estimado ${input.tempo_estimado_min}min`);

  // ── CAMADA 3.5: tempo total (espera + restante)
  // Pra IN_PROGRESS: usa só o tempo restante (estimado - já trabalhado)
  // Pra outros: usa estimado total
  const tempoRestante = input.status_atual === "IN_PROGRESS"
    ? Math.max(0, input.tempo_estimado_min - input.min_no_status)
    : input.tempo_estimado_min;
  const tempoTotal = input.min_desde_open + tempoRestante;

  if (input.tempo_estimado_min > 0
      && input.min_desde_open < 480       // guard: >8h é C1_ANOMALIA
      && tempoTotal > THRESHOLDS.tempo_total_max) {
    return reserva("C3_TEMPO_COMBINADO",
      `já esperou ${input.min_desde_open}min + restante ${tempoRestante}min = ${tempoTotal}min`);
  }

  // ── Nada disparou → vai pro Claude
  return { decision: "SEM_RESERVA", rule_triggered: "C4_PENDING", motivo: "...", ... };
}
```

**O que importa nesse desenho:**
- Cada `if` é uma linha. Dá pra ler pro Billy/Chalela em 30 segundos.
- Thresholds num objeto único no topo — ajuste rápido.
- IDs de peças críticas num `Set` — lookup O(1).
- Output sempre tem `rule_triggered` — o que disparou é parte do contrato.

---

## 6. A query ClickHouse — o que ela faz e por quê

Arquivo: `src/app/api/os/route.ts` (a string `OS_QUERY`).

A query é grande mas estruturada em **CTEs nomeadas**. Cada CTE responde uma pergunta:

| CTE | O que retorna | Pergunta que responde |
|---|---|---|
| `item_skill` | mapa `item_group_id → skill_level (1-7)` | Quão difícil é essa peça? |
| `os_meta` | dados da OS (status, timestamps, flags do checklist) | O que é essa OS? |
| `mecanico_atual` | nome do mecânico de IN_PROGRESS | Quem está trabalhando? |
| `pecas_diag` | contagem, tempo estimado, complexidade max | O que o diag disse? |
| `estoque` | qty disponível por (item_group_id, location_id) | O que tem em estoque? |
| `sem_estoque` | quais peças da OS estão em falta | Falta alguma peça? |
| `pecas_criticas_nomes` | string com nomes das peças críticas | Quais peças críticas? |
| `is_piso` | OSs cujo cliente está no piso hoje | Cliente está aqui? |

E um `SELECT` final faz `LEFT JOIN` de tudo num único resultado por OS.

**Decisões de query que valem mencionar:**

1. **`FINAL` em todas as tabelas:** ClickHouse com ReplacingMergeTree precisa de `FINAL` pra pegar a versão mais recente de cada linha. Sem isso vêm duplicatas.

2. **`_peerdb_is_deleted = 0`** em todo lado: como o sync via PeerDB usa soft delete, é preciso filtrar manualmente.

3. **Janela temporal:** `toDate(so.created_at) >= toDate(now()) - 1` — só OSs dos últimos 2 dias. Sem isso a query varre meses.

4. **`is_piso` via `maestro_scheduler_r.checkin`** com `checkin_type = 'MAINTENANCE'` e `called_at IS NOT NULL` e `status NOT IN ('NO_SHOW', 'CANCELLED', 'DROPOUT')`. Esse foi o conjunto de filtros que bateu 1:1 com o que o líder considera "piso".

5. **Estoque agregado por `(item_group_id, location_id)`:** essencial garantir que o estoque verificado é da MESMA base da OS. Inicialmente eu só agrupava por `item_group_id` e dava falso positivo (peça existia em Osasco, OS em Mooca).

6. **Depósitos:** filtrar `d.type IN ('STORAGE', 'STAGING')` e excluir `MAINTENANCE` (que só tem bateria, polui o resultado).

---

## 7. A camada Claude — quando, o que e como

### Quando o Claude é chamado

Só quando **as duas** condições batem:
1. `is_piso === 1` (cliente fisicamente na oficina)
2. `rule_triggered === "C4_PENDING"` (nenhuma regra disparou)

Resto não vai pro Claude. Custo controlado.

### O que ele recebe

Além dos dados da OS, recebe o **estado atual da oficina na mesma base**:

```json
{
  "mecanicos_em_os": 8,
  "tempo_medio_restante_min": 35,
  "outras_os_aguardando_mec": 2
}
```

Calculado no frontend a partir das outras OSs já carregadas. Sem chamada extra.

### O prompt (essência)

```
Você é um assistente de decisão da oficina Vammo.

Uma OS acabou de entrar em AWAITING_MECHANIC. O algoritmo determinístico já verificou:
- Não está imobilizada, sem acidente, sem guincho
- Todas peças têm estoque
- Nenhuma peça crítica
- <9 tipos de peça
- Estimado ≤120min, total ≤180min

Mesmo assim, pode haver motivo pra reserva.

DADOS DA OS: ...
ESTADO DA OFICINA: ...

CRITÉRIO: recomende reserva se o conjunto de fatores indicar que a moto
não ficará pronta a tempo (meta: 3h desde abertura).
Considere especialmente:
1. Apontamento do CX (texto livre) — pode revelar problemas não capturados
2. Demanda da oficina — mesmo OS simples pode atrasar se há fila

Responda APENAS JSON: {"decision": "RESERVA"|"SEM_RESERVA", "motivo": "1 frase PT-BR"}
```

### Por que esse prompt funciona

- **Contexto explícito do que JÁ FOI VERIFICADO** evita o Claude repetir checagem
- **Critério único e claro** (meta 3h) ancora a decisão
- **Lista de sinais sutis** (apontamento CX, fila) direciona o foco
- **Output JSON estrito** com 2 campos só — parse trivial
- **`max_tokens: 150`** força resposta curta = barata

### O parse defensivo

Claude às vezes embrulha em markdown ` ```json ... ``` `. Strip antes do parse:
```typescript
const jsonText = content.text.replace(/```json\n?|\n?```/g, "").trim();
const result = JSON.parse(jsonText);
```

---

## 8. Frontend pattern — auto-refresh + Claude assíncrono

`src/app/page.tsx` faz duas coisas que valem destacar:

### 1. Refresh a cada 60s sem flicker

```typescript
useEffect(() => {
  buscarOS();
  const interval = setInterval(buscarOS, 60_000);
  return () => clearInterval(interval);
}, []);
```

Os dados são substituídos no estado, mas como o React reconcilia por `key={os.os_id}`, as linhas que não mudaram nem re-renderizam.

### 2. Claude rodando em paralelo, atualizando linha por linha

Depois que `/api/os` responde, o frontend identifica todos os `C4_PENDING` e dispara `POST /api/recommendation` **em paralelo**, sem await sequencial:

```typescript
pendentes.forEach(async (os) => {
  const r = await fetch("/api/recommendation", {...});
  const resultado = await r.json();
  // atualiza só essa OS no estado, não refaz fetch inteiro
  setOsList(prev => prev.map(item =>
    item.os_id === os.os_id
      ? { ...item, recomendacao: { ...item.recomendacao!, ...resultado } }
      : item
  ));
});
```

UX resultante: tabela aparece instantânea com regras determinísticas, e os badges "pending" viram resultado do Claude um por um conforme respondem (~1s cada).

---

## 9. Deploy

### Variáveis de ambiente (Vercel)

| Variável | Onde | Pra quê |
|---|---|---|
| `CLICKHOUSE_HOST` | Vercel env | URL HTTPS do ClickHouse Cloud |
| `CLICKHOUSE_USER` | Vercel env | Usuário read-only |
| `CLICKHOUSE_PASSWORD` | Vercel env | Senha do read-only |
| `ANTHROPIC_API_KEY` | Vercel env | Chave da API Claude |

### next.config.ts

```typescript
const nextConfig: NextConfig = {
  typescript: { ignoreBuildErrors: true },
};
```

Pragmatismo — algumas vezes o type-check trava deploy por coisa boba (campo que existe em runtime mas não na interface). Em ambiente interno, prefiro o deploy passar e corrigir depois.

### Pipeline

`git push origin master` → Vercel detecta → build 1-2min → live. Sem CI/CD custom.

---

## 10. Lições aprendidas (bugs que aconteceram)

| Bug | Causa | Lição |
|---|---|---|
| Algoritmo nunca disparava C3_TEMPO_COMBINADO | `min_desde_open` faltava na interface `AlgoritmoInput` — virou `undefined` em runtime | Toda mudança de query precisa atualizar interface TS |
| `ReservaBadge` mostrava "—" pra tudo exceto AWAITING_MECHANIC | Gate antigo que ninguém removeu | Refactor frequente — código antigo vira armadilha |
| OS quase pronta recebia reserva errada | C3_TEMPO_COMBINADO usava `tempo_estimado_min` total | Pra IN_PROGRESS usar tempo RESTANTE, não total |
| Claude girando spinner eterno em erro | `if (!r.ok) return;` sem atualizar estado | Sempre setar estado de erro explícito |
| Status PAUSED / AWAITING_VMGMT não avaliados | Set `STATUSES_AVALIAVEIS` desatualizado | Adicionar novo status: 3 lugares pra mudar (query, set, UI labels) |

---

## 11. Como replicar esse padrão pra outro caso

Se outro time tec quer fazer algo parecido (tomar decisão operacional em tempo real com dado do ClickHouse + LLM no fim), o template seria:

1. **Listar os casos de decisão reais** (peguei 101 OS do líder Victor). Sem isso você cai no over-engineering.
2. **Categorizar por motivo** — quanto é regra clara? quanto é cinza?
3. **Escrever a query ClickHouse primeiro** — uma linha por entidade, com TODOS os campos que você pode vir a precisar
4. **Escrever interface TS espelhando a query** — contrato
5. **Algoritmo em camadas no TS** — cada motivo claro vira uma camada
6. **LLM como fallback** — só pros casos que não viraram regra
7. **UI minimalista** — tabela + modal/painel de detalhe. Auto-refresh.
8. **Deploy Vercel + env vars do ClickHouse + Anthropic** — não custa nada
9. **Validar contra decisões reais** antes de chamar de pronto
10. **Loop de feedback** (Supabase): salvar decisão do operador pra calibrar threshold depois

---

## 12. O que ficou pra próxima fase

- **Supabase feedback loop**: já tem `@supabase/supabase-js` no `package.json` e os botões de "Confirmar / Não reservar" no modal. Falta criar `/api/feedback/route.ts` e ligar.
- **Calibrar thresholds com Billy/Chalela** com dado real de aceite/rejeição
- **Camada 4-6 determinística** antes do Claude (mecânicos disponíveis no turno + backlog da rampa)
- **Histórico de recomendações** pra validação semanal de acurácia

---

**Contato:** alvaro@vammo.com
