# Gestor de Pagos — imagen de producción (Node 20, sin dependencias npm)
FROM node:20-alpine

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATA_DIR=/app/data \
    TRUST_PROXY=0

WORKDIR /app

# su-exec para bajar privilegios tras ajustar el volumen; wget para el healthcheck.
RUN apk add --no-cache su-exec wget \
 && addgroup -S gestor && adduser -S -G gestor gestor \
 && mkdir -p /app/data \
 && chown -R gestor:gestor /app

# Solo se copia lo que el servidor sirve o ejecuta: ni tests, ni tools, ni .git.
COPY package.json server.mjs index.html sync.js sw.js manifest.webmanifest icon.svg ./
COPY vendor/ ./vendor/
COPY icons/ ./icons/
COPY legal/ ./legal/
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 755 /usr/local/bin/docker-entrypoint.sh

# No declaramos VOLUME: lo gestiona docker-compose / el disco de la plataforma,
# evitando volúmenes anónimos que ocultarían el almacenamiento persistente.
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:8080/api/health || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server.mjs"]
