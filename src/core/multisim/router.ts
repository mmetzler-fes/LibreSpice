import type { Pt } from "./model.js";

/**
 * The wiring of a converted schematic, drawn between our own terminals.
 *
 * The conversion used to copy Multisim's wire geometry and then patch up where it
 * did not land on our pins: bridge stubs, a withdrawal pass, a pruning pass, and
 * net labels for whatever was still split. That chain existed because the two
 * tools put their terminals in different places, and every attempt to close the
 * gap by *moving* something (our pin raster, the parts, the wire ends) traded one
 * defect for another.
 *
 * So the geometry is not copied at all. Multisim's net list says authoritatively
 * which terminals belong together, and our own pin positions are known — so the
 * wiring is drawn fresh between them. Every connection then holds by
 * construction: no ends in mid-air, no stub to bridge a gap, nothing to prune.
 *
 * What decides whether that works is not the routing but the *crossings*: LTSpice
 * joins any two wires that share a point, so a route that touches another net
 * shorts it. Hence the rule: draw the wire only where it can be drawn without
 * touching another net; where it cannot, leave the connection to a net label,
 * exactly as the conversion did before. A short is therefore not a measurement
 * here but an impossibility, and what the approach costs is counted in labels.
 *
 * That the fallback is needed at all is not a shortcoming of the router. These
 * sheets are not planar: Multisim's own drawing of them crosses itself 1964 times
 * without connecting, which it can afford because it stores connectivity
 * separately. Our format joins any two wires sharing a point, so "no crossings"
 * is a hard constraint here and a free choice there.
 *
 * Deliberately simple otherwise: a minimum spanning tree per net, each edge tried
 * as one of the two L-bends. A Z-bend through a free channel, or a real search
 * around obstacles, would need the fallback less often — the label count is an
 * upper bound, not a floor.
 */

/** A wire segment as [x1, y1, x2, y2]; always axis-aligned. */
export type Seg = [number, number, number, number];

/** Wiring or a terminal already on the sheet, and the net it carries. */
export interface Occupied<T> {
  what: T;
  /**
   * The net it belongs to, or null when that is not known — and null is the
   * stricter case: no route may touch it at all. The invented ground terminal of
   * a digital source is the example, and it matters: laid across by a route it
   * grounds that net silently, which is the one fault a reader will not spot.
   */
  net: string | null;
}

export interface RouteRequest {
  /** Each net as the points our parts put on the sheet, and its name. */
  nets: { name: string; pts: Pt[] }[];
  /** Symbol bounding boxes — ugly to cross, not wrong. */
  bodies: Seg[];
  /** Wiring the emitters drew themselves; fixed, and an obstacle like any other. */
  fixed?: Occupied<Seg>[];
  /** Terminals a route may not run over unless they sit on the net being routed. */
  keepClear?: Occupied<Pt>[];
}

