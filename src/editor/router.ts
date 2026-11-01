/**
 * Orthogonal wire routing for the schematic editor.
 *
 * Wires are drawn textbook style: horizontal and vertical segments only,
 * leaving a port perpendicular to its side (outputs on the EAST side go
 * right, inputs on the WEST side are entered from the left, select and
 * clock pins on the SOUTH side are entered from below).
 *
 * `routeWire` runs an A* search over a rectilinear grid whose state is
 * (grid point, direction of travel), so bends can be charged for. It goes
 * around symbols, grows a tree for its own net (fan-out wires branch off
 * the wires already drawn, giving T junctions) and never runs along a wire
 * of another net, which would read as a connection. `simpleRoute` is the
 * cheap version used while dragging and as the fallback.
 */
import type { Side } from '../core/diagram';
import type { Point } from '../layout/elk-layout';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RouteEnd {
  /** Port position (absolute). */
  point: Point;
  /** Side of its node the port is on. The wire leaves (or enters) perpendicular to it: EAST = to the right, WEST = left, SOUTH = down, NORTH = up. */
  side: Side;
  /** The rectangle of the port's node. */
  rect: Rect;
}

export interface RouteOptions {
  /** Every node rectangle on the sheet (may include from.rect and to.rect). Wires must not pass through them. */
  obstacles: Rect[];
  /**
   * Polylines already routed for the SAME net; each starts at the same source port as 'from'.
   * The new wire may branch off any point of them (a T junction) instead of starting at 'from';
   * then the returned polyline is the prefix of that existing polyline up to the branch point
   * followed by the new part, so it still starts at from.point.
   */
  ownNet?: Point[][];
  /**
   * Polylines of OTHER nets. The new wire must never run along (collinear overlap of positive length)
   * any of their segments, since that would look like a connection; crossing them perpendicularly is
   * allowed but costs a little.
   */
  otherNets?: Point[][];
  /**
   * Pins of other nets whose wires are not drawn (yet). Their stubs are kept clear like other nets' wires:
   * a wire that turned on, or ran through, the spot where such a pin's wire has to start would meet that
   * wire there later and look connected to it.
   */
  reserved?: RouteEnd[];
  /** Grid pitch, default 10. */
  grid?: number;
  /** Search cap before falling back to simpleRoute. */
  maxExpansions?: number;
}

// ---------------------------------------------------------------------------
// Tuning

/** Minimum straight piece of wire at a port. */
const STUB = 10;
/** A stub also ends at least this far beyond its own symbol's edge (ports may sit inside the box, e.g. on a sloped MUX edge). */
const STUB_CLEAR = 6;
/** Wires keep at least this far from symbols. */
const INFLATE = 4;
/** Search windows: the end points (and their symbols) plus these margins, then the whole sheet plus the last one. */
const MARGINS = [60, 240];
const SHEET_MARGIN = 60;
const DEFAULT_MAX_EXPANSIONS = 150_000;
/** Cost of one grid edge through a symbol: only used when there is no other way. */
const BLOCK = 1e7;
/** Cost of one grid edge along another net's wire. */
const OVERLAP = 1e5;
/** Extra cost per px of running right next to a symbol (within one grid pitch of its keep-out). */
const HUG = 0.3;
/** Another net's coordinate this close to a grid line counts as being on it. */
const MATCH_TOL = 2;
/** Grid lines this close (as a fraction of the pitch) to an exact coordinate are dropped, so wires do not jog by a pixel or two. */
const SPECIAL_SNAP = 0.3;
const EPS = 1e-9;

// Directions: 0 = east (+x), 1 = south (+y), 2 = west (-x), 3 = north (-y). Opposite: d ^ 2.
const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];
const SIDE_DIR: Record<Side, number> = { EAST: 0, SOUTH: 1, WEST: 2, NORTH: 3 };

// ---------------------------------------------------------------------------
// Polyline helpers

const samePoint = (a: Point, b: Point) => Math.abs(a.x - b.x) <= EPS && Math.abs(a.y - b.y) <= EPS;

/** True when b lies on the axis-parallel line through a and c (a straight run, or a spike that doubles back). */
function redundant(a: Point, b: Point, c: Point): boolean {
  return (Math.abs(a.x - b.x) <= EPS && Math.abs(b.x - c.x) <= EPS) || (Math.abs(a.y - b.y) <= EPS && Math.abs(b.y - c.y) <= EPS);
}

/** Remove duplicate consecutive points and middle points of straight runs. */
export function simplify(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    if (out.length && samePoint(out[out.length - 1], p)) continue;
    while (out.length >= 2 && redundant(out[out.length - 2], out[out.length - 1], p)) out.pop();
    // Popping a spike can leave p on top of the new last point.
    if (out.length && samePoint(out[out.length - 1], p)) continue;
    out.push({ x: p.x, y: p.y });
  }
  // Keep the exact end point even when it merged into a point within EPS of it.
  if (points.length && out.length) {
    const last = points[points.length - 1];
    out[out.length - 1] = { x: last.x, y: last.y };
  }
  return out;
}

/** Make any polyline orthogonal: between two points that differ in both x and y insert one corner (horizontal first). Then simplify. */
export function orthogonalize(points: Point[]): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (i > 0) {
      const a = points[i - 1];
      if (Math.abs(a.x - p.x) > EPS && Math.abs(a.y - p.y) > EPS) out.push({ x: p.x, y: a.y });
    }
    out.push(p);
  }
  return simplify(out);
}

/**
 * Rubber-band a hand-edited route when its end points moved: keep the inner bends, move the first/last
 * point to the new positions and shift the adjacent bend so every segment stays horizontal or vertical
 * (insert corners if needed). Result orthogonal and simplified.
 */
