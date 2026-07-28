/**
 * The curated default parts, compiled into the app bundle.
 *
 * Every shipped `.asc` references parts by name — `seg7hex`, `pot`, `LM317`,
 * the 74LS93 — exactly as LTSpice does: the file names the subcircuit, the
 * subcircuit itself lives in the library. Until now that library reached the
 * browser from one place only, the backend's `api/library`. That makes opening
 * an example depend on a network round trip, and it fails in three ways at
 * once:
 *
 *   - No backend at all (static hosting, `npm run dev` without `npm run
 *     server`) — nothing is ever loaded.
 *   - A backend whose `/data/lib` is empty, which is what a Docker image built
 *     from a context that excluded `library/` produces.
 *   - The fetch is in flight while the app already restores a circuit, so the
 *     part is linked against an empty library and stays unlinked afterwards.
 *
 * All three end at the same symptom, and it is a bad one: the netlist writes
 * `X1 N9 N8 N7 N6 UNKNOWN` (`CustomSubcircuit.getNetlistLine`, the name it
 * reads out of an empty model text) and ngspice answers "unknown subckt", which
 * reads as a broken schematic rather than a missing file.
 *
 * So the defaults ship with the code. They are the same files the server reads
 * — globbed straight out of `library/sub/`, not copied into `src/`, because a
 * second copy is the trap `symbolSources.test.ts` already guards for the
 * op-amp symbols: edit one, and the app goes on using the other.
 *
 * These are a floor, never an override. The store consults them only for names
 * no `local`/`temp`/`server` entry claims (see `libraryStore`), so dropping a
 * better `seg7hex.lib` into the served library still wins.
 */

import { ModelParser } from "./ModelParser.js";
import type { LibraryEntry } from "./types.js";

/**
 * Raw text of every curated `.lib`, keyed by path.
 *
 * `library/` must therefore be inside the Vite root *and* inside the Docker
 * build context — `.dockerignore` used to exclude it, which produced an image
 * whose bundle silently contained no parts at all.
 */
const rawModules = import.meta.glob("../../../library/sub/*.lib", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

let cache: LibraryEntry[] | null = null;

/**
 * The curated entries, parsed once.
 *
 * Per file, like the server load: one malformed drop-in must not throw out of
 * the whole set and leave the app with no parts.
 */
export function bundledEntries(): LibraryEntry[] {
  if (cache) return cache;
  const out: LibraryEntry[] = [];
  for (const text of Object.values(rawModules)) {
    try {
      out.push(...ModelParser.parse(text).entries);
    } catch {
      /* skip an unparsable file rather than lose the rest */
    }
  }
  cache = out;
  return out;
}
