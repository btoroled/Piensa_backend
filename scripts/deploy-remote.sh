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
for _ in $(seq 1 30); do
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
