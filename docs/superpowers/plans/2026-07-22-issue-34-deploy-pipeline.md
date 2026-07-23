# ISSUE-34 — Pipeline de deploy · Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** En cada push a `main`, **solo si los tests pasan**, construir la imagen de producción, publicarla en GHCR y desplegarla al VPS por SSH (pull + `docker compose up -d` + `prisma migrate deploy` + health check post-deploy); si el health check falla, el deploy falla y no se marca exitoso.

**Architecture:** El gate de tests es el workflow `CI` existente. Un nuevo workflow `deploy.yml` se dispara con `workflow_run` **solo cuando `CI` concluye en `success` sobre `main`** — así nada llega al VPS sin verde. El job construye la imagen desde el `Dockerfile` (ISSUE-31), la etiqueta con el SHA y `latest`, la publica en GHCR, y por SSH corre un script idempotente en el VPS (`scripts/deploy-remote.sh`) que hace `docker login ghcr.io`, `docker compose pull`, `up -d --no-build` (el servicio `migrate` aplica las migraciones antes de `api`) y un health check contra Caddy. `docker-compose.prod.yml` (ISSUE-31) se parametriza para tomar la imagen desde `API_IMAGE`, de modo que el VPS **tira** la imagen en vez de construirla. La parte build+push se prueba de verdad con un push a una rama; la parte SSH se verifica contra el VPS real vía runbook.

**Tech Stack:** GitHub Actions, GHCR (GitHub Container Registry), Docker Buildx, SSH, Docker Compose, Prisma migrate.

## Global Constraints

- **Nada al VPS sin verde** (spec §7): el deploy depende de que `CI` (lint + typecheck + build + test) pase. Se implementa con `workflow_run` filtrado a `conclusion == success` y `head_branch == main`.
- **Imagen privada en GHCR:** el paquete se publica privado; el VPS se autentica para tirarlo (token efímero del propio workflow).
- **Migraciones en el deploy:** el servicio `migrate` de `docker-compose.prod.yml` corre `prisma migrate deploy` y debe completar (`service_completed_successfully`) antes de que arranque `api` (ya definido en ISSUE-31).
- **Health check post-deploy obligatorio:** si `GET /api/v1/health` no responde OK tras el despliegue, el script sale con código ≠ 0 y el job falla.
- **Secretos del repo (GitHub Actions):** `SSH_HOST`, `SSH_USER`, `SSH_PRIVATE_KEY`, `SSH_PORT` (opcional). GHCR usa el `GITHUB_TOKEN` del workflow (permiso `packages: write`).
- **Idempotencia del deploy remoto:** re-ejecutar `deploy-remote.sh` con el mismo tag no rompe nada.
- **Formatear antes de commitear** (memoria): `npm run format && npm run lint` antes de cada commit.

---

## File Structure

- `docker-compose.prod.yml` — **modificar** (de ISSUE-31): `api` y `migrate` toman la imagen de `${API_IMAGE:-piensa-backend:local}`, conservando `build: .` para el uso local.
- `scripts/deploy-remote.sh` — script que corre EN el VPS: login GHCR, pull, `up -d --no-build`, espera health y verifica; idempotente.
- `.github/workflows/deploy.yml` — workflow: `workflow_run` sobre `CI` → build + push a GHCR → SSH al VPS ejecutando el script.
- `docs/runbooks/deploy.md` — runbook: secretos requeridos, primer despliegue, rollback, verificación.

**Interfaces consumidas:**
- De ISSUE-31: `Dockerfile`, `docker-compose.prod.yml` (servicios `migrate`/`api`/`caddy`), `.env.prod` en el VPS, `GET /api/v1/health`.
- De ISSUE-33: VPS con Docker + Compose y usuario `deploy` (SSH por llave, en grupo docker).
- Del repo: workflow `CI` (`name: CI` en `.github/workflows/ci.yml`).

**Interfaces producidas:**
- Imagen `ghcr.io/<owner>/<repo>:<sha>` y `:latest` (privada).
- Variable `API_IMAGE` que selecciona la imagen del compose de producción.

---

### Task 1: Parametrizar la imagen del compose + script de deploy remoto

