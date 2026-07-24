import type { Pt } from "./model.js";

/**
 * A prototype router for the converted schematics — measured, not used.
 *
 * The conversion copies Multisim's wire geometry and then patches up where it
 * does not land on our pins: bridge stubs, a withdrawal pass, a pruning pass,
 * and net labels for whatever is still split. That chain exists because the two
 * tools put their terminals in different places, and every attempt to close the
 * gap by *moving* something (our pin raster, the parts, the wire ends) traded
 * one defect for another.
 *
 * The alternative is not to copy the geometry at all. Multisim's net list says
 * authoritatively which terminals belong together, and our own pin positions are
 * known — so the wiring can be drawn fresh between them. Then every connection
 * holds by construction: no ends in mid-air, no labels to bridge a gap, nothing
 * to prune.
 *
 * What decides whether that is viable is not the routing itself but the
 * *crossings*: LTSpice joins any two wires that share a point, so a route that
 * crosses another net shorts it. This module exists to put a number on that
 * before the conversion is rebuilt around it.
 *
 * The rule is: draw the wire only where it can be drawn without crossing another
 * net; where it cannot, leave the connection to a net label, exactly as the
 * conversion does today. So a crossing is never produced, and the number that
 * decides the approach is how many connections have to fall back to a name.
 *
 * That the fallback is needed at all is not a shortcoming of the router. These
 * sheets are not planar: Multisim's own drawing of them crosses itself 1964
 * times without connecting, which it can afford because it stores connectivity
 * separately. Our format joins any two wires sharing a point, so "no crossings"
 * is a hard constraint here and a free choice there.
 *
 * Deliberately simple otherwise, because the question is feasibility: a minimum
 * spanning tree per net, each edge tried as one of the two L-bends. A real router
 * would search around obstacles and would need the fallback less often.
 */

/** A wire segment as [x1, y1, x2, y2]; always axis-aligned. */
export type Seg = [number, number, number, number];

export interface RouteReport {
  /** Segments the router produced. */
  wires: Seg[];
  /** Nets it had to route, and terminals across them. */
  nets: number;
  terminals: number;
  /** Points where two *different* nets meet. Zero by construction. */
  shorts: number;
  /** Connections drawn as wire, and those left to a net label instead. */
  drawn: number;
  named: number;
  /**
   * Net labels the result needs: one per island a net is left in. A net whose
   * every connection could be drawn needs none.
   */
  labels: number;
  /** Segments crossing a part body. Ugly, not wrong. */
  throughBodies: number;
  /** Total wire length, as a rough measure of how tidy the result is. */
  length: number;
}

const key = (p: Pt) => `${p[0]},${p[1]}`;

/** Manhattan distance — the length an orthogonal route actually costs. */
const dist = (a: Pt, b: Pt) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);

/**
 * Minimum spanning tree over a net's terminals, by Manhattan distance.
 *
 * A tree and not a chain: a net is a set of points that must end up on one node,
 * and the cheapest way to join n points with n-1 wires is exactly an MST. Prim's
 * algorithm, because the point counts here are small and it needs no sorting.
 */
function spanningTree(pts: Pt[]): [Pt, Pt][] {
  const edges: [Pt, Pt][] = [];
  if (pts.length < 2) return edges;
  const inTree = [pts[0]];
  const rest = pts.slice(1);
  while (rest.length) {
    let bi = 0, bj = 0, best = Infinity;
    for (let i = 0; i < inTree.length; i++) {
      for (let j = 0; j < rest.length; j++) {
        const d = dist(inTree[i], rest[j]);
        if (d < best) { best = d; bi = i; bj = j; }
      }
    }
    edges.push([inTree[bi], rest[bj]]);
    inTree.push(rest[bj]);
    rest.splice(bj, 1);
  }
  return edges;
}

/** The two L-routes between a and b: horizontal first, or vertical first. */
function lRoutes(a: Pt, b: Pt): Seg[][] {
  if (a[0] === b[0] || a[1] === b[1]) return [[[a[0], a[1], b[0], b[1]]]];
  return [
    [[a[0], a[1], b[0], a[1]], [b[0], a[1], b[0], b[1]]],
    [[a[0], a[1], a[0], b[1]], [a[0], b[1], b[0], b[1]]],
  ];
}

