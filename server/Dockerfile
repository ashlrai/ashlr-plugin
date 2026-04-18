# Stage 1: install dependencies
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

# Stage 2: runtime image
FROM oven/bun:1-slim AS runner
WORKDIR /app

# Copy production node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy source
COPY src ./src
COPY package.json tsconfig.json ./

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

CMD ["bun", "run", "src/index.ts"]
