import { readMs14, explode } from "@core/multisim/ms14.js";
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

  return { total, passed: total - failures.length, failures };
}
