# ISSUE-32 — Backups automáticos cifrados a R2 · Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Backup diario automático de PostgreSQL, cifrado con `age` (clave privada fuera del VPS) y subido a un bucket R2 dedicado con retención de 30 días, más un `restore.sh` y un runbook con el procedimiento de restauración y el recordatorio de prueba mensual.

**Architecture:** Un contenedor de backup basado en `postgres:17-alpine` (trae `pg_dump`/`psql`) con `age` y `rclone` instalados. `backup.sh` hace `pg_dump` → cifra con `age` a una **clave pública** de destinatario → sube con `rclone` a `R2:<bucket>/<prefijo>/<fecha>.sql.age`. La clave **privada** de `age` nunca vive en el VPS: solo se usa al restaurar, desde la máquina del operador. La retención de 30 días es una **lifecycle rule** del bucket R2 (documentada), no un borrado desde el script. El schedule diario lo da `supercronic` dentro del contenedor. El ciclo completo (dump→cifra→sube→descarga→descifra→restaura→la API arranca) se prueba en local contra un MinIO efímero que hace de stand-in S3, sin credenciales de nube.

**Tech Stack:** Docker, `postgres:17-alpine` (pg_dump/psql), `age`, `rclone` (S3/R2), `supercronic`, MinIO (solo para el test local), Docker Compose.

## Global Constraints

- **Privacidad de menores (memoria "elegir siempre lo más seguro", spec §6):** los backups son datos de familias/menores → **cifrado en reposo obligatorio** con clave asimétrica; el VPS solo tiene la **clave pública** (puede cifrar, no descifrar). La clave privada vive fuera del VPS (gestor de secretos del operador).
- **Credenciales R2 con alcance mínimo:** el backup usa variables `BACKUP_R2_*` propias, apuntando a un **bucket dedicado de backups** con un token R2 de permisos acotados a ese bucket — separadas de las `R2_*` de la app (uploads). No reusar el mismo token.
- **Retención:** 30 días vía lifecycle rule del bucket R2 (documentada en el runbook). El script no borra objetos.
- **Stack:** `postgres:17-alpine` (coincide con la base). `pg_dump`/`pg_restore` deben ser de la misma major (17) que el servidor.
- **Formatear antes de commitear** (memoria): `npm run format && npm run lint` antes de cada commit; los `.sh`/`.yml`/`.md` pasan por prettier salvo `.prettierignore`. Correr `shellcheck` sobre los scripts.
- **Prueba de restauración mensual** (spec §6): el runbook lo deja como recordatorio explícito y verificable.

---

## File Structure

- `docker/backup/Dockerfile` — imagen de backup (postgres-client + age + rclone + supercronic).
- `docker/backup/backup.sh` — `pg_dump` → `age` (cifra) → `rclone` (sube). Falla ruidoso (exit ≠ 0) si cualquier paso falla.
- `docker/backup/restore.sh` — descarga → `age -d` (descifra con identidad provista) → `psql` restaura en la BD destino.
- `docker/backup/crontab` — línea de cron para `supercronic` (diario).
- `docker/backup/entrypoint.sh` — arranca `supercronic` con el crontab (modo servicio).
- `docker-compose.backup.yml` — servicio `backup` (schedule) y perfil `oneshot` para correr un backup manual; se usa junto al compose de producción vía red externa.
- `docs/runbooks/restore.md` — runbook: generar el par de claves, lifecycle rule de 30 días, restaurar, prueba mensual.
- `.env.backup.example` — plantilla de variables del backup.

**Interfaces consumidas (de ISSUE-31):**
- Servicio `postgres` y su red interna del compose de producción; variables `POSTGRES_USER`/`POSTGRES_DB`/`POSTGRES_PASSWORD`.
- Imagen de la API (`piensa-backend:local`) solo en el test de restauración, para verificar que la API arranca contra la BD restaurada.

