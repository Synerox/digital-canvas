/**
 * Put an ELK layout on the editor's grid.
 *
 * ELK places symbols at any (fractional) coordinate. Every symbol size and pin
 * offset is a multiple of the grid, so pins of connected symbols then end up a
 * pixel or a few apart, and ELK draws each such wire with a tiny step in it
 * (1 to 9 px), at fractional coordinates that anti-alias differently from the
 * wires next to them. Those steps are the "gaps" and "misaligned lines" a
 * reader sees, and the editor, which snaps everything to the grid, cannot
 * line anything up with such a symbol either.
 *
 * So after ELK:
 *
 * 1. Every symbol moves to the nearest grid point.
 * 2. Symbols then move up or down by a few grid steps where that makes a wire
 *    between them straight (or turns a small step into none), as long as they
 *    keep their order and their distance to the symbols above and below them,
 *    and stay near where ELK put them.
 * 3. Each wire keeps ELK's shape: its first and last legs follow its pins,
 *    every other leg moves to the nearest grid line. A wire that then no
 *    longer leaves and enters its pins the right way, runs through a symbol or
 *    runs along a wire of another net is routed again by the editor's router.
 */
import type { Side } from '../core/diagram';
import { type Rect, type RouteEnd, netJunctions, polylineHitsRect, routeWire, simplify, wiresMeet } from '../editor/router';
import type { LEdge, LNode, LayoutResult, Point } from './elk-layout';

/** How far (in grid steps) a symbol may move from the grid point nearest to where ELK put it. */
const MAX_DRIFT = 3;
/** Cost of a wire with a step of at most two grid steps in it (a straight wire costs nothing, any other wire 1). */
const JOG = 3;
/** Per grid step a symbol moved from where ELK put it: only breaks ties. */
const DRIFT = 0.01;
const PASSES = 8;

/** Side a wire leaves a pin in (or enters it against). */
const OUT: Record<Side, Point> = { EAST: { x: 1, y: 0 }, WEST: { x: -1, y: 0 }, SOUTH: { x: 0, y: 1 }, NORTH: { x: 0, y: -1 } };

/** A port's place on its symbol. */
interface PortAt {
  node: number;
  dx: number;
  dy: number;
  side: Side;
}

/** A wire from an EAST pin to a WEST pin further right: it is straight when the two pins are level. */
interface Link {
  s: number;
  t: number;
  /** Offsets of the two pins below their symbols' tops. */
  sdy: number;
  tdy: number;
}

/** Offsets come from sizeNode as multiples of the grid; ELK's coordinates add float noise to them. */
const clean = (v: number) => Math.round(v * 1000) / 1000;

/**
 * The same layout with every symbol on the grid, as many wires straight as moving symbols by a few grid
 * steps allows, and every wire on grid lines (but for its ends on pins off the grid, such as a MUX's select).
 */
