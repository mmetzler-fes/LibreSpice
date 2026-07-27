import { useCircuitStore } from "@store/circuitStore.js";
import { useUIStore } from "@store/uiStore.js";
import { LTSpiceExporter } from "@core/ltspice/LTSpiceExporter.js";
import { formatAnchor, isGroundAnchor, anchorsFromNodes, type NetAnchor } from "@core/circuit/netAnchor.js";
import { resolveAnchors } from "@editor/anchorNets.js";
import { anchorBoxes, anchorsInBand } from "@editor/anchorHitBox.js";
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
    { directiveRaw: s.directiveRaw, header: s.ascHeader, anchors: s.netAnchors, busTaps: s.busTaps },
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
          { directiveRaw: s.directiveRaw, header: s.ascHeader, anchors: s.netAnchors, busTaps: s.busTaps },
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

    // ── A converted name belongs to the pin it sits on ────────────────────
    // The converted sheets are where two names land closest together: the
    // INA333's two inputs are 32 units apart, each with its own name. A name is
    // resolved by what it lies on, so the two must not swap — which they did
    // when the converter still hung each name off a 16-unit stub and the stub
    // was invisible to the resolution (it belonged to no net yet), leaving the
    // neighbouring input's run 4 px away as the nearest thing to claim it.
    total++;
    try {
      const file = path.resolve("examples/Multisim_converted/1_4_2_PT100-Sensor_Bruecke_mit_INA333.asc");
      if (fs.existsSync(file)) {
        st().clearCircuit();
        st().loadFromAsc(fs.readFileSync(file, "latin1"));
        await tick(); await tick();
        st().rebuildConnections();

        const s = st();
        const op = s.nodes.find((n) => (n.data as { componentType?: string }).componentType === "opamp");
        if (!op) throw new Error("no op-amp in the fixture");
        const nameOf = (handle: string) => {
          const netId = s.circuit.components.get(op.id)?.ports.find((p) => p.id === `${op.id}-${handle}`)?.netId;
          return netId ? s.circuit.nets.get(netId)?.nodeLabel : undefined;
        };
        // `Ut` sits 12 px from In+ on its own stub; `N3` sits 20 px from In- on
        // another. Each must name the pin its stub ends on.
        if (nameOf("inp") !== "Ut" || nameOf("inn") !== "N3") {
          fail("a name on a stub names that stub's pin",
            `In+ = ${nameOf("inp")} (soll Ut), In- = ${nameOf("inn")} (soll N3)`);
        }
      }
    } catch (e) {
      fail("a name on a stub names that stub's pin", `threw: ${(e as Error).message}`);
    }

    // ── Delete removes the selected name ───────────────────────────────────
    // A name is neither a node nor an edge, so `deleteSelected` never saw it and
    // the Delete key did nothing on one. That is at its worst right after the
    // wire under a name is deleted: the name correctly stays (a FLAG is a point,
    // not a property of a wire), Delete is the next key reached for, and with it
    // dead the label reads as impossible to get rid of.
    total++;
    try {
      const ui = useUIStore;
      st().clearCircuit();
      await tick();
      const id = st().addNetAnchor(160, 160, "VX");
      ui.getState().setSelectedAnchorId(id);
      st().deleteSelected();
      await tick();
      if (st().netAnchors.some((a) => a.id === id)) fail("Delete removes the selected name", "the name survived");
      if (ui.getState().selectedAnchorIds.length) fail("Delete removes the selected name", "the selection was left pointing at a deleted name");
    } catch (e) {
      fail("Delete removes the selected name", `threw: ${(e as Error).message}`);
    }

    // …but only what the user is actually pointing at. A name nobody selected is
    // never swept up by deleting something else, however near it happens to lie —
    // which is the whole reason names are selected explicitly rather than by
    // proximity (see uiStore.selectedAnchorIds).
    total++;
    try {
      const ui = useUIStore;
      st().clearCircuit();
      await tick();
      const id = st().addNetAnchor(160, 160, "VX");
      ui.getState().setSelectedAnchorIds([]);
      st().setEdges([{ id: "e_sel", source: "a", target: "b", selected: true } as never]);
      st().deleteSelected();
      await tick();
      if (!st().netAnchors.some((a) => a.id === id)) {
        fail("deleting a wire leaves an unselected name alone", "the name went with the wire");
      }
    } catch (e) {
      fail("deleting a wire leaves an unselected name alone", `threw: ${(e as Error).message}`);
    }

    // A block selected as one is deleted as one. This is the half the old
    // behaviour got wrong: names were kept out of the selection entirely, so a
    // rubber band across a circuit deleted its parts and left its names hanging
    // over the hole.
    total++;
    try {
      const ui = useUIStore;
      st().clearCircuit();
      await tick();
      const keep = st().addNetAnchor(600, 600, "FAR");
      const goes = st().addNetAnchor(160, 160, "VX");
      ui.getState().setSelectedAnchorIds([goes]);
      st().setEdges([{ id: "e_sel", source: "a", target: "b", selected: true } as never]);
      st().deleteSelected();
      await tick();
      const left = st().netAnchors.map((a) => a.id);
      if (left.includes(goes)) fail("a selected block takes its names with it", "the selected name survived");
      if (!left.includes(keep)) fail("a selected block takes its names with it", "an unselected name went too");
    } catch (e) {
      fail("a selected block takes its names with it", `threw: ${(e as Error).message}`);
    }

    // ── The grid ───────────────────────────────────────────────────────────
    // The anchor snaps, the tag does not, and the split is the point: the anchor
    // decides which net is named, so it has to be able to land *exactly* on a
    // wire — and a wire only ever runs between grid points. Rounded merely to
    // whole numbers, a dragged name came to rest beside its wire and held on by
    // the resolution tolerance alone (`FLAG 303 487` in a hand-tidied sheet, two
    // thirds of a step off). The tag decides nothing, so it may sit wherever it
    // reads best.
    total++;
    try {
      st().clearCircuit();
      await tick();
      const id = st().addNetAnchor(0, 0, "VX");
      st().moveNetAnchor(id, 303.4, 487.8);
      await tick();
      const a = st().netAnchors.find((x) => x.id === id)!;
      if (a.x % 4 !== 0 || a.y % 4 !== 0) fail("a dragged name lands on the grid", `landed at ${a.x},${a.y}`);
      st().moveNetAnchorsBy([id], 7, 7);
      await tick();
      const b = st().netAnchors.find((x) => x.id === id)!;
      if (b.x % 4 !== 0 || b.y % 4 !== 0) fail("a dragged name lands on the grid", `group move left it at ${b.x},${b.y}`);
    } catch (e) {
      fail("a dragged name lands on the grid", `threw: ${(e as Error).message}`);
    }

    total++;
    try {
      st().clearCircuit();
      await tick();
      const id = st().addNetAnchor(160, 160, "VX");
      st().moveNetAnchorTag(id, { dx: 33, dy: -47 });
      await tick();
      const a = st().netAnchors.find((x) => x.id === id)!;
      if (a.tx !== 33 || a.ty !== -47) {
        fail("the tag is free of the grid", `offset snapped to ${a.tx},${a.ty}`);
      }
    } catch (e) {
      fail("the tag is free of the grid", `threw: ${(e as Error).message}`);
    }

    // ── The tag offset ─────────────────────────────────────────────────────
    // Where the name is *read* is not where it is *attached*. The offset moves
    // the first and must never touch the second — that separation is what lets a
    // label be dragged clear of a crowded corner without losing its net.
    total++;
    try {
      st().clearCircuit();
      await tick();
      const id = st().addNetAnchor(160, 160, "VX");
      st().moveNetAnchorTag(id, { dx: 48, dy: -64 });
      await tick();
      const moved = st().netAnchors.find((a) => a.id === id)!;
      if (moved.x !== 160 || moved.y !== 160) {
        fail("moving the tag leaves the anchor put", `anchor drifted to ${moved.x},${moved.y}`);
      }
      if (moved.tx !== 48 || moved.ty !== -64) {
        fail("moving the tag leaves the anchor put", `offset is ${moved.tx},${moved.ty}`);
      }
      // The `.asc` knows nothing about it: the exported line is the anchor's,
      // unchanged, which is what keeps a file with dragged tags readable by
      // LTSpice (and identical to one without them).
      if (formatAnchor(moved).join("\n") !== "FLAG 160 160 VX") {
        fail("moving the tag leaves the anchor put", `exported as ${formatAnchor(moved).join(" | ")}`);
      }
      st().moveNetAnchorTag(id, null);
      await tick();
      const reset = st().netAnchors.find((a) => a.id === id)!;
      if (reset.tx !== undefined || reset.ty !== undefined) {
        fail("moving the tag leaves the anchor put", "the offset survived being cleared");
      }
    } catch (e) {
      fail("moving the tag leaves the anchor put", `threw: ${(e as Error).message}`);
    }

    // A group move carries anchor and tag together, so a block keeps its layout.
    total++;
    try {
      st().clearCircuit();
      await tick();
      const a1 = st().addNetAnchor(100, 100, "A");
      const a2 = st().addNetAnchor(200, 200, "B");
      st().moveNetAnchorTag(a1, { dx: 32, dy: 32 });
      st().moveNetAnchorsBy([a1], 48, -16);
      await tick();
      const m = st().netAnchors.find((a) => a.id === a1)!;
      const still = st().netAnchors.find((a) => a.id === a2)!;
      if (m.x !== 148 || m.y !== 84) fail("a group move carries the tag along", `anchor at ${m.x},${m.y}`);
      if (m.tx !== 32 || m.ty !== 32) fail("a group move carries the tag along", `offset changed to ${m.tx},${m.ty}`);
      if (still.x !== 200 || still.y !== 200) fail("a group move carries the tag along", "an unlisted name moved too");
    } catch (e) {
      fail("a group move carries the tag along", `threw: ${(e as Error).message}`);
    }

    // ── What a rubber band catches ─────────────────────────────────────────
    // Names are drawn by an overlay, so React Flow's selection rectangle cannot
    // see them and the hit test is ours (see anchorHitBox). It is pure geometry
    // and therefore the one part of the selection that *can* be checked here —
    // the harness renders no React Flow, so how it feels is a manual question,
    // but where the boxes are is not.
    total++;
    try {
      const boxes = anchorBoxes(
        [
          { id: "a1", x: 100, y: 100, name: "VX" },
          { id: "a2", x: 400, y: 400, name: "FAR" },
          // Anchor far outside the band, tag dragged into it: the band should
          // still take it, because the tag is the thing the user drew around.
          { id: "a3", x: 900, y: 100, name: "PULLED", tx: -700, ty: 0 },
        ],
        [], [],
      );
      const hit = anchorsInBand(boxes, { x1: 60, y1: 60, x2: 260, y2: 200 });
      if (!hit.includes("a1")) fail("the rubber band catches the names inside it", "missed a name inside the band");
      if (hit.includes("a2")) fail("the rubber band catches the names inside it", "caught a name well outside it");
      if (!hit.includes("a3")) fail("the rubber band catches the names inside it", "missed a name whose tag was dragged into the band");
    } catch (e) {
      fail("the rubber band catches the names inside it", `threw: ${(e as Error).message}`);
    }

    // The band is drawn in any direction; dragging up-left must select the same
    // names as dragging down-right over the same rectangle.
    total++;
    try {
      const boxes = anchorBoxes([{ id: "a1", x: 100, y: 100, name: "VX" }], [], []);
      const down = anchorsInBand(boxes, { x1: 60, y1: 60, x2: 200, y2: 200 });
      const up = anchorsInBand(boxes, { x1: 200, y1: 200, x2: 60, y2: 60 });
      if (down.join() !== up.join()) {
        fail("the band works in every direction", `down-right ${down.join()} vs up-left ${up.join()}`);
      }
    } catch (e) {
      fail("the band works in every direction", `threw: ${(e as Error).message}`);
    }

    // A tag dragged off has to *be* where the drawing puts it, or the band
    // catches a box the user cannot see. Both read the offset the same way —
    // this is the check that they agree.
    total++;
    try {
      const [box] = anchorBoxes([{ id: "a1", x: 200, y: 200, name: "CLK", tx: 48, ty: -64 }], [], []);
      const cx = box.tag.x + box.tag.w / 2;
      const cy = box.tag.y + box.tag.h / 2;
      if (Math.abs(cx - 248) > 0.5 || Math.abs(cy - 136) > 0.5) {
        fail("a dragged tag is measured where it is drawn", `tag centre ${cx},${cy}, expected 248,136`);
      }
      if (box.point.x !== 200 || box.point.y !== 200) {
        fail("a dragged tag is measured where it is drawn", `anchor point moved to ${box.point.x},${box.point.y}`);
      }
    } catch (e) {
      fail("a dragged tag is measured where it is drawn", `threw: ${(e as Error).message}`);
    }

    // ── 4. A name stays on its wire when the wire moves ────────────────────
    // The claim the binding exists for, over every bundled schematic: move a
    // part, and every name still names the net it named before.
    //
    // Before it, a name was a coordinate and its net was whatever lay beneath —
    // so re-routing a wire slid the geometry out from under names nobody had
    // touched. They fell onto whatever was left there, or onto nothing, and a
    // connection vanished without a gesture that meant it to. Checked by *name*
    // rather than by net id, because the ids are re-derived on every rebuild and
    // the question is whether `Ub` still means the node it meant.
    for (const file of files) {
      total++;
      const name = `a name keeps its net when a part moves: ${file}`;
      try {
        st().clearCircuit();
        st().loadFromAsc(fs.readFileSync(path.join(dir, file), "latin1"));
        await tick(); await tick();
        st().rebuildConnections();
        await tick();

        /** Which named net each name sits on — by the ports on it, not its id. */
        const bound = () => {
          const s2 = st();
          const resolved = resolveAnchors(s2, "en");
          const out = new Map<string, string>();
          for (const a of s2.netAnchors) {
            const netId = resolved.get(a.id);
            if (!netId) { out.set(`${a.id}:${a.name}`, "—"); continue; }
            const ports: string[] = [];
            for (const c of s2.circuit.components.values()) {
              for (const p of c.ports) if (p.netId === netId) ports.push(p.id);
            }
            out.set(`${a.id}:${a.name}`, ports.sort().join(","));
          }
          return out;
        };

        const before = bound();
        if (before.size === 0) continue;

        // Move a part that a *named* wire hangs on, and far enough that the wire
        // is genuinely somewhere else afterwards. Both matter: nudging an
        // arbitrary part a grid step leaves every name inside its tolerance, so
        // the check passes with the binding switched off and proves nothing —
        // which is what a first version of this test did.
        const s0 = st();
        const named = resolveAnchors(s0, "en");
        const namedNets = new Set([...named.values()]);
        const carrier = s0.edges.find((e) => {
          const port = (id: string, h: string | null | undefined) => `${id}-${h}`;
          for (const c of s0.circuit.components.values()) {
            for (const p of c.ports) {
              if (!p.netId || !namedNets.has(p.netId)) continue;
              if (p.id === port(e.source, e.sourceHandle) || p.id === port(e.target, e.targetHandle)) return true;
            }
          }
          return false;
        });
        const victim = carrier ? st().nodes.find((n) => n.id === carrier.source) : undefined;
        if (!victim) continue;
        st().setNodes(st().nodes.map((n) =>
          n.id === victim.id ? { ...n, position: { x: n.position.x + 128, y: n.position.y + 96 } } : n));
        await tick();
        st().rebuildConnections();
        await tick();

        const after = bound();
        const lost: string[] = [];
        for (const [key, ports] of before) {
          const now = after.get(key);
          if (now !== ports) lost.push(`${key}: ${ports || "—"} -> ${now ?? "weg"}`);
        }
        if (lost.length) fail(name, `${lost.length} Namen wechselten das Netz: ${lost.slice(0, 3).join(" | ")}`);
      } catch (e) {
        fail(name, `threw: ${(e as Error).message}`);
      }
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
