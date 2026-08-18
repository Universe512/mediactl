FROM node:22-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

FROM dependencies AS builder
ARG NEXT_PUBLIC_ROOT_DOMAIN
ENV NEXT_PUBLIC_ROOT_DOMAIN=${NEXT_PUBLIC_ROOT_DOMAIN}
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS manager-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM node:22-alpine AS portal
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 portal
COPY --from=builder --chown=portal:nodejs /app/dist/standalone ./
USER portal
EXPOSE 3000
CMD ["node", "server.js"]

FROM node:22-bookworm-slim AS manager
WORKDIR /app
ENV NODE_ENV=production PORT=4000 DATA_DIR=/data SSH_KEY_DIR=/run/secrets/ssh
COPY --from=manager-dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY config ./config
RUN mkdir -p /data /run/secrets/ssh && chown -R node:node /app /data /run/secrets/ssh
USER node
EXPOSE 4000
CMD ["node", "server/index.mjs"]
