#!/usr/bin/env node
/**
 * Batch-convert Multisim Live (`.msjs`) exports to LTSpice (`.asc`).
 *
 * The conversion itself lives in `src/core/multisim/MultisimConverter.ts`,
 * shared with the in-app importer so the two cannot drift apart. This wrapper
 * adds only what a CLI needs: reading a directory, writing the files, and the
 * batch report. It bundles the TypeScript module the same way the regression
 * runner does.
 *
 * Both Multisim formats go through here. They differ only in the reader — the
 * Live export (`.msjs`) and the Multisim 14 file (`.ms14`) both become the same
 * neutral schematic, and `convert` is one function for either (see model.ts). So
 * the extension picks the reader and nothing else changes.
 *
 * Subdirectories are searched too. The Multisim 14 examples are filed in folders
 * per exercise — two thirds of them are nested — and a flat scan found a third
 * of the corpus.
 *
 * Usage: node scripts/convert-multisim.mjs <input-dir> [--out <dir>]
 */
import { build } from "esbuild";
import { readFileSync, writeFileSync, readdirSync, mkdirSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve, basename } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const outfile = resolve(root, "node_modules/.cache/librespice-multisim.mjs");

// Beide Haelften: der Leser macht aus dem .msjs das Zwischenmodell, der
// Konverter macht daraus das .asc (siehe model.ts).
await build({
  stdin: {
    contents: `
      export { convert, R_CLOSED, R_OPEN } from "./src/core/multisim/MultisimConverter.ts";
      export { readMsjs, msjsToSchematic } from "./src/core/multisim/msjs.ts";
      export { readMs14 } from "./src/core/multisim/ms14.ts";
      export { ms14ToSchematic } from "./src/core/multisim/ms14Schematic.ts";
    `,
    resolveDir: root,
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  // The converter reads the gate's pin table from ltspiceGeometry so it cannot
  // drift from the one the parser and the canvas use — and that module's tree
  // reaches asyParser, which asks Vite for `import.meta.glob`. Node has no such
  // API, so it gets the same empty-symbol shim the test runner uses. No symbol
  // artwork is needed here: the conversion places parts by coordinate.
  define: { "import.meta.glob": "globShim", "import.meta.env": '{"BASE_URL":"/"}' },
  inject: [resolve(__dirname, "glob-shim.js")],
  outfile,
  logLevel: "warning",
});

const { readMsjs, msjsToSchematic, readMs14, ms14ToSchematic, convert, R_CLOSED, R_OPEN } =
  await import(pathToFileURL(outfile).href);

/** Which reader a file needs, by extension. Everything after this is shared. */
const READERS = {
  ".msjs": (buf) => msjsToSchematic(readMsjs(buf)),
  ".ms14": (buf) => ms14ToSchematic(readMs14(buf)),
};

/** Every Multisim file under `dir`, however deeply filed. */
function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else {
      const ext = Object.keys(READERS).find((e) => name.endsWith(e));
      if (ext) out.push({ path: p, ext, name: basename(name, ext) });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/**
 * Write up what the conversion could not carry over.
 *
 * Ordered by how many schematics each missing part blocks, because that is the
 * order in which adding support pays off.
 */
function buildReport(results) {
  const L = [];
  const total = results.length;
  const clean = results.filter((r) => !r.error && !r.skipped.length);

  L.push("Konvertierung Multisim -> LTSpice (.asc)");
  L.push("=".repeat(60));
  L.push("");
  L.push(`Erzeugt am:            ${new Date().toISOString().slice(0, 10)}`);
  L.push(`Schaltungen gesamt:    ${total}`);
  L.push(`Vollstaendig:          ${clean.length}`);
  L.push(`Mit fehlenden Teilen:  ${total - clean.length}`);
  L.push("");

  // --- 1. by part type ---
  const byPart = new Map();
  for (const r of results) {
    for (const p of r.skipped) {
      if (!byPart.has(p)) byPart.set(p, []);
      byPart.get(p).push(r.name);
    }
  }
  L.push("1. FEHLENDE BAUTEILE (nach betroffenen Schaltungen)");
  L.push("-".repeat(60));
  L.push("");
  if (!byPart.size) L.push("  keine");
  for (const [part, hits] of [...byPart].sort((a, b) => b[1].length - a[1].length)) {
    L.push(`  ${String(hits.length).padStart(3)}x  ${part}`);
  }
  L.push("");

  // --- 2. per schematic ---
  L.push("2. BETROFFENE SCHALTUNGEN");
  L.push("-".repeat(60));
  L.push("");
  for (const r of results) {
    if (r.error) L.push(`  ${r.name}\n        FEHLER: ${r.error}`);
    else if (r.skipped.length) L.push(`  ${r.name}\n        ${r.skipped.join(", ")}`);
  }
  L.push("");

  // --- 3. substitutions ---
  const subs = results.filter((r) => r.substituted.length);
  L.push("3. ERSETZTE BAUTEILE (konvertiert, aber als Ersatzmodell)");
  L.push("-".repeat(60));
  L.push("");
  L.push("  Schalter werden als Parameterwiderstand abgebildet:");
  L.push(`    geschlossen = ${R_CLOSED}   offen = ${R_OPEN}`);
  L.push("  Der Wert steht als .param in der Schaltung und laesst sich dort");
  L.push("  umschalten. Die gespeicherte Schalterstellung ist voreingestellt.");
  L.push("");
  L.push("  Potentiometer werden als zwei Widerstaende mit gemeinsamem");
  L.push("  Stellungsparameter T_<name> abgebildet.");
  L.push("");
  L.push("  ACHTUNG: Spannungsgesteuerte Schalter verlieren ihren Steuer-");
  L.push("  eingang - ein Widerstand kann keinem Steuersignal folgen. Diese");
  L.push("  Kontakte sind danach statisch, die Schaltung simuliert also nicht");
  L.push("  mehr dasselbe Verhalten wie im Original.");
  L.push("");
  for (const r of subs) L.push(`  ${r.name}\n        ${r.substituted.join(", ")}`);
  L.push("");

  // --- 4. shorts ---
  const sh = results.filter((r) => r.shorts.length);
  L.push("4. KURZGESCHLOSSENE NETZE");
  L.push("-".repeat(60));
  L.push("");
  L.push("  Hier liegen zwei in Multisim getrennte Netze am selben Knoten. Die");
  L.push("  Verdrahtung selbst kann das nicht mehr verursachen - sie wird zwischen");
  L.push("  unseren Pins neu verlegt und nur dort, wo sie kein anderes Netz");
  L.push("  beruehrt (siehe router.ts). Bleibt hier etwas stehen, liegen zwei");
  L.push("  Anschluesse aufeinander. Diese Schaltungen vor Gebrauch pruefen.");
  L.push("");
  if (!sh.length) L.push("  keine");
  for (const r of sh) L.push(`  ${r.name}\n        ${r.shorts.join(", ")}`);
  L.push("");

  // --- 5. connection names the part does not have ---
  const un = results.filter((r) => r.unmapped?.length);
  L.push("5. NICHT GEFUNDENE ANSCHLUSSNAMEN");
  L.push("-".repeat(60));
  L.push("");
  L.push("  Die Zuordnungstabelle nennt einen Anschluss, den das Bauteil in der");
  L.push("  Datei nicht hat. Der Pin bleibt dann unbeschaltet und jede Leitung");
  L.push("  darauf faellt weg - lautlos, deshalb steht es hier.");
  L.push("");
  if (!un.length) L.push("  keine");
  for (const r of un) L.push(`  ${r.name}\n        ${r.unmapped.join("\n        ")}`);
  L.push("");

  // --- 6. what the sheet itself never connected ---
  const spare = results.filter((r) => r.unconnected?.length);
  L.push("6. BAUTEILE OHNE ANSCHLUSS IM ORIGINAL");
  L.push("-".repeat(60));
  L.push("");
  L.push("  Diese Bauteile haengen schon in der Multisim-Datei an weniger als");
  L.push("  zwei Knoten - meist Uebungsblaetter, auf denen die Schaltung erst");
  L.push("  verdrahtet werden soll. Es ist also nichts zu zeichnen. Es steht");
  L.push("  hier, weil es von aussen wie ein Konvertierungsfehler aussieht: jeder");
  L.push("  solche Anschluss landet auf Knoten 0, und eine Quelle mit beiden");
  L.push("  Anschluessen dort startet in ngspice nicht.");
  L.push("");
  if (!spare.length) L.push("  keine");
  for (const r of spare) L.push(`  ${r.name}\n        ${r.unconnected.join(", ")}`);
  L.push("");

  // --- 7. how much of the wiring is drawn, and how much is named ---
  const routed = results.filter((r) => r.route);
  const sum = (f) => routed.reduce((n, r) => n + f(r.route), 0);
  L.push("7. GEZEICHNET ODER BENANNT");
  L.push("-".repeat(60));
  L.push("");
  L.push("  Die Leitungen werden zwischen unseren eigenen Pins verlegt, aber nur");
  L.push("  wo das kein anderes Netz beruehrt - diese Blaetter sind nicht planar.");
  L.push("  Was sich nicht kreuzungsfrei zeichnen laesst, wird ueber den Netznamen");
  L.push("  verbunden. Beides ist elektrisch dasselbe, gezeichnet liest es sich");
  L.push("  besser.");
  L.push("");
  L.push(`  Verbindungen als Leitung gezeichnet:  ${String(sum((x) => x.drawn)).padStart(6)}`);
  L.push(`  auf den Netznamen ausgewichen:        ${String(sum((x) => x.named)).padStart(6)}`);
  L.push(`  Netze in mehr als einer Insel:        ${String(sum((x) => x.labels)).padStart(6)}`);
  L.push(`  Leitungen durch einen Bauteilkoerper: ${String(sum((x) => x.throughBodies)).padStart(6)}`);
  L.push("");
  const worst = routed.filter((r) => r.route.named).sort((a, b) => b.route.named - a.route.named).slice(0, 10);
  if (worst.length) {
    L.push("  Am meisten ausgewichen:");
    for (const r of worst) L.push(`  ${String(r.route.named).padStart(5)}x  ${r.name}`);
    L.push("");
  }

  return L.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const inDir = args.find((a) => !a.startsWith("--"));
  const outIdx = args.indexOf("--out");
  const outDir = outIdx !== -1 ? args[outIdx + 1] : "examples/Multisim_converted";
  if (!inDir) {
    console.error("usage: node scripts/convert-multisim.mjs <input-dir> [--out <dir>]");
    process.exit(1);
  }
  mkdirSync(outDir, { recursive: true });

  const files = sourceFiles(inDir);
  let ok = 0;
  const gaps = [];
  const shorted = [];
  const results = [];
  for (const f of files) {
    const name = f.name;
    try {
      const buf = readFileSync(f.path);
      const sch = READERS[f.ext](buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      const { asc, skipped, substituted, shorts, unmapped, unconnected, route } = convert(sch);
      writeFileSync(join(outDir, `${name}.asc`), asc, "latin1");
      ok++;
      results.push({ name, skipped, substituted, shorts, unmapped, unconnected, route });
      if (skipped.length) gaps.push(`  ${name}: ${skipped.join(", ")}`);
      if (shorts.length) shorted.push(`  ${name}: ${shorts.join(", ")}`);
    } catch (e) {
      results.push({ name, skipped: [], substituted: [], shorts: [], unmapped: [], error: e.message });
      gaps.push(`  ${name}: FEHLER ${e.message}`);
    }
  }

  const reportPath = join(outDir, "Konvertierungsfehler.txt");
  writeFileSync(reportPath, buildReport(results), "utf8");
  console.log(`${ok}/${files.length} Dateien nach ${outDir}/ konvertiert`);
  if (shorted.length) {
    console.log(`\n${shorted.length} Schaltungen mit kurzgeschlossenen Netzen (Drahtkreuzung):`);
    console.log(shorted.join("\n"));
  }
  if (gaps.length) {
    console.log(`\n${gaps.length} Schaltungen mit nicht abbildbaren Bauteilen:`);
    console.log(gaps.join("\n"));
  }
}

main();