export function adjustRoute(points: Point[], newStart: Point, newEnd: Point): Point[] {
  const pts = orthogonalize(points);
  if (pts.length < 2) return orthogonalize([newStart, newEnd]);
  if (pts.length === 2) {
    // A straight wire keeps leaving and entering the way it did: a Z with its bend in the middle.
    if (Math.abs(pts[0].y - pts[1].y) <= EPS) {
      const mx = (newStart.x + newEnd.x) / 2;
      return simplify([newStart, { x: mx, y: newStart.y }, { x: mx, y: newEnd.y }, newEnd]);
    }
    const my = (newStart.y + newEnd.y) / 2;
    return simplify([newStart, { x: newStart.x, y: my }, { x: newEnd.x, y: my }, newEnd]);
  }
  const k = pts.length;
  const firstHorizontal = Math.abs(pts[0].y - pts[1].y) <= EPS;
  const lastHorizontal = Math.abs(pts[k - 1].y - pts[k - 2].y) <= EPS;
  pts[0] = { x: newStart.x, y: newStart.y };
  if (firstHorizontal) pts[1].y = newStart.y;
  else pts[1].x = newStart.x;
  pts[k - 1] = { x: newEnd.x, y: newEnd.y };
  if (lastHorizontal) pts[k - 2].y = newEnd.y;
  else pts[k - 2].x = newEnd.x;
  return orthogonalize(pts);
}

/** Whether segment p-q passes through the interior of the box (Liang-Barsky clip, then test the middle of the clipped piece). */
function segmentHitsBox(p: Point, q: Point, x0: number, y0: number, x1: number, y1: number): boolean {
  const e = 1e-6;
  // Wires are horizontal and vertical: answer those without clipping (geometry tests every route).
  if (p.y === q.y) return p.y > y0 + e && p.y < y1 - e && Math.max(p.x, q.x) > x0 + e && Math.min(p.x, q.x) < x1 - e;
  if (p.x === q.x) return p.x > x0 + e && p.x < x1 - e && Math.max(p.y, q.y) > y0 + e && Math.min(p.y, q.y) < y1 - e;
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  let t0 = 0;
  let t1 = 1;
  // Keeps the part of the segment where den * t <= num.
  const clip = (den: number, num: number): boolean => {
    if (Math.abs(den) < 1e-12) return num >= 0;
    const t = num / den;
    if (den > 0) t1 = Math.min(t1, t);
    else t0 = Math.max(t0, t);
    return t0 <= t1;
  };
  if (!clip(-dx, p.x - x0) || !clip(dx, x1 - p.x) || !clip(-dy, p.y - y0) || !clip(dy, y1 - p.y)) return false;
  // A convex box: if any point of the clipped piece is interior, its middle is.
  const t = (t0 + t1) / 2;
  const mx = p.x + dx * t;
  const my = p.y + dy * t;
  return mx > x0 + e && mx < x1 - e && my > y0 + e && my < y1 - e;
}

/** True when any segment of the polyline passes through the interior of the rectangle. */
export function polylineHitsRect(points: Point[], r: Rect): boolean {
  const x1 = r.x + r.width;
  const y1 = r.y + r.height;
  if (points.length === 1) return segmentHitsBox(points[0], points[0], r.x, r.y, x1, y1);
  for (let i = 0; i + 1 < points.length; i++) if (segmentHitsBox(points[i], points[i + 1], r.x, r.y, x1, y1)) return true;
  return false;
}

/**
 * True when the polyline comes closer to the symbol than routed wires do: through it, along its edge, or
 * through one of its pins. Wires and symbols both sit on the grid, so a symbol dropped next to a wire
 * often lands exactly on it, and the wire then reads as connected to the pins it passes.
 */
export function polylineCrowdsRect(points: Point[], r: Rect): boolean {
  return polylineHitsRect(points, { x: r.x - INFLATE, y: r.y - INFLATE, width: r.width + 2 * INFLATE, height: r.height + 2 * INFLATE });
}

// ---------------------------------------------------------------------------
// Junction dots

/** Groups sorted-by-value coordinates that lie within tol of their neighbour; each group is drawn at its most frequent value. */
function clusterCoords(values: number[], tol: number): { index: Map<number, number>; value: number[] } {
  const sorted = [...values].sort((a, b) => a - b);
  const index = new Map<number, number>();
  const value: number[] = [];
  let start = 0;
  for (let i = 1; i <= sorted.length; i++) {
    if (i < sorted.length && sorted[i] - sorted[i - 1] <= tol) continue;
    // sorted[start..i-1] is one cluster; pick its most frequent value (smallest on ties).
    let best = sorted[start];
    let bestCount = 0;
    for (let k = start; k < i; ) {
      let m = k;
      while (m < i && sorted[m] === sorted[k]) m++;
      if (m - k > bestCount) {
        best = sorted[k];
        bestCount = m - k;
      }
      k = m;
    }
    for (let k = start; k < i; k++) index.set(sorted[k], value.length);
    value.push(best);
    start = i;
  }
  return { index, value };
}

type Interval = [number, number];
/** A point in cluster index space: [column, row]. */
type Cell = [number, number];

