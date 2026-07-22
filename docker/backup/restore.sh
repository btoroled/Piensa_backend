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
