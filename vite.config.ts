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
    },
  },
  worker: {
    format: "es",
  },
  optimizeDeps: {
    exclude: ["eecircuit-engine"],
  },
});
