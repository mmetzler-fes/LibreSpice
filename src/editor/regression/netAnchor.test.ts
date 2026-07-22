import { useCircuitStore } from "@store/circuitStore.js";
import { LTSpiceExporter } from "@core/ltspice/LTSpiceExporter.js";
import { formatAnchor, isGroundAnchor, anchorsFromNodes } from "@core/circuit/netAnchor.js";
import { resolveAnchor, type RoutedNet } from "@core/circuit/anchorResolve.js";
import { wireRoutes, type PinLookup } from "@core/geometry/wireRoutes.js";
import { getNodePins } from "@editor/pinGeometry.js";
import { withSymbols } from "./withSymbols.js";

/**
 * Do net anchors carry everything the net-label *nodes* carry?
 *
 * This is the evidence step of moving labels out of the topology. A `.asc`
 * `FLAG` is a name at a coordinate; we model it as a node with a pin, joined by
 * edges, and that one decision is behind the label dragging its wire, the
 * `ascPassThrough` bookkeeping, splicing labels out of routes before writing
 * them, and a second name on a net overwriting the first.
 *
 * Anchors are the replacement, and they are introduced *beside* the nodes rather
 * than instead of them. Before anything switches over, this suite checks the
 * claim that makes the switch safe: for every bundled schematic, the anchors the
 * parser collected reproduce exactly the `FLAG` and `IOPIN` lines the exporter
 * writes today — same names, same coordinates, same directions.
 *
 * If that holds across the whole corpus, the anchor set is a faithful
 * representation of the file's naming and the exporter can be switched to it. If
 * it does not, the failing file names precisely what the model still misses.
 */

const tick = () => new Promise((r) => setTimeout(r, 0));
const st = () => useCircuitStore.getState();

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

    // ── The anchors reproduce what the exporter writes ──────────────────────
    for (const file of files) {
      total++;
      const name = `anchors reproduce the flags of ${file}`;
      try {
        st().clearCircuit();
        st().loadFromAsc(fs.readFileSync(path.join(dir, file), "latin1"));
        await tick(); await tick();

        const s = st();
        const written = flagLines(LTSpiceExporter.export(
          s.nodes, s.edges, s.spiceDirectives, s.circuit, s.dataFlags, s.textBoxes, s.sheetShapes,
          { directiveRaw: s.directiveRaw, header: s.ascHeader, orphanWires: s.ascOrphanWires },
        ));
        const fromAnchors = anchorsFromNodes(s.nodes).flatMap(formatAnchor).sort();

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

    // ── Geometry finds the same net the topology does ──────────────────────
    // The mechanism the switch stands or falls on. Today a label's net comes
    // from the edge it hangs on; an anchor has no edge and must find its net by
    // lying on a wire, the way LTSpice does. So: for every named flag in every
    // bundled schematic, does the geometric answer match the one the wired-up
    // label node already gives?
    for (const file of files) {
      total++;
      const name = `anchors resolve to the same nets in ${file}`;
      try {
        st().clearCircuit();
        st().loadFromAsc(fs.readFileSync(path.join(dir, file), "latin1"));
        await tick(); await tick();
        const s = st();

        // Wires as the canvas draws them — flow coordinates, so the anchor is
        // measured against the wire the user actually sees (see wireRoutes).
        const flowPins: PinLookup = {
          at: (nodeId, handle) => {
            const n = s.nodes.find((x) => x.id === nodeId);
            if (!n) return undefined;
            const p = getNodePins(n).find((q) => q.handleId === handle);
            return p ? { x: p.x, y: p.y } : undefined;
          },
        };
        const netOfEdge = (e: { source: string; sourceHandle?: string | null }) =>
          s.circuit.components.get(e.source)?.ports.find((p) => p.id === `${e.source}-${e.sourceHandle}`)?.netId;
        const routes: RoutedNet[] = wireRoutes(s.edges, flowPins)
          .map(({ edge, verts }) => ({ netId: netOfEdge(edge) ?? "", verts }))
          .filter((r) => r.netId !== "");

        const mismatches: string[] = [];
        for (const a of anchorsFromNodes(s.nodes)) {
          if (isGroundAnchor(a)) continue; // ground stays a component for now
          // The label node the parser made for this same flag.
          const node = s.nodes.find((n) => {
            const d = n.data as { componentType?: string; label?: string };
            return (d.componentType === "netlabel" || d.componentType === "netconnector")
              && d.label === a.name
              && Math.abs(n.position.x + 40 - a.x) < 1 && Math.abs(n.position.y + 40 - a.y) < 1;
          });
          if (!node) continue;
          const viaTopology = s.circuit.components.get(node.id)?.ports[0]?.netId ?? null;
          const viaGeometry = resolveAnchor(a, routes);
          // A label on a wire nobody else touches has no edge at all, so the
          // topology gives it a net of its own that geometry cannot see. Only
          // disagreement about a *shared* net matters here.
          if (viaTopology && viaGeometry && viaTopology !== viaGeometry) {
            mismatches.push(`${a.name}@${a.x},${a.y}: topology ${viaTopology}, geometry ${viaGeometry}`);
          }
        }
        if (mismatches.length) fail(name, mismatches.slice(0, 6).join("\n    "));
      } catch (e) {
        fail(name, `threw: ${(e as Error).message}`);
      }
    }

    // ── The projection holds while the schematic is edited ──────────────────
    // Anchors used to be a snapshot taken at load, which was fine for proving
    // the idea and useless for building on: the moment a label moved, the list
    // described where the name *had been*. Derived from the parts instead, it
    // cannot drift — and that is what this checks, by editing and asking again.
    total++;
    try {
      const file = path.resolve("examples", "05-2-3_Brummspannung1.asc");
      st().clearCircuit();
      st().loadFromAsc(fs.readFileSync(file, "latin1"));
      await tick(); await tick();

      const agrees = (what: string) => {
        const s = st();
        const written = flagLines(LTSpiceExporter.export(
          s.nodes, s.edges, s.spiceDirectives, s.circuit, s.dataFlags, s.textBoxes, s.sheetShapes,
          { directiveRaw: s.directiveRaw, header: s.ascHeader, orphanWires: s.ascOrphanWires },
        ));
        const derived = anchorsFromNodes(s.nodes).flatMap(formatAnchor).sort();
        if (written.join("\n") !== derived.join("\n")) {
          fail("anchors keep up with edits", `after ${what}:\n    written: ${written.join(" | ")}\n    derived: ${derived.join(" | ")}`);
          return false;
        }
        return true;
      };

      if (agrees("loading")) {
        // Move a label: the anchor has to move with it, not stay where the file
        // put it.
        const label = st().nodes.find((n) => (n.data as { label?: string }).label === "UA1")!;
        st().setNodes(st().nodes.map((n) =>
          n.id === label.id ? { ...n, position: { x: n.position.x + 48, y: n.position.y - 16 } } : n));
        await tick();
        if (agrees("moving a label")) {
          // Rename one: same again for the name itself.
          st().updateComponentProperty(label.id, "label", "UAx");
          await tick();
          if (agrees("renaming a label")) {
            // And a ground, whose flag sits at its pin rather than its centre.
            const gnd = st().nodes.find((n) => (n.data as { componentType?: string }).componentType === "ground");
            if (gnd) {
              st().setNodes(st().nodes.map((n) =>
                n.id === gnd.id ? { ...n, position: { x: n.position.x - 32, y: n.position.y } } : n));
              await tick();
              agrees("moving a ground");
            }
          }
        }
      }
    } catch (e) {
      fail("anchors keep up with edits", `threw: ${(e as Error).message}`);
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