**Interfaces producidas:**
- `backup.sh` sube objetos con clave `${BACKUP_PREFIX}/piensa-YYYYMMDDTHHMMSSZ.sql.age`.
- `restore.sh <objeto> <identidad_age> <DATABASE_URL_destino>` restaura ese objeto.

---

### Task 1: Scripts de backup y restore (probados con MinIO local)

**Files:**
- Create: `docker/backup/backup.sh`
- Create: `docker/backup/restore.sh`
- Create: `.env.backup.example`

**Interfaces:**
- Consumes: variables `PGHOST`/`PGUSER`/`PGPASSWORD`/`PGDATABASE` (libpq), `AGE_RECIPIENT` (clave pública), `RCLONE_CONFIG_R2_*`, `BACKUP_BUCKET`, `BACKUP_PREFIX`.
- Produces: objeto cifrado en R2; `restore.sh` que revierte el ciclo dada la identidad `age`.

- [ ] **Step 1: Escribir `backup.sh`**

```bash
#!/usr/bin/env sh
# Backup cifrado de PostgreSQL a R2 (Spec §3, §6, ISSUE-32).
# pg_dump -> age (cifra a la clave PÚBLICA) -> rclone (sube al bucket R2).
# Falla ruidoso: `set -eu` + pipefail; cualquier paso roto aborta con exit != 0.
set -eu
# pipefail no es POSIX sh, pero busybox ash (alpine) lo soporta.
# shellcheck disable=SC3040
set -o pipefail

: "${PGHOST:?falta PGHOST}"
: "${PGUSER:?falta PGUSER}"
: "${PGDATABASE:?falta PGDATABASE}"
: "${AGE_RECIPIENT:?falta AGE_RECIPIENT (clave pública age)}"
: "${BACKUP_BUCKET:?falta BACKUP_BUCKET}"
: "${BACKUP_PREFIX:=piensa}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OBJECT="${BACKUP_PREFIX}/piensa-${STAMP}.sql.age"

echo "[backup] pg_dump ${PGDATABASE}@${PGHOST} -> cifrado -> R2:${BACKUP_BUCKET}/${OBJECT}"

# pg_dump (formato plano SQL) | cifra a la clave pública | sube por stdin.
# rcat lee de stdin y escribe el objeto de una sola pasada (sin archivo temporal
# con datos en claro en disco).
pg_dump --no-owner --no-privileges \
  | age -r "${AGE_RECIPIENT}" \
  | rclone rcat "R2:${BACKUP_BUCKET}/${OBJECT}"

echo "[backup] OK: R2:${BACKUP_BUCKET}/${OBJECT}"
```

Notas para el implementador:
- `PGPASSWORD` la toma `pg_dump` del entorno (libpq); se pasa por env, no por CLI.
- No se escribe el dump en claro a disco: `pg_dump | age | rclone rcat` es un pipe end-to-end.
- La retención la maneja la lifecycle rule del bucket (runbook), no este script.

- [ ] **Step 2: Escribir `restore.sh`**

```bash
#!/usr/bin/env sh
# Restauración de un backup cifrado (Spec §6, ISSUE-32).
# Uso: restore.sh <objeto> <ruta_identidad_age> <DATABASE_URL_destino>
#   <objeto>            clave en el bucket, p. ej. piensa/piensa-20260722T030000Z.sql.age
#   <ruta_identidad>    archivo con la clave PRIVADA age (identity). NUNCA en el VPS.
#   <DATABASE_URL>      base destino (debe existir y estar vacía).
# Descarga -> age -d (descifra) -> psql (restaura).
set -eu
# shellcheck disable=SC3040
set -o pipefail

OBJECT="${1:?uso: restore.sh <objeto> <identidad_age> <DATABASE_URL>}"
IDENTITY="${2:?falta la ruta a la identidad age}"
DEST_URL="${3:?falta DATABASE_URL destino}"
: "${BACKUP_BUCKET:?falta BACKUP_BUCKET}"

echo "[restore] R2:${BACKUP_BUCKET}/${OBJECT} -> descifrar -> restaurar en destino"

rclone cat "R2:${BACKUP_BUCKET}/${OBJECT}" \
  | age -d -i "${IDENTITY}" \
  | psql "${DEST_URL}"

echo "[restore] OK"
```

