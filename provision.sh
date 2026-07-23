#!/usr/bin/env bash
# Aprovisionamiento idempotente de un VPS Ubuntu para Piensa (Spec §3, §6, ISSUE-33).
# Re-ejecutable: cada bloque comprueba el estado antes de actuar.
# Uso (como root o con sudo):
#   DEPLOY_PUBKEY="ssh-ed25519 AAAA... operador" sudo -E bash provision.sh
set -euo pipefail

DEPLOY_USER="${DEPLOY_USER:-deploy}"
SSH_PORT="${SSH_PORT:-22}"
DEPLOY_PUBKEY="${DEPLOY_PUBKEY:-}"

log() { printf '\033[1;32m[provision]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[provision]\033[0m %s\n' "$*" >&2; }

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "Debe ejecutarse como root (usa sudo)." >&2
    exit 1
  fi
}
require_root
export DEBIAN_FRONTEND=noninteractive

log "Actualizando índices e instalando paquetes base"
apt-get update -y
# apt-get install es idempotente: no reinstala lo ya presente.
apt-get install -y ufw fail2ban unattended-upgrades ca-certificates curl gnupg

log "Asegurando usuario de deploy: ${DEPLOY_USER}"
if ! id -u "${DEPLOY_USER}" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "${DEPLOY_USER}"
fi
usermod -aG sudo "${DEPLOY_USER}"

if [ -n "${DEPLOY_PUBKEY}" ]; then
  install -d -m 700 -o "${DEPLOY_USER}" -g "${DEPLOY_USER}" "/home/${DEPLOY_USER}/.ssh"
  AK="/home/${DEPLOY_USER}/.ssh/authorized_keys"
  touch "${AK}"
  # Idempotente: agrega la llave solo si no está ya.
  if ! grep -qF "${DEPLOY_PUBKEY}" "${AK}"; then
    echo "${DEPLOY_PUBKEY}" >>"${AK}"
  fi
  chown "${DEPLOY_USER}:${DEPLOY_USER}" "${AK}"
  chmod 600 "${AK}"
else
  warn "DEPLOY_PUBKEY vacío: no se autorizó ninguna llave. Configúrala antes de desactivar el login por password."
fi

log "Endureciendo SSH (drop-in)"
install -d -m 755 /etc/ssh/sshd_config.d
cat >/etc/ssh/sshd_config.d/60-piensa-hardening.conf <<EOF
# Gestionado por provision.sh (ISSUE-33). No editar a mano.
Port ${SSH_PORT}
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
PubkeyAuthentication yes
X11Forwarding no
MaxAuthTries 3
EOF
# Validar la config antes de recargar; si falla, no recargar (evita cortarse).
if sshd -t; then
  systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
else
  warn "sshd -t falló: revisa la config, no se recargó SSH."
fi

log "Configurando firewall ufw"
ufw --force reset >/dev/null # reset + re-declarar = estado determinista e idempotente
ufw default deny incoming
ufw default allow outgoing
ufw limit "${SSH_PORT}/tcp" # rate-limit anti fuerza bruta en SSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

log "Habilitando actualizaciones de seguridad automáticas"
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true

log "Configurando fail2ban para SSH"
install -d -m 755 /etc/fail2ban/jail.d
cat >/etc/fail2ban/jail.d/piensa-sshd.conf <<EOF
[sshd]
enabled = true
port    = ${SSH_PORT}
maxretry = 5
bantime = 1h
findtime = 10m
EOF
systemctl enable --now fail2ban >/dev/null 2>&1 || true
systemctl restart fail2ban 2>/dev/null || true

log "Instalando Docker Engine + Compose plugin"
if ! command -v docker >/dev/null 2>&1; then
  install -d -m 755 /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg |
    gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  # /etc/os-release solo existe en el VPS (runtime); define VERSION_CODENAME.
  # shellcheck source=/dev/null
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    >/etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker >/dev/null 2>&1 || true
# Permite al usuario de deploy usar docker sin sudo (idempotente).
usermod -aG docker "${DEPLOY_USER}"

log "Aprovisionamiento completo. Verifica con docs/runbooks/vps-setup.md"
