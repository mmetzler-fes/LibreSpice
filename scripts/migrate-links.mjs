// Converts the share links we ship to the anchor model, ahead of time.
//
// A link written before net names became coordinates carries them as `netlabel`
// / `netconnector` *nodes*. The app converts such a payload when it opens one
// (see loadFromSnapshot), so every link ever handed out keeps working — but the
// links on our own landing page are ours to fix, and a visitor should not be
// paying for a migration on every page load. This rewrites them once.
//
// It does not reimplement the conversion. It runs the app's own: the payload is
// decoded, handed to `loadFromSnapshot` exactly as the browser would, and read
// back out with `exportSnapshot`. Whatever the app makes of an old link is what
// gets stored — a second implementation here could only drift from it.
//
// Three files carry the payloads and all three are rewritten:
//   - `scratchpad_example_links.md` — the source of truth (see apply:links), so
//     the next `npm run apply:links` does not put the old payloads back;
//   - `scripts/example-links.json`;
//   - `site/index.html`.
//
// Every conversion is checked before it is accepted: the `.asc` the migrated
// snapshot saves must be identical to the one the original saved, and it must
// carry the same names. A payload that fails is reported and left alone.
//
// Usage: node scripts/migrate-links.mjs [--dry-run]
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const dryRun = process.argv.includes("--dry-run");

const FILES = [
  resolve(root, "scratchpad_example_links.md"),
  resolve(root, "scripts/example-links.json"),
  resolve(root, "site/index.html"),
];

