/**
 * Sheet geometry: the drawable layout (the same LayoutResult the renderer and
 * the exporters use) from a netlist, symbol positions and stored wire routes.
 *
 * Stored routes are used as long as both of their ends still meet their
 * ports; hand-shaped routes are stretched when a symbol moves; every other
 * wire is routed again with the orthogonal router. Junction dots are found
 * from the drawn wires, so they are right whoever routed them.
 */
import type { DEdge, DNode, Diagram, Side } from '../core/diagram';
import { FONT, type LEdge, type LNode, type LayoutResult, type MeasureText, type Point, sizeNode } from '../layout/elk-layout';
import type { Box, RouteRec } from './doc';
import { type Rect, type RouteEnd, adjustRoute, netJunctions, polylineCrowdsRect, portStub, routeWire, simpleRoute, wiresMeet } from './router';

export interface GeometryInput {
  netlist: Diagram;
  /** Top-left corner of every symbol. Symbols without one are placed at the origin. */
  pos: Record<string, Point>;
  routes: Record<string, RouteRec>;
  measure: MeasureText;
  /** While dragging: wires that need a new route get a quick one instead of a search. */
  fast?: boolean;
  /**
   * Symbols that just moved: automatic wires now running into them are routed again. Symbols that differ
   * from `previous` (moved, grown, placed, pasted) count as moved too.
   */
  moved?: ReadonlySet<string>;
  /**
   * The previous geometry of the same sheet: unchanged symbols keep their objects (fewer re-renders), and
   * stored wires are checked against what changed since.
   */
  previous?: LayoutResult;
}

export interface Geometry {
  layout: LayoutResult;
  /** Routes found now, to be stored so they are not searched again. */
  routed: Record<string, RouteRec>;
}

const near = (a: Point | undefined, b: Point | undefined) => !!a && !!b && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;

const nodeKeys = new WeakMap<LNode, string>();

function nodeKey(n: DNode, x: number, y: number): string {
  return JSON.stringify([x, y, n.kind, n.label, n.subLabel, n.cellType, n.attrs, n.rule, n.ports.map((p) => [p.id, p.side, p.width, p.dir])]);
}

/** For a layout drawn while dragging (fast): the layout drawn before the drag began. */
const beforeDrag = new WeakMap<LayoutResult, LayoutResult>();

const samePoints = (a: Point[], b: Point[]) => a === b || (a.length === b.length && a.every((p, i) => near(p, b[i])));

/** A symbol, its pins, and a box around both and the pins' stubs (with room to spare: the exact tests come after). */
interface Keep {
  id: string;
  rect: Rect;
  ports: string[];
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const keepOut = (n: LNode): Keep => ({
  id: n.id,
  rect: { x: n.x, y: n.y, width: n.width, height: n.height },
  ports: n.ports.map((p) => p.id),
  x0: n.x - 20,
  y0: n.y - 20,
  x1: n.x + n.width + 20,
  y1: n.y + n.height + 20,
});

type Bounds = ReturnType<typeof boundsOf>;
const apart = (a: Bounds, b: Bounds) => a.x1 < b.x0 || a.x0 > b.x1 || a.y1 < b.y0 || a.y0 > b.y1;

function boundsOf(points: Point[]): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of points) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return { x0, y0, x1, y1 };
}

/** Unit step of an axis-parallel move from a to b (both components set for a slanted one). */
const heading = (a: Point, b: Point): [number, number] => [Math.abs(b.x - a.x) < 0.5 ? 0 : Math.sign(b.x - a.x), Math.abs(b.y - a.y) < 0.5 ? 0 : Math.sign(b.y - a.y)];

/**
 * How far wires w and o, which start at the same point, run together before they part, and whether w is
 * the one that turns off there (or ends). A wire routed as a branch of o runs along o up to its branch
 * point; when both turn where they part, either may be the branch.
 */
export function runTogether(w: Point[], o: Point[]): { len: number; turnsOff: boolean } {
  if (w.length < 2 || o.length < 2 || !near(w[0], o[0])) return { len: 0, turnsOff: false };
  let at: Point = w[0];
  let i = 1;
  let j = 1;
  let len = 0;
  let dir: [number, number] = [0, 0];
  for (;;) {
    while (i < w.length && near(w[i], at)) i++;
    while (j < o.length && near(o[j], at)) j++;
    if (i >= w.length || j >= o.length) return { len, turnsOff: i >= w.length };
    const wd = heading(at, w[i]);
    const od = heading(at, o[j]);
    if (wd[0] !== od[0] || wd[1] !== od[1]) return { len, turnsOff: wd[0] !== dir[0] || wd[1] !== dir[1] };
    // Slanted pieces do not come from the router: stop comparing.
    if (wd[0] && wd[1]) return { len, turnsOff: true };
    const step = Math.min(Math.abs(w[i].x - at.x) + Math.abs(w[i].y - at.y), Math.abs(o[j].x - at.x) + Math.abs(o[j].y - at.y));
    at = { x: at.x + wd[0] * step, y: at.y + wd[1] * step };
    len += step;
    dir = wd;
  }
}