**Files:**
- Modify: `docker-compose.prod.yml`
- Create: `scripts/deploy-remote.sh`

**Interfaces:**
- Consumes: servicios `api`/`migrate`/`caddy` de ISSUE-31; `.env.prod` en el VPS.
- Produces: `API_IMAGE` como selector de imagen; `deploy-remote.sh <image_ref>` idempotente.

- [ ] **Step 1: Parametrizar la imagen en `docker-compose.prod.yml`**

En los servicios `migrate` y `api`, cambiar la línea `image: piensa-backend:local` por `image: ${API_IMAGE:-piensa-backend:local}` (dejar `build: .` intacto). Así, sin `API_IMAGE`, se usa el build local (ISSUE-31 sigue funcionando); con `API_IMAGE` definido, se usa esa imagen.

Verificar con compose config. El directivo `env_file: .env.prod` de los servicios
exige que ese archivo exista (aunque `--env-file` alimente la interpolación), así
que se crea uno temporal para el chequeo:

Run:

```bash
cp .env.prod.example .env.prod && chmod 600 .env.prod
echo "con API_IMAGE:"
API_IMAGE=ghcr.io/acme/piensa-backend:abc123 docker compose -f docker-compose.prod.yml --env-file .env.prod config | grep -E "^    image:"
echo "sin API_IMAGE (fallback):"
docker compose -f docker-compose.prod.yml --env-file .env.prod config | grep -E "^    image:"
rm -f .env.prod
```

Expected: con `API_IMAGE`, `migrate` y `api` muestran `image: ghcr.io/acme/piensa-backend:abc123`
(junto a `postgres:17-alpine` y `caddy:2-alpine`); sin `API_IMAGE`, ambos resuelven a
`piensa-backend:local`.

- [ ] **Step 2: Escribir `scripts/deploy-remote.sh`**

```bash
#!/usr/bin/env bash
# Deploy remoto en el VPS (ISSUE-34). Se ejecuta EN el VPS por SSH desde el
# workflow. Idempotente: mismo tag re-ejecutado no rompe nada.
# Uso: deploy-remote.sh <image_ref> [ghcr_user] [ghcr_token]
#   <image_ref>  ghcr.io/<owner>/<repo>:<sha>
#   ghcr_user/ghcr_token  credenciales efímeras para tirar la imagen privada.
set -euo pipefail

IMAGE_REF="${1:?falta la referencia de imagen (ghcr.io/owner/repo:sha)}"
GHCR_USER="${2:-}"
GHCR_TOKEN="${3:-}"

# Directorio del proyecto en el VPS (ajustable por env).
APP_DIR="${APP_DIR:-/home/deploy/piensa-backend}"
COMPOSE="docker compose -f docker-compose.prod.yml --env-file .env.prod"

cd "${APP_DIR}"

if [ -n "${GHCR_TOKEN}" ]; then
  echo "${GHCR_TOKEN}" | docker login ghcr.io -u "${GHCR_USER}" --password-stdin
fi

export API_IMAGE="${IMAGE_REF}"

echo "[deploy] pull ${IMAGE_REF}"
${COMPOSE} pull api migrate

echo "[deploy] up -d (migrate corre migraciones antes de api)"
${COMPOSE} up -d --no-build

echo "[deploy] esperando a que api quede healthy..."
for i in $(seq 1 30); do
  status="$(${COMPOSE} ps api --format '{{.Health}}' 2>/dev/null || echo '')"
  if [ "${status}" = "healthy" ]; then break; fi
  sleep 3
done

echo "[deploy] health check post-deploy contra Caddy"
# -k: en local/staging Caddy usa CA interna; en prod con dominio real el cert es válido.
if ! curl -fsSk https://localhost/api/v1/health | grep -q '"status":"ok"'; then
  echo "[deploy] HEALTH CHECK FALLÓ — el deploy no se marca exitoso" >&2
  ${COMPOSE} logs --tail=50 api >&2 || true
  exit 1
fi

echo "[deploy] OK: ${IMAGE_REF} desplegado y sano"
docker image prune -f >/dev/null 2>&1 || true
```

- [ ] **Step 3: Verificar el script con shellcheck**

Run: `shellcheck scripts/deploy-remote.sh`
Expected: sin errores.

