/**
 * LibreSpice server: serves the built SPA and exposes the file-backed component
 * library under /api/library. Kept intentionally tiny – the app is a static
 * bundle; this only adds persistent, shared library storage backed by a volume.
 */

import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureLibraryDirs, readLibrary, writeEntry, LIB_DIR } from "./library.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.resolve(__dirname, "..", "dist");
const PORT = Number(process.env.PORT) || 8080;

const app = express();
app.use(express.json({ limit: "4mb" }));

app.get("/api/library", async (_req, res) => {
  try {
    res.json(await readLibrary());
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post("/api/library", async (req, res) => {
  try {
    if (!req.body || !req.body.name) {
      res.status(400).json({ error: "Missing 'name'" });
      return;
    }
    const descriptor = await writeEntry(req.body);
    res.json({ ok: true, descriptor });
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

// Static SPA + client-side routing fallback.
app.use(express.static(DIST_DIR));
app.get(/^(?!\/api\/).*/, (_req, res) => {
  res.sendFile(path.join(DIST_DIR, "index.html"));
});

await ensureLibraryDirs().catch((err) => {
  console.warn(`Could not initialise library dir ${LIB_DIR}: ${err.message}`);
});

app.listen(PORT, () => {
  console.log(`LibreSpice listening on :${PORT}  (library dir: ${LIB_DIR})`);
});