/** Union of intervals; touching ones merge too (a straight continuation is not a branch). */
function mergeIntervals(list: Interval[]): Interval[] {
  list.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: Interval[] = [];
  for (const iv of list) {
    const last = out[out.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else out.push([iv[0], iv[1]]);
  }
  return out;
}

/**
 * Junction dots for one net: points where the union of the polylines continues in 3 or more directions
 * (T or + joins of the same net). Overlapping collinear segments of different polylines of the net do
 * not create a dot. Result deduplicated, in a deterministic order (by x, then y). Coordinates within
 * 0.5px are treated as equal.
 */
export function netJunctions(polylines: Point[][]): Point[] {
  const TOL = 0.5;
  const allX: number[] = [];
  const allY: number[] = [];
  for (const pl of polylines) for (const p of pl) {
    allX.push(p.x);
    allY.push(p.y);
  }
  const cx = clusterCoords(allX, TOL);
  const cy = clusterCoords(allY, TOL);

  // Work in cluster index space: rows/columns of merged intervals, plus candidate points.
  const rows = new Map<number, Interval[]>();
  const cols = new Map<number, Interval[]>();
  const candidates: Cell[] = [];
  const add = (m: Map<number, Interval[]>, k: number, iv: Interval) => {
    const list = m.get(k);
    if (list) list.push(iv);
    else m.set(k, [iv]);
  };
  for (const pl of polylines) {
    for (let i = 0; i < pl.length; i++) {
      const a: Cell = [cx.index.get(pl[i].x)!, cy.index.get(pl[i].y)!];
      candidates.push(a);
      if (i === 0) continue;
      const b: Cell = [cx.index.get(pl[i - 1].x)!, cy.index.get(pl[i - 1].y)!];
      if (a[1] === b[1] && a[0] !== b[0]) add(rows, a[1], [Math.min(a[0], b[0]), Math.max(a[0], b[0])]);
      else if (a[0] === b[0] && a[1] !== b[1]) add(cols, a[0], [Math.min(a[1], b[1]), Math.max(a[1], b[1])]);
      // Slanted segments only contribute their end points (they never come out of the router).
    }
  }
  for (const [k, list] of rows) rows.set(k, mergeIntervals(list));
  for (const [k, list] of cols) cols.set(k, mergeIntervals(list));
  for (const [y, hs] of rows)
    for (const [x, vs] of cols)
      if (hs.some(([a, b]) => a <= x && x <= b) && vs.some(([a, b]) => a <= y && y <= b)) candidates.push([x, y]);

  const seen = new Set<number>();
  const found: Cell[] = [];
  const stride = cy.value.length + 1;
  for (const [x, y] of candidates) {
    const key = x * stride + y;
    if (seen.has(key)) continue;
    seen.add(key);
    let dirs = 0;
    for (const [a, b] of rows.get(y) ?? []) {
      if (a <= x && x < b) dirs++;
      if (a < x && x <= b) dirs++;
    }
    for (const [a, b] of cols.get(x) ?? []) {
      if (a <= y && y < b) dirs++;
      if (a < y && y <= b) dirs++;
    }
    if (dirs >= 3) found.push([x, y]);
  }
  found.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  return found.map(([x, y]) => ({ x: cx.value[x], y: cy.value[y] }));
}

// ---------------------------------------------------------------------------
// Search lattice and A*

/** First index with arr[i] >= v. */
function lowerBound(arr: number[], v: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index with arr[i] > v. */
function upperBound(arr: number[], v: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Index of a coordinate known to be on the axis, or -1. */
function findExact(arr: number[], v: number): number {
  const i = lowerBound(arr, v);
  return i < arr.length && arr[i] === v ? i : -1;
}

/** A rectilinear grid; node (i, j) is xs[i], ys[j], numbered j * nx + i. Edge costs are extras on top of the length. */
interface Lattice {
  xs: number[];
  ys: number[];
  nx: number;
  ny: number;
  /** Edge (i, j)-(i + 1, j), indexed j * (nx - 1) + i. */
  hCost: Float64Array;
  /** Edge (i, j)-(i, j + 1), indexed j * nx + i. */
  vCost: Float64Array;
  /** Per node: 0 free, 1 on the inside of another net's segment, 2 on a corner or end of another net. */
  touch: Uint8Array | null;
}

function makeLattice(xs: number[], ys: number[]): Lattice {
  const nx = xs.length;
  const ny = ys.length;
  return { xs, ys, nx, ny, hCost: new Float64Array(Math.max(0, nx - 1) * ny), vCost: new Float64Array(nx * Math.max(0, ny - 1)), touch: null };
}

/** Add `cost` to every edge that passes through the open box (l, t)-(r, b). */
function blockBox(L: Lattice, l: number, t: number, r: number, b: number, cost: number): void {
  const { xs, ys, nx, ny, hCost, vCost } = L;
  // Horizontal edges on rows strictly inside (t, b) whose span overlaps (l, r).
  const j0 = upperBound(ys, t);
  const j1 = lowerBound(ys, b);
  const i0 = Math.max(0, upperBound(xs, l) - 1);
  const i1 = Math.min(nx - 1, lowerBound(xs, r));
  for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) hCost[j * (nx - 1) + i] += cost;
  // Vertical edges on columns strictly inside (l, r) whose span overlaps (t, b).
  const c0 = upperBound(xs, l);
  const c1 = lowerBound(xs, r);
  const e0 = Math.max(0, upperBound(ys, t) - 1);
  const e1 = Math.min(ny - 1, lowerBound(ys, b));
  for (let j = e0; j < e1; j++) for (let i = c0; i < c1; i++) vCost[j * nx + i] += cost;
}

interface Costs {
  bend: number;
  /** Going straight through a point on another net's segment (a crossing). */
  cross: number;
  /** Turning on another net's wire, or passing through one of its corners or ends (looks like a connection). */
  touch: number;
}

/**
 * A search start, travelling in any of the directions in the bit mask `dirs` (1 << d) without a bend;
 * the directions in `ban` may not be taken from it at all. tag says where it came from.
 */
interface Seed {
  node: number;
  dirs: number;
  ban?: number;
  g: number;
  tag: number;
}

interface Found {
  /** Nodes from the seed to the goal. */
  nodes: number[];
  tag: number;
  cost: number;
}

/** Binary min-heap of search states keyed by f; ties go to the larger g (deeper first, which finds equal-cost paths sooner). */
class StateHeap {
  private f = new Float64Array(1024);
  private g = new Float64Array(1024);
  private s = new Int32Array(1024);
  size = 0;
  /** g of the state last returned by pop(). */
  topG = 0;

  clear(): void {
    this.size = 0;
  }

  private less(f1: number, g1: number, f2: number, g2: number): boolean {
    return f1 < f2 || (f1 === f2 && g1 > g2);
  }

  push(f: number, g: number, s: number): void {
    if (this.size === this.f.length) {
      const n = this.f.length * 2;
      const nf = new Float64Array(n);
      const ng = new Float64Array(n);
      const ns = new Int32Array(n);
      nf.set(this.f);
      ng.set(this.g);
      ns.set(this.s);
      this.f = nf;
      this.g = ng;
      this.s = ns;
    }
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(f, g, this.f[p], this.g[p])) break;
      this.f[i] = this.f[p];
      this.g[i] = this.g[p];
      this.s[i] = this.s[p];
      i = p;
    }
    this.f[i] = f;
    this.g[i] = g;
    this.s[i] = s;
  }

  pop(): number {
    const top = this.s[0];
    this.topG = this.g[0];
    const n = --this.size;
    if (n > 0) {
      const f = this.f[n];
      const g = this.g[n];
      const s = this.s[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && this.less(this.f[c + 1], this.g[c + 1], this.f[c], this.g[c])) c++;
        if (!this.less(this.f[c], this.g[c], f, g)) break;
        this.f[i] = this.f[c];
        this.g[i] = this.g[c];
        this.s[i] = this.s[c];
        i = c;
      }
      this.f[i] = f;
      this.g[i] = g;
      this.s[i] = s;
    }
    return top;
  }
}

