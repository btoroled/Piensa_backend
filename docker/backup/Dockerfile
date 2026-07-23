# Imagen de backup (ISSUE-32): pg_dump/psql (postgres 17) + age + rclone +
# supercronic (cron confiable para contenedores: pasa el env del contenedor a
# los jobs y loguea a stdout).
FROM postgres:17-alpine

# age y rclone están en los repos de Alpine.
RUN apk add --no-cache age rclone curl

# supercronic: binario único. Checksum verificado POR ARQUITECTURA (cada build
# de arch descarga y valida su propio binario).
ARG SUPERCRONIC_VERSION=v0.2.33
RUN set -eu; \
    ARCH="$(uname -m)"; \
    case "$ARCH" in \
      x86_64) SC_ARCH=amd64; SC_SHA1=71b0d58cc53f6bd72cf2f293e09e294b79c666d8 ;; \
      aarch64) SC_ARCH=arm64; SC_SHA1=e0f0c06ebc5627e43b25475711e694450489ab00 ;; \
      *) echo "arch no soportada: $ARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSLO "https://github.com/aptible/supercronic/releases/download/${SUPERCRONIC_VERSION}/supercronic-linux-${SC_ARCH}"; \
    echo "${SC_SHA1}  supercronic-linux-${SC_ARCH}" | sha1sum -c -; \
    chmod +x "supercronic-linux-${SC_ARCH}"; \
    mv "supercronic-linux-${SC_ARCH}" /usr/local/bin/supercronic

COPY backup.sh restore.sh /usr/local/bin/
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY crontab /etc/piensa/crontab
RUN chmod +x /usr/local/bin/backup.sh /usr/local/bin/restore.sh /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
