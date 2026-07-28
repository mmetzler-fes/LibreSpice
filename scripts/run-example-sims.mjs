// Runs every shipped schematic that carries an analysis directive through
// ngspice (see src/simulation/regression/exampleSims.test.ts).
//
// Separate from `test:editor` on purpose: this is the slow half of the corpus —
// a `.tran 1e-3 2` is legitimately slow — and the pre-commit run has to stay one
// people actually run. Bundling mirrors run-editor-tests.mjs.
//
//   npm run test:examples                 # every corpus
//   npm run test:examples examples/Rahm   # just one directory
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const entry = resolve(root, "src/simulation/regression/exampleSims.test.ts");
const outfile = resolve(root, "node_modules/.cache/librespice-example-sims.mjs");

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

const { runExampleSimTests } = await import(pathToFileURL(outfile).href);
const report = await runExampleSimTests(process.argv.slice(2));

console.log(`Beispiel-Simulationen: ${report.passed}/${report.total} Verzeichnisse ohne Fehler`);
for (const f of report.failures) console.error(`  ✗ ${f.name}: ${f.reason}`);
process.exit(report.failures.length ? 1 : 0);
