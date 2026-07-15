# scripts/ — calibração e análise

Scripts rodados **localmente** (não em produção) para calibrar os modelos e medir a acurácia do RIVERS. Servem de trilha de reprodutibilidade: qualquer número dos relatórios sai de um destes.

## Pré-requisitos

- **`.env.local`** na raiz do repo (mesmas credenciais do app — Supabase + ClickHouse). Nunca é commitado.
- **Exports do Metabase** em `$METABASE_DIR` (padrão: `./data`). Os scripts leem JSONs exportados do ClickHouse via Metabase. Defina o diretório com:
  ```bash
  export METABASE_DIR=/caminho/para/os/exports   # ou deixe em ./data
  ```

## Scripts

| Script | O que faz | Entrada → Saída |
|---|---|---|
| `calibra-tempo.mjs` | Calibra os minutos-por-peça via **regressão não-negativa (NNLS)** e valida out-of-sample | exports de treino → `src/lib/tempo-pecas.ts` + `calib/tempo-calibracao-*.json` |
| `cross-analysis.mjs` | Cruzamento completo RIVERS × Oficina (Maestro) × desfecho real | log Supabase + `rivers-cross-*.json` → `calib/cross-dashboard.json` |
| `cross-weekly.mjs` | Comparativo semana atual × semana anterior | idem → stdout |
| `excessos.mjs` | Isola os "excessos" (só-RIVERS que ficaram prontas <3h) com o que o algoritmo estimou | → `calib/excessos.json` |
| `excessos-merge.mjs` | Junta excessos + peças trocadas + tempo real de execução | → `calib/excessos-detalhe.csv` |
| `pordia-acordo.mjs` | Quebra diária das sugestões em "os dois" vs "só RIVERS" | → stdout |
| `md2pdf.py` / `md2html.py` | Convertem os docs `.md` em PDF / HTML estilizado | `docs/*.md` → PDF / HTML |

## Rodar

```bash
node scripts/cross-analysis.mjs
node scripts/calibra-tempo.mjs
python scripts/md2pdf.py docs/RIVERS-CONCEITOS.md
```