// Scratch space reused by every search (the search never re-enters itself).
const heap = new StateHeap();
let gBuf = new Float64Array(0);
let parentBuf = new Int32Array(0);

/**
 * Fewest bends from travelling in direction d, (dx, dy) away from the goal, to arriving there travelling
 * in gd (arriving perpendicular counts one more bend: the turn into the stub). Exact without obstacles,
 * so a lower bound with them.
 */
function minBends(dx: number, dy: number, d: number, gd: number): number {
  const along = dx * DX[d] + dy * DY[d];
  const side = dx * DY[d] - dy * DX[d];
  if (d === gd) {
    if (side === 0) return along >= 0 ? 0 : 4;
    return along >= 0 ? 2 : 4;
  }
  if (d === (gd ^ 2)) return side !== 0 ? 2 : 4;
  return along >= 0 && dx * DX[gd] + dy * DY[gd] >= 0 ? 1 : 3;
}

/**
 * A* from the seeds to `goal`, which must be reached travelling in goalDir (or perpendicular to it,
 * for one more bend). State = node * 4 + direction of travel; U-turns are not allowed.
 */
function search(L: Lattice, c: Costs, seeds: Seed[], goal: number, goalDir: number, budget: { left: number }): Found | null {
  const { xs, ys, nx, ny, hCost, vCost, touch } = L;
  const states = nx * ny * 4;
  if (gBuf.length < states) {
    gBuf = new Float64Array(states);
    parentBuf = new Int32Array(states);
  }
  const g = gBuf;
  const parent = parentBuf;
  g.fill(Infinity, 0, states);
  heap.clear();
  const back = goalDir ^ 2;
  const gx = xs[goal % nx];
  const gy = ys[Math.floor(goal / nx)];
  const h = (node: number, d: number): number => {
    if (node === goal) return d === back ? 2 * c.bend : 0;
    const dx = gx - xs[node % nx];
    const dy = gy - ys[Math.floor(node / nx)];
    return Math.abs(dx) + Math.abs(dy) + minBends(dx, dy, d, goalDir) * c.bend;
  };

  const banned = new Map<number, number>();
  for (const seed of seeds) {
    if (seed.ban) banned.set(seed.node, (banned.get(seed.node) ?? 0) | seed.ban);
    for (let d = 0; d < 4; d++) {
      if (!(seed.dirs & (1 << d))) continue;
      const s = seed.node * 4 + d;
      if (seed.g < g[s]) {
        g[s] = seed.g;
        parent[s] = -1 - seed.tag;
        heap.push(seed.g + h(seed.node, d), seed.g, s);
      }
    }
  }

  while (heap.size) {
    const s = heap.pop();
    const gs = heap.topG;
    if (gs > g[s]) continue; // stale entry
    if (--budget.left < 0) return null;
    const node = s >> 2;
    const d = s & 3;
    if (node === goal && d !== back) {
      const nodes: number[] = [];
      let k = s;
      for (; k >= 0; k = parent[k]) nodes.push(k >> 2);
      return { nodes: nodes.reverse(), tag: -1 - k, cost: gs };
    }
    const i = node % nx;
    const j = (node - i) / nx;
    // Other nets are not charged at a start: that point was not chosen by the search.
    const t = touch && parent[s] >= 0 ? touch[node] : 0;
    const ban = parent[s] < 0 ? (banned.get(node) ?? 0) : 0;
    for (let d2 = 0; d2 < 4; d2++) {
      if (d2 === (d ^ 2) || ban & (1 << d2)) continue;
      let next: number;
      let cost: number;
      if (d2 === 0) {
        if (i + 1 >= nx) continue;
        next = node + 1;
        cost = xs[i + 1] - xs[i] + hCost[j * (nx - 1) + i];
      } else if (d2 === 2) {
        if (i === 0) continue;
        next = node - 1;
        cost = xs[i] - xs[i - 1] + hCost[j * (nx - 1) + i - 1];
      } else if (d2 === 1) {
        if (j + 1 >= ny) continue;
        next = node + nx;
        cost = ys[j + 1] - ys[j] + vCost[node];
      } else {
        if (j === 0) continue;
        next = node - nx;
        cost = ys[j] - ys[j - 1] + vCost[node - nx];
      }
      if (d2 !== d) cost += c.bend + (t ? c.touch : 0);
      else if (t) cost += t === 2 ? c.touch : c.cross;
      if (next === goal && (d2 & 1) !== (goalDir & 1)) cost += c.bend; // the turn into the stub
      const ng = gs + cost;
      const ns = next * 4 + d2;
      if (ng < g[ns]) {
        g[ns] = ng;
        parent[ns] = s;
        heap.push(ng + h(next, d2), ng, ns);
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Ports and stubs

const ceilTo = (v: number, grid: number) => Math.ceil(v / grid - 1e-9) * grid + 0;
const floorTo = (v: number, grid: number) => Math.floor(v / grid + 1e-9) * grid + 0;

/** Where the straight piece at a port ends: len px out of its side and clear px beyond its symbol, snapped outward to the grid (grid > 0). */
function stubEnd(end: RouteEnd, len: number, clear: number, grid: number): Point {
  const { point: p, rect: r } = end;
  switch (end.side) {
    case 'EAST': {
      const x = Math.max(p.x + len, r.x + r.width + clear);
      return { x: grid ? ceilTo(x, grid) : x, y: p.y };
    }
    case 'WEST': {
      const x = Math.min(p.x - len, r.x - clear);
      return { x: grid ? floorTo(x, grid) : x, y: p.y };
    }
    case 'SOUTH': {
      const y = Math.max(p.y + len, r.y + r.height + clear);
      return { x: p.x, y: grid ? ceilTo(y, grid) : y };
    }
    case 'NORTH': {
      const y = Math.min(p.y - len, r.y - clear);
      return { x: p.x, y: grid ? floorTo(y, grid) : y };
    }
  }
}

/** Where the router's straight piece of wire at a port ends (the first bend or branch is no closer). */
export function portStub(end: RouteEnd, grid = 10): Point {
  return stubEnd(end, STUB, STUB_CLEAR, grid > 0 ? grid : 10);
}

/** Direction of travel from a to an axis-aligned b, or -1 when they are the same point or not aligned. */
function directionTo(a: Point, b: Point): number {
  if (a.y === b.y && a.x !== b.x) return b.x > a.x ? 0 : 2;
  if (a.x === b.x && a.y !== b.y) return b.y > a.y ? 1 : 3;
  return -1;
}

const sameRect = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/** Axis-parallel segment of another net. */
interface Seg {
  horizontal: boolean;
  /** The fixed coordinate (y for horizontal). */
  at: number;
  lo: number;
  hi: number;
}

function cutUp(pl: Point[]): Seg[] {
  const segs: Seg[] = [];
  for (let i = 0; i + 1 < pl.length; i++) {
    const p = pl[i];
    const q = pl[i + 1];
    if (Math.abs(p.y - q.y) <= EPS && Math.abs(p.x - q.x) > EPS) segs.push({ horizontal: true, at: p.y, lo: Math.min(p.x, q.x), hi: Math.max(p.x, q.x) });
    else if (Math.abs(p.x - q.x) <= EPS && Math.abs(p.y - q.y) > EPS) segs.push({ horizontal: false, at: p.x, lo: Math.min(p.y, q.y), hi: Math.max(p.y, q.y) });
  }
  return segs;
}

// Segments of each wire and pin stub seen. A refresh hands every wire it routes the same wires of the
// other nets and the same free pins (neither is changed in place), so each is cut up once, not once per wire.
const segCache = new WeakMap<Point[], Seg[]>();
const stubCache = new WeakMap<RouteEnd, { grid: number; segs: Seg[] }>();

function segmentsOf(polylines: Point[][]): Seg[] {
  const out: Seg[] = [];
  for (const pl of polylines) {
    let segs = segCache.get(pl);
    if (!segs) segCache.set(pl, (segs = cutUp(pl)));
    for (const s of segs) out.push(s);
  }
  return out;
}

function stubSegments(end: RouteEnd, grid: number): Seg[] {
  let c = stubCache.get(end);
  if (!c || c.grid !== grid) stubCache.set(end, (c = { grid, segs: cutUp([end.point, stubEnd(end, STUB, STUB_CLEAR, grid)]) }));
  return c.segs;
}

/** Whether a straight wire p-q would run along another net or touch one of its corners or ends. */
function conflictsWithOthers(p: Point, q: Point, others: Seg[]): boolean {
  const horizontal = p.y === q.y;
  const at = horizontal ? p.y : p.x;
  const lo = horizontal ? Math.min(p.x, q.x) : Math.min(p.y, q.y);
  const hi = horizontal ? Math.max(p.x, q.x) : Math.max(p.y, q.y);
  for (const s of others) {
    if (s.horizontal === horizontal) {
      if (Math.abs(s.at - at) <= MATCH_TOL && Math.min(hi, s.hi) - Math.max(lo, s.lo) > EPS) return true;
    } else if (s.at >= lo - MATCH_TOL && s.at <= hi + MATCH_TOL && at >= s.lo - MATCH_TOL && at <= s.hi + MATCH_TOL) {
      // They meet; only a clean crossing of two insides is fine.
      const inside = s.at > lo + MATCH_TOL && s.at < hi - MATCH_TOL && at > s.lo + MATCH_TOL && at < s.hi - MATCH_TOL;
      if (!inside) return true;
    }
  }
  return false;
}

/**
 * How many of the first `count` segments of an own-net wire stay out of the symbols. Its source symbol
 * does not count, nor, for the wire's last segment, a symbol its end is on (a pin may sit inside the box).
 */
function clearSegments(pl: Point[], count: number, source: Rect, obstacles: Rect[]): number {
  for (let s = 0; s < count; s++) {
    const u = pl[s];
    const v = pl[s + 1];
    const last = s + 2 === pl.length;
    for (const r of obstacles) {
      if (sameRect(r, source)) continue;
      if (last && v.x >= r.x && v.x <= r.x + r.width && v.y >= r.y && v.y <= r.y + r.height) continue;
      if (segmentHitsBox(u, v, r.x, r.y, r.x + r.width, r.y + r.height)) return s;
    }
  }
  return count;
}

/**
 * True when two wires of different nets would look connected: they run along each other, or a corner or
 * end of one lies on the other. Crossing each other's insides is fine.
 */
export function wiresMeet(a: Point[], b: Point[]): boolean {
  const others = segmentsOf([b]);
  for (let i = 0; i + 1 < a.length; i++) {
    const p = a[i];
    const q = a[i + 1];
    if ((p.x === q.x) === (p.y === q.y)) continue; // a point, or slanted (not from the router)
    if (conflictsWithOthers(p, q, others)) return true;
  }
  return false;
}

/** The facing-ports case: one straight wire, when nothing is in the way. */
function straightRoute(from: RouteEnd, to: RouteEnd, obstacles: Rect[], others: Seg[]): Point[] | null {
  const fd = SIDE_DIR[from.side];
  if (SIDE_DIR[to.side] !== (fd ^ 2)) return null;
  const p = from.point;
  const q = to.point;
  if (fd & 1 ? p.x !== q.x : p.y !== q.y) return null;
  if ((q.x - p.x) * DX[fd] + (q.y - p.y) * DY[fd] <= 0) return null;
  const line = [p, q];
  for (const r of obstacles) {
    if (sameRect(r, from.rect) || sameRect(r, to.rect)) continue;
    if (polylineHitsRect(line, { x: r.x - INFLATE, y: r.y - INFLATE, width: r.width + 2 * INFLATE, height: r.height + 2 * INFLATE })) return null;
  }
  if (conflictsWithOthers(p, q, others)) return null;
  return [{ x: p.x, y: p.y }, { x: q.x, y: q.y }];
}

/** Sorted grid lines k * grid in [lo, hi] plus the exact coordinates; grid lines right next to an exact one are dropped. */
function axisCoords(lo: number, hi: number, grid: number, exact: number[]): number[] {
  const sp = [...new Set(exact.filter((v) => v >= lo && v <= hi))].sort((a, b) => a - b);
  const out = [...sp];
  const near = grid * SPECIAL_SNAP;
  let k = 0;
  for (let n = Math.ceil(lo / grid); n * grid <= hi; n++) {
    const v = n * grid + 0;
    while (k < sp.length && sp[k] < v) k++;
    // Now sp[k - 1] < v <= sp[k].
    if ((k < sp.length && sp[k] - v < near) || (k > 0 && v - sp[k - 1] < near)) continue;
    out.push(v);
  }
  return out.sort((a, b) => a - b);
}

/** Mark another net's segment on the lattice: edges along it are nearly forbidden, crossings cost a little, its corners and ends must not be touched. */
function addOther(L: Lattice, s: Seg, c: Costs): void {
  const { nx, ny, hCost, vCost } = L;
  const touch = L.touch!;
  // In the segment's own frame: `along` is the axis it runs on, `across` the other one.
  const along = s.horizontal ? L.xs : L.ys;
  const across = s.horizontal ? L.ys : L.xs;
  const nodeAt = (a: number, b: number) => (s.horizontal ? b * nx + a : a * nx + b);
  let line = lowerBound(across, s.at);
  if (line > 0 && (line === across.length || Math.abs(across[line - 1] - s.at) <= Math.abs(across[line] - s.at))) line--;
  const a0 = lowerBound(along, s.lo - MATCH_TOL);
  if (Math.abs(across[line] - s.at) <= MATCH_TOL) {
    // On a lattice line: forbid running along it, mark its points.
    for (let a = a0; a < along.length && along[a] <= s.hi + MATCH_TOL; a++) {
      const n = nodeAt(a, line);
      touch[n] = Math.max(touch[n], along[a] > s.lo + MATCH_TOL && along[a] < s.hi - MATCH_TOL ? 1 : 2);
    }
    for (let a = Math.max(0, upperBound(along, s.lo) - 1); a + 1 < along.length && along[a] < s.hi; a++) {
      if (Math.min(along[a + 1], s.hi) - Math.max(along[a], s.lo) <= EPS) continue;
      if (s.horizontal) hCost[line * (nx - 1) + a] += OVERLAP;
      else vCost[a * nx + line] += OVERLAP;
    }
  } else {
    // Between two lattice lines: the edges across it cross it (or hit its end).
    const e = lowerBound(across, s.at) - 1;
    if (e < 0 || e >= (s.horizontal ? ny : nx) - 1) return;
    for (let a = a0; a < along.length && along[a] <= s.hi + MATCH_TOL; a++) {
      const cost = along[a] > s.lo + MATCH_TOL && along[a] < s.hi - MATCH_TOL ? c.cross : c.touch;
      if (s.horizontal) vCost[e * nx + a] += cost;
      else hCost[a * (nx - 1) + e] += cost;
    }
  }
}

interface Window {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

// ---------------------------------------------------------------------------
// Routing

/** Best orthogonal route from 'from' to 'to'. First point is exactly from.point, last exactly to.point; consecutive points share x or y; no zero-length or collinear-redundant points. */
export function routeWire(from: RouteEnd, to: RouteEnd, opts: RouteOptions): Point[] {
  const grid = opts.grid && opts.grid > 0 ? opts.grid : 10;
  const p = from.point;
  const q = to.point;
  if (samePoint(p, q)) return [{ x: p.x, y: p.y }, { x: q.x, y: q.y }];
  const others = segmentsOf(opts.otherNets ?? []);
  // Free pins' stubs count as wires of other nets.
  for (const r of opts.reserved ?? []) if (!samePoint(r.point, p) && !samePoint(r.point, q)) for (const s of stubSegments(r, grid)) others.push(s);
  const obstacles = [...opts.obstacles, from.rect, to.rect];
  const straight = straightRoute(from, to, obstacles, others);
  if (straight) return straight;

  const a = stubEnd(from, STUB, STUB_CLEAR, grid);
  const b = stubEnd(to, STUB, STUB_CLEAR, grid);
  // Own-net wires that start at this port, cut to their orthogonal part, and to before they first run
  // through a symbol: a branch takes the wire's path up to the branch point and must not copy a crossing.
  const own: Point[][] = [];
  for (const pl of opts.ownNet ?? []) {
    if (pl.length < 2 || !samePoint(pl[0], p)) continue;
    let n = 1;
    while (n < pl.length && (pl[n].x === pl[n - 1].x || pl[n].y === pl[n - 1].y)) n++;
    n = Math.min(n, 1 + clearSegments(pl, n - 1, from.rect, obstacles));
    if (n >= 2) own.push([p, ...pl.slice(1, n)]);
  }

  // Search windows, smallest first.
  const ends = [p, q, a, b];
  let bx0 = Math.min(...ends.map((e) => e.x), from.rect.x, to.rect.x);
  let by0 = Math.min(...ends.map((e) => e.y), from.rect.y, to.rect.y);
  let bx1 = Math.max(...ends.map((e) => e.x), from.rect.x + from.rect.width, to.rect.x + to.rect.width);
  let by1 = Math.max(...ends.map((e) => e.y), from.rect.y + from.rect.height, to.rect.y + to.rect.height);
  const windows: Window[] = MARGINS.map((m) => ({ x0: bx0 - m, y0: by0 - m, x1: bx1 + m, y1: by1 + m }));
  for (const r of obstacles) {
    bx0 = Math.min(bx0, r.x);
    by0 = Math.min(by0, r.y);
    bx1 = Math.max(bx1, r.x + r.width);
    by1 = Math.max(by1, r.y + r.height);
  }
  for (const pl of own)
    for (const pt of pl) {
      bx0 = Math.min(bx0, pt.x);
      by0 = Math.min(by0, pt.y);
      bx1 = Math.max(bx1, pt.x);
      by1 = Math.max(by1, pt.y);
    }
  windows.push({ x0: bx0 - SHEET_MARGIN, y0: by0 - SHEET_MARGIN, x1: bx1 + SHEET_MARGIN, y1: by1 + SHEET_MARGIN });

  const budget = { left: opts.maxExpansions ?? DEFAULT_MAX_EXPANSIONS };
  let best: { points: Point[]; cost: number } | null = null;
  let prev: Window | null = null;
  for (const w of windows) {
    if (prev && w.x0 >= prev.x0 && w.y0 >= prev.y0 && w.x1 <= prev.x1 && w.y1 <= prev.y1) continue;
    prev = w;
    const found = routeInWindow(from, to, a, b, own, obstacles, others, grid, w, budget);
    if (found && (!best || found.cost < best.cost)) best = found;
    // Clean (no symbol crossed, no wire overlapped): a bigger window cannot do much better.
    if (best && best.cost < OVERLAP) break;
    if (budget.left <= 0) break;
  }
  return best ? best.points : simpleRoute(from, to);
}

function routeInWindow(
  from: RouteEnd,
  to: RouteEnd,
  a: Point,
  b: Point,
  own: Point[][],
  obstacles: Rect[],
  others: Seg[],
  grid: number,
  w: Window,
  budget: { left: number },
): { points: Point[]; cost: number } | null {
  const p = from.point;
  const q = to.point;
  const exactX = [p.x, a.x, q.x, b.x];
  const exactY = [p.y, a.y, q.y, b.y];
  for (const pl of own) for (const pt of pl) {
    exactX.push(pt.x);
    exactY.push(pt.y);
  }
  const L = makeLattice(axisCoords(w.x0, w.x1, grid, exactX), axisCoords(w.y0, w.y1, grid, exactY));
  const { xs, ys, nx, ny, hCost, vCost } = L;
  const costs: Costs = { bend: 2 * grid, cross: 0.5 * grid, touch: 50 * grid };

  // Symbols: blocked, with a band around them that is a little more expensive.
  const near = new Uint8Array(nx * ny);
  const pad = INFLATE + grid;
  for (const r of obstacles) {
    if (r.x - pad > w.x1 || r.y - pad > w.y1 || r.x + r.width + pad < w.x0 || r.y + r.height + pad < w.y0) continue;
    blockBox(L, r.x - INFLATE, r.y - INFLATE, r.x + r.width + INFLATE, r.y + r.height + INFLATE, BLOCK);
    const i0 = upperBound(xs, r.x - pad);
    const i1 = lowerBound(xs, r.x + r.width + pad);
    for (let j = upperBound(ys, r.y - pad); j < ny && ys[j] < r.y + r.height + pad; j++) near.fill(1, j * nx + i0, j * nx + i1);
  }
  for (let j = 0; j < ny; j++)
    for (let i = 0; i + 1 < nx; i++) if (near[j * nx + i] && near[j * nx + i + 1]) hCost[j * (nx - 1) + i] += HUG * (xs[i + 1] - xs[i]);
  for (let j = 0; j + 1 < ny; j++)
    for (let i = 0; i < nx; i++) if (near[j * nx + i] && near[(j + 1) * nx + i]) vCost[j * nx + i] += HUG * (ys[j + 1] - ys[j]);

  // Other nets.
  const tol = MATCH_TOL;
  const inWindow = others.filter((s) =>
    s.horizontal ? s.at >= w.y0 - tol && s.at <= w.y1 + tol && s.hi >= w.x0 && s.lo <= w.x1 : s.at >= w.x0 - tol && s.at <= w.x1 + tol && s.hi >= w.y0 && s.lo <= w.y1,
  );
  if (inWindow.length) {
    L.touch = new Uint8Array(nx * ny);
    for (const s of inWindow) addOther(L, s, costs);
  }

  // Starts: the source stub, and every lattice point of the wires this net already has.
  const node = (pt: Point) => {
    const i = findExact(xs, pt.x);
    const j = findExact(ys, pt.y);
    return i < 0 || j < 0 ? -1 : j * nx + i;
  };
  const start = node(a);
  const goal = node(b);
  if (start < 0 || goal < 0) return null;
  const seeds: Seed[] = [{ node: start, dirs: 1 << SIDE_DIR[from.side], g: 0, tag: 0 }];
  const branchFrom: { wire: number; seg: number }[] = [];
  if (own.length) {
    // Branching off an existing junction would make a four-way join: allowed, but not free.
    const joins = new Set(netJunctions(own).map(node));
    const seeded = new Uint8Array(nx * ny);
    const stub = Math.abs(a.x - p.x) + Math.abs(a.y - p.y);
    own.forEach((pl, k) => {
      const end = pl[pl.length - 1];
      for (let s = 0; s + 1 < pl.length; s++) {
        const u = pl[s];
        const v = pl[s + 1];
        const horizontal = u.y === v.y;
        const line = horizontal ? findExact(ys, u.y) : findExact(xs, u.x);
        if (line < 0) continue;
        const axis = horizontal ? xs : ys;
        const lo = horizontal ? Math.min(u.x, v.x) : Math.min(u.y, v.y);
        const hi = horizontal ? Math.max(u.x, v.x) : Math.max(u.y, v.y);
        for (let t = lowerBound(axis, lo); t < axis.length && axis[t] <= hi; t++) {
          const n = horizontal ? line * nx + t : t * nx + line;
          // No branching inside a stub: not before the source stub's end, not in the last STUB px before a sink.
          const x = horizontal ? axis[t] : xs[line];
          const y = horizontal ? ys[line] : axis[t];
          if (s === 0 && Math.abs(x - p.x) + Math.abs(y - p.y) < stub) continue;
          if (s === pl.length - 2 && Math.abs(x - end.x) + Math.abs(y - end.y) < STUB) continue;
          if (seeded[n]) continue;
          seeded[n] = 1;
          branchFrom.push({ wire: k, seg: s });
          // Any way out except back along the wire toward the source: that would fold the new wire onto the
          // old one and really branch earlier, perhaps inside the source stub.
          const prior = x === u.x && y === u.y ? pl[s - 1] : u;
          const back = prior ? directionTo({ x, y }, prior) : -1;
          const ban = back < 0 ? 0 : 1 << back;
          seeds.push({ node: n, dirs: 15 & ~ban, ban, g: joins.has(n) ? costs.bend : 0, tag: branchFrom.length });
        }
      }
    });
  }

  const found = search(L, costs, seeds, goal, SIDE_DIR[to.side] ^ 2, budget);
  if (!found) return null;
  const path = found.nodes.map((n) => ({ x: xs[n % nx], y: ys[Math.floor(n / nx)] }));
  const head = found.tag === 0 ? [p] : own[branchFrom[found.tag - 1].wire].slice(0, branchFrom[found.tag - 1].seg + 1);
  const points = simplify([...head, ...path, q]);
  points[0] = { x: p.x, y: p.y };
  return { points, cost: found.cost };
}

/**
 * Fast orthogonal route that ignores obstacles (used while dragging, and as fallback): leaves 'from'
 * perpendicular to its side by a 10px stub, enters 'to' likewise, with as few bends as possible
 * (Z shape for EAST->WEST, L shapes where natural, and sensible U/detours when the target is behind
 * the source). Only the two end symbols are avoided.
 */
export function simpleRoute(from: RouteEnd, to: RouteEnd): Point[] {
  const p = from.point;
  const q = to.point;
  if (samePoint(p, q)) return [{ x: p.x, y: p.y }, { x: q.x, y: q.y }];
  const fd = SIDE_DIR[from.side];
  const td = SIDE_DIR[to.side] ^ 2;
  let len = STUB;
  let clear = STUB_CLEAR;
  if (fd === td) {
    // Facing ports closer than two stubs meet in the middle.
    const gap = (q.x - p.x) * DX[fd] + (q.y - p.y) * DY[fd];
    if (gap > 0 && gap < 2 * STUB) {
      len = gap / 2;
      clear = 0;
    }
  }
  const a = stubEnd(from, len, clear, 0);
  const b = stubEnd(to, len, clear, 0);
  const fr = from.rect;
  const tr = to.rect;

  // A small lattice of the coordinates a short route can use: the ports, their stubs, the middle,
  // the gap between the two symbols, and lines just outside each symbol for detours.
  const mid = (u: number, v: number) => {
    const m = (u + v) / 2;
    const snapped = Math.round(m / 10) * 10 + 0;
    return snapped > Math.min(u, v) && snapped < Math.max(u, v) ? snapped : m;
  };
  const gapMid = (l1: number, r1: number, l2: number, r2: number): number[] => (r1 < l2 ? [mid(r1, l2)] : r2 < l1 ? [mid(r2, l1)] : []);
  const prefX = [p.x, q.x, mid(a.x, b.x), ...gapMid(fr.x, fr.x + fr.width, tr.x, tr.x + tr.width)];
  const prefY = [p.y, q.y, mid(a.y, b.y), ...gapMid(fr.y, fr.y + fr.height, tr.y, tr.y + tr.height)];
  const uniq = (v: number[]) => [...new Set(v)].sort((u, w) => u - w);
  const xs = uniq([...prefX, a.x, b.x, fr.x - STUB, fr.x + fr.width + STUB, tr.x - STUB, tr.x + tr.width + STUB]);
  const ys = uniq([...prefY, a.y, b.y, fr.y - STUB, fr.y + fr.height + STUB, tr.y - STUB, tr.y + tr.height + STUB]);
  const L = makeLattice(xs, ys);
  const { nx, ny, hCost, vCost } = L;
  // Lines other than the preferred ones cost a hair more, so equal routes put their bends in the middle.
  const PREF = 1e-3;
  for (let j = 0; j < ny; j++) if (!prefY.includes(ys[j])) for (let i = 0; i + 1 < nx; i++) hCost[j * (nx - 1) + i] += PREF * (xs[i + 1] - xs[i]);
  for (let i = 0; i < nx; i++) if (!prefX.includes(xs[i])) for (let j = 0; j + 1 < ny; j++) vCost[j * nx + i] += PREF * (ys[j + 1] - ys[j]);
  const keep = 2;
  for (const r of [fr, tr]) blockBox(L, r.x - keep, r.y - keep, r.x + r.width + keep, r.y + r.height + keep, BLOCK);

  const at = (pt: Point) => findExact(ys, pt.y) * nx + findExact(xs, pt.x);
  const found = search(L, { bend: 1000, cross: 0, touch: 0 }, [{ node: at(a), dirs: 1 << fd, g: 0, tag: 0 }], at(b), td, { left: 100_000 });
  if (!found) return orthogonalize([p, a, b, q]);
  const points = simplify([p, ...found.nodes.map((n) => ({ x: xs[n % nx], y: ys[Math.floor(n / nx)] })), q]);
  points[0] = { x: p.x, y: p.y };
  return points;
}
