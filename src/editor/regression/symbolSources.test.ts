import type { TestReport } from "./svgExport.test.js";

/**
 * Guards on the shipped `.asy` symbol files.
 *
 * Two traps, both of which had already been sprung once:
 *
 * 1. The op-amp symbols exist twice — `src/sym/Opamps/` is bundled into the app
 *    by `asyParser`'s `import.meta.glob`, `library/sym/OpAmps/` is served from
 *    the runtime library. Commit 0a4d6f6 redrew only the second, so the app went
 *    on drawing the old symbol from the first, and editing the library copy
 *    changed nothing on screen. They must stay byte-identical.
 *
 * 2. That same commit replaced symbols that were verbatim copies of LTspice's
 *    library files, carrying LTspice's own description texts. The copies under
 *    `src/sym/Opamps/` were missed and stayed in the public repo and the
 *    JavaScript bundle for as long as nobody looked. Any reappearance of those
 *    texts means a file has been copied back in.
 */

type Case = { name: string; run: (fail: (r: string) => void) => Promise<void> };

/** Node's `fs`/`path`, via a runtime specifier so `tsc` stays out of it. */
async function nodeApi(): Promise<any> {
  const load = (m: string) => import(/* @vite-ignore */ m);
  const [fs, path] = await Promise.all([load("node:fs"), load("node:path")]);
  return { fs, path, proc: (globalThis as any).process };
}

/** Every `.asy` under a directory, recursively, as repo-relative paths. */
async function asyFiles(dir: string): Promise<string[]> {
  const { fs, path, proc } = await nodeApi();
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".asy")) out.push(p);
    }
  };
  const root = path.join(proc.cwd(), dir);
  if (fs.existsSync(root)) walk(root);
  return out;
}

/**
 * Phrases unique to LTspice's own symbol files. Matching one means the file is a
 * copy rather than our own drawing.
 */
const LTSPICE_TEXT = [
  "See Educational/",
  "Copyright © Linear Technology",
  "Copyright Linear Technology",
];

const CASES: Case[] = [
  {
    name: "the bundled and the served op-amp symbols are identical",
    run: async (fail) => {
      const { fs, path, proc } = await nodeApi();
      const a = path.join(proc.cwd(), "src/sym/Opamps");
      const b = path.join(proc.cwd(), "library/sym/OpAmps");
      if (!fs.existsSync(a) || !fs.existsSync(b)) return fail("one of the op-amp symbol directories is missing");
      const names = (d: string) => fs.readdirSync(d).filter((n: string) => n.endsWith(".asy")).sort();
      const na = names(a), nb = names(b);
      if (na.join() !== nb.join()) return fail(`different files: ${na.join()} vs ${nb.join()}`);
      for (const n of na) {
        const ta = fs.readFileSync(path.join(a, n), "latin1");
        const tb = fs.readFileSync(path.join(b, n), "latin1");
        // The bundled copy is the one the app draws from; if they differ, an
        // edit to the library copy is invisible in the editor.
        if (ta !== tb) fail(`${n} differs between src/sym/Opamps and library/sym/OpAmps`);
      }
    },
  },
  {
    name: "no shipped symbol carries LTspice's own text",
    run: async (fail) => {
      const { fs } = await nodeApi();
      for (const dir of ["src/sym", "library/sym"]) {
        for (const f of await asyFiles(dir)) {
          const text = fs.readFileSync(f, "latin1");
          for (const phrase of LTSPICE_TEXT) {
            if (text.includes(phrase)) fail(`${f} contains LTspice text: "${phrase}"`);
          }
        }
      }
    },
  },
  {
    name: "the op-amp keeps its pin interface whatever the drawing",
    run: async (fail) => {
      const { fs } = await nodeApi();
      // The artwork is ours to change; the pins are not. A moved pin or a
      // renumbered SpiceOrder silently rewires every schematic using the part.
      const want = [
        ["-32", "16", "In+", "1"], ["-32", "-16", "In-", "2"],
        ["0", "-32", "V+", "3"], ["0", "32", "V-", "4"], ["32", "0", "OUT", "5"],
      ];
      for (const f of await asyFiles("src/sym/Opamps")) {
        const lines = fs.readFileSync(f, "latin1").split(/\r?\n/);
        const pins: string[][] = [];
        for (let i = 0; i < lines.length; i++) {
          const m = /^PIN\s+(-?\d+)\s+(-?\d+)/.exec(lines[i]);
          if (!m) continue;
          const name = /^PINATTR PinName (.+)$/.exec(lines[i + 1] ?? "")?.[1]?.trim();
          const order = /^PINATTR SpiceOrder (\d+)$/.exec(lines[i + 2] ?? "")?.[1];
          pins.push([m[1], m[2], name ?? "?", order ?? "?"]);
        }
        if (JSON.stringify(pins) !== JSON.stringify(want)) {
          fail(`${f} pin interface changed: ${JSON.stringify(pins)}`);
        }
      }
    },
  },
];

export async function runSymbolSourceTests(): Promise<TestReport> {
  const failures: { name: string; reason: string }[] = [];
  for (const c of CASES) {
    let failed = false;
    await c.run((reason) => { if (!failed) { failed = true; failures.push({ name: c.name, reason }); } });
  }
  return { total: CASES.length, passed: CASES.length - failures.length, failures };
}
