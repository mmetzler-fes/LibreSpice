/**
 * LibreSpice server: serves the built SPA and exposes the file-backed component
 * library under <base>/api/library. Kept intentionally tiny – the app is a
 * static bundle; this only adds persistent, shared library storage backed by a
 * volume.
 *
 * The app can be hosted at the root ("/") or under a subpath via APP_BASE, e.g.
 * APP_BASE=/librespice/app/  →  app at /librespice/app/, its API at
 * /librespice/app/api, and a static landing page (site/) at the parent
 * /librespice/. Build the frontend with a matching BASE_PATH so asset URLs line
 * up (see vite.config.ts / Dockerfile).
 */

import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureLibraryDirs, readLibrary, writeEntry, LIB_DIR } from "./library.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.resolve(__dirname, "..", "dist");
const SITE_DIR = path.resolve(__dirname, "..", "site");
const PORT = Number(process.env.PORT) || 8080;

/** Normalise a base path to have a leading and trailing slash ("/" stays "/"). */
function normBase(b) {
  if (!b || b === "/") return "/";
  let s = b.startsWith("/") ? b : `/${b}`;
  if (!s.endsWith("/")) s += "/";
  return s;
}
const APP_BASE = normBase(process.env.APP_BASE || "/");
// Parent of the app base — where the landing page lives (only used off-root).
const SITE_ROOT = APP_BASE === "/" ? "/" : APP_BASE.replace(/[^/]+\/$/, "");

const app = express();
app.use(express.json({ limit: "4mb" }));

// ── Library API (under the app base) ─────────────────────────────────────────
const api = express.Router();
api.get("/library", async (_req, res) => {
  try {
    res.json(await readLibrary());
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});
api.post("/library", async (req, res) => {
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
app.use(`${APP_BASE}api`, api);

// ── Landing page (only when the app is hosted under a subpath) ────────────────
if (APP_BASE !== "/") {
  // Bare "/base/app" → "/base/app/" so relative asset URLs resolve. Match the
  // exact path (not via app.get, which — with non-strict routing — would also
  // catch the trailing-slash form and loop).
  const bare = APP_BASE.slice(0, -1);
  app.use((req, res, next) => (req.path === bare ? res.redirect(301, APP_BASE) : next()));
  app.use(SITE_ROOT, express.static(SITE_DIR));
}

// ── App bundle + client-side routing fallback (under the app base) ────────────
app.use(APP_BASE, express.static(DIST_DIR));
app.get(new RegExp(`^${APP_BASE}(?!api/).*`), (_req, res) => {
  res.sendFile(path.join(DIST_DIR, "index.html"));
});

await ensureLibraryDirs().catch((err) => {
  console.warn(`Could not initialise library dir ${LIB_DIR}: ${err.message}`);
});

app.listen(PORT, () => {
  console.log(`LibreSpice listening on :${PORT}  (base: ${APP_BASE}, library dir: ${LIB_DIR})`);
});