export interface RouteReport {
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

export interface RouteResult {
  /** The segments to draw, in the order they were laid. */
  wires: Seg[];
  report: RouteReport;
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

/** Do the two ranges [v1,v2] and [w1,w2] overlap, touching included? */
const spans = (v1: number, v2: number, w1: number, w2: number) =>
  Math.max(v1, v2) >= Math.min(w1, w2) && Math.min(v1, v2) <= Math.max(w1, w2);

/**
 * Do two axis-aligned segments share any point at all?
 *
 * Any shared point is a connection in this format, so this is deliberately wider
 * than a crossing test: a T, a shared corner and a collinear overlap all count.
 * The overlap is the case that is easy to miss — two segments on the same line
 * never *cross*, but one of them always ends inside the other, and that end is a
 * shared point like any other.
 */
export function touches(a: Seg, b: Seg): boolean {
  const av = a[0] === a[2], bv = b[0] === b[2];
  if (av !== bv) {
    const [v, h] = av ? [a, b] : [b, a];
    return v[0] >= Math.min(h[0], h[2]) && v[0] <= Math.max(h[0], h[2])
        && h[1] >= Math.min(v[1], v[3]) && h[1] <= Math.max(v[1], v[3]);
  }
  // Parallel: only the same line can meet, and then wherever the extents do.
  if (av) return a[0] === b[0] && spans(a[1], a[3], b[1], b[3]);
  return a[1] === b[1] && spans(a[0], a[2], b[0], b[2]);
}

/** True when a point lies on an axis-aligned segment, endpoints included. */
function onSegment(p: Pt, [x1, y1, x2, y2]: Seg): boolean {
  return x1 === x2
    ? p[0] === x1 && p[1] >= Math.min(y1, y2) && p[1] <= Math.max(y1, y2)
    : y1 === y2 && p[1] === y1 && p[0] >= Math.min(x1, x2) && p[0] <= Math.max(x1, x2);
}

/** Does a segment run through a part's body (not merely touch its edge)? */
export function entersBody(s: Seg, body: Seg): boolean {
  const [bx1, by1, bx2, by2] = body;
  const lo = (a: number, b: number) => Math.min(a, b), hi = (a: number, b: number) => Math.max(a, b);
  return hi(s[0], s[2]) > bx1 && lo(s[0], s[2]) < bx2
      && hi(s[1], s[3]) > by1 && lo(s[1], s[3]) < by2;
}

/**
 * Route every net, and say what it cost.
 *
 * Nets are taken longest-first: the long runs shape the sheet, and the short ones
 * have more room to dodge what is already there than the other way round.
 */
export function routeNets(req: RouteRequest): RouteResult {
  const { nets, bodies } = req;
  const fixed = req.fixed ?? [];
  const placed: Occupied<Seg>[] = [...fixed];
  const blocked = req.keepClear ?? [];
  let throughBodies = 0, drawn = 0, named = 0, labels = 0;

  const order = [...nets].sort((a, b) => {
    const reach = (n: { pts: Pt[] }) => {
      const xs = n.pts.map((p) => p[0]), ys = n.pts.map((p) => p[1]);
      return (Math.max(...xs) - Math.min(...xs)) + (Math.max(...ys) - Math.min(...ys));
    };
    return reach(b) - reach(a);
  });

  for (const net of order) {
    // One point per coordinate: two pins on the same spot are already joined.
    const seen = new Set<string>();
    const pts = net.pts.filter((p) => !seen.has(key(p)) && seen.add(key(p)));
    // Terminals a route of this net may not run over: everything that is not on
    // it. A point this net occupies as well is not one of them.
    const forbidden = blocked.filter((b) => b.net !== net.name && !seen.has(key(b.what)));

    // Which of this net's points the drawn wiring actually joined, so the labels
    // can be counted per island rather than per skipped connection.
    const parent = new Map<string, string>();
    const find = (k: string): string => {
      if (!parent.has(k)) parent.set(k, k);
      while (parent.get(k) !== k) { parent.set(k, parent.get(parent.get(k)!)!); k = parent.get(k)!; }
      return k;
    };
    const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
    for (const p of pts) find(key(p));

    for (const [a, b] of spanningTree(pts)) {
      // Only a route that touches no other net may be drawn; among those, the one
      // that runs through fewer part bodies.
      let best: Seg[] | null = null, bestBodies = Infinity;
      for (const segs of lRoutes(a, b)) {
        let hits = false, inBodies = 0;
        for (const s of segs) {
          for (const q of placed) {
            if (q.net !== net.name && touches(s, q.what)) { hits = true; break; }
          }
          if (!hits) {
            for (const f of forbidden) if (onSegment(f.what, s)) { hits = true; break; }
          }
          if (hits) break;
          for (const body of bodies) if (entersBody(s, body)) inBodies++;
        }
        if (hits) continue;
        if (inBodies < bestBodies) { bestBodies = inBodies; best = segs; }
      }
      if (!best) { named++; continue; }
      drawn++;
      throughBodies += bestBodies;
      for (const s of best) placed.push({ what: s, net: net.name });
      union(key(a), key(b));
    }

    // A net left in more than one island needs its name on each of them.
    const islands = new Set(pts.map((p) => find(key(p))));
    if (islands.size > 1) labels += islands.size;
  }

  const routed = placed.slice(fixed.length);
  // Should be zero — stated rather than assumed, because the whole approach rests
  // on it. Two pieces of *fixed* wiring meeting is not the router's doing, so only
  // pairs involving a routed segment are counted.
  let shorts = 0;
  for (let i = 0; i < placed.length; i++) {
    for (let j = Math.max(i + 1, fixed.length); j < placed.length; j++) {
      if (placed[i].net === placed[j].net) continue;
      if (touches(placed[i].what, placed[j].what)) shorts++;
    }
  }

  return {
    wires: routed.map((p) => p.what),
    report: {
      nets: nets.length,
      terminals: nets.reduce((n, x) => n + x.pts.length, 0),
      shorts, drawn, named, labels, throughBodies,
      length: routed.reduce((n, p) => n + Math.abs(p.what[2] - p.what[0]) + Math.abs(p.what[3] - p.what[1]), 0),
    },
  };
}
