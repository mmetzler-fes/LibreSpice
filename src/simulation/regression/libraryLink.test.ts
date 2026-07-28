import { useCircuitStore } from "@store/circuitStore.js";
import { useLibraryStore } from "@store/libraryStore.js";
import { ModelParser } from "@core/library/ModelParser.js";
import { withSymbols } from "@editor/regression/withSymbols.js";
import type { TestReport } from "@editor/regression/svgExport.test.js";

/**
 * Every shipped schematic netlists the parts it names.
 *
 * A library part is referenced by name in the `.asc` and defined elsewhere,
 * exactly as in LTSpice. Joining the two used to happen once, while the file
 * was being read, against whatever the library held at that instant — and the
 * library arrives over the network. Miss that instant and the part netlists as
 * `X1 N9 N8 N7 N6 UNKNOWN`: not a warning, not an empty line, a reference to a
 * subcircuit that exists nowhere. ngspice stops with "unknown subckt" and the
 * sheet yields nothing, while everything on screen looks connected.
 *
 * Worse, the failure was silent in exactly the situation that produced it. The
 * definitions are emitted by *reference*, so an unlinked part also suppresses
 * the `.subckt` block it needed — the netlist ends up self-consistently wrong.
 *
 * Two cases, because the fix has two halves:
 *
 *   1. **No library at all**, as on a deployment without the backend, or before
 *      its first response. The defaults compiled into the bundle have to carry
 *      the sheet on their own (`bundledLibrary.ts`).
 *   2. **The library arrives late** — the sheet is already open when the fetch
 *      lands. Nothing used to come back to the part; `regenerateNetlist` now
 *      links it at the moment it collects the definitions.
 *
 * Read off the netlist, not from a run: the question is whether every `X` line
 * names a subcircuit the same netlist defines, and that is text.
 */

type Case = { name: string; run: (fail: (r: string) => void) => Promise<void> };

const st = () => useCircuitStore.getState();
const tick = () => new Promise((r) => setTimeout(r, 0));

/** Node's `fs`/`path`, via a runtime specifier so `tsc` stays out of it. */
async function nodeApi(): Promise<any> {
  const load = (m: string) => import(/* @vite-ignore */ m);
  const [fs, path] = await Promise.all([load("node:fs"), load("node:path")]);
  return { fs, path, proc: (globalThis as any).process };
}

/** The served library, as the app would have fetched it from `library/sub`. */
async function servedEntries(): Promise<{ entry: unknown; scope: string }[]> {
  const { fs, path, proc } = await nodeApi();
  const dir = path.join(proc.cwd(), "library/sub");
  const out: { entry: unknown; scope: string }[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".lib")) continue;
    try {
      for (const e of ModelParser.parse(fs.readFileSync(path.join(dir, f), "latin1")).entries) {
        out.push({ entry: e, scope: "server" });
      }
    } catch { /* a malformed drop-in is not this suite's business */ }
  }
  return out;
}

/** Every `.asc` directly under a directory, as full paths. */
async function ascFiles(dir: string): Promise<string[]> {
  const { fs, path, proc } = await nodeApi();
  const root = path.join(proc.cwd(), dir);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .filter((n: string) => n.endsWith(".asc"))
    .sort()
    .map((n: string) => path.join(root, n));
}

/**
 * The subcircuits a netlist instantiates but never defines.
 *
 * `UNKNOWN` is called out by name because it is not a missing part but the
 * placeholder for an unlinked one — the two want different fixes, so the report
 * says which it is.
 */
function danglingSubckts(netlist: string): string[] {
  const defined = new Set<string>();
  for (const l of netlist.split(/\r?\n/)) {
    const m = /^\s*\.subckt\s+(\S+)/i.exec(l);
    if (m) defined.add(m[1].toLowerCase());
  }
  const bad: string[] = [];
  for (const l of netlist.split(/\r?\n/)) {
    if (!/^\s*[Xx]\S*\s/.test(l)) continue;
    // `X<name> <nodes…> <subckt> [params]`: the subcircuit is the last token
    // that is not a `key=value` parameter.
    const tok = l.trim().split(/\s+/).filter((t) => !t.includes("="));
    const name = tok[tok.length - 1];
    if (!name) continue;
    if (name.toUpperCase() === "UNKNOWN") bad.push(`${tok[0]}: unlinked (UNKNOWN)`);
    else if (!defined.has(name.toLowerCase())) bad.push(`${tok[0]}: no .subckt ${name}`);
  }
  return bad;
}

