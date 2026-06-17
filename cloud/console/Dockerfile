# SmartNote Console — production multi-stage build.
#
# Result: ~150 MB image running a self-contained Next.js standalone
# server. The Cloud URL the console hits is baked at build time via
# NEXT_PUBLIC_CLOUD_URL — users can still override it from the login
# form, but the default they see should match the production deployment.
#
#   docker build \
#     --build-arg NEXT_PUBLIC_CLOUD_URL=https://api.example.com \
#     -t smartnote-console .

# ─── deps ───────────────────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app
# Standalone build needs pnpm-lock for reproducibility.
RUN corepack enable && corepack prepare pnpm@latest --activate
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile 2>/dev/null \
    || pnpm install --prefer-frozen-lockfile

# ─── build ──────────────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@latest --activate
ARG NEXT_PUBLIC_CLOUD_URL=""
ENV NEXT_PUBLIC_CLOUD_URL=${NEXT_PUBLIC_CLOUD_URL}
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

# ─── runtime ────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Run as non-root.
RUN addgroup --system --gid 1001 nodejs \
    && adduser  --system --uid 1001 nextjs

# `output: "standalone"` writes a minimal self-contained server into
# .next/standalone — copy it + the static assets and the public folder.
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static     ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/public           ./public

USER nextjs
EXPOSE 3000

# Standalone server is at /app/server.js (Next.js convention).
CMD ["node", "server.js"]