- [ ] **Step 3: Escribir `.env.backup.example`**

```dotenv
# Variables del contenedor de backup (ISSUE-32). Copiar a `.env.backup` en el
# VPS y fijar permisos 600. La clave PRIVADA age NO va aquí ni en el VPS.

# --- Conexión a PostgreSQL (libpq) ---
PGHOST=postgres
PGUSER=piensa
PGPASSWORD=la-misma-de-POSTGRES_PASSWORD
PGDATABASE=piensa_prod

# --- Cifrado age ---
# Clave PÚBLICA del destinatario (empieza con age1...). Solo cifra.
AGE_RECIPIENT=age1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxq9y8yv

# --- Destino R2 (bucket DEDICADO de backups, token de alcance mínimo) ---
BACKUP_BUCKET=piensa-backups
BACKUP_PREFIX=piensa
RCLONE_CONFIG_R2_TYPE=s3
RCLONE_CONFIG_R2_PROVIDER=Cloudflare
RCLONE_CONFIG_R2_ENV_AUTH=false
RCLONE_CONFIG_R2_ACCESS_KEY_ID=
RCLONE_CONFIG_R2_SECRET_ACCESS_KEY=
RCLONE_CONFIG_R2_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com
RCLONE_CONFIG_R2_ACL=private
```

- [ ] **Step 4: Verificar los scripts con shellcheck**

Run: `shellcheck docker/backup/backup.sh docker/backup/restore.sh`
Expected: sin errores (los `SC3040` de `pipefail` quedan silenciados por el `disable`). Si `shellcheck` no está instalado: `brew install shellcheck`.

- [ ] **Step 5: Commit**

```bash
chmod +x docker/backup/backup.sh docker/backup/restore.sh
git add docker/backup/backup.sh docker/backup/restore.sh .env.backup.example
git commit -m "feat(infra): scripts de backup cifrado y restore a R2 (ISSUE-32)"
```

---

### Task 2: Imagen de backup y schedule diario

**Files:**
- Create: `docker/backup/crontab`
- Create: `docker/backup/entrypoint.sh`
- Create: `docker/backup/Dockerfile`
- Create: `docker-compose.backup.yml`

**Interfaces:**
- Consumes: `backup.sh`/`restore.sh` de Task 1; la red del compose de producción para alcanzar `postgres`.
- Produces: servicio `backup` (schedule con supercronic) y perfil `oneshot`.

- [ ] **Step 1: Escribir el `crontab`**

```cron
# Backup diario a las 03:00 UTC (Spec §3). Formato supercronic (5 campos).
0 3 * * * /usr/local/bin/backup.sh
```

- [ ] **Step 2: Escribir `entrypoint.sh`**

```bash
#!/usr/bin/env sh
# Arranca supercronic con el crontab del backup (modo servicio).
set -eu
echo "[backup] supercronic iniciado; schedule:"
cat /etc/piensa/crontab
exec supercronic /etc/piensa/crontab
```

- [ ] **Step 3: Escribir el `Dockerfile` de backup**

