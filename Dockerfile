# D253 — official Node 22 bookworm-slim via Google's Docker Hub
# pull-through cache. Bare `node:22-bookworm-slim` resolves to
# docker.io/library/node; Railway Metal builders 429 there
# (2026-10-09, four failed deploys of D251/D252).
FROM mirror.gcr.io/library/node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci || npm install

COPY tsconfig.json ./
COPY src ./src
COPY public ./public
# Runtime data (generic-pool domain plan). The pool provisioner reads this at
# runtime from ../../data relative to dist/services, so it must ship in the image.
# The embedded plan in src/data/genericPoolPlan.ts is the fallback when it can't.
COPY data ./data
RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production
ENV STATE_FILE_PATH=/data/state.json
ENV PORT=3000

RUN mkdir -p /data

EXPOSE 3000
CMD ["npm", "run", "start"]
