import { useCircuitStore } from "@store/circuitStore.js";
import { resolveAnchors } from "@editor/anchorNets.js";
import { withSymbols } from "./withSymbols.js";

/**
 * A name near the *moved* end of a wire that crosses a selection boundary.
 *
 * `SchematicCanvas` decides which names travel with a drag by looking for edges
 * whose *both* ends sit inside the moving set — a wire fully inside a selected
 * block. A wire from a selected part to one left behind is not such an edge, so
 * no name on it is pre-carried, however close that name sits to the end that is
 * actually moving. That is correct: rebuilding every step of a drag would make a
 * full sheet stutter, and the rebuild at drag-stop is what was supposed to catch
 * this case regardless — a name that fell off the wire is put back on it there
 * (see `circuitStore.rebuildConnections`'s "carry each name along its own wire").
 *
 * `SchematicCanvas.onNodeDragStop` used to skip that rebuild whenever nothing had
 * been pre-carried, which is exactly backwards: pre-carried names are the ones
 * that *don't* need the rebuild to still be right, having already moved with
 * their wire. It was the uncarried names — the only ones the rebuild exists for —
 * that got no rebuild at all, so a name near the moved end of a boundary wire was
 * left at its old coordinate while the wire itself moved out from under it, and
 * nothing afterwards ever put it back: not the next edit, not reopening the file,
 * nothing short of dragging the name back by hand.
 *
 * This drives the store exactly as that handler does — moving only the carried
 * names live, then running the one rebuild at the end — so a regression here is a
 * regression there.
 */

const st = () => useCircuitStore.getState();
const tick = () => new Promise((r) => setTimeout(r, 0));

// R1's bottom pin and R2's bottom pin, joined by one long wire at y=80. UB sits
// 32 units in from R1's end — near it, but not on R1's own pin, and nowhere near
// R2's end 800 units away.
const ASC = `Version 4
SHEET 1 1000 400
FLAG 48 80 UB
WIRE 16 80 816 80
SYMBOL res 0 -16 R0
SYMATTR InstName R1
SYMATTR Value 1k
SYMBOL res 800 -16 R0
SYMATTR InstName R2
SYMATTR Value 2k
`;

/** Which names a drag of exactly `movingIds` would carry live, and the net UB
 *  resolves to once the drag has been played out and stopped. */
async function dragAndStop(movingIds: Set<string>, dx: number, dy: number, ubId: string) {
  const before = st();
  const inner = before.edges.filter((e) => movingIds.has(e.source) && movingIds.has(e.target));
  const carried = resolveAnchors(
    { nodes: before.nodes.filter((n) => movingIds.has(n.id)), edges: inner, netAnchors: before.netAnchors, circuit: before.circuit },
    "default",
  );
  const carriedIds = [...carried.keys()];

  st().setNodes(st().nodes.map((n) => (movingIds.has(n.id)
    ? { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } } : n)));
  st().moveNetAnchorsBy(carriedIds, dx, dy);
  await tick();
  // The fixed onNodeDragStop: always rebuilds once, however little was carried live.
  st().rebuildConnections();
  await tick();

  return { carriedIds, netAfter: resolveAnchors(st(), "default").get(ubId) };
}

export async function runDragCarryTests(): Promise<{ total: number; passed: number; failures: { name: string; reason: string }[] }> {
  const failures: { name: string; reason: string }[] = [];
  let total = 0;
  const fail = (name: string, reason: string) => failures.push({ name, reason });

  return await withSymbols(async () => {
    total++;
    try {
      st().clearCircuit();
      st().loadFromAsc(ASC);
      await tick(); await tick();

      const s0 = st();
      const ub = s0.netAnchors.find((a) => a.name === "UB");
      if (!ub) throw new Error("no UB anchor loaded");
      const netBefore = resolveAnchors(s0, "default").get(ub.id);
      if (!netBefore) throw new Error("UB does not resolve before the move");

      const r1 = s0.nodes.find((n) => (n.data as { label?: string }).label === "R1");
      if (!r1) throw new Error("no R1 node");

      // R1 alone is "moving" — the wire to R2 is a boundary edge, so UB is not
      // pre-carried even though it sits right by the end that is about to move.
      const { carriedIds, netAfter } = await dragAndStop(new Set([r1.id]), 200, 0, ub.id);
      if (carriedIds.length !== 0) throw new Error(`expected nothing pre-carried, got ${JSON.stringify(carriedIds)}`);

      if (netAfter !== netBefore) {
        const a = st().netAnchors.find((x) => x.id === ub.id)!;
        fail(
          "a name near the moved end of a boundary wire keeps its net",
          `name stayed at ${a.x},${a.y}; net before=${netBefore}, after=${netAfter ?? "NONE (disconnected)"}`,
        );
      }
    } catch (e) {
      fail("a name near the moved end of a boundary wire keeps its net", `threw: ${(e as Error).message}`);
    }

    return { total, passed: total - failures.length, failures };
  });
}
