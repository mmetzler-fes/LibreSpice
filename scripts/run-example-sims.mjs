// Runs every shipped schematic that carries an analysis directive through
// ngspice, one child process per sheet.
//
//   npm run test:examples                      # every corpus
//   npm run test:examples examples/Rahm        # one directory
//   npm run test:examples --budget 45          # seconds per sheet
//
// Separate from `test:editor` on purpose: this is the slow half of the corpus,
// and a `.tran 1e-3 2` is legitimately slow, while the pre-commit run has to
// stay one people actually run.
//
// **Why a process per sheet.** ngspice is a WASM call. A budget enforced with
// `Promise.race` inside one process only stops *waiting* — the abandoned run
// keeps a core busy and the queue behind it slows down with every straggler. The
// first version did that and took over three quarters of an hour on 77 sheets.
// A child can be killed, so the budget is real, and the parent stays responsive
// enough to print progress as it goes.
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve, join, basename } from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const bundle = resolve(root, "node_modules/.cache/librespice-example-sims.mjs");

const DIRS = [
  "examples",
  "examples/Rahm",
  "examples/Multisim_converted",
  "examples/Multisim14_converted",
];

/** Analysis directives a sheet must carry to be worth running. */
const ANALYSIS = /^\s*TEXT\b.*!\s*\.(tran|ac|dc|op|noise|four)\b/im;

// ── Child mode: one sheet, one answer ────────────────────────────────────────
// Reads the sheet, prints a single machine-readable line, exits. Everything
// ngspice writes to stdout on its own way out is noise the parent discards
// unless the sheet fails.
if (process.argv[2] === "--one") {
  const file = process.argv[3];
  const { simulateSheet } = await import(pathToFileURL(bundle).href);
  let outcome;
  try {
    outcome = await simulateSheet(readFileSync(file, "latin1"));
  } catch (err) {
    outcome = { kind: "error", detail: `load throws — ${String(err?.message ?? err)}`, analyses: [] };
  }
  console.log(`@@RESULT@@${JSON.stringify(outcome)}`);
  // ngspice's WASM instance keeps handles open; nothing here needs to outlive
  // the answer, and the parent has it.
  process.exit(0);
}

// ── Parent ───────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let budgetS = 20;
const bi = args.indexOf("--budget");
if (bi >= 0) { budgetS = Number(args[bi + 1]) || budgetS; args.splice(bi, 2); }
const dirs = args.length ? args : DIRS;

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
    b.onResolve({ filter: /^@(core|editor|store|simulation|oscilloscope|sym)\// }, (a) => {
      const [prefix, ...rest] = a.path.split("/");
      const base = resolve(ALIASES[prefix], rest.join("/"));
      const ts = base.replace(/\.js$/, ".ts");
      if (existsSync(ts)) return { path: ts };
      if (existsSync(base)) return { path: base };
      return undefined;
    });
    b.onResolve({ filter: /\.js$/ }, (a) => {
      if (!a.importer) return undefined;
      const base = resolve(dirname(a.importer), a.path);
      for (const ext of [".ts", ".tsx"]) {
        const cand = base.replace(/\.js$/, ext);
        if (existsSync(cand)) return { path: cand };
      }
      return undefined;
    });
  },
};

// Built once, imported by every child: bundling per sheet would cost more than
// the simulations.
await build({
  entryPoints: [resolve(root, "src/simulation/regression/exampleSims.test.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  jsx: "automatic",
  packages: "external",
  define: { "import.meta.glob": "globShim", "import.meta.env": '{"BASE_URL":"/"}' },
  inject: [resolve(__dirname, "glob-shim.js")],
  outfile: bundle,
  plugins: [aliasResolver],
  logLevel: "warning",
});

/** Runs one sheet in its own process, killed if it outstays the budget. */
function runOne(file) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--one", file], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    const started = Date.now();
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, budgetS * 1000);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const ms = Date.now() - started;
      if (signal === "SIGKILL") return done({ kind: "slow", ms });
      const line = out.split("\n").reverse().find((l) => l.startsWith("@@RESULT@@"));
      if (!line) {
        // No answer and not killed: the child died on its own. Its output is the
        // only clue there is, so it goes into the report rather than the void.
        const tail = (err || out).trim().split("\n").slice(-3).join(" / ");
        return done({ kind: "error", detail: `child exited ${code} without a result: ${tail}`, analyses: [] });
      }
      done(JSON.parse(line.slice("@@RESULT@@".length)));
    });
  });
}

let failures = 0;
for (const dir of dirs) {
  const full = resolve(root, dir);
  if (!existsSync(full)) continue; // git-ignored corpus, absent in a fresh clone
  // Filtered by a plain read, so no child is spawned for a sheet that is only a
  // drawing — that is most of the exercise corpus.
  const files = readdirSync(full)
    .filter((n) => n.endsWith(".asc"))
    .sort()
    .filter((n) => ANALYSIS.test(readFileSync(join(full, n), "latin1")));

  console.log(`### ${dir}: ${files.length} Blaetter mit Analyse`);
  let ok = 0, slow = 0;
  const bad = [];
  for (const f of files) {
    const r = await runOne(join(full, f));
    if (r.kind === "ok") ok++;
    else if (r.kind === "skip") continue;
    else if (r.kind === "slow") {
      slow++;
      console.log(`   ~ ${basename(f)}: ueber ${budgetS}s, abgebrochen`);
    } else {
      bad.push(`${basename(f)} [${(r.analyses ?? []).join(",")}]: ${r.detail}`);
      console.log(`   ✗ ${basename(f)} [${(r.analyses ?? []).join(",")}]: ${r.detail}`);
    }
  }
  console.log(`   ${ok} gerechnet, ${slow} ueber Budget, ${bad.length} fehlerhaft`);
  failures += bad.length;
}

console.log(failures ? `\n${failures} Blaetter rechnen nicht.` : "\nAlle Blaetter mit Analyse rechnen.");
process.exit(failures ? 1 : 0);
