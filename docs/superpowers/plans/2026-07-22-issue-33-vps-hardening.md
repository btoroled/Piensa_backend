# ISSUE-33 — Hardening del VPS · Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un script idempotente de aprovisionamiento (`provision.sh`) y un runbook que dejan un VPS Ubuntu limpio endurecido: firewall (ufw: solo 22 con rate-limit, 80, 443), SSH solo por llave y sin login de root, `unattended-upgrades`, `fail2ban` para SSH y Docker instalado — con cada ítem del checklist verificable por comando.

**Architecture:** `provision.sh` es un script POSIX/bash idempotente (re-ejecutable sin efectos duplicados): cada bloque comprueba el estado antes de actuar y usa drop-ins de configuración (`/etc/ssh/sshd_config.d/`, `/etc/apt/apt.conf.d/`, `/etc/fail2ban/jail.d/`) en vez de editar archivos base. Se valida en tres capas: `shellcheck` (estático), una pasada en un contenedor Ubuntu con systemd (`jrei/systemd-ubuntu`) para las partes apt/paquetes e idempotencia, y el runbook `vps-setup.md` que ejecuta el checklist final sobre el VPS real (las piezas que requieren kernel/red real: ufw activo, fail2ban con jail vivo).

**Tech Stack:** Bash, Ubuntu 24.04 LTS, `ufw`, OpenSSH, `unattended-upgrades`, `fail2ban`, Docker Engine + Compose plugin.

## Global Constraints

- **Idempotencia obligatoria:** `provision.sh` debe poder correrse N veces sin romper ni duplicar reglas/config. Cada acción va precedida de una comprobación de estado.
- **Elegir siempre lo más seguro** (memoria, spec §6): default-deny en el firewall; `PermitRootLogin no`; `PasswordAuthentication no`; SSH solo por llave; fail2ban activo; actualizaciones de seguridad automáticas.
- **No auto-bloquearse:** el script **no** debe cortar la sesión SSH del operador. Antes de habilitar ufw debe permitir el puerto SSH; antes de desactivar password auth, debe existir ya una llave autorizada. El runbook advierte de esto explícitamente.
- **Objetivo:** Ubuntu 24.04 LTS (o 22.04). Documentar la versión asumida.
- **Verificabilidad (criterio de aceptación):** cada ítem del runbook tiene su comando de verificación y salida esperada.
- **Formatear antes de commitear** (memoria): `npm run format && npm run lint` deja `.sh`/`.md` conformes a prettier (o listarlos en `.prettierignore` si prettier los deforma); correr `shellcheck` sobre el script.

---

## File Structure

- `provision.sh` — script idempotente de aprovisionamiento del VPS.
- `docs/runbooks/vps-setup.md` — runbook: prerrequisitos, ejecución, y checklist verificable ítem por ítem.

**Interfaces producidas (las consume ISSUE-34):**
- Un VPS con Docker + Compose instalados y un usuario de deploy sin root con acceso SSH por llave — destino del pipeline de deploy.
- `provision.sh` acepta la variable `DEPLOY_USER` (default `deploy`) para el nombre del usuario de despliegue.

---

### Task 1: `provision.sh` idempotente

**Files:**
- Create: `provision.sh`

**Interfaces:**
- Consumes: variables opcionales `DEPLOY_USER` (default `deploy`), `SSH_PORT` (default `22`), `DEPLOY_PUBKEY` (clave pública a autorizar; si vacía, avisa y no toca `authorized_keys`).
- Produces: firewall activo (default-deny, 22 rate-limited, 80, 443), SSH endurecido, `unattended-upgrades`, `fail2ban` (jail sshd), Docker + usuario de deploy en el grupo `docker`.

- [ ] **Step 1: Escribir el encabezado y los helpers idempotentes**

Crear `provision.sh` empezando por:

```bash
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
```

- [ ] **Step 2: Bloque de paquetes (idempotente vía apt)**

Agregar:

```bash
log "Actualizando índices e instalando paquetes base"
apt-get update -y
# apt-get install es idempotente: no reinstala lo ya presente.
apt-get install -y ufw fail2ban unattended-upgrades ca-certificates curl gnupg
```

- [ ] **Step 3: Usuario de deploy sin root + su llave SSH**

Agregar:

```bash
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
    echo "${DEPLOY_PUBKEY}" >> "${AK}"
  fi
  chown "${DEPLOY_USER}:${DEPLOY_USER}" "${AK}"
  chmod 600 "${AK}"
else
  warn "DEPLOY_PUBKEY vacío: no se autorizó ninguna llave. Configúrala antes de desactivar el login por password."
fi
```

- [ ] **Step 4: Endurecer SSH vía drop-in (no toca sshd_config base)**

Agregar:

```bash
log "Endureciendo SSH (drop-in)"
install -d -m 755 /etc/ssh/sshd_config.d
cat > /etc/ssh/sshd_config.d/60-piensa-hardening.conf <<EOF
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
```

- [ ] **Step 5: Firewall ufw (default-deny, SSH rate-limited, 80/443)**