- [ ] **Step 4: Commit**

```bash
chmod +x scripts/deploy-remote.sh
git add docker-compose.prod.yml scripts/deploy-remote.sh
git commit -m "feat(deploy): imagen parametrizable y script de deploy remoto (ISSUE-34)"
```

---

### Task 2: Workflow de deploy (build → push GHCR → SSH)

**Files:**
- Create: `.github/workflows/deploy.yml`

**Interfaces:**
- Consumes: workflow `CI` (por nombre); `Dockerfile`; `scripts/deploy-remote.sh`; secretos `SSH_*`.
- Produces: imagen en GHCR + deploy ejecutado en el VPS.

- [ ] **Step 1: Escribir `deploy.yml`**

```yaml
# Deploy a producción (Spec §7, ISSUE-34). Se dispara SOLO cuando el workflow
# `CI` concluye en éxito sobre `main`: nada llega al VPS sin tests en verde.
name: Deploy

on:
  workflow_run:
    workflows: ["CI"]
    types: [completed]
    branches: [main]

# Un deploy a la vez; no cancelar uno en curso.
concurrency:
  group: deploy-production
  cancel-in-progress: false

jobs:
  build-and-deploy:
    name: Build · Push · Deploy
    runs-on: ubuntu-latest
    # Doble guarda: solo si CI pasó (además del filtro `branches`).
    if: ${{ github.event.workflow_run.conclusion == 'success' }}
    permissions:
      contents: read
      packages: write
    steps:
      - name: Checkout del commit que pasó CI
        uses: actions/checkout@v4
        with:
          ref: ${{ github.event.workflow_run.head_sha }}

      - name: Nombre de imagen en minúsculas (GHCR lo exige)
        id: img
        run: echo "repo=$(echo '${{ github.repository }}' | tr '[:upper:]' '[:lower:]')" >> "$GITHUB_OUTPUT"

      - name: Login en GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Set up Buildx
        uses: docker/setup-buildx-action@v3

      - name: Build y push
        uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: |
            ghcr.io/${{ steps.img.outputs.repo }}:${{ github.event.workflow_run.head_sha }}
            ghcr.io/${{ steps.img.outputs.repo }}:latest
          cache-from: type=gha
          cache-to: type=gha,mode=max

      - name: Copiar el script de deploy al VPS
        uses: appleboy/scp-action@v0.1.7
        with:
          host: ${{ secrets.SSH_HOST }}
          username: ${{ secrets.SSH_USER }}
          key: ${{ secrets.SSH_PRIVATE_KEY }}
          port: ${{ secrets.SSH_PORT }}
          source: "scripts/deploy-remote.sh"
          target: "/home/deploy/piensa-backend"
          overwrite: true

      - name: Desplegar por SSH
        uses: appleboy/ssh-action@v1.0.3
        with:
          host: ${{ secrets.SSH_HOST }}
          username: ${{ secrets.SSH_USER }}
          key: ${{ secrets.SSH_PRIVATE_KEY }}
          port: ${{ secrets.SSH_PORT }}
          # El script hace: docker login ghcr.io -> pull -> up -d -> health check.
          # Falla el step (y el job) si el health check no pasa.
          script: |
            chmod +x /home/deploy/piensa-backend/scripts/deploy-remote.sh
            /home/deploy/piensa-backend/scripts/deploy-remote.sh \
              "ghcr.io/${{ steps.img.outputs.repo }}:${{ github.event.workflow_run.head_sha }}" \
              "${{ github.actor }}" \
              "${{ secrets.GITHUB_TOKEN }}"
```

Notas para el implementador:
- `SSH_PORT` como secreto: si no lo defines, `appleboy/ssh-action` usa 22 por defecto sólo si el input queda vacío; define el secreto `SSH_PORT=22` para evitar ambigüedad.
- El `GITHUB_TOKEN` que se pasa al VPS es válido solo durante el run; sirve para el `docker login` de ese pull. Alternativa más duradera (documentada en el runbook): un PAT de solo-lectura de packages guardado en el VPS.

- [ ] **Step 2: Validar la sintaxis del workflow**

