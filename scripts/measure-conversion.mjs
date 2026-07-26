#!/usr/bin/env node
/**
 * Measure the quality of the converted Multisim schematics.
 *
 * The converter reports the one fault it can detect while converting — two
 * Multisim nets shorted by a wire crossing. That is not the whole picture, and
 * the two it misses are the ones that make a sheet unusable without anything on
 * it looking wrong:
 *
 *   - a **shorted source**, both terminals on one node. ngspice refuses to run
 *     at all ("instance vdg6 is a shorted VSRC"), so the sheet yields nothing.
 *     Counted against the original: a part the source file itself leaves unwired
 *     has no two nodes to be on, and several of these sheets are exercises whose
 *     parts are there for the student to connect. Those are listed separately.
 *   - a **wire in mid-air**, an end that reaches no pin, no other wire and no
 *     name. Harmless to the simulation, but it is the visible symptom of a
 *     connection the converter could not draw.
 *
 * Both are read off the finished `.asc` — the same file the user opens — rather
 * than from the converter's own bookkeeping, so the measurement cannot agree
 * with the converter by construction.
 *
 * One trap, worth stating because it cost a wrong answer once: pins must be
 * taken in the *file's* coordinate system (`offsetsForNode`), not the canvas's
 * (`getNodePins`). For a voltage source the two differ by 8 units on purpose —
 * the canvas draws the hand-drawn artwork, whose pins span 64, while the file
 * uses `voltage.asy`, whose pins span 80 — so measuring one against the other
 * reports every source in the corpus as two wires hanging in mid-air.
 *
 * Usage:
 *   node scripts/measure-conversion.mjs                 # measure the working tree
 *   node scripts/measure-conversion.mjs --against HEAD  # and compare with a revision
 *   node scripts/measure-conversion.mjs --open-wires    # list every open end and
 *                                                       # the parts around it
 */
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const DIR = "examples/Multisim_converted";

const ALIASES = {
  "@core": resolve(root, "src/core"),
  "@editor": resolve(root, "src/editor"),
  "@store": resolve(root, "src/store"),
  "@simulation": resolve(root, "src/simulation"),
  "@oscilloscope": resolve(root, "src/oscilloscope"),
  "@sym": resolve(root, "src/sym"),
};

const aliasResolver = {
  name: "aliases",
  setup(b) {
    b.onResolve({ filter: /^@(core|editor|store|simulation|oscilloscope|sym)\// }, (args) => {
      const [prefix, ...rest] = args.path.split("/");
      const base = resolve(ALIASES[prefix], rest.join("/"));
      const ts = base.replace(/\.js$/, ".ts");
      if (existsSync(ts)) return { path: ts };
      if (existsSync(base)) return { path: base };
      return undefined;
    });
    b.onResolve({ filter: /\.js$/ }, (args) => {
      if (!args.importer) return undefined;
      const base = resolve(dirname(args.importer), args.path);
      for (const ext of [".ts", ".tsx"]) {
        const cand = base.replace(/\.js$/, ext);
        if (existsSync(cand)) return { path: cand };
      }
      return undefined;
    });
  },
};

