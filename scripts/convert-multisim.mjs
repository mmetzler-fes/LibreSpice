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
 * Usage: node scripts/convert-multisim.mjs <input-dir> [--out <dir>]
 */
import { build } from "esbuild";
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
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
    `,
    resolveDir: root,
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  outfile,
  logLevel: "warning",
});

const { readMsjs, msjsToSchematic, convert, R_CLOSED, R_OPEN } = await import(pathToFileURL(outfile).href);

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

  L.push("Konvertierung Multisim Live (.msjs) -> LTSpice (.asc)");
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
  L.push("  Hier verbindet die uebernommene Verdrahtung zwei Netze, die in");
  L.push("  Multisim getrennt waren. Diese Schaltungen vor Gebrauch pruefen.");
  L.push("");
  if (!sh.length) L.push("  keine");
  for (const r of sh) L.push(`  ${r.name}\n        ${r.shorts.join(", ")}`);
  L.push("");

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

  const files = readdirSync(inDir).filter((f) => f.endsWith(".msjs")).sort();
  let ok = 0;
  const gaps = [];
  const shorted = [];
  const results = [];
  for (const f of files) {
    const name = basename(f, ".msjs");
    try {
      const buf = readFileSync(join(inDir, f));
      const { asc, skipped, substituted, shorts } = convert(msjsToSchematic(readMsjs(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))));
      writeFileSync(join(outDir, `${name}.asc`), asc, "latin1");
      ok++;
      results.push({ name, skipped, substituted, shorts });
      if (skipped.length) gaps.push(`  ${name}: ${skipped.join(", ")}`);
      if (shorts.length) shorted.push(`  ${name}: ${shorts.join(", ")}`);
    } catch (e) {
      results.push({ name, skipped: [], substituted: [], shorts: [], error: e.message });
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
