# Vammo Reserva — Sistema de Recomendação de Reserva

App web para líderes de turno da oficina Vammo decidirem se um cliente em piso deve receber moto reserva.

## O Problema

O líder de turno olhava o Retool e decidia reserva no feeling — geralmente tarde, depois que o cliente já estava horas esperando. Este app decide **logo após o diagnóstico** (≈15min de OS), antes da moto entrar na rampa.

## Como Funciona

```
ClickHouse (dados ao vivo) → Algoritmo C1-C3 (regras determinísticas) → Claude Haiku (casos ambíguos)
```

### Algoritmo em Camadas

Primeira camada que disparar vence:

| Camada | Regra | Resultado |
|--------|-------|-----------|
| C1_HARD | Moto imobilizada, acidente, guincho, vistoria de seguro | RESERVA |
| C1_ANOMALIA | OS aberta há >4h antes do diag fechar | RESERVA |
| C2_SEM_ESTOQUE | Alguma peça do diag sem estoque na base | RESERVA |
| C3_PECA_CRITICA | Motor, balança, caixa de direção, chassi, garfo | RESERVA |
| C3_DIVERSAS_AVARIAS | 9+ tipos de peça diferentes | RESERVA |
| C3_TEMPO_ALTO | Trabalho estimado >120min | RESERVA |
| C3_TEMPO_COMBINADO | Tempo já esperado + estimado >180min | RESERVA |
| C4_PENDING | Nenhuma regra disparou → Claude decide | RESERVA ou SEM_RESERVA |

### Claude (Camada 4)

OS que passam por C1-C3 sem disparar nenhuma regra vão pro Claude Haiku. O modelo recebe:
- Dados da OS (peças, complexidade, tempo, apontamento do CX)
- Estado atual da oficina (mecânicos em OS, tempo médio restante, fila)

Claude raciocina sobre sinais sutis: apontamento do CX preocupante, oficina sobrecarregada, combinações de peças incomuns.

## Estrutura do Projeto

```
src/
├── app/
│   ├── page.tsx                    # UI principal (tabela + painel de detalhe)
│   └── api/
│       ├── os/route.ts             # GET /api/os — busca OS ativas no ClickHouse
│       └── recommendation/route.ts # POST /api/recommendation — chama Claude
├── lib/
│   ├── clickhouse.ts               # Helper de query pro ClickHouse
│   └── algorithm.ts                # Algoritmo C1-C3 (TypeScript puro)
└── types/
    └── index.ts                    # Interfaces compartilhadas (Recomendacao, etc.)
```

## Stack

- **Next.js 15** (App Router) — framework full-stack
- **Tailwind CSS** — estilização
- **ClickHouse Cloud** — banco de dados (read-only, via HTTPS API)
- **Anthropic Claude Haiku** — LLM para casos ambíguos (C4+)
- **Vercel** — deploy (planejado)

## Variáveis de Ambiente

Copiar `.env.local.example` para `.env.local` e preencher:

```env
CLICKHOUSE_HOST=https://<host>:8443
CLICKHOUSE_USER=<usuario>
CLICKHOUSE_PASSWORD=<senha>
ANTHROPIC_API_KEY=sk-ant-...
```

**Nunca commitar `.env.local`** — está no `.gitignore`.

## Rodando Localmente

```bash
npm install
npm run dev
```

Abre em [http://localhost:3000](http://localhost:3000).

## Dados ao Vivo

O app busca OS ativas das bases **Mooca** (location_id=1), **Osasco** (location_id=34) e **São Bernardo** (location_id=166).

Mostra apenas OS de clientes **em piso** (fisicamente na oficina), detectados via `maestro_scheduler_r.checkin` com `checkin_type = 'MAINTENANCE'` e `called_at IS NOT NULL`.

### Campos da Query Principal (`/api/os`)

| Campo | Fonte | O que é |
|-------|-------|---------|
| `status_atual` | `oms_r.so_status` | Status atual da OS |
| `min_desde_open` | `oms_r.so` | Minutos desde abertura da OS |
| `min_no_status` | `oms_r.so_status` | Minutos no status atual |
| `tempo_estimado_min` | `ims_r.item_group.time_target` | Soma dos tempos das peças + 12min buffer |
| `complexidade_max` | item_skill CTE | Nível 1-7 da peça mais complexa do diag |
| `n_sem_estoque` | `ims_r.inventory` | Peças do diag sem estoque disponível |
| `is_piso` | `maestro_scheduler_r.checkin` | 1 = cliente fisicamente no piso |

### Estoque

Consulta depósitos `STORAGE` e `STAGING` — exclui `MAINTENANCE` (que só tem baterias). Agrupa por `item_group_id` e `location_id` para garantir que o estoque verificado é da mesma base da OS.

## Thresholds do Algoritmo

Definidos em `src/lib/algorithm.ts`:

```typescript
const THRESHOLDS = {
  anomalia_min: 240,        // 4h sem entrar na oficina = anomalia
  diversas_avarias: 9,      // 9+ tipos de peça = diversas avarias
  tempo_estimado_max: 120,  // >2h estimado = RESERVA
  tempo_total_max: 180,     // espera + estimado >3h = RESERVA
};
```

Peças críticas que disparam RESERVA imediata (C3):
`Motor (257-260), Balança (184, 357), Caixa de direção (250, 308, 340, 359), Chassi (296), Garfo (240)`

## Estado da Oficina (Contexto para o Claude)

Calculado no frontend em tempo real a partir das OS carregadas:

```typescript
oficina_estado: {
  mecanicos_em_os: number,           // OS com status IN_PROGRESS na mesma base
  tempo_medio_restante_min: number,  // média de (estimado - tempo_no_status) das IN_PROGRESS
  outras_os_aguardando_mec: number,  // outras AWAITING_MECHANIC na mesma base
}
```

Limitação: tão fresco quanto o último refresh da página (não há polling automático). PeerDB tem ~5min de lag.

## Próximos Passos

- [ ] Auto-refresh periódico (ex: a cada 2min)
- [ ] Supabase: salvar feedback do shift leader (confirmou / não confirmou reserva)
- [ ] Deploy Vercel + configuração de env vars
- [ ] Fase 4: fechar loop de aprendizado com dados reais de decisão

## Calibração (11/05/2026)

Thresholds validados contra 865 OS reais. Análise de 101 sugestões reais do líder Victor:

| Motivo real | % | Regra |
|-------------|---|-------|
| Peça em falta | 38% | C2_SEM_ESTOQUE |
| Diversas avarias / complexidade | 22% | C3_DIVERSAS_AVARIAS |
| Ocupação da oficina | 16% | C4 (Claude) |
| Peça complexa | 14% | C3_PECA_CRITICA |
| Anomalia de fluxo | 6% | C1_ANOMALIA |
