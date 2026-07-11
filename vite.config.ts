import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { execSync } from "node:child_process";

/**
 * A unique id for this build, stamped into autosaved snapshots so the app can
 * refuse to silently restore one written by a different build (see
 * persistence.ts). Prefers the git commit (stable across dev-server restarts of
 * the same checkout); falls back to a build timestamp when git is unavailable —
 * e.g. the Docker build, which excludes .git, so every image gets a fresh id.
 */
function buildId(): string {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return `t${Date.now()}`;
  }
}

export default defineConfig({
  define: { __BUILD_ID__: JSON.stringify(buildId()) },
  // Public base path the app is served under. Default "/" for local dev and
  // root deployments; set e.g. BASE_PATH=/librespice/app/ to host it under a
  // subpath. All asset URLs, the share link and API calls derive from this.
  base: process.env.BASE_PATH || "/",
  plugins: [react()],
  resolve: {
    alias: {
      "@core": resolve(__dirname, "src/core"),
      "@editor": resolve(__dirname, "src/editor"),
      "@store": resolve(__dirname, "src/store"),
      "@simulation": resolve(__dirname, "src/simulation"),
      "@oscilloscope": resolve(__dirname, "src/oscilloscope"),
      "@sym": resolve(__dirname, "src/sym"),
    },
  },
  worker: {
    format: "es",
  },
  server: {
    // Proxy library API to the thin backend during `npm run dev`. If no server
    // is running the requests fail silently and the app falls back to the
    // bundled defaults + localStorage.
    proxy: {
      "/api": "http://localhost:8080",
    },
  },
  optimizeDeps: {
    exclude: ["eecircuit-engine"],
  },
});
