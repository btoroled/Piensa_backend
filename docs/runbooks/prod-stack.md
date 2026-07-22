# Runbook — Stack de producción (ISSUE-31)

Stack: Caddy (TLS, único con puertos 80/443) → API (Fastify, no root) →
PostgreSQL (red interna, sin puertos). Migraciones vía servicio `migrate`.

## Prerrequisitos en el VPS

- Docker + Docker Compose (los instala `provision.sh`, ISSUE-33).
- DNS: un registro A del dominio apuntando a la IP del VPS (necesario para que
  Caddy obtenga el certificado por ACME).
- `.env.prod` presente en el directorio del proyecto, con permisos 600.

## Configurar secretos

```bash
cp .env.prod.example .env.prod
chmod 600 .env.prod
# Editar .env.prod:
#  - SITE_ADDRESS = dominio real (p. ej. api.piensa.org)
#  - POSTGRES_PASSWORD y el password embebido en DATABASE_URL: mismo valor fuerte
#  - JWT_SECRET = openssl rand -base64 48
#  - R2_*        = credenciales de Cloudflare R2
```

## Levantar / actualizar

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
docker compose -f docker-compose.prod.yml --env-file .env.prod ps
```

`migrate` debe quedar en `exited (0)` antes de que `api` arranque.

## Verificar

```bash
# Salud a través de Caddy (con dominio real ya no hace falta -k):
curl -s https://$SITE_ADDRESS/api/v1/health   # -> {"data":{"status":"ok"}}

# PostgreSQL NO alcanzable desde el host (prueba autoritativa: sin binding):
docker compose -f docker-compose.prod.yml --env-file .env.prod port postgres 5432
#   -> sin mapeo 0.0.0.0:...->5432 (a lo sumo "invalid IP:0")
docker inspect piensa-postgres-prod --format '{{json .NetworkSettings.Ports}}'
#   -> {"5432/tcp":null}   (null = no publicado al host)
```

> No uses `nc localhost 5432` como prueba de aislamiento: da falso positivo si el
> host ya corre otro Postgres (p. ej. Homebrew) ocupando ese puerto.

## Ver logs / bajar

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod logs -f api
docker compose -f docker-compose.prod.yml --env-file .env.prod down   # conserva el volumen de datos
```

`down` sin `-v` conserva `piensa_pgdata_prod`. **Nunca** usar `-v` en el VPS:
borra la base de datos.

## Prueba local del stack (sin VPS)

Idéntico pero con `SITE_ADDRESS=localhost`; verificar con `curl -sk https://localhost/api/v1/health`
(Caddy usa su CA interna en local, de ahí el `-k`).
