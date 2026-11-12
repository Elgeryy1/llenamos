# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS build
WORKDIR /app
RUN npm install --global pnpm@12.10.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY apps/landing/package.json apps/landing/package.json
COPY apps/api/package.json apps/api/package.json
COPY functions/package.json functions/package.json
COPY packages/core/package.json packages/core/package.json
RUN pnpm install --frozen-lockfile
COPY . .
ARG NEXT_PUBLIC_FIREBASE_PROJECT_ID
ARG NEXT_PUBLIC_FIREBASE_API_KEY
ARG NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
ARG NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET
ARG NEXT_PUBLIC_FIREBASE_APP_ID
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_DATA_BACKEND=postgres
ARG VITE_APP_URL
ENV NEXT_PUBLIC_USE_EMULATORS=0 NEXT_PUBLIC_FUNCTIONS_REGION=europe-west1 NEXT_TELEMETRY_DISABLED=1
RUN node deploy/vps/validate-public-env.mjs
RUN pnpm --filter web build && pnpm --filter landing build

# Comprobación estricta del bundle: la imagen `web` depende de esta etapa y no se construye si el bundle `postgres`
# lleva Firestore, Functions o Storage (ni como chunk diferido). `gateway` NO depende de ella: solo copia la presentación.
FROM build AS bundle-check
RUN cd apps/web && node scripts/check-imports.mjs && node scripts/check-bundle.mjs --dir .next --sin-construir && touch .next/bundle-limpio

FROM node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS web
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
# Marca de la etapa bundle-check: obliga a ejecutarla antes de dar por buena la imagen.
COPY --from=bundle-check /app/apps/web/.next/bundle-limpio /tmp/bundle-limpio
COPY --from=build --chown=node:node /app/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]

FROM nginxinc/nginx-unprivileged:stable-alpine@sha256:f5116ed4606f3eb015dd4a8e28cb9b351476dc0ad4bc6e9f93b19cec130cdf03 AS gateway
COPY deploy/vps/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/landing/dist /usr/share/nginx/html
EXPOSE 8080