export function alignToGrid(layout: LayoutResult, grid: number): LayoutResult {
  const snap = (v: number) => Math.round(v / grid) * grid;
  const nodes = layout.nodes;
  const portAt = new Map<string, PortAt>();
  /** Where ELK put each pin. */
  const elkPin = new Map<string, Point>();
  nodes.forEach((n, i) =>
    n.ports.forEach((p) => {
      portAt.set(p.id, { node: i, dx: clean(p.x - n.x), dy: clean(p.y - n.y), side: p.side });
      elkPin.set(p.id, { x: p.x, y: p.y });
    }),
  );

  const xs = nodes.map((n) => snap(n.x));
  const ys = placeRows(layout, portAt, xs, grid);

  const moved: LNode[] = nodes.map((n, i) => {
    const x = xs[i];
    const y = ys[i];
    if (x === n.x && y === n.y) return n;
    return { ...n, x, y, ports: n.ports.map((p) => ({ ...p, x: x + portAt.get(p.id)!.dx, y: y + portAt.get(p.id)!.dy })) };
  });
  const pinOf = (id: string): Point | undefined => {
    const a = portAt.get(id);
    return a && { x: xs[a.node] + a.dx, y: ys[a.node] + a.dy };
  };
  const rects: Rect[] = moved.map((n) => ({ x: n.x, y: n.y, width: n.width, height: n.height }));
  const endOf = (id: string): RouteEnd | undefined => {
    const a = portAt.get(id);
    const p = pinOf(id);
    return a && p ? { point: p, side: a.side, rect: rects[a.node] } : undefined;
  };

  // Wires: ELK's shape on the grid, where it still fits; the others are routed again below.
  const netOf = (e: LEdge) => e.source.port;
  const routes = new Map<string, Point[]>();
  const byNet = new Map<string, Point[][]>();
  // The symbols and the wires laid so far by column, so that a wire is checked only against those near it.
  const rectCols = columns(moved, xs, 0);
  const wireCols = new Map<number, { net: string; points: Point[] }[]>();
  const add = (e: LEdge, points: Point[]) => {
    routes.set(e.id, points);
    const list = byNet.get(netOf(e));
    if (list) list.push(points);
    else byNet.set(netOf(e), [points]);
    const b = boundsOf(points);
    for (let c = Math.floor(b.x0 / COLUMN); c <= Math.floor(b.x1 / COLUMN); c++) {
      const col = wireCols.get(c);
      if (col) col.push({ net: netOf(e), points });
      else wireCols.set(c, [{ net: netOf(e), points }]);
    }
  };
  const again: LEdge[] = [];
  for (const e of layout.edges) {
    const s = endOf(e.source.port);
    const t = endOf(e.target.port);
    const os = elkPin.get(e.source.port);
    const ot = elkPin.get(e.target.port);
    const points = s && t && os && ot ? onGrid(e.points, s, t, os, ot, snap) : undefined;
    if (
      !points ||
      !s ||
      !t ||
      runsThroughSymbol(points, rects, rectCols, portAt.get(e.source.port)!.node, portAt.get(e.target.port)!.node) ||
      meetsOtherNet(points, netOf(e), wireCols)
    ) {
      again.push(e);
      continue;
    }
    add(e, points);
  }
  for (const e of again) {
    const s = endOf(e.source.port);
    const t = endOf(e.target.port);
    if (!s || !t) continue;
    const otherNets: Point[][] = [];
    for (const [net, polys] of byNet) if (net !== netOf(e)) otherNets.push(...polys);
    add(e, routeWire(s, t, { obstacles: rects, ownNet: byNet.get(netOf(e)) ?? [], otherNets, grid }));
  }

  const firstOfNet = new Set<string>();
  const edges: LEdge[] = layout.edges.map((e) => {
    const points = routes.get(e.id) ?? e.points;
    let junctions: Point[] = [];
    if (!firstOfNet.has(netOf(e))) {
      firstOfNet.add(netOf(e));
      const polys = byNet.get(netOf(e)) ?? [];
      if (polys.length > 1) junctions = netJunctions(polys);
    }
    const same = points.length === e.points.length && points.every((p, i) => p.x === e.points[i].x && p.y === e.points[i].y);
    // ELK put the label by the wire as ELK drew it: a wire drawn elsewhere gets its label placed again (sheet geometry does that).
    return { ...e, points, junctions, labelBox: same ? e.labelBox : undefined };
  });

  let x1 = 0;
  let y1 = 0;
  for (const n of moved) {
    x1 = Math.max(x1, n.x + n.width);
    y1 = Math.max(y1, n.y + n.height);
  }
  for (const e of edges) {
    for (const p of e.points) {
      x1 = Math.max(x1, p.x);
      y1 = Math.max(y1, p.y);
    }
    if (e.labelBox) {
      x1 = Math.max(x1, e.labelBox.x + e.labelBox.width);
      y1 = Math.max(y1, e.labelBox.y + e.labelBox.height);
    }
  }
  return { ...layout, nodes: moved, edges, width: Math.max(48, Math.ceil(x1 + 24)), height: Math.max(48, Math.ceil(y1 + 24)) };
}

/** Width of the columns symbols are filed under, so that what is near a symbol is found without looking at all of them. */
const COLUMN = 200;

/** The symbols by column: those whose span (`xs`, widened by `pad`) reaches into it. */
function columns(nodes: readonly LNode[], xs: readonly number[], pad: number): Map<number, number[]> {
  const cols = new Map<number, number[]>();
  nodes.forEach((n, i) => {
    for (let c = Math.floor((xs[i] - pad) / COLUMN); c <= Math.floor((xs[i] + n.width + pad) / COLUMN); c++) {
      const list = cols.get(c);
      if (list) list.push(i);
      else cols.set(c, [i]);
    }
  });
  return cols;
}

/** The symbols filed under the columns from x `lo` to `hi` (each once). */
function near(cols: ReadonlyMap<number, number[]>, lo: number, hi: number): Set<number> {
  const out = new Set<number>();
  for (let c = Math.floor(lo / COLUMN); c <= Math.floor(hi / COLUMN); c++) for (const i of cols.get(c) ?? []) out.add(i);
  return out;
}

/**
 * The y of every symbol: first the grid line nearest to ELK's y, then moves of a few grid steps that make
 * wires straight (see the file comment). A move is taken only when it lowers the cost of the symbol's wires,
 * so the search ends.
 */