const outfile = resolve(root, "node_modules/.cache/librespice-measure.mjs");
await build({
  stdin: {
    contents: `
      export { useCircuitStore } from "@store/circuitStore.js";
      export { useLibraryStore } from "@store/libraryStore.js";
      export { ModelParser } from "@core/library/ModelParser.js";
      export { registerSymbol, symbolByName } from "@sym/asyParser.js";
      export { offsetsForNode, parseRot, symbolToType } from "@core/ltspice/ltspiceGeometry.js";
      export { convert } from "@core/multisim/MultisimConverter.js";
      export { readMsjs, msjsToSchematic } from "@core/multisim/msjs.js";
      export { readMs14 } from "@core/multisim/ms14.js";
      export { ms14ToSchematic } from "@core/multisim/ms14Schematic.js";
    `,
    resolveDir: root,
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  jsx: "automatic",
  packages: "external",
  define: { "import.meta.glob": "globShim", "import.meta.env": '{"BASE_URL":"/"}' },
  inject: [resolve(__dirname, "glob-shim.js")],
  outfile,
  plugins: [aliasResolver],
  logLevel: "warning",
});

const {
  useCircuitStore, useLibraryStore, ModelParser,
  registerSymbol, symbolByName, offsetsForNode, parseRot, symbolToType,
  convert, readMsjs, msjsToSchematic, readMs14, ms14ToSchematic,
} = await import(pathToFileURL(outfile).href);

const MSJS = "examples/Sicherung_Multisim_Circuits";

/**
 * The sources the *original* leaves with fewer than two nodes, per converted file.
 *
 * Several of these sheets are exercises: the parts lie on them for the student to
 * wire up, and a source with nothing on either terminal has both of them on node 0
 * — which reads exactly like a source this conversion shorted. Only the difference
 * is worth counting, so the original is asked first (see ConversionResult.unconnected).
 */
function spareInstances(file) {
  const src = resolve(root, MSJS, file.replace(/\.asc$/, ".msjs"));
  if (!existsSync(src)) return [];
  try {
    const b = readFileSync(src);
    const res = convert(msjsToSchematic(readMsjs(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))));
    return res.unconnected;
  } catch {
    return [];
  }
}

/** Every `.asy` under a directory, registered under its bare name. */
function eachSymbol(dir, fn) {
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (e.name.endsWith(".asy")) fn(e.name.replace(/\.asy$/i, ""), p);
    }
  };
  walk(resolve(root, dir));
}

// The symbols the sheets are drawn with, from both trees (bundled + served)…
for (const dir of ["src/sym", "library/sym"]) {
  eachSymbol(dir, (name, p) => registerSymbol(name, readFileSync(p, "latin1")));
}
// …and each library symbol's pin names in SpiceOrder, which is what
// `offsetsForNode` needs to place a `.subckt` part's terminals.
const symPins = new Map();
for (const dir of ["src/sym", "library/sym"]) {
  eachSymbol(dir, (name) => {
    const sym = symbolByName(name);
    if (sym) symPins.set(name, [...sym.pins].sort((a, b) => a.order - b.order).map((q) => q.name));
  });
}

// The served model library, so `pot`, `LM317`, `SCR` and the 74LS93 resolve.
const entries = [];
const subDir = resolve(root, "library/sub");
if (existsSync(subDir)) {
  for (const f of readdirSync(subDir)) {
    if (!f.endsWith(".lib")) continue;
    try {
      for (const e of ModelParser.parse(readFileSync(join(subDir, f), "latin1")).entries) {
        entries.push({ entry: e, scope: "server" });
      }
    } catch { /* a malformed drop-in is not this tool's business */ }
  }
}
useLibraryStore.setState({ entries, serverAvailable: true });

const tick = () => new Promise((r) => setTimeout(r, 0));
const st = () => useCircuitStore.getState();
const key = (x, y) => `${x},${y}`;

/** Wire segments and flag points, straight out of the file. */
function readAsc(text) {
  const wires = [];
  const flags = [];
  for (const line of text.split(/\r?\n/)) {
    const w = /^WIRE\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)/.exec(line);
    if (w) { wires.push(w.slice(1, 5).map(Number)); continue; }
    const f = /^FLAG\s+(-?\d+)\s+(-?\d+)/.exec(line);
    if (f) flags.push([+f[1], +f[2]]);
  }
  return { wires, flags };
}

/**
 * Pin positions in the file's own coordinate system, from its SYMBOL lines.
 *
 * Each pin carries its instance name too (`R3`, `U2`), because that is what a
 * reader needs to find the spot on the sheet — a symbol name alone does not say
 * *which* resistor.
 */
