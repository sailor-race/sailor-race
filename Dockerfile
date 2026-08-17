FROM oven/bun:1 AS builder
WORKDIR /app
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile
COPY . .

ARG VITE_WS_URL=ws://localhost:3001
ENV VITE_WS_URL=${VITE_WS_URL}
ARG VITE_WS_TOKEN=
ENV VITE_WS_TOKEN=${VITE_WS_TOKEN}
RUN bun run build

FROM oven/bun:1-slim
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/serve.ts ./
COPY --from=builder /app/node_modules ./node_modules
EXPOSE 3000
CMD ["bun", "run", "serve.ts"]