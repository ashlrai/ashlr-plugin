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

# src/serve.ts is the production entrypoint — it dynamically imports the app
# to avoid Bun's auto-detected `export default app` triggering a second
# Bun.serve() and EADDRINUSE on top of the explicit one.
CMD ["bun", "run", "src/serve.ts"]
