// Bundles and runs the editor regression suite (SVG export routing) in Node.
// Mirrors run-library-tests.mjs but also resolves the project's path aliases
// (@sym, @store, …) and `.js` → `.ts` specifiers, as Vite does at dev time.
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const entry = resolve(root, "src/editor/regression/index.ts");
const outfile = resolve(root, "node_modules/.cache/librespice-editor-tests.mjs");

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
    // Map "@sym/asyParser.js" → "<root>/src/sym/asyParser.ts".
    b.onResolve({ filter: /^@(core|editor|store|simulation|oscilloscope|sym)\// }, (args) => {
      const [prefix, ...rest] = args.path.split("/");
      const base = resolve(ALIASES[prefix], rest.join("/"));
      const ts = base.replace(/\.js$/, ".ts");
      if (existsSync(ts)) return { path: ts };
      if (existsSync(base)) return { path: base };
      return undefined;
    });
    // Map relative "./foo.js" → "./foo.ts(x)" when a source file exists.
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
  // Keep node_modules (react, react-dom/server, @xyflow) external so Node
  // resolves them natively — bundling react-dom/server's CJS to ESM breaks its
  // dynamic `require("util")`.
  packages: "external",
  // asyParser uses Vite's `import.meta.glob`; Node has no such API, so replace
  // it with a shim that yields an empty symbol map.
  define: { "import.meta.glob": "globShim", "import.meta.env": '{"BASE_URL":"/"}' },
  inject: [resolve(__dirname, "glob-shim.js")],
  outfile,
  plugins: [aliasResolver],
  logLevel: "warning",
});

const { runAllSuites } = await import(pathToFileURL(outfile).href);
const suites = runAllSuites();

let anyFailed = false;
for (const s of suites) {
  console.log(`${s.name}: ${s.passed}/${s.total} passed`);
  for (const f of s.failures) {
    anyFailed = true;
    console.error(`  ✗ ${f.name}: ${f.reason}`);
  }
}
process.exit(anyFailed ? 1 : 0);
