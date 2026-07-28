// Node stand-in for Vite's `import.meta.glob`.
//
// The editor tests don't rely on any bundled `.asy` symbol (they use
// fallback-pin components), so an empty module map is sufficient for those —
// and `withSymbols` loads the symbols a test needs explicitly.
//
// The curated `library/sub/*.lib` parts are different: they are compiled into
// the app precisely so a schematic finds them with no backend and no fetch, and
// a shim that answered "no files" would let a suite pass on an app that ships
// no parts at all. That is the failure it exists to catch, so this pattern is
// served for real, off disk, exactly as the bundle would carry it.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// The repo root, not this file's directory: esbuild inlines this shim into a
// bundle under node_modules/.cache, where a path relative to `import.meta.url`
// points at node_modules/library. Every runner is invoked from the root, and
// `LS_ROOT` covers a caller that is not.
const root = process.env.LS_ROOT ?? process.cwd();

export const globShim = (pattern) => {
  if (typeof pattern === "string" && pattern.endsWith("library/sub/*.lib")) {
    const dir = resolve(root, "library/sub");
    if (!existsSync(dir)) return {};
    const out = {};
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".lib")) continue;
      // Vite's `?raw`/`eager` form: the module map holds the text itself.
      out[`../../../library/sub/${f}`] = readFileSync(resolve(dir, f), "latin1");
    }
    return out;
  }
  return {};
};