function ascPins(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^SYMBOL\s+(\S+)\s+(-?\d+)\s+(-?\d+)\s+(\S+)/.exec(lines[i]);
    if (!m) continue;
    const base = m[1].split(/[\\/]/).pop();
    const { deg, mirrored } = parseRot(m[4]);
    // The InstName and, where the part has one, its pin list — both follow the
    // SYMBOL line, before the next one.
    let inst = "?";
    let declared;
    for (let j = i + 1; j < lines.length && !/^SYMBOL\s/.test(lines[j]); j++) {
      const a = /^SYMATTR\s+InstName\s+(\S+)/.exec(lines[j]);
      if (a) { inst = a[1]; continue; }
      // A gate's pin count is a property, not a fixed table, so its offsets can
      // only be worked out from the pins the file names. Without this every 3- and
      // 4-input gate was measured against a 2-input raster, and each of its inputs
      // came out as a wire ending 16 or 24 units short of a pin — 149 phantom open
      // ends across the corpus, all of them wiring that in fact meets its pin.
      const g = /^SYMATTR\s+LibreSpice\s+.*\bpins=([^;]+)/.exec(lines[j]);
      if (g) declared = g[1].split(",");
    }
    // Exactly the resolution the parser does: a known device symbol maps to its
    // component type, anything else is a library part drawn from its own `.asy`.
    const type = symbolToType(m[1]) ?? "subcircuit";
    const names = declared ?? (type === "subcircuit" ? (symPins.get(base) ?? []) : undefined);
    let offs = [];
    try { offs = offsetsForNode(type, deg, names, base, mirrored) ?? []; } catch { offs = []; }
    for (const o of offs) out.push({ x: +m[2] + o.dx, y: +m[3] + o.dy, handleId: o.handle, sym: base, inst });
  }
  return out;
}

/**
 * The parts around an open wire end, nearest first — what a reader has to look
 * at to judge whether the end matters.
 */
function neighbours(x, y, pins, limit = 3, radius = 160) {
  const perInst = new Map();
  for (const pin of pins) {
    const d = Math.round(Math.hypot(pin.x - x, pin.y - y));
    if (d > radius) continue;
    const prev = perInst.get(pin.inst);
    if (!prev || d < prev.d) perInst.set(pin.inst, { d, pin });
  }
  return [...perInst.values()]
    .sort((a, b) => a.d - b.d)
    .slice(0, limit)
    .map(({ d, pin }) => `${pin.inst} (${pin.sym}.${pin.handleId}, ${d})`);
}

/**
 * Wire ends that reach nothing: exactly one segment stops there, no other
 * segment passes through, and no pin or name sits on it.
 */
function danglingEnds({ wires, flags }, pins) {
  const deg = new Map();
  for (const [x1, y1, x2, y2] of wires) {
    for (const [x, y] of [[x1, y1], [x2, y2]]) deg.set(key(x, y), (deg.get(key(x, y)) ?? 0) + 1);
  }
  const taken = new Set([...pins.map((p) => key(p.x, p.y)), ...flags.map(([x, y]) => key(x, y))]);
  const out = [];
  for (const [k, n] of deg) {
    if (n !== 1 || taken.has(k)) continue;
    const [x, y] = k.split(",").map(Number);
    const through = wires.some((w) => (w[0] === w[2]
      ? x === w[0] && y > Math.min(w[1], w[3]) && y < Math.max(w[1], w[3])
      : y === w[1] && x > Math.min(w[0], w[2]) && x < Math.max(w[0], w[2])));
    if (!through) out.push(k);
  }
  return out;
}

