#!/usr/bin/env bash
# Snapshot completo de /etc/asterisk antes de qualquer alteração. Gravado
# FORA do repositório de propósito (nunca no Git — pode conter senha em
# texto plano de config real). Seguro rodar quantas vezes quiser: cada
# chamada cria um snapshot novo, timestamped, nunca sobrescreve o anterior.
set -euo pipefail

ASTERISK_ETC="${VOICE_ASTERISK_ETC:-/etc/asterisk}"
BACKUP_DIR="${VOICE_BACKUP_DIR:-$HOME/vivenzza-voice-backups}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
DESTINO="$BACKUP_DIR/asterisk-$TIMESTAMP.tar.gz"

if [ "$(id -u)" -ne 0 ]; then
  echo "Precisa rodar como root para ler todos os arquivos de $ASTERISK_ETC (sudo). Nada foi copiado." >&2
  exit 1
fi

if [ ! -d "$ASTERISK_ETC" ]; then
  echo "$ASTERISK_ETC não existe — nada para backupear." >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
tar -czf "$DESTINO" -C "$(dirname "$ASTERISK_ETC")" "$(basename "$ASTERISK_ETC")"
chmod 600 "$DESTINO"

echo "Backup criado: $DESTINO"
echo "Para restaurar: $(dirname "${BASH_SOURCE[0]}")/rollback-asterisk.sh $TIMESTAMP"

# Mantém só os últimos 20 snapshots — evita crescer sem limite num servidor
# que roda o instalador repetidas vezes ao longo do tempo. `|| true` no
# mapfile: com poucos snapshots (nada para limpar), o process substitution
# vazio pode retornar status != 0, o que com `set -e` derrubaria o script
# inteiro mesmo já com o backup concluído com sucesso — achado real ao
# testar (ver histórico do PR).
mapfile -t antigos < <(ls -1t "$BACKUP_DIR"/asterisk-*.tar.gz 2>/dev/null | tail -n +21) || true
for f in "${antigos[@]:-}"; do
  [ -n "$f" ] && rm -f "$f"
done

# `exit 0` explícito: sem isto, o status de saída do script é o do ÚLTIMO
# comando executado — se o loop acima terminar num `[ -n "$f" ]` falso
# (nenhum backup antigo pra remover, caso comum), o script inteiro reportava
# falha mesmo com o backup já concluído com sucesso — achado real ao testar.
exit 0
