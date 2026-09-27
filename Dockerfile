# syntax=docker/dockerfile:1
# Multi-stage build:
#   build web → build server → node:22-alpine runtime.
# The same image serves the app and runs the app-migrate one-shot.

## ---- build: install deps, build all packages (web + server + libs) ----
FROM node:22-alpine AS build
RUN npm install -g pnpm@11.17.0
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
# pnpm patchedDependencies (PAY-93): install fails without the patch files.
COPY patches ./patches
COPY apps ./apps
COPY packages ./packages
RUN pnpm install --frozen-lockfile
# pnpm -r builds in topological order: engine/shared/db → web/server.
RUN pnpm -r run build
# Self-contained production deploys (workspace:* deps resolved + inlined).
RUN pnpm deploy --legacy --filter @payroll/server --prod /prod/app
RUN pnpm deploy --legacy --filter @payroll/db --prod /prod/db
# better-auth declares vite/vitest/tsx as OPTIONAL peers (used only by its CLI,
# which we never run). pnpm auto-installs peers, so test/build tooling leaks
# into the prod bundle — including esbuild 0.25.12's Go binary (CRITICAL
# CVE-2025-68121, Trivy gate). None of it is executed at runtime; prune it.
# Trivy re-verifies the image on every build, so a regression fails CI.
RUN rm -rf /prod/app/node_modules/.pnpm/vite@* \
           /prod/app/node_modules/.pnpm/vite-node@* \
           /prod/app/node_modules/.pnpm/vitest@* \
           /prod/app/node_modules/.pnpm/@vitest+* \
           /prod/app/node_modules/.pnpm/tsx@4.20* \
           /prod/app/node_modules/.pnpm/esbuild@0.25* \
           /prod/app/node_modules/.pnpm/@esbuild+*@0.25*

## ---- runtime: node:22-alpine, non-root, healthcheck on /health ----
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=8927 \
    SECRETS_DIR=/run/secrets
WORKDIR /app
# Strip npm/npx/yarn/corepack from the runtime image: the app runs `node`
# directly and drizzle-kit runs via its own node shebang — none of these
# package managers are needed, and npm bundles a CRITICAL-vulnerable tar
# (CVE-2026-59873, Trivy gate). Also shrinks the attack surface.
RUN rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/lib/node_modules/corepack \
           /opt/yarn-v* \
           /usr/local/bin/npm /usr/local/bin/npx \
           /usr/local/bin/yarn /usr/local/bin/yarnpkg \
           /usr/local/bin/corepack
# Fixed uid/gid (10001) so the host knows exactly which account must be able
# to read the secret FILES under /srv/payroll/secrets (0600, chown 10001:10001)
# — compose bind-mounts them, preserving host ownership, and the app runs as
# this non-root user.
RUN addgroup -g 10001 -S payroll && adduser -u 10001 -S -G payroll payroll
COPY --from=build --chown=payroll:payroll /prod/app ./
# Built SPA — Fastify static serving is wired in a later step (spec 8 says the
# server serves the SPA; step 1 only ships the assets in the image).
COPY --from=build --chown=payroll:payroll /app/apps/web/dist ./public
# Migration package for the app-migrate one-shot: drizzle-kit + SQL migrations.
COPY --from=build --chown=payroll:payroll /prod/db ./db
USER payroll
EXPOSE 8927
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8927/health || exit 1
CMD ["node", "dist/index.js"]
