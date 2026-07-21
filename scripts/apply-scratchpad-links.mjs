// Applies the share links collected in `scratchpad_example_links.md` to the
// two places that actually ship them: `scripts/example-links.json` and the
// landing page `site/index.html`.
//
// Why transcribe rather than generate the payloads from the .asc files? Because
// a payload built from the schematic alone carries only the schematic. The links
// exported from the running app also carry the diagram configuration and the
// active scope probes, and those are the point — a link without them opens on an
// empty plot. The `.plt` beside a circuit is not a substitute either:
// 05-1-2_Transistor2_2.plt has no `Parametric:` line, while the exported payload
// does carry its V(C) x-axis. So the scratchpad is the source of truth, and this
// script only transcribes it.
//
// A `bake:examples` script used to generate them that way. It was removed: on
// top of dropping the plot settings it rebuilt site/index.html from a template
// of its own, which by then no longer had the page's quote, attribution or
// licence notice — running it would have silently deleted all three.
//
// Scratchpad shape: `##` opens a section, `###` an entry, and the *last* `#z=…`
// under an entry wins (the user pastes a fresh export below the old one, often
// labelled ALT:/NEU:).
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const scratchpad = resolve(root, "scratchpad_example_links.md");
const jsonPath = resolve(root, "scripts/example-links.json");
const htmlPath = resolve(root, "site/index.html");

// ── Parse the scratchpad ────────────────────────────────────────────────────
const sections = [];
let section = null;
let entry = null;
for (const raw of readFileSync(scratchpad, "utf8").split("\n")) {
  const h2 = raw.match(/^##(?!#)\s*(.+?)\s*$/);
  const h3 = raw.match(/^###\s*(.+?)\s*$/);
  if (h2) { section = { title: h2[1], items: [] }; sections.push(section); entry = null; continue; }
  if (h3) {
    if (!section) { section = { title: "Beispiele", items: [] }; sections.push(section); }
    // Drop a leading "12. " — the numbering is scratchpad bookkeeping, not a name.
    entry = { name: h3[1].replace(/^\d+\.\s*/, ""), z: null };
    section.items.push(entry);
    continue;
  }
  const z = raw.match(/#z=([A-Za-z0-9_\-]+)/);
  if (z && entry) entry.z = z[1];   // last one under this entry wins
}
for (const s of sections) s.items = s.items.filter((it) => it.z);
const live = sections.filter((s) => s.items.length > 0);

// ── Decode each payload to recover which .asc it came from ──────────────────
const outfile = resolve(root, "node_modules/.cache/librespice-decode.mjs");
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
await build({
  stdin: {
    contents: `export { decodeSnapshotCompressed } from "@store/persistence.js";`,
    resolveDir: root, loader: "ts",
  },
  bundle: true, format: "esm", platform: "node", jsx: "automatic", packages: "external",
  define: { "import.meta.glob": "globShim", "import.meta.env": '{"BASE_URL":"/"}' },
  inject: [resolve(__dirname, "glob-shim.js")],
  outfile, plugins: [aliasResolver], logLevel: "warning",
});
const { decodeSnapshotCompressed } = await import(pathToFileURL(outfile).href);

/** Existing name → file mapping, so an entry keeps its .asc when the payload can't say. */
const known = new Map();
if (existsSync(jsonPath)) {
  for (const s of JSON.parse(readFileSync(jsonPath, "utf8"))) {
    for (const it of s.items) known.set(it.name, it.file);
  }
}

/**
 * Directories a linked circuit may live in:
 *  - `examples/` — the hand-built set;
 *  - `examples/Multisim_converted/` — what the converter writes, replaced whole
 *    on every run;
 *  - `converted_from_multisim/` — schematics revised by hand in the app, which
 *    the converter no longer touches.
 *
 * The last two are where the digital circuits live; a link to one of those
 * recorded no file at all while only `examples/` was searched.
 *
 * The recorded `file` stays a bare basename: it is bookkeeping read back only by
 * this script, which searches every root again on the next run. Should the same
 * basename exist in more than one, the earlier root wins — so a hand-revised
 * copy is found before the generated one it was made from.
 */
const ASC_ROOTS = ["examples", "converted_from_multisim", "examples/Multisim_converted"];

/** A basename that really exists under one of the roots, trying umlaut spellings. */
function resolveAsc(name) {
  if (!name) return null;
  const swaps = [
    (s) => s,
    (s) => s.replace(/ae/g, "ä").replace(/oe/g, "ö").replace(/ue/g, "ü"),
    (s) => s.replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue"),
  ];
  for (const dir of ASC_ROOTS) {
    for (const f of swaps) {
      const cand = f(name);
      if (existsSync(resolve(root, `${dir}/${cand}.asc`))) return cand;
    }
  }
  return null;
}

for (const s of live) {
  for (const it of s.items) {
    const snap = await decodeSnapshotCompressed(it.z);
    const cn = snap?.circuitName;
    // The payload's own name first; then whatever the previous run recorded —
    // but only if that file is still there. A stale mapping is worse than none:
    // it points a later bake at a circuit that no longer exists (the `ae`/`ä`
    // duplicates were cleaned up, and the old name survived in the JSON).
    it.file = resolveAsc(cn) ?? resolveAsc(known.get(it.name)) ?? "";
    it.probes = snap?.selectedVariables?.length ?? 0;
    it.panels = snap?.plotSettings?.panels?.length ?? 0;
    it.xAxis = snap?.plotSettings?.panels?.map((p) => p.xTrace).filter(Boolean).join(",") || "";
    if (!it.file) console.error(`  ! ${it.name}: no .asc could be determined`);
  }
}

// ── Write example-links.json ────────────────────────────────────────────────
const json = live.map((s) => ({
  title: s.title,
  items: s.items.map((it) => ({ name: it.name, file: it.file, z: it.z })),
}));
writeFileSync(jsonPath, JSON.stringify(json, null, 2) + "\n", "utf8");

// ── Rewrite the card sections in site/index.html ────────────────────────────
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const cards = live.map((s) => {
  const items = s.items.map((it) => `          <a class="card" href="app/#z=${it.z}">
            <span class="card-name">${esc(it.name)}</span>
            <span class="card-open">Öffnen &amp; simulieren →</span>
          </a>`).join("\n");
  return `        <section class="cat">
          <h3>${esc(s.title)}</h3>
          <div class="grid">
${items}
          </div>
        </section>`;
}).join("\n");

const html = readFileSync(htmlPath, "utf8");
const startTag = '        <section class="cat">';
const start = html.indexOf(startTag);
const endTag = "        </section>\n      </div>";
const end = html.lastIndexOf(endTag);
if (start < 0 || end < 0) { console.error("could not locate the card block in site/index.html"); process.exit(1); }
writeFileSync(htmlPath, html.slice(0, start) + cards + "\n      </div>" + html.slice(end + endTag.length), "utf8");

// ── Report ──────────────────────────────────────────────────────────────────
for (const s of live) {
  console.log(`\n${s.title}`);
  for (const it of s.items) {
    const extras = [it.probes ? `${it.probes} Proben` : null, it.panels ? "Plot" : null,
                    it.xAxis ? `x=${it.xAxis}` : null].filter(Boolean).join(", ");
    console.log(`  ${it.name.padEnd(38)} ${(it.file || "?").padEnd(30)} ${extras}`);
  }
}
console.log(`\n${live.reduce((n, s) => n + s.items.length, 0)} Links in ${live.length} Abschnitten geschrieben.`);
