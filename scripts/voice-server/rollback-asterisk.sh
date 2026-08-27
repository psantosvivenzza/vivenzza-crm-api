#!/usr/bin/env bash
# Restaura /etc/asterisk a partir de um snapshot criado por backup-asterisk.sh.
# Sempre pede confirmação explícita antes de sobrescrever a config atual —
# nunca roda silenciosamente.
#
# Uso:
#   ./rollback-asterisk.sh --list                # lista snapshots disponíveis
#   sudo ./rollback-asterisk.sh <TIMESTAMP>       # restaura um snapshot específico
set -euo pipefail

ASTERISK_ETC="${VOICE_ASTERISK_ETC:-/etc/asterisk}"
BACKUP_DIR="${VOICE_BACKUP_DIR:-$HOME/vivenzza-voice-backups}"

if [ "${1:-}" = "--list" ] || [ "${1:-}" = "" ]; then
  echo "Snapshots disponíveis em $BACKUP_DIR:"
  ls -1t "$BACKUP_DIR"/asterisk-*.tar.gz 2>/dev/null | sed -E 's#.*/asterisk-(.*)\.tar\.gz#  \1#' || echo "  (nenhum)"
  echo ""
  echo "Uso: sudo $0 <TIMESTAMP>"
  exit 0
fi

TIMESTAMP="$1"
ORIGEM="$BACKUP_DIR/asterisk-$TIMESTAMP.tar.gz"

if [ ! -f "$ORIGEM" ]; then
  echo "Snapshot não encontrado: $ORIGEM" >&2
  echo "Rode '$0 --list' para ver os disponíveis." >&2
  exit 1
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "Precisa rodar como root para restaurar em $ASTERISK_ETC (sudo). Nada foi alterado." >&2
  exit 1
fi

echo "ATENÇÃO: isto vai SUBSTITUIR o conteúdo atual de $ASTERISK_ETC pelo snapshot de $TIMESTAMP."
echo "A config atual (antes deste rollback) NÃO é automaticamente salva — rode backup-asterisk.sh antes se quiser preservá-la."
read -r -p "Digite CONFIRMO para prosseguir: " resposta
if [ "$resposta" != "CONFIRMO" ]; then
  echo "Cancelado — nada foi alterado."
  exit 1
fi

PRE_ROLLBACK_DIR="$(dirname "${BASH_SOURCE[0]}")"
"$PRE_ROLLBACK_DIR/backup-asterisk.sh" || echo "AVISO: backup pré-rollback falhou, prosseguindo mesmo assim conforme confirmado."

rm -rf "${ASTERISK_ETC:?}"/*
tar -xzf "$ORIGEM" -C "$(dirname "$ASTERISK_ETC")"

systemctl restart asterisk
echo "Rollback para $TIMESTAMP concluído. Validando..."
"$PRE_ROLLBACK_DIR/validar-voice-server.sh" || echo "AVISO: validação pós-rollback encontrou problemas — ver saída acima."