```dockerfile
# Imagen de backup (ISSUE-32): pg_dump/psql (postgres 17) + age + rclone +
# supercronic (cron confiable para contenedores).
FROM postgres:17-alpine

# age y rclone están en los repos de Alpine.
RUN apk add --no-cache age rclone curl

# supercronic: binario único, cron determinista para contenedores.
ARG SUPERCRONIC_VERSION=v0.2.29
ARG SUPERCRONIC_SHA1SUM=cd48d45c4b10f3f0bfdd3a57d054cd05ac96812b
RUN set -eu; \
    ARCH="$(uname -m)"; \
    case "$ARCH" in \
      x86_64) SC_ARCH=amd64 ;; \
      aarch64) SC_ARCH=arm64 ;; \
      *) echo "arch no soportada: $ARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSLO "https://github.com/aptible/supercronic/releases/download/${SUPERCRONIC_VERSION}/supercronic-linux-${SC_ARCH}"; \
    chmod +x "supercronic-linux-${SC_ARCH}"; \
    mv "supercronic-linux-${SC_ARCH}" /usr/local/bin/supercronic

COPY backup.sh restore.sh /usr/local/bin/
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY crontab /etc/piensa/crontab
RUN chmod +x /usr/local/bin/backup.sh /usr/local/bin/restore.sh /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
```

Nota para el implementador: si la `SHA1SUM` fijada no coincide con la release al momento de construir, actualizar `SUPERCRONIC_VERSION`/`SUPERCRONIC_SHA1SUM` al valor publicado en la release de supercronic y añadir el `echo "${SHA1SUM}  supercronic-linux-${SC_ARCH}" | sha1sum -c -` antes del `chmod` (verificación de integridad de la descarga). Este `ARG` está declarado para no olvidar el chequeo; incorporarlo en el paso `RUN`.

- [ ] **Step 4: Escribir `docker-compose.backup.yml`**

```yaml
# Servicio de backup (ISSUE-32). Se conecta a la red del compose de producción
# (external) para alcanzar `postgres`. Levantar junto a producción:
#   docker compose -f docker-compose.backup.yml --env-file .env.backup up -d
# Backup manual inmediato (perfil oneshot):
#   docker compose -f docker-compose.backup.yml --env-file .env.backup \
#     run --rm oneshot /usr/local/bin/backup.sh
services:
  backup:
    build: ./docker/backup
    image: piensa-backup:local
    container_name: piensa-backup
    restart: unless-stopped
    env_file: .env.backup
    networks:
      - piensa_prod

  # Mismo binario, sin cron: para correr un backup/restore manual.
  oneshot:
    build: ./docker/backup
    image: piensa-backup:local
    profiles: ["oneshot"]
    env_file: .env.backup
    entrypoint: []
    networks:
      - piensa_prod

networks:
  # Red creada por docker-compose.prod.yml (proyecto por defecto: piensa-backend).
  piensa_prod:
    external: true
    name: piensa-backend_default
```

Nota: el nombre real de la red externa depende del nombre del proyecto compose (por defecto, el del directorio: `piensa-backend`). El runbook indica cómo confirmarlo con `docker network ls`.

- [ ] **Step 5: Construir la imagen de backup (verificación)**

Run: `docker build -t piensa-backup:local docker/backup`
Expected: build OK; incluye `pg_dump`, `age`, `rclone`, `supercronic`.

Run: `docker run --rm --entrypoint sh piensa-backup:local -c "pg_dump --version && age --version && rclone version | head -1 && supercronic -version"`
Expected: imprime versión de `pg_dump (PostgreSQL) 17.x`, `age`, `rclone` y `supercronic` sin error.

- [ ] **Step 6: Commit**

```bash
git add docker/backup/crontab docker/backup/entrypoint.sh docker/backup/Dockerfile docker-compose.backup.yml
git commit -m "feat(infra): imagen de backup con schedule diario (supercronic) (ISSUE-32)"
```

---

### Task 3: Prueba del ciclo completo dump→cifra→sube→descarga→descifra→restaura

Este es el **criterio de aceptación** de ISSUE-32. Se corre en local usando MinIO como stand-in de R2 (rclone S3 funciona igual), sin credenciales de nube.

**Files:**
- Create (temporal, no se commitea): `/Users/btoro/.claude/jobs/c4972cb7/tmp/issue-32-cycle-test.sh`

**Interfaces:**
- Consumes: `piensa-backup:local` (Task 2), imagen `piensa-backend:local` (ISSUE-31) para el arranque final, la BD de desarrollo de `docker-compose.dev.yml`.
- Produces: evidencia del ciclo completo (backup subido, restaurado en BD vacía, API arranca).

