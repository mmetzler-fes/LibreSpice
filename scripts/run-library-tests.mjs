// Bundles and runs the LTSpice library regression suite in Node.
// Uses esbuild's API with a resolver that maps the project's `.js` import
// specifiers onto their actual `.ts` sources (as Vite does at dev time).
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const entry = resolve(root, "src/core/library/regression/runRegression.ts");
const outfile = resolve(root, "node_modules/.cache/librespice-regression.mjs");

const jsToTs = {
  name: "js-to-ts",
  setup(b) {
    b.onResolve({ filter: /\.js$/ }, (args) => {
      if (!args.importer) return undefined;
      const tsPath = resolve(dirname(args.importer), args.path.replace(/\.js$/, ".ts"));
      if (existsSync(tsPath)) return { path: tsPath };
      return undefined;
    });
  },
};

await build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile,
  plugins: [jsToTs],
  logLevel: "warning",
});

const { runRegression } = await import(pathToFileURL(outfile).href);
const report = runRegression();

console.log(`LTSpice library regression: ${report.passed}/${report.total} passed`);
for (const f of report.failures) {
  console.error(`  ✗ ${f.name}: ${f.reason}`);
}
process.exit(report.failures.length === 0 ? 0 : 1);
