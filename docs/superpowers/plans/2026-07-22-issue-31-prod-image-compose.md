# ISSUE-31 — Imagen de producción y compose del VPS · Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Empaquetar la API en una imagen de producción reproducible (multi-stage, usuario no root) y levantar el stack del VPS con `docker-compose.prod.yml`: Caddy (único servicio con puertos publicados, HTTPS automático), la API y PostgreSQL confinado a la red interna de Docker.

**Architecture:** Imagen Docker multi-stage sobre `node:24-slim`: un stage `builder` que instala dependencias y compila TS a `dist/`, y un stage `runtime` con solo dependencias de producción, el cliente Prisma regenerado y un usuario sin privilegios. `docker-compose.prod.yml` orquesta cuatro servicios en una red interna: `postgres` (sin puertos publicados, volumen persistente), `migrate` (one-shot que corre `prisma migrate deploy` y termina), `api` (arranca tras la migración) y `caddy` (reverse proxy con 80/443 publicados, headers de seguridad). Los secretos llegan por `env_file` (`.env.prod`, permisos 600). Se prueba de punta a punta en local; el despliegue real al VPS es un paso manual documentado en un runbook.

**Tech Stack:** Docker (multi-stage), Docker Compose, Caddy 2, PostgreSQL 17-alpine, Node.js 24, Prisma 6, Fastify 5.

## Global Constraints

- **Stack (spec §2):** Node.js 24 · TypeScript · Fastify 5 · Prisma 6 · PostgreSQL 17 · Docker Compose. Copiar versiones exactas de las imágenes ya usadas: `postgres:17-alpine`, Node `24` (de `.nvmrc`).
- **Seguridad (spec §6, memoria "elegir siempre lo más seguro"):** el contenedor de la API corre como usuario no root; PostgreSQL **no publica puertos** al host; solo Caddy publica 80/443; secretos en `.env.prod` con permisos 600, nunca en la imagen ni en el repo.
- **API surface existente:** el servidor ya escucha en `host: "0.0.0.0"` y `env.PORT` (`src/server.ts`); health check en `GET /api/v1/health` (`src/app.ts` registra `healthRoutes` con prefijo `/api/v1`). El build sale a `dist/` (`tsconfig.build.json`) y `npm start` = `node dist/server.js`.
- **Errores/formato:** no aplica lógica de API nueva; este issue son artefactos de infra. Igual: `npm run lint` y `npm run typecheck` deben quedar en verde (el CI los corre).
- **Formatear antes de commitear** (memoria): correr `npm run format` antes de cada commit; el CI falla si `prettier --check` no pasa. Los `.yml`, `Dockerfile`, `Caddyfile` y `.md` entran en el chequeo de prettier salvo que estén en `.prettierignore` — verificar con `npm run lint` antes de cada commit y, si prettier reformatea, incluir el cambio.

---

## File Structure

- `Dockerfile` — imagen multi-stage de la API (builder → runtime no root).
- `.dockerignore` — excluye `node_modules`, `dist`, `.env*`, `.git`, tests, del contexto de build.
- `docker-compose.prod.yml` — stack de producción: `postgres`, `migrate`, `api`, `caddy`.
- `docker/caddy/Caddyfile` — reverse proxy a `api:3000`, HTTPS automático, headers de seguridad, dominio por variable `SITE_ADDRESS`.
- `.env.prod.example` — plantilla de variables de producción (copiar a `.env.prod`, permisos 600).
- `package.json` — mover `prisma` (CLI) de `devDependencies` a `dependencies` para que `prisma migrate deploy` y `prisma generate` existan en la imagen de runtime.
- `docs/runbooks/prod-stack.md` — runbook: cómo levantar/verificar el stack en local y cómo se despliega al VPS.

**Interfaces producidas (las consumen ISSUE-32 y ISSUE-34):**
- Imagen construible con `docker build -t piensa-backend:local .` cuyo `CMD` es `node dist/server.js`.
- `docker-compose.prod.yml` con servicios nombrados `postgres`, `migrate`, `api`, `caddy`, red interna por defecto del proyecto compose, volumen `piensa_pgdata_prod`.
- Variable `SITE_ADDRESS` (dominio o `localhost`) leída por el `Caddyfile`.
- La API dentro de la red compose es alcanzable como `api:3000`; PostgreSQL como `postgres:5432`.

---

### Task 1: Imagen multi-stage de la API

**Files:**
- Create: `.dockerignore`
- Create: `Dockerfile`
- Modify: `package.json` (mover `prisma` a `dependencies`)

**Interfaces:**
- Consumes: scripts `build` (`tsc -p tsconfig.build.json`) y `start` (`node dist/server.js`) ya existentes; `prisma/schema.prisma` + `prisma/migrations/`.
- Produces: imagen `piensa-backend:local`, usuario `node` (no root), `WORKDIR /app`, cliente Prisma generado en runtime, `CMD ["node", "dist/server.js"]`.

