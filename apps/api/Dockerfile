# syntax=docker/dockerfile:1
# Contexto: raíz del monorepo. Usa el lockfile común y despliega solo dependencias de producción.
FROM node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS build
WORKDIR /repo
RUN npm install --global pnpm@12.10.1
COPY . .
RUN pnpm install --frozen-lockfile --filter @llenamos/api
RUN pnpm --filter @llenamos/api build
RUN pnpm --filter @llenamos/api deploy --prod --legacy /runtime

FROM node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d
ENV NODE_ENV=production PORT=3100 HOST=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /runtime ./
RUN mkdir -p /data/files && chown node:node /data/files
USER node
EXPOSE 3100
CMD ["node", "dist/main.js"]
