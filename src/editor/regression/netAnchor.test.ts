import { useCircuitStore } from "@store/circuitStore.js";
import { LTSpiceExporter } from "@core/ltspice/LTSpiceExporter.js";
import { formatAnchor, isGroundAnchor, anchorsFromNodes, type NetAnchor } from "@core/circuit/netAnchor.js";
import { resolveAnchors } from "@editor/anchorNets.js";
import { withSymbols } from "./withSymbols.js";

/**
 * Names are coordinates, and this is what holds that model to account.
 *
 * A `.asc` `FLAG` is a name at a point. We used to model it as a node with a
 * pin, joined by edges — part of the topology — and that one decision was behind
 * the label dragging its wire, the splicing of labels out of routes before
 * writing them, and a second name on a net overwriting the first. Anchors
 * replaced it: a name owns no pin, no edge and no netlist line, and finds its
 * net by lying on one.
 *
 * Three claims are checked here, over every bundled schematic:
 *
 *   1. what the store holds is what the file gets — the anchors (plus ground,
 *      the one name that is still a part) reproduce every `FLAG`/`IOPIN` line
 *      the exporter writes;
 *   2. the names survive the trip — saving and re-reading yields the same set,
 *      so no name is invented, dropped or moved by a round trip;
 *   3. the names name the right nets — each anchor resolves, geometrically, to
 *      a net that actually carries its name.
 *
 * Plus the editing case that the old node model got wrong: moving a name must
 * not move the wire, and must re-resolve to whatever it now lies on.
 */

const tick = () => new Promise((r) => setTimeout(r, 0));
const st = () => useCircuitStore.getState();

/**
 * Every name on the sheet: the anchors, plus ground.
 *
 * Ground is the one flag that is also a part — on our sheet it is a drawn symbol
 * with a pin the netlist ties to node 0 — so its anchor is derived back from the
 * node. `anchorsFromNodes` is that derivation, and the union is what the file
 * gets.
 */
function allAnchors(s: ReturnType<typeof st>): NetAnchor[] {
  return [...anchorsFromNodes(s.nodes), ...s.netAnchors];
}

/** Save the current store exactly as the Save button does. */
function exportCurrent(): string {
  const s = st();
  return LTSpiceExporter.export(
    s.nodes, s.edges, s.spiceDirectives, s.circuit, s.dataFlags, s.textBoxes, s.sheetShapes,
    { directiveRaw: s.directiveRaw, header: s.ascHeader, orphanWires: s.ascOrphanWires, anchors: s.netAnchors, busTaps: s.busTaps },
  );
}

/** `FLAG`/`IOPIN` lines, sorted — their order in the file carries no meaning. */
function flagLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^(FLAG|IOPIN)\s/.test(l))
    .sort();
}