- [ ] **Step 1: Escribir `.dockerignore`**

Evita meter basura y secretos en el contexto de build (más rápido y más seguro).

```gitignore
node_modules
dist
.git
.github
.env
.env.*
!.env.prod.example
!.env.example
npm-debug.log
coverage
*.md
docs
tests
docker-compose*.yml
.vscode
.idea
```

- [ ] **Step 2: Mover el CLI de Prisma a dependencias de producción**

`prisma migrate deploy` (servicio `migrate`) y `prisma generate` (stage runtime) necesitan el CLI dentro de la imagen slim, que solo instala `dependencies`. Editar `package.json`: quitar `"prisma": "^6.19.3"` de `devDependencies` y agregarlo a `dependencies` (junto a `@prisma/client`). Mantener el mismo rango de versión.

Verificar tras editar:

Run: `node -e "const p=require('./package.json'); console.log('dep prisma:', p.dependencies.prisma, '| devDep prisma:', p.devDependencies && p.devDependencies.prisma)"`
Expected: `dep prisma: ^6.19.3 | devDep prisma: undefined`

- [ ] **Step 3: Reinstalar y confirmar que nada se rompe**

Run: `npm install && npm run lint && npm run typecheck && npm test`
Expected: `package-lock.json` actualizado, lint/typecheck/tests en verde (mover un paquete de dev a prod no cambia el árbol resuelto).

- [ ] **Step 4: Escribir el `Dockerfile` multi-stage**

```dockerfile
# Imagen de producción de la API (Spec §3). Multi-stage: `builder` compila TS y
# genera el cliente Prisma; `runtime` queda con solo dependencias de producción
# y corre como usuario no root. Base debian-slim: el engine por defecto de
# Prisma (debian-openssl-3.0.x) funciona sin configurar binaryTargets.

# --- Stage 1: build ---
FROM node:24-slim AS builder
WORKDIR /app

# Instala TODAS las dependencias (incluye devDeps: typescript, tsc) de forma
# reproducible a partir del lockfile.
COPY package.json package-lock.json ./
RUN npm ci

# Genera el cliente Prisma (necesita el schema) y compila TypeScript a dist/.
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# --- Stage 2: runtime ---
FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Solo dependencias de producción (incluye el CLI prisma, movido a deps).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Regenera el cliente Prisma contra el node_modules de producción y deja el
# schema + migraciones disponibles para `prisma migrate deploy` en el deploy.
COPY prisma ./prisma
RUN npx prisma generate

# Artefactos compilados desde el builder.
COPY --from=builder /app/dist ./dist

# El usuario `node` (uid 1000) ya viene en la imagen oficial: correr sin root.
USER node

EXPOSE 3000
CMD ["node", "dist/server.js"]
```

- [ ] **Step 5: Construir la imagen (verificación: falla si el Dockerfile está mal)**

Run: `docker build -t piensa-backend:local .`
Expected: build termina en `naming to docker.io/library/piensa-backend:local` sin errores; los stages `builder` y `runtime` se ejecutan.

- [ ] **Step 6: Verificar que corre como no root**

Run: `docker run --rm --entrypoint id piensa-backend:local`
Expected: `uid=1000(node) gid=1000(node) ...` (no `uid=0(root)`).

- [ ] **Step 7: Verificar que el binario arranca y falla limpio sin config**

El server debe terminar con mensaje claro (no stack) si falta `DATABASE_URL`/`JWT_SECRET` (comportamiento de `loadEnv`).

Run: `docker run --rm piensa-backend:local`
Expected: imprime `[config] Configuración de entorno inválida (...)` y el contenedor sale con código 1, sin stack trace.

- [ ] **Step 8: Commit**

```bash
git add Dockerfile .dockerignore package.json package-lock.json
git commit -m "feat(infra): imagen de producción multi-stage de la API (ISSUE-31)"
```

---

### Task 2: Stack de producción con Caddy y PostgreSQL aislado

**Files:**
- Create: `docker/caddy/Caddyfile`
- Create: `.env.prod.example`
- Create: `docker-compose.prod.yml`

**Interfaces:**
- Consumes: imagen construida en Task 1 (`build: .` en el servicio `api`/`migrate`); `GET /api/v1/health` para el healthcheck; variables de `.env.prod`.
- Produces: servicios `postgres`, `migrate`, `api`, `caddy`; volúmenes `piensa_pgdata_prod`, `caddy_data`, `caddy_config`; variable `SITE_ADDRESS`.

- [ ] **Step 1: Escribir el `Caddyfile`**