function placeRows(layout: LayoutResult, portAt: ReadonlyMap<string, PortAt>, xs: readonly number[], grid: number): number[] {
  const snap = (v: number) => Math.round(v / grid) * grid;
  const nodes = layout.nodes;
  const home = nodes.map((n) => snap(n.y));
  const ys = [...home];

  const links: Link[] = [];
  const incident: number[][] = nodes.map(() => []);
  for (const e of layout.edges) {
    const a = portAt.get(e.source.port);
    const b = portAt.get(e.target.port);
    if (!a || !b || a.node === b.node || a.side !== 'EAST' || b.side !== 'WEST') continue;
    if (xs[b.node] <= xs[a.node] + nodes[a.node].width) continue;
    incident[a.node].push(links.length);
    incident[b.node].push(links.length);
    links.push({ s: a.node, t: b.node, sdy: a.dy, tdy: b.dy });
  }

  // Symbols above and below each other (their columns overlap) keep their order and their distance, up to two
  // grid steps: a wire may run between them.
  interface Bound {
    j: number;
    above: boolean;
    gap: number;
  }
  const bounds: Bound[][] = nodes.map(() => []);
  const cols = columns(nodes, xs, grid);
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    for (const j of near(cols, xs[i] - grid, xs[i] + a.width + grid)) {
      if (j <= i) continue;
      const b = nodes[j];
      if (!(xs[i] < xs[j] + b.width + grid && xs[j] < xs[i] + a.width + grid)) continue;
      if (a.y + a.height <= b.y + 1e-6) {
        const gap = Math.min(2 * grid, b.y - a.y - a.height);
        bounds[i].push({ j, above: false, gap });
        bounds[j].push({ j: i, above: true, gap });
      } else if (b.y + b.height <= a.y + 1e-6) {
        const gap = Math.min(2 * grid, a.y - b.y - b.height);
        bounds[i].push({ j, above: true, gap });
        bounds[j].push({ j: i, above: false, gap });
      }
    }
  }

  // Wires that pass a symbol's column without touching it (long wires through a layer): the symbol keeps off them.
  interface Passing {
    y: number;
    room: number;
  }
  const passing: Passing[][] = nodes.map(() => []);
  for (const e of layout.edges) {
    const ends = new Set([portAt.get(e.source.port)?.node, portAt.get(e.target.port)?.node]);
    for (let k = 1; k < e.points.length; k++) {
      const p = e.points[k - 1];
      const q = e.points[k];
      if (Math.abs(p.y - q.y) > 1e-6) continue;
      const lo = Math.min(p.x, q.x);
      const hi = Math.max(p.x, q.x);
      for (const i of near(cols, lo, hi)) {
        const n = nodes[i];
        if (ends.has(i) || hi <= n.x || lo >= n.x + n.width) continue;
        // As far as ELK kept it, up to a grid step.
        const room = Math.min(grid, Math.max(0, n.y - p.y, p.y - n.y - n.height));
        passing[i].push({ y: snap(p.y), room });
      }
    }
  }

  const linkCost = (l: Link) => {
    const d = Math.abs(ys[l.t] + l.tdy - (ys[l.s] + l.sdy));
    return d < 0.5 ? 0 : d <= 2 * grid + 0.5 ? JOG : 1;
  };
  const costAt = (i: number, y: number) => {
    const was = ys[i];
    ys[i] = y;
    let c = (DRIFT * Math.abs(y - home[i])) / grid;
    for (const k of incident[i]) c += linkCost(links[k]);
    ys[i] = was;
    return c;
  };
  const fits = (i: number, y: number) => {
    if (Math.abs(y - home[i]) > MAX_DRIFT * grid + 0.5) return false;
    const h = nodes[i].height;
    for (const b of bounds[i]) {
      const o = nodes[b.j];
      if (b.above ? y < ys[b.j] + o.height + b.gap - 0.5 : y + h + b.gap > ys[b.j] + 0.5) return false;
    }
    for (const w of passing[i]) if (w.y > y - w.room + 0.5 && w.y < y + h + w.room - 0.5) return false;
    return true;
  };

  const order = nodes.map((_, i) => i).sort((a, b) => xs[a] - xs[b] || ys[a] - ys[b]);
  for (let pass = 0; pass < PASSES; pass++) {
    let changed = false;
    for (const i of order) {
      let best = costAt(i, ys[i]);
      let to = ys[i];
      for (const k of incident[i]) {
        const l = links[k];
        // The y at which this wire is straight.
        const y = l.s === i ? ys[l.t] + l.tdy - l.sdy : ys[l.s] + l.sdy - l.tdy;
        if (Math.abs(y - snap(y)) > 0.01 || y === ys[i] || !fits(i, y)) continue;
        const c = costAt(i, y);
        if (c < best - 1e-9) {
          best = c;
          to = y;
        }
      }
      if (to !== ys[i]) {
        ys[i] = to;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return ys;
}

/**
 * ELK's route of a wire moved onto the grid: the first leg follows the source pin (now at `s`), the last
 * the target pin (`t`), any leg that ran level with one of the pins (at `os`, `ot` before) still does, and
 * every other leg moves to the nearest grid line. Undefined when the result no longer leaves the source and
 * enters the target the way their sides face.
 */
// Exported for the tests.
export function onGrid(points: Point[], s: RouteEnd, t: RouteEnd, os: Point, ot: Point, snap: (v: number) => number): Point[] | undefined {
  const pts = simplify(points);
  if (pts.length < 2) return undefined;
  const legs: { horizontal: boolean; at: number }[] = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const horizontal = Math.abs(a.y - b.y) < 1e-6;
    if (horizontal === Math.abs(a.x - b.x) < 1e-6) return undefined;
    legs.push({ horizontal, at: horizontal ? a.y : a.x });
  }
  const sp = s.point;
  const tp = t.point;
  const n = legs.length;
  const at = legs.map((g, k) => {
    const [from, to, was, wasTo] = g.horizontal ? [sp.y, tp.y, os.y, ot.y] : [sp.x, tp.x, os.x, ot.x];
    if (k === 0) return from;
    if (k === n - 1) return to;
    if (Math.abs(g.at - was) < 0.5) return from;
    if (Math.abs(g.at - wasTo) < 0.5) return to;
    return snap(g.at);
  });
  let out: Point[];
  if (n === 1) {
    // One straight leg whose ends are no longer level: a step in the middle.
    const g = legs[0];
    if (g.horizontal ? sp.y === tp.y : sp.x === tp.x) out = [sp, tp];
    else if (g.horizontal) {
      const m = snap((sp.x + tp.x) / 2);
      out = [sp, { x: m, y: sp.y }, { x: m, y: tp.y }, tp];
    } else {
      const m = snap((sp.y + tp.y) / 2);
      out = [sp, { x: sp.x, y: m }, { x: tp.x, y: m }, tp];
    }
  } else {
    out = [sp];
    for (let k = 0; k + 1 < n; k++) out.push(legs[k].horizontal ? { x: at[k + 1], y: at[k] } : { x: at[k], y: at[k + 1] });
    out.push(tp);
  }
  out = simplify(out);
  if (out.length < 2) return undefined;
  const heads = (a: Point, b: Point, d: Point) => Math.sign(Math.round(b.x - a.x)) === d.x && Math.sign(Math.round(b.y - a.y)) === d.y;
  const into = OUT[t.side];
  if (!heads(out[0], out[1], OUT[s.side]) || !heads(out[out.length - 1], out[out.length - 2], into)) return undefined;
  return out;
}

/** Whether a wire runs through a symbol (its first leg may start inside its source's box and its last end inside its target's: a pin on a sloped edge). */
function runsThroughSymbol(points: Point[], rects: readonly Rect[], cols: ReadonlyMap<number, number[]>, source: number, target: number): boolean {
  const b = boundsOf(points);
  for (const i of near(cols, b.x0, b.x1)) {
    let line = points;
    if (i === source) line = line.slice(1);
    if (i === target) line = line.slice(0, -1);
    if (line.length >= 2 && polylineHitsRect(line, rects[i])) return true;
  }
  return false;
}

interface Bounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const boundsCache = new WeakMap<Point[], Bounds>();

function boundsOf(points: Point[]): Bounds {
  let b = boundsCache.get(points);
  if (b) return b;
  b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const p of points) {
    b.x0 = Math.min(b.x0, p.x);
    b.y0 = Math.min(b.y0, p.y);
    b.x1 = Math.max(b.x1, p.x);
    b.y1 = Math.max(b.y1, p.y);
  }
  boundsCache.set(points, b);
  return b;
}

/** Whether a wire runs along, or ends on, a wire of another net (it would read as connected to it). */
function meetsOtherNet(points: Point[], net: string, cols: ReadonlyMap<number, { net: string; points: Point[] }[]>): boolean {
  const b = boundsOf(points);
  const seen = new Set<Point[]>();
  for (let col = Math.floor((b.x0 - 3) / COLUMN); col <= Math.floor((b.x1 + 3) / COLUMN); col++) {
    for (const o of cols.get(col) ?? []) {
      if (o.net === net || seen.has(o.points)) continue;
      seen.add(o.points);
      const c = boundsOf(o.points);
      if (c.x1 < b.x0 - 3 || c.x0 > b.x1 + 3 || c.y1 < b.y0 - 3 || c.y0 > b.y1 + 3) continue;
      if (wiresMeet(points, o.points)) return true;
    }
  }
  return false;
}
