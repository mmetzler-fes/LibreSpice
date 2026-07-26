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
    // The op-amps are not the only symbol that exists twice. Any part the
    // library serves *and* the bundle draws (the potentiometer, the changeover
    // switch) has the same trap: the served copy is what a dropped-in `.asc`
    // resolves against, the bundled copy is what the canvas draws, and a pin
    // moved in one of them rewires the part in exactly one of the two places.
    name: "any symbol present in both trees is the same file",
    run: async (fail) => {
      const { fs, path, proc } = await nodeApi();
      const byBase = async (dir: string) => {
        const m = new Map<string, string>();
        for (const f of await asyFiles(dir)) m.set(path.basename(f), f);
        return m;
      };
      const bundled = await byBase("src/sym");
      const served = await byBase("library/sym");
      for (const [name, a] of bundled) {
        const b = served.get(name);
        if (!b) continue;
        const read = (f: string) => fs.readFileSync(path.resolve(proc.cwd(), f), "latin1");
        if (read(a) !== read(b)) fail(`${name} differs between src/sym and library/sym`);
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
  {
    name: "each library symbol's pins match its .subckt's terminals",
    run: async (fail) => {
      // A `.subckt` part is wired by *position*: the `X` line lists the symbol's
      // pins in SpiceOrder and ngspice matches them against the `.subckt` header
      // one for one. The two files that decide this sit in different trees, and
      // nothing but this connects them — swap two terminals in either and the
      // circuit still builds, still simulates and is quietly wrong. That is the
      // one failure a reader has no way of seeing.
      const { fs, path, proc } = await nodeApi();
      const subDir = path.join(proc.cwd(), "library/sub");
      if (!fs.existsSync(subDir)) return fail("library/sub is missing");
      for (const asy of await asyFiles("src/sym")) {
        const text: string = fs.readFileSync(asy, "latin1");
        const model = /^SYMATTR\s+SpiceModel\s+(\S+)/mi.exec(text)?.[1];
        if (!model) continue;
        const lib = path.join(subDir, `${model}.lib`);
        if (!fs.existsSync(lib)) continue;
        // The symbol's pin names, ordered by SpiceOrder — the order the X line
        // is written in.
        const pins: { name: string; order: number }[] = [];
        let name: string | null = null;
        for (const line of text.split(/\r?\n/)) {
          const n = /^PINATTR\s+PinName\s+(\S+)/i.exec(line);
          if (n) { name = n[1]; continue; }
          const o = /^PINATTR\s+SpiceOrder\s+(\d+)/i.exec(line);
          if (o && name) { pins.push({ name, order: +o[1] }); name = null; }
        }
        const ordered = pins.sort((a, b) => a.order - b.order).map((p) => p.name);
        // `.subckt <name> <terminals…> [PARAMS: …]` — the terminals stop at the
        // first `params:` or `name=value`.
        const head = new RegExp(`^\\.subckt\\s+${model}\\s+(.*)$`, "mi").exec(fs.readFileSync(lib, "latin1"));
        if (!head) { fail(`${path.basename(lib)} has no .subckt ${model}`); continue; }
        const terminals: string[] = [];
        for (const t of head[1].trim().split(/\s+/)) {
          if (/^params:$/i.test(t) || t.includes("=")) break;
          terminals.push(t);
        }
        if (ordered.length !== terminals.length) {
          fail(`${model}: symbol has ${ordered.length} pins (${ordered.join(",")}), .subckt has ${terminals.length} (${terminals.join(",")})`);
          continue;
        }
        // Where the `.subckt` names its terminals the way the symbol names its
        // pins, the names are compared too — a mismatch there is a swap rather
        // than a naming choice. A `.subckt` that merely numbers them (the
        // comparator does) carries no such information, so the count is all
        // there is to check.
        const numbered = terminals.every((t) => /^\d+$/.test(t));
        if (!numbered && ordered.join(",").toUpperCase() !== terminals.join(",").toUpperCase()) {
          fail(`${model}: symbol order ${ordered.join(",")} vs .subckt ${terminals.join(",")}`);
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