/** Every metric for one directory of converted `.asc` files. */
async function measure(dir) {
  const files = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".asc")).sort() : [];
  const shortedSources = [];
  const dangling = [];
  const blame = new Map();
  const openWires = [];
  let danglingTotal = 0;
  let flagTotal = 0;
  /** Instances the original itself leaves with fewer than two nodes. */
  let spareTotal = 0;

  for (const file of files) {
    const text = readFileSync(join(dir, file), "latin1");
    try {
      st().clearCircuit();
      st().loadFromAsc(text);
      await tick(); await tick();
      st().rebuildConnections();
      await tick();
      st().regenerateNetlist();
      await tick();

      const spare = spareInstances(file);
      spareTotal += spare.length;
      // The netlist prepends the device letter where the instance name lacks it.
      const spared = new Set(spare.flatMap((n) => [n, `V${n}`, `I${n}`]));
      const bad = [];
      for (const l of st().netlist.split(/\r?\n/)) {
        const m = /^\s*([VI]\S*)\s+(\S+)\s+(\S+)\s/.exec(l);
        if (m && m[2] === m[3] && !spared.has(m[1])) bad.push(m[1]);
      }
      if (bad.length) shortedSources.push(`${file}: ${bad.join(", ")}`);

      const asc = readAsc(text);
      flagTotal += asc.flags.length;
      const pins = ascPins(text);
      const ends = danglingEnds(asc, pins);
      if (ends.length) {
        dangling.push(`${file}: ${ends.length}`);
        danglingTotal += ends.length;
        openWires.push({
          file,
          ends: ends.map((k) => {
            const [x, y] = k.split(",").map(Number);
            return { x, y, near: neighbours(x, y, pins) };
          }),
        });
      }

      // Attribute each open end to the nearest pin, with the distance. A
      // geometry problem clusters on a few exact offsets; wiring that merely
      // stops somewhere scatters.
      for (const k of ends) {
        const [x, y] = k.split(",").map(Number);
        let best = null, bestD = Infinity;
        for (const pin of pins) {
          const d = Math.hypot(pin.x - x, pin.y - y);
          if (d < bestD) { bestD = d; best = pin; }
        }
        const label = !best || bestD > 200
          ? "(kein Pin in der Naehe)"
          : `${best.sym} (${best.handleId}, ${Math.round(bestD)} weg)`;
        blame.set(label, (blame.get(label) ?? 0) + 1);
      }
    } catch (e) {
      shortedSources.push(`${file}: THREW ${e.message}`);
    }
  }
  return { files: files.length, shortedSources, dangling, danglingTotal, flagTotal, blame, openWires, spareTotal };
}

