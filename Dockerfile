FROM node:24-alpine
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001 HOST_KEY_FILE=/run/secrets/host_key
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node server ./server
COPY --chown=node:node public ./public
COPY --chown=node:node lua ./lua
COPY LICENSE.md ATTRIBUTION.md ./
RUN mkdir /app/data && chown node:node /app/data
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.mjs"]