```caddy
# Reverse proxy TLS del stack de producción (Spec §3, §6).
# SITE_ADDRESS define el dominio: en el VPS un dominio real (Caddy pide el
# certificado por ACME automáticamente); en local `localhost` (Caddy usa su CA
# interna). Único servicio con puertos publicados: 80 y 443.
{$SITE_ADDRESS:localhost} {
	encode zstd gzip

	# Headers de seguridad (Spec §6): HSTS, nosniff, frame-deny.
	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
		X-Content-Type-Options "nosniff"
		X-Frame-Options "DENY"
		Referrer-Policy "no-referrer"
		-Server
	}

	# La API escucha en el puerto 3000 dentro de la red interna de Docker.
	reverse_proxy api:3000
}
```

- [ ] **Step 2: Escribir `.env.prod.example`**

```dotenv
# Plantilla de variables de producción. Copiar a `.env.prod` en el VPS,
# rellenar con valores reales y fijar permisos 600 (chmod 600 .env.prod).
# NUNCA commitear `.env.prod`. El servidor no arranca si falta una requerida.

# Dominio público servido por Caddy. En el VPS: el dominio real (p. ej.
# api.piensa.org). En local para probar el stack: localhost.
SITE_ADDRESS=localhost

# --- PostgreSQL (servicio interno `postgres`) ---
POSTGRES_USER=piensa
POSTGRES_PASSWORD=cambia-esto-por-una-clave-larga-y-aleatoria
POSTGRES_DB=piensa_prod

# --- API ---
# Apunta al servicio interno `postgres`. Debe coincidir con las tres de arriba.
DATABASE_URL=postgresql://piensa:cambia-esto-por-una-clave-larga-y-aleatoria@postgres:5432/piensa_prod?schema=public
JWT_SECRET=genera-uno-con-openssl-rand-base64-48
NODE_ENV=production
PORT=3000

# --- Cloudflare R2 (subida de archivos, ISSUE-17) ---
R2_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com
R2_BUCKET=piensa
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_PUBLIC_BASE_URL=
```

- [ ] **Step 3: Escribir `docker-compose.prod.yml`**

```yaml
# Stack de producción del VPS (Spec §3). Levantar con:
#   docker compose -f docker-compose.prod.yml --env-file .env.prod up -d
# Solo Caddy publica puertos (80/443). PostgreSQL vive en la red interna de
# Docker, sin puertos al host. `migrate` corre las migraciones y termina antes
# de que arranque `api`.
services:
  postgres:
    image: postgres:17-alpine
    container_name: piensa-postgres-prod
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
    volumes:
      - piensa_pgdata_prod:/var/lib/postgresql/data
    # Sin `ports`: inalcanzable desde fuera de la red de Docker.
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}"]
      interval: 5s
      timeout: 5s
      retries: 5

  migrate:
    image: piensa-backend:local
    build: .
    env_file: .env.prod
    command: ["npx", "prisma", "migrate", "deploy"]
    depends_on:
      postgres:
        condition: service_healthy
    restart: "no"

  api:
    image: piensa-backend:local
    build: .
    container_name: piensa-api-prod
    restart: unless-stopped
    env_file: .env.prod
    expose:
      - "3000"
    depends_on:
      postgres:
        condition: service_healthy
      migrate:
        condition: service_completed_successfully
    healthcheck:
      test:
        [
          "CMD",
          "node",
          "-e",
          "fetch('http://127.0.0.1:3000/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
        ]
      interval: 10s
      timeout: 5s
      retries: 5

  caddy:
    image: caddy:2-alpine
    container_name: piensa-caddy-prod
    restart: unless-stopped
    environment:
      SITE_ADDRESS: ${SITE_ADDRESS}
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./docker/caddy/Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - api

volumes:
  piensa_pgdata_prod:
    name: piensa_pgdata_prod
  caddy_data:
  caddy_config:
```

- [ ] **Step 4: Preparar `.env.prod` local para la prueba**

Run: `cp .env.prod.example .env.prod && chmod 600 .env.prod`
Then edita `.env.prod`: pon un `JWT_SECRET` de al menos 16 chars (`openssl rand -base64 48`) y deja `SITE_ADDRESS=localhost`. (`DATABASE_URL` ya apunta a `postgres:5432` con las credenciales de ejemplo — coherentes entre sí para la prueba.)

- [ ] **Step 5: Levantar el stack completo (verificación end-to-end)**

Run: `docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build`
Then: `docker compose -f docker-compose.prod.yml ps`
Expected: `postgres` healthy, `migrate` `exited (0)`, `api` running/healthy, `caddy` running.

- [ ] **Step 6: Verificar el health check a través de Caddy**

