FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Primero solo los manifiestos de dependencias: mientras no cambien, Docker reutiliza esta capa.
COPY package.json package-lock.json ./
# npm ci instala exactamente lo que dice package-lock.json; --omit=dev excluye dependencias de desarrollo.
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

# Usuario sin privilegios: si alguien vulnera la aplicacion, no obtiene root dentro del contenedor.
# Los archivos de /app quedan de solo lectura para este usuario (pertenecen a root).
RUN addgroup -S app && adduser -S app -G app
USER app

# La aplicacion escucha en 3000; docker-compose NO publica este puerto al host.
EXPOSE 3000

# Liveness sin tocar la base de datos (la comprobacion con consulta real es GET /health).
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/live || exit 1

CMD ["node", "src/server.js"]
