# ---- Build stage: compile the SPA -------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app

# Install frontend deps against the lockfile for reproducible builds.
COPY package.json package-lock.json ./
RUN npm ci

# Public base path the SPA is served under. Keep in sync with the runtime
# APP_BASE (e.g. build with --build-arg BASE_PATH=/librespice/app/ and run with
# APP_BASE=/librespice/app/). Defaults to root.
ARG BASE_PATH=/
ENV BASE_PATH=$BASE_PATH

# Build the static bundle into /app/dist.
COPY . .
RUN npm run build

# ---- Runtime stage: tiny server + built assets ------------------------------
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV LIBRESPICE_LIB_DIR=/data/lib

# Server deps only (no dev / no frontend toolchain).
COPY server/package.json server/package-lock.json* ./server/
RUN cd server && npm install --omit=dev --no-audit --no-fund

# App: server code + built assets + static landing page.
COPY server ./server
COPY site ./site
COPY --from=build /app/dist ./dist

# Subpath hosting: set to match the build's BASE_PATH, e.g. /librespice/app/.
# Default "/" serves the app at the root (no separate landing page).
ENV APP_BASE=/

# Run as the non-root `node` user (uid/gid 1000) so files written into the
# library volume are owned by a normal user, not root. Pre-create the library
# dir with that ownership so an anonymous volume (docker run without a bind
# mount) is writable too. When bind-mounting a host folder, match its owner via
# the compose `user:` override (see docker-compose.yml).
RUN mkdir -p /data/lib && chown -R node:node /data/lib

# Seed the library volume with the curated defaults, so the shipped examples
# find the parts they reference by name (`seg7hex`, `pot`, `LM317`, …) even
# without a bind mount: Docker initialises an empty volume from the image's
# content at this path. A bind-mounted host folder shadows this, which is the
# intent — the host copy then is the library. The SPA carries the same defaults
# compiled in (bundledLibrary.ts), so this is the second of two floors, not the
# only one.
COPY --chown=node:node library/sub /data/lib/sub
COPY --chown=node:node library/sym /data/lib/sym
COPY --chown=node:node library/cmp /data/lib/cmp

USER node

EXPOSE 8080
VOLUME ["/data/lib"]
CMD ["node", "server/index.mjs"]
