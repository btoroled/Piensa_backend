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
- Recién ingresado al grupo `docker`, el usuario `deploy` debe reabrir su sesión SSH
  (o `newgrp docker`) para que el grupo tenga efecto en la shell interactiva.
