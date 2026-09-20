import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve, extname } from "path";
import { createReadStream, existsSync } from "node:fs";
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

/**
 * `samples/` in the dev server, exactly as the express server publishes it in
 * production (server/index.mjs): the files a circuit reads with `wavefile=` or
 * `PWL file=`, under <base>/samples/.
 *
 * Deliberately not `public/`, whose contents are copied into `dist/` and would
 * ship with every build: the recordings belong to third parties and stay out of
 * the repository and out of the image (see .gitignore, samples/README.md).
 */
function serveSamples() {
  const types: Record<string, string> = {
    ".wav": "audio/wav", ".txt": "text/plain", ".csv": "text/plain",
    ".dat": "text/plain", ".tsv": "text/plain",
  };
  return {
    name: "librespice-samples",
    configureServer(server: { middlewares: { use: (fn: (req: any, res: any, next: () => void) => void) => void } }) {
      server.middlewares.use((req, res, next) => {
        const m = /\/samples\/([^/?#]+)/.exec(req.url ?? "");
        // No directory listing and no path to climb out of: a bare file name.
        const name = m ? decodeURIComponent(m[1]) : "";
        const file = resolve(__dirname, "samples", name);
        if (!name || name.includes("..") || !existsSync(file)) { next(); return; }
        res.setHeader("Content-Type", types[extname(name).toLowerCase()] ?? "application/octet-stream");
        createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  define: { __BUILD_ID__: JSON.stringify(buildId()) },
  // Public base path the app is served under. Default "/" for local dev and
  // root deployments; set e.g. BASE_PATH=/librespice/app/ to host it under a
  // subpath. All asset URLs, the share link and API calls derive from this.
  base: process.env.BASE_PATH || "/",
  plugins: [react(), serveSamples()],
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
