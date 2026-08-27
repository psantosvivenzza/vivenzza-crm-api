#!/usr/bin/env bash
# Instalador do lado Linux (nativo ou dentro do WSL) do servidor de voz.
# IDEMPOTENTE: rodar de novo numa máquina já instalada só valida e reporta —
# nunca sobrescreve um /etc/asterisk já customizado sem --force explícito.
# Precisa rodar como root (sudo) — é quem grava em /etc/asterisk.
#
# Uso:
#   sudo ./instalar-asterisk.sh              # instala o que faltar, nunca sobrescreve config existente
#   sudo ./instalar-asterisk.sh --force       # além disso, faz backup e SUBSTITUI configs já existentes pelos templates
#   sudo ./instalar-asterisk.sh --dry-run     # só mostra o que faria, não muda nada
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CONFIG_SRC="$REPO_ROOT/config/asterisk"
ASTERISK_ETC="${VOICE_ASTERISK_ETC:-/etc/asterisk}"
FORCE=0
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    *) echo "Argumento desconhecido: $arg" >&2; exit 2 ;;
  esac
done

log() { echo "[instalar-asterisk] $*"; }
run() {
  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] $*"
  else
    "$@"
  fi
}

if [ "$DRY_RUN" = "0" ] && [ "$(id -u)" -ne 0 ]; then
  echo "Este instalador precisa rodar como root (sudo ./instalar-asterisk.sh). Nada foi alterado." >&2
  exit 1
fi

if [ ! -f /etc/os-release ]; then
  echo "Não foi possível detectar a distro (/etc/os-release ausente). Este instalador só cobre Debian/Ubuntu (apt). Nada foi alterado." >&2
  exit 1
fi
# shellcheck disable=SC1091
. /etc/os-release
case "${ID:-}:${ID_LIKE:-}" in
  ubuntu*|debian*|*:*debian*) : ;;
  *) echo "Distro '$ID' não é Debian/Ubuntu — este instalador usa apt-get e não é compatível. Nada foi alterado." >&2; exit 1 ;;
esac
log "Distro detectada: ${PRETTY_NAME:-$ID}"

log "== 1/6: pacote asterisk =="
if dpkg -s asterisk >/dev/null 2>&1; then
  log "asterisk já instalado ($(dpkg -s asterisk | awk -F': ' '/^Version/{print $2}')) — pulando apt install."
else
  log "instalando asterisk via apt..."
  run apt-get update -qq
  run apt-get install -y asterisk
fi

log "== 2/6: backup de $ASTERISK_ETC antes de qualquer alteração =="
if [ -d "$ASTERISK_ETC" ]; then
  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] $SCRIPT_DIR/backup-asterisk.sh"
  else
    "$SCRIPT_DIR/backup-asterisk.sh"
  fi
else
  log "$ASTERISK_ETC ainda não existe (instalação fresca do pacote deve criá-lo) — sem nada para backupear ainda."
fi

log "== 3/6: aplicar templates de $CONFIG_SRC =="
gerar_senha() { openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 32; }

aplicar_template() {
  local nome="$1"  # ex: pjsip.conf
  local origem="$CONFIG_SRC/${nome}.example"
  local destino="$ASTERISK_ETC/$nome"

  [ -f "$origem" ] || { log "AVISO: template $origem não existe — pulando $nome."; return 0; }

  if [ -f "$destino" ] && [ "$FORCE" != "1" ]; then
    log "$destino já existe — NÃO sobrescrito (rode com --force para substituir; um backup já foi feito no passo 2)."
    return 0
  fi

  log "gerando $destino a partir do template (senha aleatória, nunca logada)..."
  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] geraria $destino com senha própria substituindo o placeholder"
    return 0
  fi

  local senha
  senha="$(gerar_senha)"
  sed "s/SUBSTITUA_POR_SENHA_FORTE_GERADA_LOCALMENTE/${senha}/g" "$origem" > "$destino"
  chown asterisk:asterisk "$destino" 2>/dev/null || true
  chmod 640 "$destino"
  unset senha
}

aplicar_template "ari.conf"
aplicar_template "http.conf"
aplicar_template "pjsip.conf"
aplicar_template "extensions.conf"
# mobile.conf é deliberadamente NÃO aplicado aqui — camada plugável, ver
# preparar-bluetooth-celular.md. O operador copia manualmente quando o
# aparelho real existir.

log "== 4/6: recursos necessários (diretório de gravação) =="
REC_DIR="/var/spool/asterisk/recording"
if [ ! -d "$REC_DIR" ]; then
  log "criando $REC_DIR (não vem criado por padrão pelo pacote)..."
  run mkdir -p "$REC_DIR"
  run chown asterisk:asterisk "$REC_DIR"
else
  log "$REC_DIR já existe — pulando."
fi

log "== 5/6: serviço systemd (enable + restart, boot automático) =="
run systemctl enable asterisk
run systemctl restart asterisk

log "== 6/6: validação pós-instalação =="
if [ "$DRY_RUN" = "1" ]; then
  echo "[dry-run] $SCRIPT_DIR/validar-voice-server.sh"
else
  sleep 2
  "$SCRIPT_DIR/validar-voice-server.sh" || {
    echo "Validação pós-instalação falhou — ver saída acima. Rollback disponível: $SCRIPT_DIR/rollback-asterisk.sh" >&2
    exit 1
  }
fi

log "Instalação concluída. voice_external_enabled/TRUNK_EXTERNO_CONFIGURADO continuam FALSE (flags de aplicação, não tocadas por este instalador)."
