// Bakes the curated example circuits into `#z=…` share payloads and writes them
// to scripts/example-links.json, for the landing page (site/index.html) to link.
//
// The payloads are produced through the very app pipeline (loadFromAsc →
// exportSnapshot → encodeSnapshotCompressed), bundled to run in Node exactly as
// run-editor-tests.mjs bundles the store — same alias resolver and glob shim.
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const entry = resolve(root, "scripts/bake-entry.ts");
const outfile = resolve(root, "node_modules/.cache/librespice-bake.mjs");
const examplesDir = resolve(root, "examples");

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

await build({
  entryPoints: [entry],
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

const { bakeAsc } = await import(pathToFileURL(outfile).href);

/**
 * The curated set from the "Einführung LibreSpice" document, in its order and
 * grouping. `file` is the basename in examples/ (without .asc).
 */
const SECTIONS = [
  {
    title: "Grundschaltungen Gleichspannung",
    items: [
      { name: "Unbelasteter Spannungsteiler", file: "Spannungsteiler_unbelastet" },
      { name: "Belasteter Spannungsteiler", file: "05-2-2_Spannungsteiler1" },
      { name: "Spannungsteiler-Belastungskennlinie", file: "Spannungsteiler_Belastungskennlinie" },
      { name: "Brückenschaltung (Temperaturmessbrücke)", file: "Tempmessbruecke_NTC502AT_2" },
      { name: "Innenwiderstand / Spannungsanpassung", file: "05-2-1_Leistungsanpassung1" },
      { name: "Kondensator Auf-/Entladung", file: "04-2-2_RC_an_Pulsquelle" },
      { name: "Spule an Rechteckspannung", file: "06-1_Spule_AC1" },
    ],
  },
  {
    title: "Grundschaltungen Wechselspannung",
    items: [
      { name: "AC-Gleichrichtung (Brummspannung)", file: "05-2-3_Brummspannung1" },
      { name: "RLC-Reihenschwingkreis", file: "RLC_Reihenschwingkreis" },
      { name: "RLC-Parallelschwingkreis", file: "RLC_Parallelschwingkreis" },
      { name: "RC-Tiefpass", file: "06-2-1_RC_TP1" },
      { name: "RC-Hochpass", file: "06-2-2_RC_HP1" },
      { name: "RLC-Bandpass", file: "06-2-3_RC_BP1" },
    ],
  },
  {
    title: "Operationsverstärkerschaltungen",
    items: [
      { name: "Invertierender Komparator", file: "OP-invKomparator1" },
      { name: "Invertierender Verstärker", file: "OP-inv_Verstärker" },
      { name: "Nicht-invertierender Verstärker", file: "OP-nicht_inv_Verstaerker" },
      { name: "Nicht-invertierender Schmitt-Trigger", file: "OP-nichtinvSchmitt-Trigger1" },
      { name: "Invertierender Summierverstärker", file: "InvSummierverstaerker" },
      { name: "Rechteckgenerator", file: "Rechteckgenerator" },
    ],
  },
];

const out = [];
let failed = 0;
for (const section of SECTIONS) {
  const items = [];
  for (const it of section.items) {
    const ascPath = resolve(examplesDir, `${it.file}.asc`);
    if (!existsSync(ascPath)) { console.error(`  ✗ missing: ${it.file}.asc`); failed++; continue; }
    const asc = readFileSync(ascPath, "utf8");
    try {
      const z = await bakeAsc(asc, it.name);
      items.push({ name: it.name, file: it.file, z });
      console.log(`  ✓ ${it.name}  (${z.length} chars)`);
    } catch (e) {
      console.error(`  ✗ ${it.name}: ${e?.message ?? e}`);
      failed++;
    }
  }
  out.push({ title: section.title, items });
}

const jsonPath = resolve(__dirname, "example-links.json");
writeFileSync(jsonPath, JSON.stringify(out, null, 2) + "\n");
console.log(`\nWrote ${jsonPath}`);

// ── Render the landing page from the baked links ─────────────────────────────
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const sectionsHtml = out.map((sec) => {
  const cards = sec.items.map((it) =>
    `          <a class="card" href="app/#z=${it.z}">
            <span class="card-name">${esc(it.name)}</span>
            <span class="card-open">Öffnen &amp; simulieren →</span>
          </a>`).join("\n");
  return `        <section class="cat">
          <h3>${esc(sec.title)}</h3>
          <div class="grid">
${cards}
          </div>
        </section>`;
}).join("\n");

const page = `<!doctype html>
<html lang="de">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>LibreSpice</title>
    <script>
      // Deep-link forwarding for share links / QR codes. Older ones were made
      // when the app was hosted at the site root ("/#z=…"); the app now lives
      // under "app/". Any URL that carries a circuit payload (hash "#z=…"/"#c=…"
      // or a "?circuit=…" query) is forwarded to the app with the payload kept
      // intact — so existing links and QR codes still open their circuit. A
      // plain visit (no payload) stays on this landing page. The redirect is
      // relative ("app/"), so it works whatever subpath the site is mounted at.
      (function () {
        var h = location.hash;   // e.g. "#z=…" / "#c=…"
        var s = location.search; // e.g. "?circuit=…"
        if (/^#(z=|c=)/.test(h) || /[?&]circuit=/.test(s)) {
          location.replace("app/" + s + h);
        }
      })();
    </script>
    <style>
      :root { color-scheme: light dark; }
      * { box-sizing: border-box; }
      body {
        margin: 0; min-height: 100vh;
        font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        background: #f8fafc; color: #1e293b; padding: 24px;
        line-height: 1.6;
      }
      main { max-width: 860px; margin: 0 auto; }
      .hero {
        background: #fff; border: 1px solid #e2e8f0; border-radius: 12px;
        padding: 40px; box-shadow: 0 10px 30px rgba(0,0,0,0.06);
      }
      h1 { margin: 0 0 4px; font-size: 32px; letter-spacing: -0.5px; }
      .tag { margin: 0 0 24px; color: #64748b; font-size: 15px; }
      p { line-height: 1.65; font-size: 15px; }
      ul { line-height: 1.8; padding-left: 20px; font-size: 15px; }
      .cta {
        display: inline-block; margin-top: 20px; padding: 12px 24px;
        background: #2563eb; color: #fff; text-decoration: none;
        border-radius: 8px; font-weight: 600; font-size: 15px;
      }
      .cta:hover { background: #1d4ed8; }
      .examples { margin-top: 40px; }
      .examples > h2 { font-size: 24px; letter-spacing: -0.3px; margin: 0 0 16px; }
      .credit {
        display: flex; gap: 12px; align-items: flex-start;
        background: #eff6ff; border: 1px solid #bfdbfe; border-left: 4px solid #2563eb;
        border-radius: 8px; padding: 14px 18px; margin: 0 0 28px; font-size: 14px; color: #1e3a8a;
      }
      .credit .icon { font-size: 18px; line-height: 1.4; }
      .cat { margin-bottom: 28px; }
      .cat h3 {
        font-size: 15px; text-transform: uppercase; letter-spacing: 0.5px;
        color: #64748b; margin: 0 0 12px; font-weight: 700;
      }
      .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
      .card {
        display: flex; flex-direction: column; gap: 6px;
        background: #fff; border: 1px solid #e2e8f0; border-radius: 10px;
        padding: 14px 16px; text-decoration: none; color: inherit;
        transition: border-color .15s, box-shadow .15s, transform .15s;
      }
      .card:hover { border-color: #2563eb; box-shadow: 0 6px 16px rgba(37,99,235,0.12); transform: translateY(-1px); }
      .card-name { font-weight: 600; font-size: 14.5px; }
      .card-open { font-size: 12.5px; color: #2563eb; }
      footer { margin-top: 40px; text-align: center; font-size: 12px; color: #94a3b8; }
      @media (prefers-color-scheme: dark) {
        body { background: #0f172a; color: #e2e8f0; }
        .hero { background: #1e293b; border-color: #334155; box-shadow: 0 10px 30px rgba(0,0,0,0.4); }
        .tag { color: #94a3b8; }
        .credit { background: #172554; border-color: #1e40af; color: #bfdbfe; }
        .cat h3 { color: #94a3b8; }
        .card { background: #1e293b; border-color: #334155; }
        .card:hover { border-color: #3b82f6; box-shadow: 0 6px 16px rgba(0,0,0,0.4); }
        .card-open { color: #60a5fa; }
        footer { color: #64748b; }
      }
    </style>
  </head>
  <body>
    <main>
      <div class="hero">
        <h1>LibreSpice</h1>
        <p class="tag">Ein SPICE-Schaltplaneditor und Simulator im Browser.</p>

        <p>
          LibreSpice ist ein freier, browserbasierter Editor zum Zeichnen
          elektronischer Schaltpläne und zum Simulieren ihres Verhaltens — ganz
          ohne Installation. Bauteile werden per Klick platziert, verdrahtet und
          über eine eingebettete SPICE-Engine analysiert.
        </p>

        <ul>
          <li>Schaltpläne zeichnen (R, C, L, Dioden, Transistoren, Quellen, Op-Amps …)</li>
          <li>Transienten-, AC-, DC- und Arbeitspunkt-Analyse</li>
          <li>Import von LTSpice-Modellen (<code>.asc</code>, <code>.model</code>, <code>.subckt</code>)</li>
          <li>Ergebnisse als Wellenform anzeigen und Schaltpläne als SVG exportieren</li>
        </ul>

        <a class="cta" href="app/">Zur App →</a>
      </div>

      <div class="examples">
        <h2>Beispielschaltungen</h2>
        <div class="credit">
          <span class="icon">ℹ️</span>
          <span>Die Schaltungsbeispiele stammen von <strong>Jürgen Richter</strong> und
          werden mit seiner freundlichen Genehmigung verwendet. Ein Klick öffnet die
          Schaltung direkt im Editor — bereit zum Simulieren und Bearbeiten.</span>
        </div>

${sectionsHtml}
      </div>

      <footer>
        Freie Software · Zum Starten auf „Zur App" klicken oder ein Beispiel öffnen.
      </footer>
    </main>
  </body>
</html>
`;

const sitePath = resolve(root, "site/index.html");
writeFileSync(sitePath, page);
console.log(`Wrote ${sitePath}`);
process.exit(failed ? 1 : 0);
