/**
 * Sheet geometry: the drawable layout (the same LayoutResult the renderer and
 * the exporters use) from a netlist, symbol positions and stored wire routes.
 *
 * Stored routes are used as long as both of their ends still meet their
 * ports; hand-shaped routes are stretched when a symbol moves; every other
 * wire is routed again with the orthogonal router. Junction dots are found
 * from the drawn wires, so they are right whoever routed them.
 */
import type { DNode, Diagram, Side } from '../core/diagram';
import { FONT, type LEdge, type LNode, type LayoutResult, type MeasureText, type Point, sizeNode } from '../layout/elk-layout';
import type { Box, RouteRec } from './doc';
import { type Rect, type RouteEnd, adjustRoute, netJunctions, polylineHitsRect, routeWire, simpleRoute } from './router';

export interface GeometryInput {
  netlist: Diagram;
  /** Top-left corner of every symbol. Symbols without one are placed at the origin. */
  pos: Record<string, Point>;
  routes: Record<string, RouteRec>;
  measure: MeasureText;
  /** While dragging: wires that need a new route get a quick one instead of a search. */
  fast?: boolean;
  /** Symbols that just moved: automatic wires now running through them are routed again. */
  moved?: ReadonlySet<string>;
  /** The previous geometry of the same sheet: unchanged symbols keep their objects (fewer re-renders). */
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

/** Where a wire label goes: above the last horizontal stretch before the target. */
export function labelBox(points: Point[], text: string, measure: MeasureText): Box {
  const width = Math.ceil(measure(text, FONT.label)) + 4;
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

  interface Resolved {
    points: Point[];
    label?: Box;
  }
  const resolved = new Map<string, Resolved>();
  const routed: Record<string, RouteRec> = {};
  const todo: typeof netlist.edges = [];
  const movedRects = [...(input.moved ?? [])].map((id) => [id, rectOf.get(id)] as const).filter((x): x is readonly [string, Rect] => !!x[1]);

  for (const e of netlist.edges) {
    const s = ends.get(e.source.port);
    const t = ends.get(e.target.port);
    if (!s || !t) continue;
    const r = routes[e.id];
    if (r && near(r.points[0], s.point) && near(r.points[r.points.length - 1], t.point)) {
      const blocked =
        !r.manual &&
        movedRects.some(([id, rect]) => id !== e.source.node && id !== e.target.node && polylineHitsRect(r.points, rect));
      if (!blocked) {
        resolved.set(e.id, { points: r.points, label: r.label });
        continue;
      }
    } else if (r?.manual && r.points.length >= 2) {
      const points = adjustRoute(r.points, s.point, t.point);
      resolved.set(e.id, { points });
      if (!input.fast) routed[e.id] = { points, manual: true };
      continue;
    }
    todo.push(e);
  }

  // Route what is left net by net, nearest sinks first, so later wires can branch off earlier ones.
  const netOf = (e: (typeof netlist.edges)[number]) => e.source.port;
  const dist = (e: (typeof netlist.edges)[number]) => {
    const s = ends.get(e.source.port)!.point;
    const t = ends.get(e.target.port)!.point;
    return Math.abs(s.x - t.x) + Math.abs(s.y - t.y);
  };
  todo.sort((a, b) => (netOf(a) < netOf(b) ? -1 : netOf(a) > netOf(b) ? 1 : dist(a) - dist(b)));

  const polyOfNet = new Map<string, Point[][]>();
  const boxes: { net: string; points: Point[]; x0: number; y0: number; x1: number; y1: number }[] = [];
  const addPoly = (net: string, points: Point[]) => {
    polyOfNet.set(net, [...(polyOfNet.get(net) ?? []), points]);
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
    boxes.push({ net, points, x0, y0, x1, y1 });
  };
  for (const e of netlist.edges) {
    const r = resolved.get(e.id);
    if (r) addPoly(netOf(e), r.points);
  }

  for (const e of todo) {
    const s = ends.get(e.source.port)!;
    const t = ends.get(e.target.port)!;
    let points: Point[];
    if (input.fast) {
      points = simpleRoute(s, t);
    } else {
      const net = netOf(e);
      const m = 300;
      const x0 = Math.min(s.point.x, t.point.x) - m;
      const x1 = Math.max(s.point.x, t.point.x) + m;
      const y0 = Math.min(s.point.y, t.point.y) - m;
      const y1 = Math.max(s.point.y, t.point.y) + m;
      const otherNets = boxes.filter((b) => b.net !== net && b.x1 >= x0 && b.x0 <= x1 && b.y1 >= y0 && b.y0 <= y1).map((b) => b.points);
      points = routeWire(s, t, { obstacles, ownNet: polyOfNet.get(net) ?? [], otherNets });
      routed[e.id] = { points };
    }
    resolved.set(e.id, { points });
    addPoly(netOf(e), points);
  }

  // Labels, junction dots, and the final edge list in netlist order.
  const firstOfNet = new Set<string>();
  const edges: LEdge[] = [];
  for (const e of netlist.edges) {
    const r = resolved.get(e.id);
    if (!r) continue;
    let lb = e.label ? r.label : undefined;
    if (e.label && !lb) {
      lb = labelBox(r.points, e.label, measure);
      if (routed[e.id]) routed[e.id] = { ...routed[e.id], label: lb };
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
  return { layout, routed };
}

/** Where a port's wire stub ends, for drawing a wire that is being made. */
export function stubPoint(p: Point, side: Side, len = 10): Point {
  const d = DIR[side];
  return { x: p.x + d.x * len, y: p.y + d.y * len };
}