/** Check out the converted directory from a git revision into a scratch dir. */
function checkout(rev) {
  const tmp = mkdtempSync(join(tmpdir(), "librespice-measure-"));
  const list = execFileSync("git", ["ls-tree", "-r", "--name-only", rev, "--", DIR], { cwd: root, encoding: "utf8" })
    .split("\n").filter((n) => n.endsWith(".asc"));
  mkdirSync(join(tmp, DIR), { recursive: true });
  for (const f of list) {
    writeFileSync(join(tmp, f), execFileSync("git", ["show", `${rev}:${f}`], { cwd: root, maxBuffer: 64 << 20 }));
  }
  return { dir: join(tmp, DIR), cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}

const againstIdx = process.argv.indexOf("--against");
const rev = againstIdx !== -1 ? process.argv[againstIdx + 1] : null;

const now = await measure(resolve(root, DIR));
let before = null, cleanup = null;
if (rev) {
  const co = checkout(rev);
  cleanup = co.cleanup;
  before = await measure(co.dir);
}

const line = (label, a, b) =>
  b === null || b === undefined
    ? `  ${label.padEnd(34)} ${String(a).padStart(6)}`
    : `  ${label.padEnd(34)} ${String(b).padStart(6)} → ${String(a).padStart(6)}   ${a === b ? "" : a < b ? "besser" : "SCHLECHTER"}`;

console.log(`\nKonvertierungsqualitaet — ${now.files} Schaltungen${rev ? `  (Vergleich: ${rev})` : ""}`);
console.log("=".repeat(70));
console.log(line("Schaltungen mit kurzgeschl. Quelle", now.shortedSources.length, before?.shortedSources.length));
console.log(line("Schaltungen mit Leitung in der Luft", now.dangling.length, before?.dangling.length));
console.log(line("Leitungsenden in der Luft (gesamt)", now.danglingTotal, before?.danglingTotal));
console.log(line("Netzlabel gesamt", now.flagTotal, before?.flagTotal));
console.log(line("Bauteile ohne Anschluss im Original", now.spareTotal, before?.spareTotal));

if (now.shortedSources.length) {
  console.log("\nKurzgeschlossene Quellen (ngspice startet nicht):");
  for (const s of now.shortedSources) console.log("  " + s);
}
if (process.argv.includes("--open-wires")) {
  console.log("\nOffene Leitungsenden mit den Bauteilen in der Naehe (Abstand in LTSpice-Einheiten):");
  for (const { file, ends } of now.openWires) {
    console.log(`\n  ${file}  (${ends.length})`);
    for (const e of ends) {
      console.log(`    ${String(e.x).padStart(6)},${String(e.y).padEnd(6)}  ${e.near.join("   ") || "— nichts im Umkreis von 160"}`);
    }
  }
}
console.log("\nOffene Leitungsenden nach Bauteil und Abstand (jetzt | vorher):");
for (const [what, n] of [...now.blame].sort((a, b) => b[1] - a[1]).slice(0, 18)) {
  console.log(`  ${String(what).padEnd(38)} ${String(n).padStart(5)} | ${String(before?.blame.get(what) ?? 0).padStart(5)}`);
}
cleanup?.();

// ── der Multisim-14-Korpus ───────────────────────────────────────────────────
/**
 * The `.ms14` files, measured on the way *through* the converter rather than on a
 * committed `.asc`: nothing checks these into the tree, they are opened as they
 * are. Three numbers, and each of them named a real defect once:
 *
 *  - **shorted nets** — two of Multisim's nets that our drawing joined. The
 *    converter reports these itself; they are the honest count of what the
 *    geometry cost.
 *  - **parts at the sheet corner** — a placement that could not be read. The
 *    result still looks like a schematic, with everything on top of everything.
 *  - **types with no mapping** — the parts that arrive with their Multisim name
 *    and are left off the sheet, which is the list to work down next.
 */
const MS14 = "examples/Multisim14";

function ms14Files(dir) {
  const out = [];
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.ms14$/i.test(e.name)) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

const ms14 = { files: 0, clean: 0, shorts: 0, stacked: 0, unknown: new Map(), worst: [] };
for (const file of ms14Files(resolve(root, MS14))) {
  const b = readFileSync(file);
  let sch, res;
  try {
    sch = ms14ToSchematic(readMs14(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)));
    res = convert(sch);
  } catch (e) {
    console.log(`  FEHLER ${file}: ${e.message}`);
    continue;
  }
  ms14.files++;
  if (!res.shorts.length) ms14.clean++;
  ms14.shorts += res.shorts.length;
  ms14.stacked += sch.parts.filter((p) => (p.matrix.e ?? 0) === 0 && (p.matrix.f ?? 0) === 0).length;
  for (const t of res.skipped) ms14.unknown.set(t, (ms14.unknown.get(t) ?? 0) + 1);
  if (res.shorts.length) ms14.worst.push([res.shorts.length, file.slice(file.lastIndexOf("/") + 1)]);
}

console.log(`\nMultisim 14 — ${ms14.files} Schaltungen, direkt aus der Datei`);
console.log("=".repeat(70));
console.log(line("Schaltungen ohne Kurzschluss", ms14.clean));
console.log(line("Kurzgeschlossene Netze (gesamt)", ms14.shorts));
console.log(line("Bauteile in der Blattecke", ms14.stacked));
console.log(line("Typen ohne Zuordnung", ms14.unknown.size));

if (ms14.worst.length) {
  console.log("\nSchaltungen mit Kurzschluss:");
  for (const [n, f] of ms14.worst.sort((a, b) => b[0] - a[0]).slice(0, 10)) {
    console.log(`  ${String(n).padStart(5)}  ${f}`);
  }
}
if (ms14.unknown.size) {
  console.log("\nNicht abbildbare Typen (Schaltungen, in denen sie vorkommen):");
  for (const [t, n] of [...ms14.unknown].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(5)}x  ${t || "(ohne Namen)"}`);
  }
}