Agregar:

```bash
log "Configurando firewall ufw"
ufw --force reset >/dev/null      # reset + re-declarar = estado determinista e idempotente
ufw default deny incoming
ufw default allow outgoing
ufw limit "${SSH_PORT}/tcp"       # rate-limit anti fuerza bruta en SSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
```

Nota: `ufw --force reset` seguido de re-declaración hace el bloque idempotente sin acumular reglas duplicadas. `limit` en SSH bloquea temporalmente IPs con demasiados intentos de conexión.

- [ ] **Step 6: unattended-upgrades (actualizaciones de seguridad automáticas)**

Agregar:

```bash
log "Habilitando actualizaciones de seguridad automáticas"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true
```

- [ ] **Step 7: fail2ban (jail sshd) vía jail.d**

Agregar:

```bash
log "Configurando fail2ban para SSH"
install -d -m 755 /etc/fail2ban/jail.d
cat > /etc/fail2ban/jail.d/piensa-sshd.conf <<EOF
[sshd]
enabled = true
port    = ${SSH_PORT}
maxretry = 5
bantime = 1h
findtime = 10m
EOF
systemctl enable --now fail2ban >/dev/null 2>&1 || true
systemctl restart fail2ban 2>/dev/null || true
```

- [ ] **Step 8: Docker Engine + Compose plugin + usuario en grupo docker**

Agregar:

```bash
log "Instalando Docker Engine + Compose plugin"
if ! command -v docker >/dev/null 2>&1; then
  install -d -m 755 /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker >/dev/null 2>&1 || true
# Permite al usuario de deploy usar docker sin sudo (idempotente).
usermod -aG docker "${DEPLOY_USER}"

log "Aprovisionamiento completo. Verifica con docs/runbooks/vps-setup.md"
```

- [ ] **Step 9: Verificar con shellcheck**

Run: `shellcheck provision.sh`
Expected: sin errores.

- [ ] **Step 10: Commit**

```bash
chmod +x provision.sh
git add provision.sh
git commit -m "feat(infra): script idempotente de hardening del VPS (ISSUE-33)"
```

---

### Task 2: Verificación en contenedor systemd + idempotencia

Las piezas que dependen del kernel/red (ufw activo, fail2ban con jail cargado) se verifican sobre el VPS real (runbook, Task 3). Aquí se valida en local todo lo que un contenedor con systemd sí permite: instalación de paquetes, creación de usuario, drop-ins de SSH, y **que correr el script dos veces no rompe** (idempotencia).

**Files:**
- (ninguno nuevo; verificación con Docker)

**Interfaces:**
- Consumes: `provision.sh` de Task 1.

- [ ] **Step 1: Levantar un contenedor Ubuntu con systemd**

Run:
```bash
docker run -d --name piensa-vps-test --privileged \
  --tmpfs /run --tmpfs /run/lock -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
  --cgroupns=host jrei/systemd-ubuntu:24.04
sleep 5 && docker exec piensa-vps-test systemctl is-system-running --wait || true
```
Expected: el contenedor arranca con systemd (estado `running` o `degraded`, ambos sirven para la prueba).

- [ ] **Step 2: Copiar y ejecutar `provision.sh` (primera pasada)**

Run:
```bash
docker cp provision.sh piensa-vps-test:/root/provision.sh
docker exec -e DEPLOY_PUBKEY="ssh-ed25519 AAAATESTKEY operador-test" \
  piensa-vps-test bash /root/provision.sh
```
Expected: corre hasta `Aprovisionamiento completo`. Nota: `ufw --force enable` dentro de un contenedor sin módulos de iptables del host puede advertir; no debe abortar el script (los pasos siguientes continúan). Si `ufw enable` aborta en el contenedor, es esperable — la verificación real de ufw es en el VPS (Task 3).

- [ ] **Step 3: Verificar los efectos comprobables en contenedor**

Run:
```bash
docker exec piensa-vps-test bash -c '
  id deploy &&
  test -f /home/deploy/.ssh/authorized_keys && echo "authorized_keys OK" &&
  grep -q "PermitRootLogin no" /etc/ssh/sshd_config.d/60-piensa-hardening.conf && echo "ssh drop-in OK" &&
  test -f /etc/apt/apt.conf.d/20auto-upgrades && echo "auto-upgrades OK" &&
  test -f /etc/fail2ban/jail.d/piensa-sshd.conf && echo "fail2ban jail OK" &&
  command -v docker && echo "docker instalado" &&
  id -nG deploy | grep -qw docker && echo "deploy en grupo docker"
'
```
Expected: imprime `authorized_keys OK`, `ssh drop-in OK`, `auto-upgrades OK`, `fail2ban jail OK`, la ruta de `docker`, y `deploy en grupo docker`.

- [ ] **Step 4: Segunda pasada — idempotencia**