// ── Bundle the app's own store and codecs for Node ───────────────────────────
const ALIASES = {
  "@core": resolve(root, "src/core"), "@editor": resolve(root, "src/editor"),
  "@store": resolve(root, "src/store"), "@simulation": resolve(root, "src/simulation"),
  "@oscilloscope": resolve(root, "src/oscilloscope"), "@sym": resolve(root, "src/sym"),
};
const aliasResolver = {
  name: "aliases",
  setup(b) {
    b.onResolve({ filter: /^@(core|editor|store|simulation|oscilloscope|sym)\// }, (args) => {
      const [prefix, ...rest] = args.path.split("/");
      const base = resolve(ALIASES[prefix], rest.join("/"));
      for (const c of [base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".tsx"), base]) {
        if (existsSync(c)) return { path: c };
      }
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

const outfile = resolve(root, "node_modules/.cache/librespice-migrate-links.mjs");
await build({
  stdin: {
    contents: `
      export { decodeSnapshotCompressed, encodeSnapshotCompressed } from "@store/persistence.js";
      export { useCircuitStore } from "@store/circuitStore.js";
      export { LTSpiceExporter } from "@core/ltspice/LTSpiceExporter.js";
      export { withSymbols } from "@editor/regression/withSymbols.js";
    `,
    resolveDir: root, loader: "ts",
  },
  bundle: true, format: "esm", platform: "node", jsx: "automatic", packages: "external",
  define: { "import.meta.glob": "globShim", "import.meta.env": '{"BASE_URL":"/"}' },
  inject: [resolve(__dirname, "glob-shim.js")],
  outfile, plugins: [aliasResolver], logLevel: "warning",
});
const {
  decodeSnapshotCompressed, encodeSnapshotCompressed, useCircuitStore, LTSpiceExporter, withSymbols,
} = await import(pathToFileURL(outfile).href);

const st = () => useCircuitStore.getState();
const tick = () => new Promise((r) => setTimeout(r, 0));

/** The `.asc` the Save button would write for the current store state. */
function currentAsc() {
  const s = st();
  return LTSpiceExporter.export(
    s.nodes, s.edges, s.spiceDirectives, s.circuit, s.dataFlags, s.textBoxes, s.sheetShapes,
    { directiveRaw: s.directiveRaw, header: s.ascHeader, orphanWires: s.ascOrphanWires, anchors: s.netAnchors },
  );
}

/** Every name a payload carries, however it carries it — old shape or new. */
function namesOf(snapshot) {
  if (snapshot.netAnchors) return snapshot.netAnchors.map((a) => a.name).sort();
  return snapshot.nodes
    .filter((n) => n.data?.componentType === "netlabel" || n.data?.componentType === "netconnector")
    .map((n) => String(n.data?.label ?? "").trim())
    .filter(Boolean)
    .sort();
}

/** Load a payload into the store the way the browser does, and settle. */
async function open(snapshot) {
  st().clearCircuit();
  st().loadFromSnapshot(snapshot);
  // loadFromSnapshot rebuilds the nets and converts the names on the next tick,
  // and removing the old label nodes queues another round of edge bridging.
  await tick(); await tick(); await tick();
  st().rebuildConnections();
  await tick();
}

// ── Collect the payloads ─────────────────────────────────────────────────────
const sources = FILES.filter(existsSync).map((path) => ({ path, text: readFileSync(path, "utf8") }));
const payloads = new Set();
// Two shapes, matched exactly rather than loosely: a link (`…#z=payload`) and
// the JSON field (`"z": "payload"`). A pattern that accepted either quote or
// hash before an optional `=` also matched the opening quote of the JSON field
// — and since one of our payloads happens to *begin* with `z`, it swallowed that
// first character and reported the link as corrupt.
for (const s of sources) {
  for (const m of s.text.matchAll(/#z=([A-Za-z0-9_-]{40,})/g)) payloads.add(m[1]);
  for (const m of s.text.matchAll(/"z":\s*"([A-Za-z0-9_-]{40,})"/g)) payloads.add(m[1]);
}

console.log(`${payloads.size} eindeutige Payloads in ${sources.length} Dateien.\n`);

// ── Convert ──────────────────────────────────────────────────────────────────
const rewrites = new Map();
let already = 0, failed = 0;

await withSymbols(async () => {
  for (const z of payloads) {
    const snapshot = await decodeSnapshotCompressed(z);
    if (!snapshot) { console.error(`  ! Payload liess sich nicht dekodieren: ${z.slice(0, 24)}…`); failed++; continue; }

    const name = snapshot.circuitName ?? "(ohne Namen)";
    if (snapshot.netAnchors) { already++; continue; }

    const wantNames = namesOf(snapshot);

    // What the old payload opens to, through the app's own migration. Note what
    // this can and cannot check: the exporter that wrote these links no longer
    // exists, so there is nothing to compare the *original* file against. What is
    // checked is that converting is idempotent — the stored payload opens to the
    // same circuit as the migrated one — and, separately, that every name the old
    // payload carried is still there afterwards.
    await open(snapshot);
    const wantAsc = currentAsc();

    const migrated = st().exportSnapshot();
    if (!migrated.netAnchors) { console.error(`  ! ${name}: nach der Umwandlung immer noch keine Anker`); failed++; continue; }

    // Re-open the converted payload and compare. Not the in-memory object: the
    // point is that the *link* opens to the same circuit, so it goes through the
    // encode/decode it will actually take.
    const z2 = await encodeSnapshotCompressed(migrated);
    const reopened = await decodeSnapshotCompressed(z2);
    if (!reopened) { console.error(`  ! ${name}: der umgewandelte Payload dekodiert nicht`); failed++; continue; }
    await open(reopened);

    const gotAsc = currentAsc();
    const gotNames = namesOf(reopened);
    if (gotAsc !== wantAsc) {
      const a = wantAsc.split("\n"), b = gotAsc.split("\n");
      const i = a.findIndex((l, k) => l !== b[k]);
      console.error(`  ! ${name}: die Schaltung aendert sich (Zeile ${i}): "${a[i]}" → "${b[i] ?? "(fehlt)"}"`);
      failed++; continue;
    }
    if (gotNames.join("|") !== wantNames.join("|")) {
      console.error(`  ! ${name}: Namen weichen ab: [${wantNames}] → [${gotNames}]`);
      failed++; continue;
    }

    rewrites.set(z, z2);
    const delta = z2.length - z.length;
    console.log(`  ✓ ${name.padEnd(38)} ${wantNames.length} Namen, ${delta >= 0 ? "+" : ""}${delta} Zeichen`);
  }
});

// ── Write back ───────────────────────────────────────────────────────────────
console.log("");
if (rewrites.size === 0) {
  console.log(`Nichts umzuwandeln (${already} bereits im Ankermodell, ${failed} fehlgeschlagen).`);
} else if (dryRun) {
  console.log(`--dry-run: ${rewrites.size} Payloads waeren umgeschrieben worden.`);
} else {
  for (const { path, text } of sources) {
    let out = text, n = 0;
    for (const [from, to] of rewrites) {
      if (!out.includes(from)) continue;
      out = out.split(from).join(to);
      n++;
    }
    if (n > 0) {
      writeFileSync(path, out, "utf8");
      console.log(`  ${path.slice(root.length + 1).padEnd(34)} ${n} Payloads ersetzt`);
    }
  }
  console.log(`\n${rewrites.size} umgewandelt, ${already} bereits im Ankermodell, ${failed} fehlgeschlagen.`);
}
if (failed > 0) process.exitCode = 1;
