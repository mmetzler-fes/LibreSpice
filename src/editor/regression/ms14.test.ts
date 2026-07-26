import { readMs14, explode } from "@core/multisim/ms14.js";
import { ms14ToSchematic } from "@core/multisim/ms14Schematic.js";
import { convert } from "@core/multisim/MultisimConverter.js";
import { LTSpiceParser } from "@core/ltspice/LTSpiceParser.js";
import type { TestReport } from "./svgExport.test.js";

/**
 * Reading Multisim 14 files.
 *
 * The format is XML, but three quarters of the bundled files are packed with
 * PKWARE's DCL "implode" — not zlib, gzip, bzip2 or lzma, so a packed file looks
 * like noise and gives no hint of what it is. This suite runs the decoder over
 * every `.ms14` there is, because a compression bug does not fail loudly: it
 * yields plausible-looking bytes that are not the document.
 *
 * Each file is therefore checked for what it must contain, not merely for
 * decoding without an exception.
 *
 * The second half is the reading proper (see ms14Schematic.ts): every file must
 * yield a schematic whose parts, pins and nets hang together, and the whole
 * corpus is held to that — a reader that quietly loses half a document still
 * produces something that looks like a schematic. `OPV Invertierend` is then
 * checked value by value, because the parameters are *positional* in this format
 * (`#5` is the fifth slot of a flat list, and which slot means what comes from the
 * part's SPICE template): a mapping that slips by one still yields a plausible
 * circuit, with the wrong numbers in it.
 */