Run:
```bash
docker exec -e DEPLOY_PUBKEY="ssh-ed25519 AAAATESTKEY operador-test" \
  piensa-vps-test bash /root/provision.sh
docker exec piensa-vps-test bash -c \
  'grep -c "AAAATESTKEY" /home/deploy/.ssh/authorized_keys'
```
Expected: la segunda ejecución termina sin error y `authorized_keys` contiene la llave **una sola vez** (`1`) — confirma idempotencia (sin duplicados).

- [ ] **Step 5: Limpiar el contenedor de prueba**

Run: `docker rm -f piensa-vps-test`
Expected: contenedor eliminado. (No hay commit en esta task; es verificación.)

---

### Task 3: Runbook `vps-setup.md` con checklist verificable

**Files:**
- Create: `docs/runbooks/vps-setup.md`

**Interfaces:**
- Consumes: `provision.sh`.
- Produces: procedimiento y checklist 100% verificable sobre el VPS real.

- [ ] **Step 1: Escribir el runbook**

Contenido de `docs/runbooks/vps-setup.md`:

````markdown
# Runbook — Aprovisionamiento y hardening del VPS (ISSUE-33)

Objetivo: Ubuntu 24.04 LTS limpio → firewall default-deny, SSH solo por llave y
sin root, actualizaciones de seguridad automáticas, fail2ban y Docker.

## ⚠️ Antes de empezar (para no auto-bloquearse)
- Ten tu **clave pública SSH** lista (`ssh-ed25519 ...`). El script la autoriza en
  el usuario `deploy`. Si `DEPLOY_PUBKEY` va vacío, NO se desactiva el password
  auth hasta que autorices una llave manualmente — de lo contrario perderías el acceso.
- Ejecuta primero con acceso de consola del proveedor disponible (por si algo falla).

## Ejecutar
```bash
# En el VPS, como root (o con sudo -E para conservar las variables):
DEPLOY_PUBKEY="ssh-ed25519 AAAA... tu-operador" \
  DEPLOY_USER=deploy SSH_PORT=22 \
  sudo -E bash provision.sh
```
Re-ejecutable las veces que haga falta (idempotente).

## Checklist de verificación (cada ítem con su comando y salida esperada)

- [ ] **Firewall activo y default-deny**
  ```bash
  sudo ufw status verbose
  ```
  Esperado: `Status: active`; `Default: deny (incoming), allow (outgoing)`;
  reglas `22/tcp LIMIT`, `80/tcp ALLOW`, `443/tcp ALLOW`.

- [ ] **SSH sin root y sin password**
  ```bash
  sudo sshd -T | grep -E '^(permitrootlogin|passwordauthentication) '
  ```
  Esperado: `permitrootlogin no` y `passwordauthentication no`.

- [ ] **Login por llave funciona (probar en una sesión NUEVA sin cerrar la actual)**
  ```bash
  ssh deploy@<IP>    # debe entrar con la llave, sin pedir password
  ```

- [ ] **unattended-upgrades habilitado**
  ```bash
  systemctl is-enabled unattended-upgrades; cat /etc/apt/apt.conf.d/20auto-upgrades
  ```
  Esperado: `enabled`; ambas líneas `"1"`.

- [ ] **fail2ban activo con jail sshd**
  ```bash
  sudo fail2ban-client status sshd
  ```
  Esperado: muestra el jail `sshd` (Currently failed / banned), sin error.

- [ ] **Docker + Compose y deploy sin sudo**
  ```bash
  docker --version && docker compose version
  sudo -u deploy docker ps        # debe funcionar (deploy en grupo docker)
  ```
  Esperado: versiones impresas; `docker ps` corre como `deploy` sin sudo.

## Notas
- El servicio SSH puede llamarse `ssh` o `sshd` según la versión; el script recarga
  el que exista.
- Si cambiaste `SSH_PORT`, abre ese puerto en el panel del proveedor y ajusta el
  cliente (`ssh -p <puerto>`), además del `ufw limit`.
````

- [ ] **Step 2: Verificar formato y commit**

Run: `npm run format && npm run lint`
Expected: en verde.

```bash
git add docs/runbooks/vps-setup.md
git commit -m "docs(infra): runbook de setup y hardening del VPS (ISSUE-33)"
```

---

## Self-Review

- **Criterio de aceptación** ("ejecutado sobre un VPS limpio deja el checklist del runbook 100% verificable, cada ítem con su comando de verificación y salida esperada") → runbook Task 3 con 6 ítems verificables.
- **Idempotencia** → helpers de comprobación en cada bloque + verificación explícita de no-duplicado en Task 2 Step 4.
- **ufw (22 limit, 80, 443, default-deny)** → Task 1 Step 5.
- **SSH por llave, sin root** → Task 1 Steps 3–4.
- **unattended-upgrades** → Task 1 Step 6.
- **fail2ban SSH** → Task 1 Step 7.
- **Docker instalado** → Task 1 Step 8.
- **No auto-bloqueo** → Global Constraints + advertencia del runbook + `sshd -t` antes de recargar + `ufw limit` (no `deny`) en SSH.
- **Sin placeholders**: script completo y ejecutable; los valores del operador (pubkey, puerto) son parámetros documentados.