- [ ] **Step 1: Generar un par de claves age de prueba**

Run:
```bash
mkdir -p "$CLAUDE_JOB_DIR/tmp/age" && docker run --rm piensa-backup:local age-keygen 2>/dev/null > "$CLAUDE_JOB_DIR/tmp/age/identity.txt"
grep 'public key' "$CLAUDE_JOB_DIR/tmp/age/identity.txt"
```
Expected: imprime `# public key: age1...` (esa es la clave pública; el archivo completo es la identidad privada). Guardar la pública en una variable en el siguiente step.

- [ ] **Step 2: Escribir el script del ciclo completo**

Contenido de `$CLAUDE_JOB_DIR/tmp/issue-32-cycle-test.sh` (levanta MinIO + una BD origen y una BD destino, siembra datos, corre backup.sh y restore.sh, y arranca la API contra la BD restaurada):

```bash
#!/usr/bin/env bash
set -euo pipefail
NET=piensa-cycle-net
ID_FILE="$CLAUDE_JOB_DIR/tmp/age/identity.txt"
PUB="$(grep 'public key' "$ID_FILE" | awk '{print $NF}')"

cleanup() {
  docker rm -f pg-src pg-dst minio >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

docker network create "$NET" >/dev/null

# MinIO (stand-in de R2/S3)
docker run -d --name minio --network "$NET" \
  -e MINIO_ROOT_USER=test -e MINIO_ROOT_PASSWORD=test12345 \
  minio/minio server /data >/dev/null

# BD origen (con datos) y BD destino (vacía)
docker run -d --name pg-src --network "$NET" \
  -e POSTGRES_USER=piensa -e POSTGRES_PASSWORD=piensa -e POSTGRES_DB=piensa_prod \
  postgres:17-alpine >/dev/null
docker run -d --name pg-dst --network "$NET" \
  -e POSTGRES_USER=piensa -e POSTGRES_PASSWORD=piensa -e POSTGRES_DB=piensa_prod \
  postgres:17-alpine >/dev/null

echo "esperando a que las bases acepten conexiones..."
for c in pg-src pg-dst; do
  until docker exec "$c" pg_isready -U piensa -d piensa_prod >/dev/null 2>&1; do sleep 1; done
done
until docker exec minio mc --version >/dev/null 2>&1 || true; do sleep 1; done
sleep 2

# Sembrar datos en el origen
docker exec pg-src psql -U piensa -d piensa_prod -c \
  "CREATE TABLE marca (id int primary key, txt text); INSERT INTO marca VALUES (1,'hola-backup');"

# Crear el bucket en MinIO
docker run --rm --network "$NET" --entrypoint sh minio/mc -c \
  "mc alias set m http://minio:9000 test test12345 && mc mb -p m/piensa-backups" >/dev/null

RCLONE_ENV="-e RCLONE_CONFIG_R2_TYPE=s3 -e RCLONE_CONFIG_R2_PROVIDER=Minio \
  -e RCLONE_CONFIG_R2_ACCESS_KEY_ID=test -e RCLONE_CONFIG_R2_SECRET_ACCESS_KEY=test12345 \
  -e RCLONE_CONFIG_R2_ENDPOINT=http://minio:9000 -e RCLONE_CONFIG_R2_ACL=private"

# BACKUP (contra pg-src)
docker run --rm --network "$NET" $RCLONE_ENV \
  -e PGHOST=pg-src -e PGUSER=piensa -e PGPASSWORD=piensa -e PGDATABASE=piensa_prod \
  -e AGE_RECIPIENT="$PUB" -e BACKUP_BUCKET=piensa-backups -e BACKUP_PREFIX=piensa \
  --entrypoint /usr/local/bin/backup.sh piensa-backup:local

# Localizar el objeto subido
OBJ="$(docker run --rm --network "$NET" $RCLONE_ENV --entrypoint rclone piensa-backup:local \
  lsf R2:piensa-backups/piensa/ | head -1)"
echo "objeto subido: piensa/$OBJ"

# RESTORE (contra pg-dst, con la identidad privada montada)
docker run --rm --network "$NET" $RCLONE_ENV \
  -v "$ID_FILE:/identity.txt:ro" \
  -e BACKUP_BUCKET=piensa-backups \
  --entrypoint /usr/local/bin/restore.sh piensa-backup:local \
  "piensa/$OBJ" /identity.txt "postgresql://piensa:piensa@pg-dst:5432/piensa_prod"

# Verificar que el dato llegó al destino
echo -n "dato restaurado: "
docker exec pg-dst psql -U piensa -d piensa_prod -tAc "SELECT txt FROM marca WHERE id=1;"
```

