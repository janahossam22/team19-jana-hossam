# The API image for the AWS version of the app (Floci, later ECS) - Jana Hossam, issue #43
FROM node:20-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app

# Production packages only
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# Only the code the API needs: no tests, no .env, no local node_modules
COPY backend/src ./src
COPY infra/floci/app/start-api.js ./start-api.js

# Run as the built-in "node" user, never root
USER node
EXPOSE 3000
CMD ["node", "start-api.js"]