Run: `actionlint .github/workflows/deploy.yml`
Expected: sin errores. Si `actionlint` no está instalado: `brew install actionlint` (o `docker run --rm -v "$PWD":/repo -w /repo rhysd/actionlint:latest .github/workflows/deploy.yml`).

- [ ] **Step 3: Commit**

```bash
npm run format && npm run lint
git add .github/workflows/deploy.yml
git commit -m "feat(deploy): workflow de deploy a GHCR + VPS tras CI verde (ISSUE-34)"
```

---

### Task 3: Verificación real de build+push y runbook

El gate de tests, el build y el push a GHCR se prueban **de verdad**. El paso SSH se verifica contra el VPS real siguiendo el runbook (requiere ISSUE-31 y ISSUE-33 desplegados).

**Files:**
- Create: `docs/runbooks/deploy.md`

**Interfaces:**
- Consumes: todo lo anterior.
- Produces: procedimiento de configuración de secretos, primer deploy, rollback y verificación.

- [ ] **Step 1: Probar build+push en una rama (verificación parcial sin VPS)**

Para validar que la imagen se construye y publica sin depender del VPS, verificar el build localmente igual que lo hará el runner (mismo `Dockerfile`):

Run: `docker build -t ghcr.io/test/piensa-backend:ci-check . && echo "BUILD OK"`
Expected: `BUILD OK` (mismo build que ejecuta `build-push-action`).

Opcional (push real, si hay acceso a GHCR del repo): empujar una rama que dispare `CI`; al pasar `CI` sobre `main`, `Deploy` corre y el step "Build y push" publica la imagen. Verificar en GitHub → Packages que aparece `piensa-backend` con el tag del SHA. (En ramas que no son `main`, `Deploy` no se dispara: es el comportamiento correcto — nada sale sin verde en main.)

- [ ] **Step 2: Escribir el runbook `docs/runbooks/deploy.md`**

````markdown
# Runbook — Pipeline de deploy (ISSUE-34)

En cada push a `main`: `CI` corre (lint/typecheck/build/test). Si pasa, `Deploy`
construye la imagen, la publica en GHCR y la despliega al VPS. Si el health check
post-deploy falla, el deploy falla.

## Secretos del repositorio (Settings → Secrets and variables → Actions)
| Secreto | Valor |
|---|---|
| `SSH_HOST` | IP o dominio del VPS |
| `SSH_USER` | `deploy` (el usuario creado por provision.sh, ISSUE-33) |
| `SSH_PRIVATE_KEY` | clave privada SSH cuyo par público autorizó provision.sh |
| `SSH_PORT` | `22` (o el puerto configurado) |

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
# En el VPS, desplegar un SHA anterior conocido (el script exporta API_IMAGE
# a partir del arg, no hace falta pasarlo dos veces):
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
````

- [ ] **Step 3: Verificar formato y commit**

Run: `npm run format && npm run lint`
Expected: en verde.

```bash
git add docs/runbooks/deploy.md
git commit -m "docs(deploy): runbook del pipeline de deploy (ISSUE-34)"
```

---

## Self-Review

- **Criterio de aceptación** ("deploy end-to-end: un cambio trivial llega a producción solo tras tests en verde, con health check verificado") → workflow `workflow_run` gated por `CI` success (Task 2) + health check en `deploy-remote.sh` (Task 1 Step 2) + prueba end-to-end documentada (runbook Task 3).
- **Nada al VPS sin verde** → `on.workflow_run` + `if: conclusion == 'success'` + `branches: [main]`.
- **Build + push a GHCR** → Task 2 Step 1 (`build-push-action`, tags SHA + latest, privado).
- **Deploy por SSH con migraciones** → `deploy-remote.sh` usa el servicio `migrate` de ISSUE-31 (`up -d` respeta `service_completed_successfully`).
- **Health check que hace fallar el deploy** → `deploy-remote.sh` sale ≠ 0 si health no responde OK (Task 1 Step 2).
- **Dependencias** → consume ISSUE-31 (imagen/compose) e ISSUE-33 (VPS/usuario), declarado en Interfaces.
- **Sin placeholders**: workflow, script y modificación del compose completos; los valores del operador (host, usuario, llave, dominio) son secretos/variables documentados en el runbook.