/** Width of a wire label's box (the same as ELK is given). */
const labelWidth = (text: string, measure: MeasureText) => Math.ceil(measure(text, FONT.label)) + 4;

/** Where a wire label goes: above the last horizontal stretch before the target. */
export function labelBox(points: Point[], text: string, measure: MeasureText): Box {
  const width = labelWidth(text, measure);
  const height = 13;
  const end = points[points.length - 1];
  for (let i = points.length - 1; i > 0; i--) {
    const a = points[i - 1];
    const b = points[i];
    if (Math.abs(a.y - b.y) > 0.5 || Math.abs(a.x - b.x) < 8) continue;
    const lo = Math.min(a.x, b.x);
    const hi = Math.max(a.x, b.x);
    // Hug the target end of the stretch, like ELK's head labels.
    const right = i === points.length - 1 ? hi - 4 : hi - 2;
    const x = Math.max(lo + 2, right - width);
    return { x, y: a.y - height - 1, width, height };
  }
  return { x: end.x + 4, y: end.y - height - 2, width, height };
}

const DIR: Record<Side, Point> = { EAST: { x: 1, y: 0 }, WEST: { x: -1, y: 0 }, NORTH: { x: 0, y: -1 }, SOUTH: { x: 0, y: 1 } };

export function buildGeometry(input: GeometryInput): Geometry {
  const { netlist, pos, routes, measure } = input;
  const fast = !!input.fast;
  const prev = new Map((input.previous?.nodes ?? []).map((n) => [n.id, n]));

  const nodes: LNode[] = [];
  const rectOf = new Map<string, Rect>();
  const ends = new Map<string, RouteEnd>();
  for (const n of netlist.nodes) {
    const p = pos[n.id] ?? { x: 0, y: 0 };
    const key = nodeKey(n, p.x, p.y);
    const old = prev.get(n.id);
    let ln: LNode;
    if (old && nodeKeys.get(old) === key) {
      ln = old;
    } else {
      const s = sizeNode(n, measure);
      ln = {
        ...n,
        x: p.x,
        y: p.y,
        width: s.width,
        height: s.height,
        ports: n.ports.map((q) => ({
          id: q.id,
          name: q.name,
          side: q.side,
          dir: q.dir,
          width: q.width,
          x: p.x + (s.ports[q.id]?.x ?? 0),
          y: p.y + (s.ports[q.id]?.y ?? 0),
        })),
      };
      nodeKeys.set(ln, key);
    }
    nodes.push(ln);
    const rect = { x: ln.x, y: ln.y, width: ln.width, height: ln.height };
    rectOf.set(n.id, rect);
    for (const q of ln.ports) ends.set(q.id, { point: { x: q.x, y: q.y }, side: q.side, rect });
  }
  const obstacles = nodes.map((n) => rectOf.get(n.id)!);

  // What the stored routes were last checked against: the sheet as drawn before this change (before the
  // drag, for a drag preview, which draws quick stand-in routes).
  const settled = input.previous && (beforeDrag.get(input.previous) ?? input.previous);
  const settledNodes = !fast && settled ? new Map(settled.nodes.map((n) => [n.id, n])) : undefined;
  const settledEdges = !fast && settled ? new Map(settled.edges.map((x) => [x.id, x.points])) : undefined;
  const netOf = (e: DEdge) => e.source.port;
  const netEdges = new Map<string, DEdge[]>();
  for (const e of netlist.edges) {
    const list = netEdges.get(netOf(e));
    if (list) list.push(e);
    else netEdges.set(netOf(e), [e]);
  }
  const netPorts = (net: string) => new Set([net, ...(netEdges.get(net) ?? []).map((x) => x.target.port)]);

  // Symbols that are new, moved, grew or shrank since then: automatic wires now running into one are routed again.
  const changed: Keep[] = [];
  if (settledNodes || input.moved?.size)
    for (const n of nodes) {
      const o = settledNodes?.get(n.id);
      if (input.moved?.has(n.id) || (settledNodes && (!o || o.x !== n.x || o.y !== n.y || o.width !== n.width || o.height !== n.height)))
        changed.push(keepOut(n));
    }
  let all: Keep[] | undefined;
  // Stored routes that still meet both of their pins, and whether each one is new here or moved along with
  // both of its symbols (pasted, or moved as a group): such a route may have landed on any symbol or wire.
  const fits = new Map<string, boolean>();
  // Pins whose wire is kept, and those whose wire is kept as it was. Such a wire stands for the pin's stub
  // (and may be crossed there); a fresh one only for routes that moved along with it.
  const keptPins = new Set<string>();
  const steadyPins = new Set<string>();
  for (const e of netlist.edges) {
    const s = ends.get(e.source.port);
    const t = ends.get(e.target.port);
    const r = routes[e.id];
    if (!s || !t || !r || !near(r.points[0], s.point) || !near(r.points[r.points.length - 1], t.point)) continue;
    const old = settledEdges?.get(e.id);
    const isFresh =
      !fast && !r.manual && ((settledEdges && (!old || !samePoints(old, r.points))) || (!!input.moved?.has(e.source.node) && input.moved.has(e.target.node)));
    fits.set(e.id, isFresh);
    keptPins.add(e.source.port);
    keptPins.add(e.target.port);
    if (!isFresh) {
      steadyPins.add(e.source.port);
      steadyPins.add(e.target.port);
    }
  }
  const stubs = new Map<string, Point[]>();
  const stubOf = (port: string) => {
    let line = stubs.get(port);
    if (!line) {
      const end = ends.get(port)!;
      line = [end.point, portStub(end)];
      stubs.set(port, line);
    }
    return line;
  };
  /**
   * Whether a wire runs into one of the symbols, or touches the stub of one of their pins (but those in
   * `drawn`): a wire routed to that pin later would have to start on it.
   */
  const crowds = (e: DEdge, points: Point[], list: Keep[], drawn: Set<string>): boolean => {
    if (!list.length) return false;
    const b = boundsOf(points);
    let mine: Set<string> | undefined;
    for (const k of list) {
      if (k.id === e.source.node || k.id === e.target.node || apart(k, b)) continue;
      if (polylineCrowdsRect(points, k.rect)) return true;
      mine ??= netPorts(netOf(e));
      for (const q of k.ports) if (!mine.has(q) && !drawn.has(q) && wiresMeet(points, stubOf(q))) return true;
    }
    return false;
  };

  interface Resolved {
    points: Point[];
    label?: Box;
  }
  const resolved = new Map<string, Resolved>();
  const routed: Record<string, RouteRec> = {};
  const todo: DEdge[] = [];
  /** Stored routes kept although they are new here or moved: they are checked against the other nets' wires too. */
  const fresh: DEdge[] = [];
  /** Wires to route again because their target symbol changed, with the path they had (when known). */
  const retargeted: [DEdge, Point[]][] = [];
  const changedIds = new Set(changed.map((k) => k.id));

  for (const e of netlist.edges) {
    const s = ends.get(e.source.port);
    const t = ends.get(e.target.port);
    if (!s || !t) continue;
    const r = routes[e.id];
    const isFresh = fits.get(e.id);
    if (r && isFresh !== undefined) {
      // Any other route can only have run into the symbols that changed.
      if (r.manual || !(isFresh ? crowds(e, r.points, (all ??= nodes.map(keepOut)), keptPins) : crowds(e, r.points, changed, steadyPins))) {
        resolved.set(e.id, { points: r.points, label: r.label });
        if (isFresh) fresh.push(e);
        continue;
      }
    } else if (r?.manual && r.points.length >= 2) {
      const points = adjustRoute(r.points, s.point, t.point);
      resolved.set(e.id, { points });
      if (!fast) routed[e.id] = { points, manual: true };
      continue;
    }
    todo.push(e);
    const old = r && r.points.length >= 2 ? r.points : settledEdges?.get(e.id);
    if (!fast && old && changedIds.has(e.target.node)) retargeted.push([e, old]);
  }

  // ... or on a wire of another net, which would read as a connection.
  if (fresh.length) {
    const isFresh = new Set(fresh.map((x) => x.id));
    const steady = netlist.edges
      .filter((x) => resolved.has(x.id) && !isFresh.has(x.id))
      .map((x) => {
        const points = resolved.get(x.id)!.points;
        return { net: netOf(x), points, box: boundsOf(points) };
      });
    for (const e of fresh) {
      const points = resolved.get(e.id)!.points;
      const b = boundsOf(points);
      if (!steady.some((o) => o.net !== netOf(e) && !apart(o.box, b) && wiresMeet(points, o.points))) continue;
      resolved.delete(e.id);
      todo.push(e);
    }
  }

  // A wire routed as a branch of another one runs along that wire up to the branch point. When the other
  // wire's target has moved, that stretch leads to where the target was: route the branch again as well,
  // so the net is drawn afresh (nearest sink first) instead of around the old path.
  for (const [e, old] of retargeted) {
    const s = ends.get(e.source.port)!;
    const a = portStub(s);
    const stub = Math.abs(a.x - s.point.x) + Math.abs(a.y - s.point.y);
    for (const x of netEdges.get(netOf(e)) ?? []) {
      const r = resolved.get(x.id);
      if (!r || routes[x.id]?.manual) continue;
      const run = runTogether(r.points, old);
      if (!run.turnsOff || run.len <= stub + 0.5) continue;
      resolved.delete(x.id);
      todo.push(x);
    }
  }

  // Route what is left net by net, nearest sinks first, so later wires can branch off earlier ones.
  const dist = (e: DEdge) => {
    const s = ends.get(e.source.port)!.point;
    const t = ends.get(e.target.port)!.point;
    return Math.abs(s.x - t.x) + Math.abs(s.y - t.y);
  };
  todo.sort((a, b) => (netOf(a) < netOf(b) ? -1 : netOf(a) > netOf(b) ? 1 : dist(a) - dist(b)));

  const polyOfNet = new Map<string, Point[][]>();
  const addPoly = (net: string, points: Point[]) => {
    const list = polyOfNet.get(net);
    if (list) list.push(points);
    else polyOfNet.set(net, [points]);
  };
  // Pins whose wires are not drawn yet: their stubs are kept clear of other nets' wires.
  const unwired = new Map(ends);
  for (const e of netlist.edges) {
    const r = resolved.get(e.id);
    if (!r) continue;
    addPoly(netOf(e), r.points);
    unwired.delete(e.source.port);
    unwired.delete(e.target.port);
  }

  for (const e of todo) {
    const s = ends.get(e.source.port)!;
    const t = ends.get(e.target.port)!;
    const net = netOf(e);
    let points: Point[];
    if (fast) {
      points = simpleRoute(s, t);
    } else {
      // Every other net: the search may end up using the whole sheet.
      const otherNets: Point[][] = [];
      for (const [n, polys] of polyOfNet) if (n !== net) otherNets.push(...polys);
      const onNet = netPorts(net);
      const reserved: RouteEnd[] = [];
      for (const [id, end] of unwired) if (!onNet.has(id)) reserved.push(end);
      points = routeWire(s, t, { obstacles, ownNet: polyOfNet.get(net) ?? [], otherNets, reserved });
      routed[e.id] = { points };
    }
    resolved.set(e.id, { points });
    addPoly(net, points);
    unwired.delete(e.source.port);
    unwired.delete(e.target.port);
  }

  // Labels, junction dots, and the final edge list in netlist order.
  const firstOfNet = new Set<string>();
  const edges: LEdge[] = [];
  for (const e of netlist.edges) {
    const r = resolved.get(e.id);
    if (!r) continue;
    let lb: Box | undefined;
    if (e.label) {
      // A stored box is kept while it fits the text: the label may have been renamed since.
      lb = r.label && Math.abs(r.label.width - labelWidth(e.label, measure)) < 0.5 ? r.label : labelBox(r.points, e.label, measure);
      if (lb !== r.label && routed[e.id]) routed[e.id] = { ...routed[e.id], label: lb };
    }
    const net = netOf(e);
    let junctions: Point[] = [];
    if (!firstOfNet.has(net)) {
      firstOfNet.add(net);
      const polys = polyOfNet.get(net) ?? [];
      if (polys.length > 1) junctions = netJunctions(polys);
    }
    edges.push({ ...e, points: r.points, junctions, labelBox: lb });
  }

  // Bounds of everything drawn, with a margin (bus marks and labels stick out a little).
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const see = (x: number, y: number) => {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  };
  for (const n of nodes) {
    see(n.x, n.y);
    see(n.x + n.width, n.y + n.height);
    // Split labels sit to the right of the bar; join labels to the left.
    if (n.kind === 'split') see(n.x + n.width + 40, n.y);
    if (n.kind === 'join') see(n.x - 40, n.y);
  }
  for (const e of edges) {
    for (const p of e.points) {
      see(p.x, p.y);
      // Bus width marks are drawn just above the wire.
      if (e.width > 1) see(p.x, p.y - 14);
    }
    if (e.labelBox) {
      see(e.labelBox.x, e.labelBox.y);
      see(e.labelBox.x + e.labelBox.width, e.labelBox.y + e.labelBox.height);
    }
  }
  const pad = 24;
  const layout: LayoutResult =
    x0 === Infinity
      ? { module: netlist.module, x: 0, y: 0, width: 48, height: 48, nodes, edges }
      : {
          module: netlist.module,
          x: Math.floor(x0 - pad),
          y: Math.floor(y0 - pad),
          width: Math.ceil(x1 - x0 + 2 * pad),
          height: Math.ceil(y1 - y0 + 2 * pad),
          nodes,
          edges,
        };
  if (fast && settled) beforeDrag.set(layout, settled);
  return { layout, routed };
}

/** Where a port's wire stub ends, for drawing a wire that is being made. */
export function stubPoint(p: Point, side: Side, len = 10): Point {
  const d = DIR[side];
  return { x: p.x + d.x * len, y: p.y + d.y * len };
}