Run: `curl -sk https://localhost/api/v1/health`
Expected: `{"data":{"status":"ok"}}` (Caddy sirve HTTPS con su CA interna; `-k` acepta ese cert en local).

- [ ] **Step 7: Verificar que PostgreSQL NO es alcanzable desde el host (criterio de aceptación)**

La prueba autoritativa es que Docker no publicó ningún puerto del servicio `postgres`
(no depende de qué más corra en el host):

Run: `docker compose -f docker-compose.prod.yml --env-file .env.prod port postgres 5432; echo "exit=$?"`
Expected: no imprime ningún mapeo `0.0.0.0:...->5432` (a lo sumo `invalid IP:0`) — el servicio no publica 5432.

Run: `docker inspect piensa-postgres-prod --format '{{json .NetworkSettings.Ports}}'`
Expected: `{"5432/tcp":null}` — `null` = sin binding al host. `docker ps` lo muestra como `5432/tcp` (expuesto en la red de Docker), nunca `0.0.0.0:5432->5432/tcp` (publicado).

> **No uses `nc -z localhost 5432` como prueba de aislamiento.** Da falso positivo si
> el host ya corre otro Postgres (p. ej. `postgresql@16/@17` de Homebrew ocupando 5432):
> `nc` conectaría a ese servicio ajeno, no al contenedor. Los dos comandos de arriba son
> los que prueban el criterio de forma fiable.

- [ ] **Step 8: Bajar el stack y limpiar el `.env.prod` de prueba**

Run: `docker compose -f docker-compose.prod.yml --env-file .env.prod down -v && rm -f .env.prod`
Expected: contenedores y volúmenes de prueba eliminados; `.env.prod` (con el secreto de prueba) borrado. `.env.prod` ya está cubierto por `.dockerignore` y por `.gitignore` (`.env.*`), así que nunca se commitea.

- [ ] **Step 9: Verificar formato y commit**

Run: `npm run format && npm run lint`
Expected: prettier no deja cambios pendientes; lint en verde.

```bash
git add docker/caddy/Caddyfile .env.prod.example docker-compose.prod.yml
git commit -m "feat(infra): stack de producción con Caddy y PostgreSQL aislado (ISSUE-31)"
```

---

### Task 3: Runbook del stack de producción

**Files:**
- Create: `docs/runbooks/prod-stack.md`

**Interfaces:**
- Consumes: todo lo anterior (imagen, compose, Caddyfile, `.env.prod`).
- Produces: procedimiento documentado y verificable (lo consume ISSUE-34 como destino del deploy).

- [ ] **Step 1: Escribir el runbook**

Contenido de `docs/runbooks/prod-stack.md` (Markdown), con estas secciones y comandos exactos:

````markdown
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
docker compose -f docker-compose.prod.yml ps
```
`migrate` debe quedar en `exited (0)` antes de que `api` arranque.

## Verificar
```bash
# Salud a través de Caddy (con dominio real ya no hace falta -k):
curl -s https://$SITE_ADDRESS/api/v1/health   # -> {"data":{"status":"ok"}}

# PostgreSQL NO alcanzable desde el host:
docker compose -f docker-compose.prod.yml port postgres 5432   # -> sin salida
```

## Ver logs / bajar
```bash
docker compose -f docker-compose.prod.yml logs -f api
docker compose -f docker-compose.prod.yml down          # conserva el volumen de datos
```
`down` sin `-v` conserva `piensa_pgdata_prod`. **Nunca** usar `-v` en el VPS:
borra la base de datos.

## Prueba local del stack (sin VPS)
Idéntico pero con `SITE_ADDRESS=localhost`; verificar con `curl -sk https://localhost/api/v1/health`.
````

- [ ] **Step 2: Verificar formato y commit**

Run: `npm run format && npm run lint`
Expected: en verde.

```bash
git add docs/runbooks/prod-stack.md
git commit -m "docs(infra): runbook del stack de producción (ISSUE-31)"
```

---

## Self-Review

- **Criterio de aceptación** ("`docker compose -f docker-compose.prod.yml up` local sirve la API detrás de Caddy; el puerto de PostgreSQL no es alcanzable desde fuera de la red de Docker, test manual documentado") → cubierto por Task 2 Steps 5–7 y el runbook (Task 3).
- **Multi-stage + no root** → Task 1 Steps 4, 6.
- **Caddy HTTPS + headers de seguridad** → Task 2 Step 1 (`Caddyfile`).
- **Migraciones en producción** → servicio `migrate` (Task 2 Step 3) con `prisma` movido a deps (Task 1 Step 2); lo reusa el deploy de ISSUE-34.
- **Sin placeholders**: todos los artefactos tienen contenido real; los únicos valores a rellenar por el operador (dominio, passwords, R2) están en `.env.prod.example`/runbook, que es su lugar correcto.
