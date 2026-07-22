# Imagen de producción de la API (Spec §3). Multi-stage: `builder` compila TS y
# genera el cliente Prisma; `runtime` queda con solo dependencias de producción
# y corre como usuario no root. Base debian-slim: el engine por defecto de
# Prisma (debian-openssl-3.0.x) funciona sin configurar binaryTargets.

# --- Stage 1: build ---
FROM node:24-slim AS builder
WORKDIR /app

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
