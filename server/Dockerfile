# API image. Build context MUST be the repo root (the server compiles
# ../shared too) — compose already does this (dockerfile: ./server/Dockerfile).
# Manual build: docker build -f server/Dockerfile -t cinetickets-api .

FROM node:20-alpine AS build
WORKDIR /app

# Workspace manifests first so dependency layers survive source edits.
COPY package.json package-lock.json ./
COPY client/package.json ./client/package.json
COPY server/package.json ./server/package.json
RUN npm ci

COPY shared ./shared
COPY server ./server
COPY client ./client

# Prisma client (generated into server/src/generated) + compiled API.
WORKDIR /app/server
RUN npx prisma generate
RUN npm run build

# Static client for SERVE_CLIENT single-container mode.
WORKDIR /app/client
ARG VITE_API_URL=/api
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app/server
ENV NODE_ENV=production \
  PORT=4000 \
  HOST=0.0.0.0 \
  DATA_DIR=/app/server/data
# Prisma engines link against OpenSSL.
RUN apk add --no-cache openssl

# Full build-time node_modules: the runtime needs the Prisma CLI (migrations)
# and the downloaded engines, not just production dependencies.
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/package.json /app/package.json
COPY --from=build /app/server/package.json ./package.json
COPY --from=build /app/server/dist ./dist
COPY --from=build /app/server/prisma ./prisma
# The compiled server resolves ../client/dist relative to dist/server.
COPY --from=build /app/client/dist ./dist/client/dist
COPY --from=build /app/client/dist /app/client/dist
RUN mkdir -p /app/server/data

EXPOSE 4000
# Migrations run only when Postgres is configured; without DATABASE_URL the
# container boots in zero-config JSON mode instead of crashing.
CMD ["sh", "-c", "if [ -n \"$DATABASE_URL\" ]; then npx prisma migrate deploy; fi && node dist/server/src/index.js"]
