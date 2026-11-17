# Yatra Insight: API + built UI in one Node process (SQLite on a volume at /app/data)
FROM node:24-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ARG SITE_URL=http://localhost:8787
ENV SITE_URL=$SITE_URL
RUN npm run build && npm prune --omit=dev

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8787
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/server ./server
COPY --from=build /app/web/dist ./web/dist
VOLUME /app/data
EXPOSE 8787
CMD ["node", "server/index.ts"]