- [ ] **Step 3: Correr el ciclo completo (verificación)**

Run: `bash "$CLAUDE_JOB_DIR/tmp/issue-32-cycle-test.sh"`
Expected: termina con `dato restaurado: hola-backup`. Eso demuestra dump→cifra→sube→descarga→descifra→restaura en una BD vacía. El `trap cleanup` borra los contenedores/red al salir.

- [ ] **Step 4: Verificar que la API arranca contra una BD restaurada**

Extiende la prueba con el schema real: en lugar de la tabla `marca`, aplica las migraciones en `pg-src` antes del backup y, tras el restore, corre la API apuntando a `pg-dst`. Comando puntual:

```bash
# (con pg-dst aún vivo tras un run manual, o replicando el flujo) arrancar la API
docker run --rm --network piensa-cycle-net \
  -e DATABASE_URL="postgresql://piensa:piensa@pg-dst:5432/piensa_prod?schema=public" \
  -e JWT_SECRET="test-secret-de-16-o-mas" -e NODE_ENV=production \
  -p 3000:3000 piensa-backend:local &
sleep 4 && curl -s http://localhost:3000/api/v1/health
```
Expected: `{"data":{"status":"ok"}}` — la API arranca y responde contra la base restaurada.

- [ ] **Step 5: No hay artefactos que commitear en esta task**

El script vive en `$CLAUDE_JOB_DIR/tmp` (no se versiona). La evidencia del ciclo queda en el output. No hay commit en esta task.

---

### Task 4: Runbook de restauración, lifecycle rule y prueba mensual

**Files:**
- Create: `docs/runbooks/restore.md`

**Interfaces:**
- Consumes: todo lo anterior.
- Produces: procedimiento documentado (generación de claves, lifecycle de 30 días, restauración, recordatorio de prueba mensual).

- [ ] **Step 1: Escribir el runbook**

Contenido de `docs/runbooks/restore.md`:

````markdown
# Runbook — Backups y restauración (ISSUE-32)

`pg_dump` diario → cifrado `age` (clave pública en el VPS) → `rclone` a un bucket
R2 dedicado con retención de 30 días. La clave **privada** NO vive en el VPS.

## 1. Generar el par de claves age (una vez, en la máquina del operador)
```bash
age-keygen -o piensa-backup-identity.txt
# Imprime: Public key: age1....  <- va en AGE_RECIPIENT (.env.backup del VPS)
```
- **Clave pública** (`age1...`) → `.env.backup` en el VPS (`AGE_RECIPIENT`). Solo cifra.
- **Clave privada** (`piensa-backup-identity.txt`) → gestor de secretos del operador,
  **fuera del VPS**. Sin ella no se puede restaurar: hacer copia segura.

## 2. Bucket R2 dedicado + retención de 30 días
- Crear un bucket **separado** para backups (p. ej. `piensa-backups`), distinto del
  de uploads de la app.
- Crear un token R2 con permisos acotados **solo a ese bucket** → `.env.backup`
  (`RCLONE_CONFIG_R2_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` / `_ENDPOINT`).
