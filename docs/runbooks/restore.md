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

> Sin `age` instalado en local, se puede generar con la imagen de backup:
> `docker run --rm --entrypoint age-keygen piensa-backup:local > piensa-backup-identity.txt`

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
| --- | --- | --- | --- |
| _(pendiente primera prueba)_ |  |  |  |
