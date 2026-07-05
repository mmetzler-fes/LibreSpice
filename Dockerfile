# ---- Build stage: compile the SPA -------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app

# Install frontend deps against the lockfile for reproducible builds.
COPY package.json package-lock.json ./
RUN npm ci

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

# App: server code + built assets.
COPY server ./server
COPY --from=build /app/dist ./dist

# Run as the non-root `node` user (uid/gid 1000) so files written into the
# library volume are owned by a normal user, not root. Pre-create the library
# dir with that ownership so an anonymous volume (docker run without a bind
# mount) is writable too. When bind-mounting a host folder, match its owner via
# the compose `user:` override (see docker-compose.yml).
RUN mkdir -p /data/lib && chown -R node:node /data/lib
USER node

EXPOSE 8080
VOLUME ["/data/lib"]
CMD ["node", "server/index.mjs"]
