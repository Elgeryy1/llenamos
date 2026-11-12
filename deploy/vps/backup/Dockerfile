# syntax=docker/dockerfile:1
# Imagen del servicio de copias: cliente PostgreSQL (pg_dump, psql), openssl, tar y las herramientas de subida
# (rsync, ssh y curl; curl sube a almacenamiento S3 como Cloudflare R2 con --aws-sigv4). Corre con el mismo uid (1000) que el usuario `node` de la API, dueño de los archivos privados
# (0600/0700), y /backups queda preparado para que el volumen nombrado lo herede. Compilar fuera del VPS y
# publicar por digest, igual que el resto.
FROM postgres:18.4-bookworm@sha256:882236b897e39051d2368c5ccc6cda944904723506b2dfc97f2a8f5bc9afa382
RUN apt-get update && apt-get install -y --no-install-recommends rsync openssh-client curl ca-certificates && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 1000 --create-home --shell /bin/sh llbackup \
 && mkdir -p /backups && chown 1000:1000 /backups && chmod 700 /backups
COPY --chmod=0555 lib.sh backup.sh ledger.sh /backup/
USER 1000:1000
ENTRYPOINT ["sh", "/backup/backup.sh"]