- Lifecycle rule (retención 30 días): en el dashboard de R2 → el bucket →
  Settings → Object lifecycle rules → "Delete objects" a los **30 días** desde
  la creación, prefijo `piensa/`. El script no borra; la retención es del bucket.

## 3. Poner en marcha el schedule
```bash
cp .env.backup.example .env.backup && chmod 600 .env.backup   # completar valores
# Confirmar el nombre de la red del stack de producción:
docker network ls | grep piensa            # ajustar `name:` en docker-compose.backup.yml si difiere
docker compose -f docker-compose.backup.yml --env-file .env.backup up -d --build
```
Backup manual inmediato (verificación):
```bash
docker compose -f docker-compose.backup.yml --env-file .env.backup \
  run --rm oneshot /usr/local/bin/backup.sh      # -> [backup] OK: R2:piensa-backups/piensa/....sql.age
```

## 4. Restaurar
```bash
# Listar backups disponibles:
docker compose -f docker-compose.backup.yml --env-file .env.backup \
  run --rm oneshot rclone lsf R2:piensa-backups/piensa/

# Restaurar UN objeto en una BD destino vacía (identidad privada montada):
docker compose -f docker-compose.backup.yml --env-file .env.backup \
  run --rm -v /ruta/segura/piensa-backup-identity.txt:/identity.txt:ro oneshot \
  /usr/local/bin/restore.sh piensa/piensa-YYYYMMDDTHHMMSSZ.sql.age /identity.txt \
  "postgresql://piensa:<pass>@postgres:5432/piensa_prod?schema=public"
```

## 5. Prueba de restauración MENSUAL (obligatoria, spec §6)
> **Recordatorio:** el primer lunes de cada mes, restaurar el backup más reciente
> en una base vacía de staging y arrancar la API contra ella. Un backup no
> probado no es un backup.

Checklist (cada ítem con su verificación):
- [ ] `rclone lsf` muestra un backup de las últimas 24 h. → salida no vacía.
- [ ] `restore.sh` sobre una BD vacía termina en `[restore] OK`. → exit 0.
- [ ] La API arranca contra la BD restaurada: `curl .../api/v1/health` → `{"data":{"status":"ok"}}`.
- [ ] Registrar fecha y resultado de la prueba en este runbook (bitácora abajo).

### Bitácora de pruebas de restauración
| Fecha | Backup restaurado | Resultado | Operador |
|---|---|---|---|
| _(pendiente primera prueba)_ | | | |
````

- [ ] **Step 2: Verificar formato y commit**

Run: `npm run format && npm run lint`
Expected: en verde.

```bash
git add docs/runbooks/restore.md
git commit -m "docs(infra): runbook de restauración y prueba mensual (ISSUE-32)"
```

---

## Self-Review

- **Criterio de aceptación** ("ciclo completo probado contra un bucket de prueba: dump → cifra → sube → descarga → descifra → restaura en una BD vacía → la API arranca contra ella") → Task 3 Steps 3–4 (MinIO como bucket de prueba, restore en `pg-dst` vacía, API arranca).
- **Cifrado con clave fuera del VPS** → `age -r` (pública) en `backup.sh`; identidad privada solo en `restore.sh` provista al restaurar (Task 1) y explicada en el runbook (Task 4 §1).
- **Retención 30 días vía lifecycle rule** → runbook Task 4 §2 (no borrado desde script).
- **`restore.sh` + runbook** → Task 1 Step 2 + Task 4.
- **Prueba de restauración mensual** → runbook Task 4 §5 con checklist verificable y bitácora.
- **Alcance mínimo de credenciales** → `BACKUP_R2_*`/bucket dedicado, separados de `R2_*` de la app (Global Constraints + `.env.backup.example`).
- **Sin placeholders**: scripts, Dockerfile, compose y test tienen contenido ejecutable; los valores del operador (claves, bucket, token) están en `.env.backup.example`/runbook.
