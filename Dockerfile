FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci || npm install

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production
ENV STATE_FILE_PATH=/data/state.json
ENV PORT=3000

RUN mkdir -p /data

EXPOSE 3000
CMD ["npm", "run", "start"]
