FROM node:24-alpine AS build
WORKDIR /src/apps/chat
COPY apps/chat/package*.json apps/chat/.npmrc ./
RUN npm ci
COPY lib /src/lib
COPY apps/chat ./
RUN npm run build

FROM node:24-alpine
WORKDIR /app
COPY --from=build /src/apps/chat/dist ./dist
COPY apps/chat/cli/server.js ./cli/server.js
COPY apps/chat/package.json ./
COPY apps/chat/standalone/adapter.mjs ./standalone/adapter.mjs
USER node
ENV PORT=3131
EXPOSE 3131
HEALTHCHECK --interval=30s --timeout=4s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1))"
CMD ["node", "standalone/adapter.mjs"]
