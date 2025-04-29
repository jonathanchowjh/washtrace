# syntax=docker/dockerfile:1

# ---- build ----------------------------------------------------------------
# One install of the whole context, as pg-ops does: copying a workspace's
# node_modules between stages breaks the day npm hoists a package elsewhere.
FROM node:22-alpine AS build
WORKDIR /repo
COPY . .
RUN npm ci
# Builds @washtrace/detect first; the web app imports it from its dist/.
RUN npm run --workspace @washtrace/web build

# ---- runtime --------------------------------------------------------------
FROM node:22-alpine AS runtime
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

USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]