/** Loads a sheet and returns whatever its netlist leaves dangling. */
async function checkSheet(file: string): Promise<string[]> {
  const { fs } = await nodeApi();
  st().clearCircuit();
  st().loadFromAsc(fs.readFileSync(file, "latin1"));
  await tick(); await tick();
  st().rebuildConnections();
  await tick();
  st().regenerateNetlist();
  await tick();
  return danglingSubckts(st().netlist);
}

const CASES: Case[] = [
  {
    // The deployment without a backend, and the window before its first reply.
    name: "every shipped schematic netlists with no library loaded at all",
    run: async (fail) => {
      const { path } = await nodeApi();
      useLibraryStore.setState({ entries: [], serverAvailable: false } as never);
      const files = [...(await ascFiles("examples")), ...(await ascFiles("examples/Rahm"))];
      if (files.length === 0) return fail("no examples/*.asc found — wrong working directory?");
      const bad: string[] = [];
      for (const f of files) {
        const d = await checkSheet(f);
        if (d.length) bad.push(`${path.basename(f)}: ${d.join(", ")}`);
      }
      if (bad.length) fail(bad.slice(0, 6).join(" | ") + (bad.length > 6 ? ` (+${bad.length - 6})` : ""));
    },
  },
  {
    // The race: the sheet is open before the fetch lands. Nothing else prompts
    // a re-link, so the netlist itself has to ask the library each time.
    name: "a library arriving after the sheet still links its parts",
    run: async (fail) => {
      const { fs, path, proc } = await nodeApi();
      const file = path.join(proc.cwd(), "examples/Rahm/6_2_1_Asynchroner_Frequenzteiler_Lsg.asc");
      if (!fs.existsSync(file)) return fail(`missing ${file}`);

      useLibraryStore.setState({ entries: [], serverAvailable: false } as never);
      st().clearCircuit();
      st().loadFromAsc(fs.readFileSync(file, "latin1"));
      await tick(); await tick();

      // …and only now does `api/library` answer.
      useLibraryStore.setState({ entries: await servedEntries(), serverAvailable: true } as never);
      st().rebuildConnections();
      await tick();
      st().regenerateNetlist();
      await tick();

      const dangling = danglingSubckts(st().netlist);
      if (dangling.length) return fail(dangling.join(", "));
      // The point of the sheet: the display is what the counter drives.
      if (!/^\s*X1\s+.*\bseg7hex\b/im.test(st().netlist)) {
        fail(`X1 does not name seg7hex: ${st().netlist.split(/\r?\n/).find((l) => /^\s*X1\b/i.test(l)) ?? "(no X1 line)"}`);
      }
    },
  },
  {
    // The floor itself. Without this the two cases above would also pass on an
    // app that simply has no parts, by having nothing to link.
    name: "the curated defaults are compiled into the bundle",
    run: async (fail) => {
      const { bundledEntries } = await import("@core/library/bundledLibrary.js");
      const entries = bundledEntries();
      if (entries.length === 0) {
        return fail("no bundled entries — is library/ inside the Vite root and the Docker context?");
      }
      // Named by shipped schematics; a missing one is a broken example.
      for (const name of ["seg7hex", "pot", "LM317/TI", "74LS93", "opamp"]) {
        if (!entries.some((e) => e.name.toLowerCase() === name.toLowerCase())) {
          fail(`bundled library has no "${name}"`);
        }
      }
    },
  },
];

export async function runLibraryLinkTests(): Promise<TestReport> {
  return await withSymbols(async () => {
    const failures: { name: string; reason: string }[] = [];
    let total = 0;
    const saved = useLibraryStore.getState().entries;
    for (const c of CASES) {
      total++;
      try {
        await c.run((reason) => failures.push({ name: c.name, reason }));
      } catch (err) {
        failures.push({ name: c.name, reason: String((err as Error)?.message ?? err) });
      }
    }
    useLibraryStore.setState({ entries: saved } as never);
    return { total, passed: total - failures.length, failures };
  });
}