/** Where two axis-aligned segments meet, ignoring shared endpoints. */
function meets(a: Seg, b: Seg): Pt | null {
  const av = a[0] === a[2], bv = b[0] === b[2];
  if (av === bv) return null;
  const [v, h] = av ? [a, b] : [b, a];
  const x = v[0], y = h[1];
  if (y < Math.min(v[1], v[3]) || y > Math.max(v[1], v[3])) return null;
  if (x < Math.min(h[0], h[2]) || x > Math.max(h[0], h[2])) return null;
  return [x, y];
}

/** Does a segment run through a part's body (not merely touch its edge)? */
function entersBody(s: Seg, body: Seg): boolean {
  const [bx1, by1, bx2, by2] = body;
  const lo = (a: number, b: number) => Math.min(a, b), hi = (a: number, b: number) => Math.max(a, b);
  return hi(s[0], s[2]) > bx1 && lo(s[0], s[2]) < bx2
      && hi(s[1], s[3]) > by1 && lo(s[1], s[3]) < by2;
}

/**
 * Route every net, and count what it cost.
 *
 * Nets are taken longest-first: the long runs shape the sheet, and the short
 * ones have more room to dodge what is already there than the other way round.
 */
export function routeNets(nets: { name: string; pts: Pt[] }[], bodies: Seg[]): RouteReport {
  const placed: { seg: Seg; net: string }[] = [];
  let throughBodies = 0, drawn = 0, named = 0, labels = 0;

  const order = [...nets].sort((a, b) => {
    const span = (n: { pts: Pt[] }) => {
      const xs = n.pts.map((p) => p[0]), ys = n.pts.map((p) => p[1]);
      return (Math.max(...xs) - Math.min(...xs)) + (Math.max(...ys) - Math.min(...ys));
    };
    return span(b) - span(a);
  });

  for (const net of order) {
    // One point per coordinate: two pins on the same spot are already joined.
    const seen = new Set<string>();
    const pts = net.pts.filter((p) => !seen.has(key(p)) && seen.add(key(p)));

    // Which of this net's points the drawn wiring actually joined, so the
    // labels can be counted per island rather than per skipped connection.
    const parent = new Map<string, string>();
    const find = (k: string): string => {
      if (!parent.has(k)) parent.set(k, k);
      while (parent.get(k) !== k) { parent.set(k, parent.get(parent.get(k)!)!); k = parent.get(k)!; }
      return k;
    };
    const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
    for (const p of pts) find(key(p));

    for (const [a, b] of spanningTree(pts)) {
      // Only a route that crosses no other net may be drawn; among those, the
      // one that runs through fewer part bodies.
      let best: Seg[] | null = null, bestBodies = Infinity;
      for (const segs of lRoutes(a, b)) {
        let crosses = false, inBodies = 0;
        for (const s of segs) {
          for (const q of placed) {
            if (q.net !== net.name && meets(s, q.seg)) { crosses = true; break; }
          }
          if (crosses) break;
          for (const body of bodies) if (entersBody(s, body)) inBodies++;
        }
        if (crosses) continue;
        if (inBodies < bestBodies) { bestBodies = inBodies; best = segs; }
      }
      if (!best) { named++; continue; }
      drawn++;
      throughBodies += bestBodies;
      for (const s of best) placed.push({ seg: s, net: net.name });
      union(key(a), key(b));
    }

    // A net left in more than one island needs its name on each of them.
    const islands = new Set(pts.map((p) => find(key(p))));
    if (islands.size > 1) labels += islands.size;
  }

  // Should be zero — stated rather than assumed, because the whole approach
  // rests on it.
  let shorts = 0;
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      if (placed[i].net === placed[j].net) continue;
      if (meets(placed[i].seg, placed[j].seg)) shorts++;
    }
  }

  return {
    wires: placed.map((p) => p.seg),
    nets: nets.length,
    terminals: nets.reduce((n, x) => n + x.pts.length, 0),
    shorts, drawn, named, labels, throughBodies,
    length: placed.reduce((n, p) => n + Math.abs(p.seg[2] - p.seg[0]) + Math.abs(p.seg[3] - p.seg[1]), 0),
  };
}