export async function runNetAnchorTests(): Promise<{ total: number; passed: number; failures: { name: string; reason: string }[] }> {
  const failures: { name: string; reason: string }[] = [];
  let total = 0;
  const fail = (name: string, reason: string) => { failures.push({ name, reason }); };

  return await withSymbols(async () => {
    const load = (m: string) => import(/* @vite-ignore */ m);
    const [fs, path] = await Promise.all([load("node:fs"), load("node:path")]);
    const dir = path.resolve("examples");
    const files: string[] = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f: string) => f.endsWith(".asc")).sort()
      : [];

    // ── 1. What the store holds is what the file gets ──────────────────────
    for (const file of files) {
      total++;
      const name = `the store's names are the file's flags: ${file}`;
      try {
        st().clearCircuit();
        st().loadFromAsc(fs.readFileSync(path.join(dir, file), "latin1"));
        await tick(); await tick();

        const s = st();
        const written = flagLines(LTSpiceExporter.export(
          s.nodes, s.edges, s.spiceDirectives, s.circuit, s.dataFlags, s.textBoxes, s.sheetShapes,
          { directiveRaw: s.directiveRaw, header: s.ascHeader, orphanWires: s.ascOrphanWires, anchors: s.netAnchors, busTaps: s.busTaps },
        ));
        const fromAnchors = allAnchors(s).flatMap(formatAnchor).sort();

        if (written.join("\n") !== fromAnchors.join("\n")) {
          const only = (a: string[], b: string[]) => a.filter((x) => !b.includes(x));
          fail(name,
            `nodes wrote ${written.length} lines, anchors ${fromAnchors.length}\n` +
            `    only from nodes:   ${only(written, fromAnchors).slice(0, 6).join(" | ") || "—"}\n` +
            `    only from anchors: ${only(fromAnchors, written).slice(0, 6).join(" | ") || "—"}`);
        }
      } catch (e) {
        fail(name, `threw: ${(e as Error).message}`);
      }
    }

    // ── 2. The names survive the round trip ────────────────────────────────
    // Saving and re-reading must yield the same names at the same points. This
    // is the check the old model could not have passed quietly: a label was a
    // node on the net, so a net carrying two names lost one of them to
    // `applyNetNames` and the file came back a name short.
    for (const file of files) {
      total++;
      const name = `names survive a save and re-read: ${file}`;
      try {
        st().clearCircuit();
        st().loadFromAsc(fs.readFileSync(path.join(dir, file), "latin1"));
        await tick(); await tick();
        const before = allAnchors(st()).flatMap(formatAnchor).sort();

        const saved = exportCurrent();
        st().clearCircuit();
        st().loadFromAsc(saved);
        await tick(); await tick();
        const after = allAnchors(st()).flatMap(formatAnchor).sort();

        if (before.join("\n") !== after.join("\n")) {
          const only = (a: string[], b: string[]) => a.filter((x) => !b.includes(x));
          fail(name,
            `${before.length} names in, ${after.length} out\n` +
            `    lost:  ${only(before, after).slice(0, 6).join(" | ") || "—"}\n` +
            `    gained: ${only(after, before).slice(0, 6).join(" | ") || "—"}`);
        }
      } catch (e) {
        fail(name, `threw: ${(e as Error).message}`);
      }
    }

    // ── 3. Each name lands on a net that carries it ────────────────────────
    // The one genuinely new mechanism: with no edge to ride on, an anchor finds
    // its net by lying on a wire or a pin. So every anchor that resolves must
    // resolve to a net that really is named that — either the winning name or
    // one of its aliases, both of which the file records on purpose.
    for (const file of files) {
      total++;
      const name = `every name lands on a net that carries it: ${file}`;
      try {
        st().clearCircuit();
        st().loadFromAsc(fs.readFileSync(path.join(dir, file), "latin1"));
        await tick(); await tick();
        const s = st();

        const resolved = resolveAnchors(s, "en");
        // Every name sitting on each net, so an alias counts as carried too.
        const namesOn = new Map<string, string[]>();
        for (const a of s.netAnchors) {
          const nid = resolved.get(a.id);
          if (nid) namesOn.set(nid, [...(namesOn.get(nid) ?? []), a.name]);
        }

        const wrong: string[] = [];
        for (const a of s.netAnchors) {
          const nid = resolved.get(a.id);
          // A name reaching nothing is allowed and LTSpice writes them:
          // `leitungstest.asc` parks `x3` and `nc3` clear of every wire.
          if (!nid) continue;
          const net = s.circuit.nets.get(nid);
          if (!net) { wrong.push(`${a.name}@${a.x},${a.y}: net ${nid} does not exist`); continue; }
          const carried = namesOn.get(nid) ?? [];
          // Ground takes any number of names and keeps calling itself GND —
          // `OP-inv_Verstärker.asc` labels the op-amp's earthed input `U+`, which
          // is a name on net 0, not a rival name for it.
          const ok = nid === "0" || net.nodeLabel === a.name || carried.includes(net.nodeLabel) || isGroundAnchor(a);
          if (!ok) wrong.push(`${a.name}@${a.x},${a.y}: net reads "${net.nodeLabel}"`);
        }
        if (wrong.length) fail(name, wrong.slice(0, 6).join("\n    "));
      } catch (e) {
        fail(name, `threw: ${(e as Error).message}`);
      }
    }

    // ── Moving a name moves nothing else ───────────────────────────────────
    // The failure the whole model exists to prevent. A label was a node with a
    // pin, so nudging it dragged the wire's endpoint along — moving `U1` in
    // 06-2-2_RC_HP1 by 40px turned a straight wire into a diagonal. An anchor is
    // not in the topology, so the wires must come out byte-identical, and the
    // name must re-resolve to whatever it now lies on.
    total++;
    try {
      const file = path.resolve("examples", "05-2-3_Brummspannung1.asc");
      st().clearCircuit();
      st().loadFromAsc(fs.readFileSync(file, "latin1"));
      await tick(); await tick();

      const wiresOf = (asc: string) => asc.split(/\r?\n/).filter((l) => /^WIRE\s/.test(l.trim())).sort();
      const wiresBefore = wiresOf(exportCurrent());

      const ua1 = st().netAnchors.find((a) => a.name === "UA1");
      if (!ua1) throw new Error("no UA1 anchor in the fixture");

      st().moveNetAnchor(ua1.id, ua1.x + 48, ua1.y - 16);
      await tick();
      const wiresAfter = wiresOf(exportCurrent());
      if (wiresBefore.join("\n") !== wiresAfter.join("\n")) {
        fail("moving a name leaves the wires alone",
          `${wiresBefore.length} wires before, ${wiresAfter.length} after — the name is still in the topology`);
      }

      // And the flag itself did move, at the point the user dropped it.
      total++;
      const moved = st().netAnchors.find((a) => a.id === ua1.id);
      if (!moved || moved.x !== ua1.x + 48 || moved.y !== ua1.y - 16) {
        fail("the name itself moved", `expected ${ua1.x + 48},${ua1.y - 16}, got ${moved?.x},${moved?.y}`);
      }
      total++;
      if (!exportCurrent().includes(`FLAG ${ua1.x + 48} ${ua1.y - 16} UA1`)) {
        fail("the moved name is written at its new point", "no FLAG at the new coordinate");
      }

      // Renaming goes through the anchor and reaches the file.
      total++;
      st().updateNetAnchor(ua1.id, { name: "UAx" });
      await tick();
      const renamed = exportCurrent();
      if (!renamed.includes("UAx") || renamed.includes("UA1")) {
        fail("renaming a name reaches the file", "the file still reads UA1, or never got UAx");
      }

      // Deleting it takes the name off the net — and leaves the wires standing.
      total++;
      st().removeNetAnchor(ua1.id);
      await tick();
      const afterDelete = exportCurrent();
      if (afterDelete.includes("UAx")) fail("deleting a name removes its flag", "the flag is still in the file");
      total++;
      if (wiresOf(afterDelete).join("\n") !== wiresBefore.join("\n")) {
        fail("deleting a name leaves the wires alone", "the wires changed when the name went away");
      }
    } catch (e) {
      fail("moving a name leaves the wires alone", `threw: ${(e as Error).message}`);
    }

    // ── The shape of an anchor ─────────────────────────────────────────────
    // Ground is a flag named `0`, not a separate kind of thing — that is what
    // lets the anchor set cover every FLAG line rather than most of them.
    total++;
    const gnd = { id: "a", x: 0, y: 0, name: "0" };
    if (!isGroundAnchor(gnd) || !isGroundAnchor({ ...gnd, name: "GND" }) || isGroundAnchor({ ...gnd, name: "UB" })) {
      fail("ground is recognised wherever it appears", "0 and GND name the ground net, UB does not");
    }

    total++;
    const conn = formatAnchor({ id: "a", x: 16, y: 32, name: "UA", portType: "Out" });
    if (conn.join("\n") !== "FLAG 16 32 UA\nIOPIN 16 32 Out") {
      fail("a connector writes its FLAG and IOPIN", `got: ${conn.join(" | ")}`);
    }
    total++;
    const plain = formatAnchor({ id: "a", x: 16, y: 32, name: "UA" });
    if (plain.join("\n") !== "FLAG 16 32 UA") {
      fail("a plain label writes only its FLAG", `got: ${plain.join(" | ")}`);
    }

    return { total, passed: total - failures.length, failures };
  });
}
