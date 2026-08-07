FROM node:24-alpine AS build

WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine

ENV HOST=0.0.0.0
ENV PORT=3131
ENV VLLM_BASE_URL=http://127.0.0.1:8000
ENV DEFAULT_MAX_TOKENS=4096

WORKDIR /app
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node server.mjs ./server.mjs

USER node
EXPOSE 3131
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/healthz').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"
CMD ["node", "server.mjs"]
