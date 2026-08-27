#!/usr/bin/env bash
# Health check do servidor de voz — 100% leitura, nunca altera nada, nunca
# origina chamada. Roda como usuário normal (algumas checagens ficam
# "sem permissão" sem sudo — não é erro fatal, só reportado como tal).
# Saída: 0 se tudo essencial passou, 1 se algo essencial falhou.
set -uo pipefail

ASTERISK_ETC="${VOICE_ASTERISK_ETC:-/etc/asterisk}"
FALHAS=0

check() {
  local descricao="$1"; shift
  if "$@" >/dev/null 2>&1; then
    echo "  [OK] $descricao"
  else
    echo "  [FALHOU] $descricao"
    FALHAS=$((FALHAS + 1))
  fi
}
info() { echo "  [info] $1"; }

echo "== Serviço =="
check "asterisk instalado (dpkg)" dpkg -s asterisk
check "serviço systemd ativo" systemctl is-active --quiet asterisk
check "serviço systemd habilitado no boot" systemctl is-enabled --quiet asterisk

echo "== Portas =="
if command -v ss >/dev/null 2>&1; then
  ss -tuln 2>/dev/null | grep -q ':8088 ' && echo "  [OK] ARI HTTP (8088) escutando" || { echo "  [FALHOU] ARI HTTP (8088) não está escutando"; FALHAS=$((FALHAS + 1)); }
  ss -tuln 2>/dev/null | grep -q '5060 ' && echo "  [OK] SIP (5060/udp) escutando" || { echo "  [FALHOU] SIP (5060/udp) não está escutando"; FALHAS=$((FALHAS + 1)); }
  ARI_BIND="$(ss -tuln 2>/dev/null | awk '/:8088/{print $5}' | head -1)"
  if [ -n "$ARI_BIND" ]; then
    case "$ARI_BIND" in
      127.0.0.1:*) echo "  [OK] ARI só em loopback ($ARI_BIND)" ;;
      *) echo "  [ALERTA] ARI escutando em $ARI_BIND — deveria ser só 127.0.0.1, nunca exposto na rede"; FALHAS=$((FALHAS + 1)) ;;
    esac
  fi
else
  info "'ss' não disponível — checagem de portas pulada"
fi

echo "== Config aplicada =="
for f in ari.conf http.conf pjsip.conf extensions.conf; do
  if [ -f "$ASTERISK_ETC/$f" ]; then
    echo "  [OK] $f presente"
  else
    echo "  [FALHOU] $f ausente em $ASTERISK_ETC"
    FALHAS=$((FALHAS + 1))
  fi
done
if [ -f "$ASTERISK_ETC/mobile.conf" ]; then
  info "mobile.conf presente (Bluetooth/celular já configurado)"
else
  info "mobile.conf ausente — esperado até um aparelho real ser pareado (ver preparar-bluetooth-celular.md)"
fi

echo "== CLI Asterisk (precisa de sudo/grupo asterisk — sem isso, apenas informativo) =="
if asterisk -rx "core show version" >/dev/null 2>&1; then
  asterisk -rx "core show version" | sed 's/^/  [info] /'
  echo "  [info] endpoints PJSIP:"
  asterisk -rx "pjsip show endpoints" 2>/dev/null | sed 's/^/  [info]   /'
else
  info "sem acesso ao console do Asterisk (rode com sudo para checar endpoints/canais em detalhe)"
fi

echo "== Logs recentes (últimas 20 linhas, só leitura) =="
if [ -r /var/log/asterisk/full ]; then
  tail -20 /var/log/asterisk/full | sed 's/^/  [log] /'
else
  info "/var/log/asterisk/full não legível sem sudo"
fi

echo ""
if [ "$FALHAS" -eq 0 ]; then
  echo "Validação: TUDO OK ($FALHAS falha(s) essencial(is))."
  exit 0
else
  echo "Validação: $FALHAS falha(s) essencial(is) encontrada(s) — ver acima."
  exit 1
fi
