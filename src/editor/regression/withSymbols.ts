import { registerSymbol, unregisterSymbol } from "@sym/asyParser.js";

/**
 * Runs `body` with the project's real `.asy` symbols loaded, then takes them out
 * again.
 *
 * The regression harness stubs Vite's `import.meta.glob` (see
 * scripts/glob-shim.js), so no symbol is bundled and every part falls back to
 * its hand-drawn geometry. That is deliberate — `svgPositions` asserts exactly
 * that fallback — but it also means a resistor or capacitor has *no pins at all*
 * here, and anything that reasons about pin positions cannot be tested with the
 * two-terminal parts users actually rotate.
 *
 * Loading them globally would silently rewrite what the fallback suites see, so
 * this borrows them for one suite and restores the registry afterwards, on the
 * error path too.
 */
export async function withSymbols<T>(body: () => Promise<T>): Promise<T> {
  const load = (m: string) => import(/* @vite-ignore */ m);
  const [fs, path] = await Promise.all([load("node:fs"), load("node:path")]);

  const loaded: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      // latin1, not utf8: the symbol files carry characters like µ.
      else if (entry.name.endsWith(".asy")) {
        const name = entry.name.replace(/\.asy$/i, "");
        registerSymbol(name, fs.readFileSync(p, "latin1"));
        loaded.push(name);
      }
    }
  };

  const dir = path.resolve("src", "sym");
  if (fs.existsSync(dir)) walk(dir);
  try {
    return await body();
  } finally {
    for (const name of loaded) unregisterSymbol(name);
  }
}
