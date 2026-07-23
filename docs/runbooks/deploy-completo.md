# Runbook maestro — Despliegue de Piensa de cero a producción

Índice ejecutable del despliegue completo (Milestone 4). Cada fase enlaza al
runbook detallado con los comandos exactos y sus verificaciones.

> **Antes de ejecutar este plan**, los PRs de Milestone 4 deben estar en `main`
> (orden de merge: ISSUE-31 → ISSUE-32 → ISSUE-34; ISSUE-33 en cualquier momento).

## Prerrequisitos (una vez)

- VPS Ubuntu 24.04 LTS limpio, con acceso root o consola del proveedor.
- Un dominio y capacidad de crear un registro DNS A.
- Cuenta Cloudflare R2 con dos buckets: uno para uploads de la app, otro
  **dedicado** para backups.
- Un par de claves SSH (para el usuario `deploy`) y un par de claves `age`
  (para cifrar los backups; la privada se guarda **fuera** del VPS).

---

## Fase 1 — Endurecer el VPS

📄 Detalle: [`vps-setup.md`](./vps-setup.md) (ISSUE-33)

```bash
# En el VPS, como root:
DEPLOY_PUBKEY="ssh-ed25519 AAAA... tu-operador" \
  DEPLOY_USER=deploy SSH_PORT=22 \
  sudo -E bash provision.sh
```

Deja: firewall ufw (default-deny, SSH rate-limited, 80/443), SSH solo por llave y
sin root, fail2ban, unattended-upgrades, Docker + Compose, usuario `deploy`.

✅ **Verificar:** correr el checklist de `vps-setup.md` (ufw activo, `sshd -T` sin
root/password, `docker compose version`, `fail2ban-client status sshd`).

---

## Fase 2 — DNS

Crear un registro **A**: `api.tu-dominio` → IP del VPS.

✅ **Verificar:** `dig +short api.tu-dominio` devuelve la IP del VPS. Necesario
para que Caddy obtenga el certificado TLS por ACME en la Fase 3.

---

## Fase 3 — Primer arranque del stack de producción

📄 Detalle: [`prod-stack.md`](./prod-stack.md) (ISSUE-31)

```bash
# En el VPS, como usuario deploy:
git clone <repo> /home/deploy/piensa-backend
cd /home/deploy/piensa-backend
cp .env.prod.example .env.prod && chmod 600 .env.prod
# Editar .env.prod: SITE_ADDRESS (dominio real), POSTGRES_PASSWORD, JWT_SECRET
# (openssl rand -base64 48), credenciales R2.
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
```

Levanta Caddy (TLS, único con 80/443) → API (no root) → PostgreSQL (red interna,
sin puertos). El servicio `migrate` aplica las migraciones antes de que arranque `api`.

✅ **Verificar:**

- `curl -s https://$SITE_ADDRESS/api/v1/health` → `{"data":{"status":"ok"}}`.
- `docker inspect piensa-postgres-prod --format '{{json .NetworkSettings.Ports}}'`
  → `{"5432/tcp":null}` (Postgres no publicado al host).

---

## Fase 4 — Backups cifrados

📄 Detalle: [`restore.md`](./restore.md) (ISSUE-32)

1. Generar el par de claves `age` (privada fuera del VPS).
2. Crear el bucket R2 dedicado + lifecycle rule de **30 días**.
3. En el VPS:

```bash
cp .env.backup.example .env.backup && chmod 600 .env.backup   # completar AGE_RECIPIENT, R2, PG
docker compose -f docker-compose.backup.yml --env-file .env.backup up -d --build
```

Backup diario 03:00 UTC (`pg_dump | age | rclone` a R2).

✅ **Verificar:** un backup manual sube un objeto, **y una restauración de prueba
sobre una BD vacía arranca la API** (checklist de `restore.md` §5). Un backup no
probado no es un backup.

---

## Fase 5 — Deploy automático (CI/CD)

📄 Detalle: [`deploy.md`](./deploy.md) (ISSUE-34)

Configurar los secretos del repo (Settings → Secrets → Actions): `SSH_HOST`,
`SSH_USER` (`deploy`), `SSH_PRIVATE_KEY`, `SSH_PORT`.

A partir de acá el ciclo es automático:

```text
push a main → CI (lint/typecheck/build/test) → si verde → Deploy:
  build imagen → push a GHCR → ssh al VPS → pull → up -d (migraciones) → health check
```

Si `CI` falla, `Deploy` **no** se dispara. Si el health check post-deploy falla, el
deploy se marca fallido.

✅ **Verificar (criterio de aceptación de M4):** un cambio trivial en `main` llega
a producción solo tras `CI` verde; romper un test a propósito impide el deploy.

**Rollback:** en el VPS, `./scripts/deploy-remote.sh ghcr.io/<owner>/piensa-backend:<sha-anterior>`.
Migraciones forward-only: si hay que revertir schema, restaurar desde backup (Fase 4).

---

## Resumen de artefactos por fase

| Fase | Runbook              | Artefactos clave                                     |
| ---- | -------------------- | ---------------------------------------------------- |
| 1    | `vps-setup.md`       | `provision.sh`                                       |
| 3    | `prod-stack.md`      | `Dockerfile`, `docker-compose.prod.yml`, `Caddyfile` |
| 4    | `restore.md`         | `docker-compose.backup.yml`, `backup.sh`, `restore.sh` |
| 5    | `deploy.md`          | `.github/workflows/deploy.yml`, `deploy-remote.sh`   |
