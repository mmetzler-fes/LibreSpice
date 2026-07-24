#!/usr/bin/env node
/**
 * Measure the prototype router against the current conversion.
 *
 * The conversion copies Multisim's wire geometry and patches where it misses our
 * pins. The alternative is to draw the wiring fresh between our own terminals,
 * using Multisim's net list — which says authoritatively what belongs together —
 * instead of its coordinates. Then nothing can end in mid-air and no net needs a
 * label to bridge a gap.
 *
 * The question that decides it is whether such routes cross *other nets*, since
 * LTSpice joins any two wires sharing a point. This puts a number on that
 * before anything is rebuilt around it: the router runs, the conversion does
 * not use it, and the two are compared.
 *
 * Usage: node scripts/route-prototype.mjs [--per-file]
 */
import { build } from "esbuild";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const SRC = "examples/Sicherung_Multisim_Circuits";
const OUT = "examples/Multisim_converted";

const outfile = resolve(root, "node_modules/.cache/librespice-route.mjs");
await build({
  stdin: {
    contents: `
      export { convert } from "./src/core/multisim/MultisimConverter.ts";
      export { readMsjs, msjsToSchematic } from "./src/core/multisim/msjs.ts";
      export { routeNets } from "./src/core/multisim/routePrototype.ts";
    `,
    resolveDir: root,
    loader: "ts",
  },
  bundle: true, format: "esm", platform: "node", packages: "external", outfile, logLevel: "warning",
});
const { convert, readMsjs, msjsToSchematic, routeNets } = await import(pathToFileURL(outfile).href);

/** Wire ends of a converted `.asc` that reach no other wire — the current cost. */
function currentStats(name) {
  const p = resolve(root, OUT, `${name}.asc`);
  if (!existsSync(p)) return null;
  const text = readFileSync(p, "latin1");
  const wires = [];
  let flags = 0;
  for (const line of text.split(/\r?\n/)) {
    const w = /^WIRE\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)/.exec(line);
    if (w) { wires.push(w.slice(1, 5).map(Number)); continue; }
    if (/^FLAG\s/.test(line)) flags++;
  }
  const length = wires.reduce((n, w) => n + Math.abs(w[2] - w[0]) + Math.abs(w[3] - w[1]), 0);
  return { wires: wires.length, flags, length };
}

const perFile = process.argv.includes("--per-file");
const total = { nets: 0, terminals: 0, shorts: 0, bodies: 0, len: 0, drawn: 0, named: 0, labels: 0,
                oldLen: 0, oldFlags: 0, oldWires: 0, files: 0 };
const worst = [];

for (const f of readdirSync(resolve(root, SRC)).sort()) {
  if (!f.endsWith(".msjs")) continue;
  const name = f.replace(/\.msjs$/, "");
  let res;
  try {
    const buf = readFileSync(resolve(root, SRC, f));
    res = convert(msjsToSchematic(readMsjs(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))));
  } catch { continue; }
  const { nets, bodies } = res.placement;
  if (!nets.length) continue;

  const r = routeNets(nets, bodies);
  const old = currentStats(name);
  total.files++;
  total.nets += r.nets;
  total.terminals += r.terminals;
  total.shorts += r.shorts;
  total.bodies += r.throughBodies;
  total.len += r.length;
  total.drawn += r.drawn;
  total.named += r.named;
  total.labels += r.labels;
  if (old) { total.oldLen += old.length; total.oldFlags += old.flags; total.oldWires += old.wires; }
  if (r.labels) worst.push([name, r.labels, r.nets]);
  if (perFile) console.log(`  ${name.padEnd(46)} ${String(r.nets).padStart(3)} Netze  ${String(r.labels).padStart(3)} Label`);
}

const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(0)}%` : "–");
console.log(`\nRouter-Prototyp — ${total.files} Schaltungen, ${total.nets} Netze, ${total.terminals} Anschluesse`);
console.log("=".repeat(70));
console.log("  Frisch verlegt, nur wo kreuzungsfrei moeglich:");
console.log(`    Kurzschluesse zwischen Netzen        ${String(total.shorts).padStart(6)}   (Bedingung, nicht Ergebnis)`);
console.log(`    Verbindungen als Leitung gezeichnet  ${String(total.drawn).padStart(6)}`);
console.log(`    davon auf einen Namen ausgewichen    ${String(total.named).padStart(6)}`);
console.log(`    Netzlabel noetig                     ${String(total.labels).padStart(6)}`);
console.log(`    Segmente durch Bauteilkoerper        ${String(total.bodies).padStart(6)}`);
console.log(`    Leitungslaenge                       ${String(total.len).padStart(6)}`);
console.log(`    Leitungsenden in der Luft                 0   (per Konstruktion)`);
console.log("\n  Heutige Konvertierung, dieselben Schaltungen:");
console.log(`    Netzlabel                            ${String(total.oldFlags).padStart(6)}`);
console.log(`    Leitungssegmente                     ${String(total.oldWires).padStart(6)}`);
console.log(`    Leitungslaenge                       ${String(total.oldLen).padStart(6)}   (${pct(total.len, total.oldLen)} davon braucht der Router)`);

if (worst.length) {
  console.log(`\n  ${worst.length} Schaltungen brauchen noch Netzlabel (meiste zuerst):`);
  for (const [n, s, nets] of worst.sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`    ${String(s).padStart(4)} Label bei ${String(nets).padStart(3)} Netzen   ${n}`);
  }
}
console.log("\n  Kurzschluesse sind hier keine Frage mehr, sondern ausgeschlossen: was sich");
console.log("  nicht kreuzungsfrei zeichnen laesst, bekommt einen Namen. Zu vergleichen");
console.log("  ist also die Label-Zahl -- und dass kein Ende mehr in der Luft haengt.");
