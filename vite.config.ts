import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig({
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
