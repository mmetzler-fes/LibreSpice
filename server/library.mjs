/**
 * File-backed component library, mirroring LTSpice's on-disk layout.
 *
 *   LIB_DIR/
 *     sub/   *.lib | *.sub | *.mod   – .model / .subckt SPICE text (auto-included)
 *     sym/   *.asy                   – graphical symbols
 *     cmp/   *.json                  – component descriptors (symbol ↔ model ↔ pins)
 *
 * The sub/sym/cmp split mirrors LTSpice's `lib/{sub,sym,cmp}` layout.
 *
 * The directory is meant to be a mounted Docker volume so files dropped in by
 * the operator are picked up automatically, and imports from the UI are written
 * back here to persist across restarts.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

const LIB_DIR = process.env.LIBRESPICE_LIB_DIR || "/data/lib";

const SUBDIRS = {
  sub: path.join(LIB_DIR, "sub"),
  sym: path.join(LIB_DIR, "sym"),
  cmp: path.join(LIB_DIR, "cmp"),
};

const MODEL_EXT = new Set([".lib", ".sub", ".mod", ".cir", ".inc", ".txt"]);

/** Ensures the three library subdirectories exist. */
export async function ensureLibraryDirs() {
  for (const dir of Object.values(SUBDIRS)) {
    await fs.mkdir(dir, { recursive: true });
  }
}

/**
 * Recursively lists files under a directory (returns paths relative to it),
 * tolerating a missing directory. Mirrors LTSpice, whose sym/sub folders nest
 * parts into subdirectories (e.g. sym/OpAmps/…).
 */
async function listFiles(dir, base = dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const out = [];
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await listFiles(full, base)));
    else out.push(path.relative(base, full));
  }
  return out;
}

/**
 * Reads the whole library into a plain JSON payload the frontend can merge:
 *   { models: string[], symbols: {name,raw}[], components: descriptor[] }
 */
export async function readLibrary() {
  const models = [];
  for (const file of await listFiles(SUBDIRS.sub)) {
    if (!MODEL_EXT.has(path.extname(file).toLowerCase())) continue;
    models.push(await fs.readFile(path.join(SUBDIRS.sub, file), "utf8"));
  }

  const symbols = [];
  for (const file of await listFiles(SUBDIRS.sym)) {
    if (path.extname(file).toLowerCase() !== ".asy") continue;
    symbols.push({
      // Registered by bare filename (LTSpice references symbols by name, not path).
      name: path.basename(file).replace(/\.asy$/i, ""),
      raw: await fs.readFile(path.join(SUBDIRS.sym, file), "utf8"),
    });
  }

  const components = [];
  for (const file of await listFiles(SUBDIRS.cmp)) {
    if (path.extname(file).toLowerCase() !== ".json") continue;
    try {
      const descriptor = JSON.parse(await fs.readFile(path.join(SUBDIRS.cmp, file), "utf8"));
      components.push(descriptor);
    } catch {
      /* skip malformed descriptor – never fail the whole read on one bad file */
    }
  }

  return { models, symbols, components };
}

/** Rejects names that would escape the target directory. */
function safeBaseName(name) {
  const base = path.basename(String(name || "").trim());
  if (!base || base === "." || base === ".." || base.includes("/") || base.includes("\\")) {
    throw new Error(`Invalid library entry name: ${name}`);
  }
  // Conservative filesystem-safe slug (keep it recognisable, avoid odd chars).
  return base.replace(/[^A-Za-z0-9._+-]/g, "_");
}

/**
 * Writes an imported entry to disk. Payload:
 *   {
 *     name:        string,          // component / model name (required)
 *     modelText?:  string,          // .model / .subckt SPICE text → sub/<name>.lib
 *     asyText?:    string,          // .asy symbol source        → sym/<symbol>.asy
 *     descriptor?: { symbol, prefix, model?, pins? }  // → cmp/<name>.json
 *   }
 * Returns the stored descriptor (or null if none was written).
 */
export async function writeEntry(payload) {
  await ensureLibraryDirs();
  const name = safeBaseName(payload?.name);

  if (typeof payload.modelText === "string" && payload.modelText.trim()) {
    await fs.writeFile(path.join(SUBDIRS.sub, `${name}.lib`), payload.modelText, "utf8");
  }

  if (typeof payload.asyText === "string" && payload.asyText.trim()) {
    const symName = safeBaseName(payload.descriptor?.symbol || name);
    await fs.writeFile(path.join(SUBDIRS.sym, `${symName}.asy`), payload.asyText, "utf8");
  }

  if (payload.descriptor && typeof payload.descriptor === "object") {
    const descriptor = { name, ...payload.descriptor };
    await fs.writeFile(
      path.join(SUBDIRS.cmp, `${name}.json`),
      JSON.stringify(descriptor, null, 2),
      "utf8",
    );
    return descriptor;
  }

  return null;
}

export { LIB_DIR };
