# syntax=docker/dockerfile:1
#
# Two services from one build: `--target api` and `--target worker`.
# docker-compose.yml builds both.

# ---- build ----------------------------------------------------------------
# One install of the whole context: copying a workspace's
# node_modules between stages breaks the day npm hoists a package elsewhere.
FROM node:22-alpine AS build
WORKDIR /repo
COPY . .
RUN npm ci
# Each builds @washtrace/detect first; both import it from its dist/.
RUN npm run --workspace @washtrace/web build && npm run --workspace @washtrace/worker build

# ---- worker ---------------------------------------------------------------
# A plain Node process: no Next, no React. Production dependencies of the
# worker workspace only (pg and viem, through @washtrace/detect).
FROM node:22-alpine AS worker
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY packages/detect/package.json packages/detect/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --workspace @washtrace/worker && npm cache clean --force
COPY --from=build /repo/packages/detect/dist packages/detect/dist
COPY --from=build /repo/apps/worker/dist apps/worker/dist
# Stored data is not in the image: the worker downloads it from Hugging Face
# into /app/data/stored (WASHTRACE_STORED_DIR overrides it), which compose
# mounts as a volume. The folder is made here, owned by node, so a fresh named
# volume copies that ownership and the worker can write it.
RUN mkdir -p data/stored && chown node:node data/stored
USER node
EXPOSE 8081
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8081/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/worker/dist/main.js"]

# ---- api ------------------------------------------------------------------
# The JSON API and the console over it. Reads the store; never a chain.
FROM node:22-alpine AS api
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
# Next's standalone server binds to $HOSTNAME, and Docker sets HOSTNAME to the
# container id, which would bind one interface instead of all of them.
ENV HOSTNAME=0.0.0.0
# Standalone output is rooted at the workspace root (next.config.ts), so the
# server lands at apps/web/server.js. Static assets are not traced; Next
# expects them copied beside the server.
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
# The worker's stored data is mounted here (read only) for the console to describe.
# The folder exists so the console reads an empty one before the volume has data.
RUN mkdir -p data/stored && chown node:node data/stored
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]
