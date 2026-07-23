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