export async function runMs14Tests(): Promise<TestReport> {
  const failures: { name: string; reason: string }[] = [];
  let total = 0;
  const fail = (name: string, reason: string) => failures.push({ name, reason });

  const load = (m: string) => import(/* @vite-ignore */ m);
  const [fs, path] = await Promise.all([load("node:fs"), load("node:path")]);

  const root = path.resolve("examples/Multisim14");
  const files: string[] = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.ms14$/i.test(e.name)) files.push(p);
    }
  };
  walk(root);

  for (const file of files) {
    total++;
    const name = `reads ${path.relative(root, file)}`;
    try {
      const buf = fs.readFileSync(file);
      const xml = readMs14(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      if (!xml.startsWith("<?xml")) { fail(name, "no XML declaration"); continue; }
      if (!xml.includes("MSMElectronicsWorkbench")) { fail(name, "not a Workbench document"); continue; }
      // A schematic has parts and wires; an empty-looking decode would pass the
      // two checks above and fail this one.
      if (!xml.includes("CIITSymbolComp")) fail(name, "no parts in the document");
    } catch (e) {
      fail(name, `threw: ${(e as Error).message}`);
    }
  }

  if (files.length === 0) fail("the Multisim 14 corpus is present", "no .ms14 files found");

  // ── the document as a schematic ─────────────────────────────────────────
  for (const file of files) {
    total++;
    const name = `reads the schematic of ${path.relative(root, file)}`;
    try {
      const buf = fs.readFileSync(file);
      const sch = ms14ToSchematic(readMs14(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)));
      const problems: string[] = [];
      if (!sch.parts.length) problems.push("no parts");
      if (!sch.nets.length) problems.push("no nets");
      if (!sch.wires.length) problems.push("no wires");

      // A part with no pin at all cannot be placed, and every pin a *net* names
      // has to be one the part actually declares — that join is what the whole
      // reading rests on (a pin carries its port's id, the port names the part).
      const byGuid = new Map(sch.parts.map((p) => [p.guid, p]));
      const pinless = sch.parts.filter((p) => Object.keys(p.pins).length === 0);
      if (pinless.length) problems.push(`${pinless.length} parts without pins (${pinless[0].typeName})`);
      let orphan = 0;
      for (const net of sch.nets) {
        for (const q of net.pins) {
          const part = byGuid.get(q.component);
          if (part && !Object.values(part.connPin).includes(q.pin)) orphan++;
        }
      }
      if (orphan) problems.push(`${orphan} net pins name a connection their part has not got`);

      // A pin at the sheet's own origin is the tell-tale of a pin read from a
      // symbol that does not draw it — the supply pins of a 74xx package are
      // shared by four gate symbols and drawn on none of them.
      const atOrigin = sch.parts.reduce(
        (n, p) => n + Object.values(p.pins).filter(([x, y]) => x === 0 && y === 0).length, 0);
      if (atOrigin) problems.push(`${atOrigin} pins at (0,0)`);

      // The same tell-tale one level up: a part whose placement could not be read
      // lands at the sheet's corner, and a whole sheet of them stacks there. It
      // reads as a schematic — right parts, right nets — while every wire between
      // them is a short. No file in the corpus draws a part at the origin, so one
      // sitting there is the reading having failed, not the author's doing.
      const partsAtOrigin = sch.parts.filter((p) => (p.matrix.e ?? 0) === 0 && (p.matrix.f ?? 0) === 0);
      if (partsAtOrigin.length) problems.push(`${partsAtOrigin.length} parts at (0,0)`);

      // Converted and read back: the two things the reading is *for*. Whether a
      // part *can* be converted is not this suite's business — the converter says
      // which types it has no entry for, and three of these sheets are built
      // entirely from 74xx packages it has none for. What is checked is that
      // nothing gets lost between the two: if any part could be mapped, the
      // schematic that comes back has to contain something.
      const res = convert(sch);
      const { nodes } = LTSpiceParser.parse(res.asc);
      if (sch.parts.some((p) => !res.skipped.includes(p.typeName)) && !nodes.length) {
        problems.push("every mappable part was lost on the way to the .asc");
      }

      if (problems.length) fail(name, problems.join("; "));
    } catch (e) {
      fail(name, `threw: ${(e as Error).message}`);
    }
  }

  // ── one file, value by value ─────────────────────────────────────────────
  // An inverting amplifier: a 1 V / 1 kHz sine on a 1k input resistor, 2k in the
  // feedback path, an ideal three-terminal op-amp, two grounds. Every number here
  // comes out of a positional parameter slot.
  total++;
  {
    const name = "OPV Invertierend arrives with its values";
    const file = path.join(root, "OPV Invertierend.ms14");
    try {
      const buf = fs.readFileSync(file);
      const sch = ms14ToSchematic(readMs14(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)));
      const by = (label: string) => sch.parts.find(
        (p) => `${p.refdes.prefix ?? ""}${p.refdes.number ?? ""}` === label);
      const problems: string[] = [];
      const r1 = by("R1"), rk = by("Rk"), v2 = by("V2"), u1 = by("U1");
      if (r1?.typeName !== "Resistor" || r1?.params.Resistance !== "1k") {
        problems.push(`R1 is ${r1?.typeName} ${r1?.params.Resistance}, not a 1k Resistor`);
      }
      if (rk?.params.Resistance !== "2k") problems.push(`Rk is ${rk?.params.Resistance}, not 2k`);
      if (v2?.typeName !== "AC Voltage" || v2?.params.VA !== "1" || v2?.params.Freq !== "1k") {
        problems.push(`V2 is ${v2?.typeName} with VA=${v2?.params.VA} Freq=${v2?.params.Freq}`);
      }
      if (u1?.typeName !== "3 Terminal Opamp") problems.push(`U1 is ${u1?.typeName}`);
      // The op-amp's three connections are named, not numbered, and each has to
      // have landed on its own point.
      const spots = new Set(Object.values(u1?.pins ?? {}).map((q) => q.join(",")));
      if (Object.keys(u1?.pins ?? {}).sort().join(",") !== "IN+,IN-,OUT") {
        problems.push(`U1 pins are ${Object.keys(u1?.pins ?? {}).join(",")}`);
      }
      if (spots.size !== 3) problems.push(`U1's pins share a position: ${[...spots].join(" ")}`);
      if (sch.connectors.filter((c) => c.kind === "ground").length !== 2) {
        problems.push(`${sch.connectors.filter((c) => c.kind === "ground").length} grounds, not 2`);
      }
      if (problems.length) fail(name, problems.join("; "));
    } catch (e) {
      fail(name, `threw: ${(e as Error).message}`);
    }
  }

  // The decoder must reject rather than invent: a stream with an impossible
  // header is a bug somewhere upstream, not something to paper over.
  total++;
  try {
    explode(Uint8Array.from([9, 6, 0, 0]));
    fail("an impossible literal mode is rejected", "no error raised");
  } catch { /* expected */ }

  total++;
  try {
    explode(Uint8Array.from([0, 9, 0, 0]));
    fail("an impossible dictionary size is rejected", "no error raised");
  } catch { /* expected */ }

  // ── the behavioural sources' node names ──────────────────────────────────
  // An ABM source states its value as an expression over the circuit's nodes,
  // and Multisim writes it in *its* node names. Two things have to hold, and
  // neither announces itself when it does not: the names have to be translated
  // the way every other net is, and the nets they name have to be labelled on
  // the sheet — a numbered net is otherwise left unlabelled wherever the wiring
  // already joins it, the netlist calls it something of its own, and the
  // expression reads a node nobody has. No error anywhere, just a source that
  // sits at zero.
  total++;
  {
    const name = "a behavioural source reads nodes the sheet actually carries";
    const file = path.join(root, "Node and Net Fundamentals", "Simple Net Current Problem Ver 2.ms14");
    try {
      const buf = fs.readFileSync(file);
      const res = convert(ms14ToSchematic(readMs14(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))));
      const specs = res.asc.split("\n").filter((l: string) => /^SYMATTR Value [VI] = /.test(l));
      const problems: string[] = [];
      if (specs.length < 3) problems.push(`only ${specs.length} behavioural sources`);
      // Multisim's bare numbers must not survive: `V(6,8)` is not a node here.
      for (const spec of specs) {
        if (/[VI]\(\s*\d/.test(spec)) problems.push(`untranslated node name: ${spec}`);
      }
      // Every node an expression names has to be a label on the sheet.
      const labels = new Set(
        res.asc.split("\n").flatMap((l: string) => /^FLAG -?\d+ -?\d+ (.+)$/.exec(l)?.[1].trim() ?? []));
      for (const spec of specs) {
        for (const m of spec.matchAll(/\bV\s*\(([^)]*)\)/gi)) {
          for (const a of m[1].split(",")) {
            const n = a.trim();
            if (n !== "0" && !labels.has(n)) problems.push(`${n} is read but never labelled`);
          }
        }
      }
      if (problems.length) fail(name, problems.join("; "));
    } catch (e) {
      fail(name, `threw: ${(e as Error).message}`);
    }
  }

  return { total, passed: total - failures.length, failures };
}
