# Runbook — Pipeline de deploy (ISSUE-34)

En cada push a `main`: `CI` corre (lint/typecheck/build/test). Si pasa, `Deploy`
construye la imagen, la publica en GHCR y la despliega al VPS. Si el health check
post-deploy falla, el deploy falla.

## Secretos del repositorio (Settings → Secrets and variables → Actions)

| Secreto           | Valor                                                     |
| ----------------- | -------------------------------------------------------- |
| `SSH_HOST`        | IP o dominio del VPS                                      |
| `SSH_USER`        | `deploy` (el usuario creado por provision.sh, ISSUE-33)  |
| `SSH_PRIVATE_KEY` | clave privada SSH cuyo par público autorizó provision.sh |
| `SSH_PORT`        | `22` (o el puerto configurado)                           |

`GITHUB_TOKEN` es automático (permiso `packages: write` declarado en el workflow).

## Preparación del VPS (una vez)

1. Provisionar el VPS con `provision.sh` (ISSUE-33) — deja Docker + usuario `deploy`.
2. Clonar el repo en `/home/deploy/piensa-backend` (o copiar `docker-compose.prod.yml`,
   `docker/caddy/Caddyfile`, `.env.prod`).
3. Crear `.env.prod` (ISSUE-31) con permisos 600 y el `SITE_ADDRESS` real.
4. DNS: registro A del dominio → IP del VPS (para el cert de Caddy).
5. Primer arranque manual para validar el stack (ISSUE-31 runbook), luego los
   deploys automáticos solo hacen `pull` + `up -d`.

## Flujo automático

Push a `main` → `CI` verde → `Deploy`:

1. Build de la imagen y push a `ghcr.io/<owner>/piensa-backend:<sha>` + `:latest`.
2. SSH al VPS → `deploy-remote.sh`: `docker login ghcr.io` → `docker compose pull` →
   `up -d --no-build` (el servicio `migrate` aplica `prisma migrate deploy` antes de
   `api`) → health check contra Caddy.
3. Si el health check no responde `{"status":"ok"}`, el job **falla** (deploy no exitoso).

## Verificar un deploy

- GitHub → Actions → run de `Deploy` en verde.
- GitHub → Packages → tag del SHA recién publicado.
- En el VPS: `curl -s https://<dominio>/api/v1/health` → `{"data":{"status":"ok"}}`.
- `docker compose -f docker-compose.prod.yml --env-file .env.prod ps` → `migrate` exited(0), `api` healthy.

## Rollback

```bash
# En el VPS, desplegar un SHA anterior conocido:
cd /home/deploy/piensa-backend
./scripts/deploy-remote.sh ghcr.io/<owner>/piensa-backend:<sha-anterior>
```

Las migraciones de Prisma son forward-only: un rollback de imagen que requiera
revertir schema necesita una migración de reversión dedicada (no bajar el schema
a mano). Ante duda, restaurar desde backup (ISSUE-32).

## Prueba end-to-end del criterio de aceptación

Un cambio trivial (p. ej. un comentario) commiteado a `main`:

1. `CI` pasa → `Deploy` arranca (verificar en Actions).
2. Imagen publicada con el nuevo SHA (verificar en Packages).
3. `curl https://<dominio>/api/v1/health` responde OK tras el run.

Si se rompe un test a propósito, `CI` falla y `Deploy` **no** se dispara — nada
llega a producción.
