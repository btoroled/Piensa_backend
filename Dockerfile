# Imagen de producción de la API (Spec §3). Multi-stage: `builder` compila TS y
# genera el cliente Prisma; `runtime` queda con solo dependencias de producción
# y corre como usuario no root. Base debian-slim: el engine por defecto de
# Prisma (debian-openssl-3.0.x) funciona sin configurar binaryTargets.

# --- Stage 1: build ---
FROM node:24-slim AS builder
WORKDIR /app

# openssl: node:*-slim no lo trae y Prisma lo necesita para detectar la versión
# de libssl y elegir el engine correcto (debian-openssl-3.0.x). Sin él, Prisma
# avisa y cae a un default que podría no cargar en otra arch/versión.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Instala TODAS las dependencias (incluye devDeps: typescript, tsc) de forma
# reproducible a partir del lockfile.
COPY package.json package-lock.json ./
RUN npm ci

# Genera el cliente Prisma (necesita el schema) y compila TypeScript a dist/.
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# --- Stage 2: runtime ---
FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# openssl: requerido por el query engine de Prisma en runtime (además de por
# `prisma generate` abajo) para elegir el binario correcto de forma determinista.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Solo dependencias de producción (incluye el CLI prisma, movido a deps).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Regenera el cliente Prisma contra el node_modules de producción y deja el
# schema + migraciones disponibles para `prisma migrate deploy` en el deploy.
COPY prisma ./prisma
RUN npx prisma generate

# Artefactos compilados desde el builder.
COPY --from=builder /app/dist ./dist

# El usuario `node` (uid 1000) ya viene en la imagen oficial: correr sin root.
USER node

EXPOSE 3000
CMD ["node", "dist/server.js"]
