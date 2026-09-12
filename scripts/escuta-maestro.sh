#!/usr/bin/env bash
# Escuta o Worker ate pegar a primeira tentativa de POST pro Maestro.
#
# Por que em pedacos e com reconexao: uma sessao de `wrangler tail` cai sozinha depois de
# um tempo, e a janela util aqui e o dia inteiro de oficina (o cron roda das 7h as 21h).
# Cada pedaco escuta por ate 15 min; se nada aparecer, reconecta e continua.
#
# Sai no primeiro `[maestro]` que aparecer, que e o que responde a pergunta:
#   "[maestro] so_id=X ... 404 sem check-in ativo"  -> esta mandando, o dev nao conhece a OS
#   "[maestro] so_id=X ... -> applied"              -> funcionou de verdade
#   "[maestro] ... falhou: HTTP 401"                -> token
#
# Uso: bash scripts/escuta-maestro.sh [minutos]   (default: ate as 21h)
set -u
cd "$(dirname "$0")/.." || exit 1
[ -d /c/rivers-build ] && cd /c/rivers-build

MIN=${1:-0}
if [ "$MIN" -gt 0 ]; then
  FIM=$(( $(date +%s) + MIN * 60 ))
else
  # ate as 21h de Sao Paulo (o servidor roda em UTC-0 aqui, entao 21h SP = 00h UTC)
  FIM=$(( $(date +%s) + 3 * 3600 ))
fi

HIT=$(mktemp)
CICLO=0
echo "[escuta] ate $(date -d "@$FIM" +%H:%M 2>/dev/null || echo "+3h") · procurando linhas [maestro]"

while [ "$(date +%s)" -lt "$FIM" ]; do
  CICLO=$((CICLO + 1))
  timeout 900 npx wrangler tail --format pretty 2>/dev/null \
    | grep -iE "\[maestro\]|suggest-reserve" \
    | head -8 > "$HIT"
  if [ -s "$HIT" ]; then
    echo ""
    echo ">>> PEGOU (ciclo $CICLO, $(date +%H:%M))"
    cat "$HIT"
    rm -f "$HIT"
    exit 0
  fi
  echo "  ciclo $CICLO sem nenhuma tentativa ate $(date +%H:%M) · reconectando"
done

rm -f "$HIT"
echo ""
echo "[escuta] janela encerrada sem nenhuma tentativa de POST."
echo "  Se houve moto elegivel nesse periodo, o problema esta ANTES do POST (filtro do passo 6b)."
echo "  Se nao houve, e so a oficina vazia: nada a concluir."
