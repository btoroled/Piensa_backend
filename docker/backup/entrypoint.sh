#!/usr/bin/env sh
# Arranca supercronic con el crontab del backup (modo servicio).
set -eu
echo "[backup] supercronic iniciado; schedule:"
cat /etc/piensa/crontab
exec supercronic /etc/piensa/crontab
