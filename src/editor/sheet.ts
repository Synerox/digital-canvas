/**
 * One sheet: its effective netlist (the Verilog-derived diagram with the
 * user's edits applied) and the pure edit operations on its SheetEdits.
 *
 * Every operation returns a new SheetEdits and never changes its input, so
 * undo/redo can keep old versions as they are.
 */
import type { DEdge, DNode, DPort, Diagram } from '../core/diagram';
import type { LayoutResult, Point } from '../layout/elk-layout';
import type { RouteRec, SheetEdits } from './doc';
import { type InterfaceOf, type SymKey, type SymParams, type UserEdge, type UserNode, symbolNode } from './symbols';

// ---------- effective netlist ----------

/** A symbol's drawn text after a rename. */
export function applyLabel(n: DNode, text: string | undefined): DNode {
  if (text === undefined) return n;
  switch (n.kind) {
    case 'instance':
      return { ...n, subLabel: text || undefined };
    case 'input':
    case 'output':
    case 'inout':
    case 'const':
    case 'text':
      return { ...n, label: text || n.label };
    default:
      return n;
  }
}

/** IDs of everything drawn by hand on this sheet. */
export function userIds(e: SheetEdits): Set<string> {
  return new Set([...e.nodes.map((n) => n.id), ...e.edges.map((x) => x.id)]);
}

/**
 * The netlist the sheet shows: the imported diagram minus what the user
 * deleted, with renamed labels, plus the symbols and wires drawn by hand.
 * Wires whose ports no longer exist (after a re-import or a parameter
 * change) are left out.
 */
export function effectiveDiagram(module: string, base: Diagram | undefined, e: SheetEdits, iface: InterfaceOf): Diagram {
  const hidden = new Set(e.hidden);
  const nodes: DNode[] = [];
  for (const n of base?.nodes ?? []) {
    if (hidden.has(n.id)) continue;
    nodes.push(applyLabel(n, e.labels[n.id]));
  }
  const seen = new Set(nodes.map((n) => n.id));
  for (const u of e.nodes) {
    if (seen.has(u.id)) continue;
    seen.add(u.id);
    nodes.push(symbolNode(u, iface));
  }
  const ports = new Map<string, { node: DNode; port: DPort }>();
  for (const n of nodes) for (const p of n.ports) ports.set(p.id, { node: n, port: p });
  const ok = (x: { node: string; port: string }) => ports.get(x.port)?.node.id === x.node;

  const edges: DEdge[] = [];
  for (const x of base?.edges ?? []) {
    if (hidden.has(x.id) || !ok(x.source) || !ok(x.target)) continue;
    const text = e.labels[x.id];
    edges.push(text === undefined ? x : { ...x, label: text || undefined });
  }
  for (const u of e.edges) {
    if (!ok(u.source) || !ok(u.target)) continue;
    const src = ports.get(u.source.port)!.port;
    const sl = u.slice && u.slice.lo >= 0 && u.slice.width >= 1 && u.slice.lo + u.slice.width <= src.width ? u.slice : undefined;
    const full = !sl || sl.width === src.width;
    edges.push({
      id: u.id,
      source: u.source,
      target: u.target,
      width: sl ? sl.width : src.width,
      fullSource: full,
      label: u.label || undefined,
      netName: u.label || undefined,
      ...(full ? {} : { bits: sl }),
    });
  }
  return { module, nodes, edges };
}

// ---------- connecting ----------

export type WireEnd =
  | { kind: 'port'; node: string; port: string }
  /** A point on an existing wire: connects to the wire's net (its driver). */
  | { kind: 'wire'; edge: string; at: Point };

export interface Connection {
  source: { node: string; port: string };
  target: { node: string; port: string };
  /** True when the user drew from the target to the source (the drawn route must be reversed). */
  reversed: boolean;
}

/** Decide which end drives: an output port or a wire's net drives an input port. */
export function resolveConnection(d: Diagram, a: WireEnd, b: WireEnd): Connection | { error: string } {
  const portOf = new Map<string, { node: DNode; port: DPort }>();
  for (const n of d.nodes) for (const p of n.ports) portOf.set(p.id, { node: n, port: p });
  const edgeOf = new Map(d.edges.map((x) => [x.id, x]));
  /** Driver of an end, if it is a driving end. */
  const driver = (end: WireEnd): { node: string; port: string } | undefined => {
    if (end.kind === 'wire') return edgeOf.get(end.edge)?.source;
    const p = portOf.get(end.port);
    return p && p.port.dir === 'out' ? { node: end.node, port: end.port } : undefined;
  };
  const sink = (end: WireEnd): { node: string; port: string } | undefined => {
    if (end.kind !== 'port') return undefined;
    const p = portOf.get(end.port);
    return p && p.port.dir === 'in' ? { node: end.node, port: end.port } : undefined;
  };
  if (a.kind === 'port' && b.kind === 'port' && a.node === b.node && a.port === b.port) return { error: 'Pick a different pin.' };
  const da = driver(a);
  const db = driver(b);
  const sa = sink(a);
  const sb = sink(b);
  let c: Connection | undefined;
  if (da && sb) c = { source: da, target: sb, reversed: false };
  else if (db && sa) c = { source: db, target: sa, reversed: true };
  else if (sa && sb) {
    // Two inputs: join the undriven one to the other's driver.
    const into = (s: { port: string }) => d.edges.find((x) => x.target.port === s.port)?.source;
    const fa = into(sa);
    const fb = into(sb);
    if (fa && !fb) c = { source: fa, target: sb, reversed: false };
    else if (fb && !fa) c = { source: fb, target: sa, reversed: true };
    else if (fa && fb) return { error: 'Both inputs already have a driver.' };
    else return { error: 'Connect an output to an input (neither of these inputs has a driver yet).' };
  } else if (da && db) {
    return { error: 'Both ends are outputs. Connect an output to an input.' };
  } else {
    return { error: 'Connect an output to an input.' };
  }
  if (c.source.node === c.target.node && c.source.port === c.target.port) return { error: 'Pick a different pin.' };
  if (d.edges.some((x) => x.source.port === c!.source.port && x.target.port === c!.target.port)) {
    return { error: 'These pins are already connected.' };
  }
  return c;
}

// ---------- edit operations ----------

export function newId(e: SheetEdits, prefix: 'u' | 'w'): [string, SheetEdits] {
  return [`${prefix}:${e.next}`, { ...e, next: e.next + 1 }];
}

export function addNodes(e: SheetEdits, items: { node: UserNode; pos: Point }[]): SheetEdits {
  if (items.length === 0) return e;
  const pos = { ...e.pos };
  for (const it of items) pos[it.node.id] = it.pos;
  return { ...e, nodes: [...e.nodes, ...items.map((it) => it.node)], pos };
}

/** Edges of the netlist that touch any of the nodes. */
function touching(d: Diagram, ids: ReadonlySet<string>): DEdge[] {
  return d.edges.filter((x) => ids.has(x.source.node) || ids.has(x.target.node));
}

/**
 * Move symbols. A wire with both ends moved keeps its shape; a hand-shaped
 * wire with one end moved is stretched later (adjustRoute); an automatic
 * wire with one end moved is routed again.
 */
export function moveNodes(e: SheetEdits, d: Diagram, ids: Iterable<string>, dx: number, dy: number): SheetEdits {
  const set = new Set([...ids].filter((id) => e.pos[id]));
  if (set.size === 0 || (dx === 0 && dy === 0)) return e;
  const pos = { ...e.pos };
  for (const id of set) pos[id] = { x: pos[id].x + dx, y: pos[id].y + dy };
  const routes = { ...e.routes };
  for (const x of touching(d, set)) {
    const r = routes[x.id];
    if (!r) continue;
    if (set.has(x.source.node) && set.has(x.target.node)) {
      routes[x.id] = {
        ...r,
        points: r.points.map((p) => ({ x: p.x + dx, y: p.y + dy })),
        label: r.label ? { ...r.label, x: r.label.x + dx, y: r.label.y + dy } : undefined,
      };
    } else if (!r.manual) {
      delete routes[x.id];
    }
  }
  return { ...e, pos, routes };
}

/** Delete symbols and wires. Hand-drawn ones are removed; imported ones are hidden. */
export function deleteItems(e: SheetEdits, d: Diagram, ids: Iterable<string>): SheetEdits {
  const del = new Set(ids);
  if (del.size === 0) return e;
  const own = userIds(e);
  // Deleting a symbol removes the hand-drawn wires on it.
  const nodes = e.nodes.filter((n) => !del.has(n.id));
  const edges = e.edges.filter((x) => !del.has(x.id) && !del.has(x.source.node) && !del.has(x.target.node));
  const hidden = new Set(e.hidden);
  for (const id of del) if (!own.has(id) && (d.nodes.some((n) => n.id === id) || d.edges.some((x) => x.id === id))) hidden.add(id);
  const pos = { ...e.pos };
  const routes = { ...e.routes };
  for (const id of del) {
    delete routes[id];
    if (own.has(id)) delete pos[id];
  }
  for (const x of touching(d, del)) delete routes[x.id];
  return { ...e, nodes, edges, hidden: [...hidden], pos, routes };
}

export function connect(e: SheetEdits, c: Connection, route?: Point[], label?: string): [string, SheetEdits] {
  const [id, e1] = newId(e, 'w');
  const edge: UserEdge = { id, source: c.source, target: c.target, ...(label ? { label } : {}) };
  const routes = route && route.length >= 2 ? { ...e1.routes, [id]: { points: route, manual: true } } : e1.routes;
  return [id, { ...e1, edges: [...e1.edges, edge], routes }];
}

/** Rename a symbol (pin name, instance name, note text) or set a wire's label. */
export function rename(e: SheetEdits, id: string, text: string): SheetEdits {
  const u = e.nodes.find((n) => n.id === id);
  if (u) return { ...e, nodes: e.nodes.map((n) => (n.id === id ? { ...n, name: text } : n)) };
  const w = e.edges.find((x) => x.id === id);
  if (w) return { ...e, edges: e.edges.map((x) => (x.id === id ? { ...x, label: text || undefined } : x)) };
  return { ...e, labels: { ...e.labels, [id]: text } };
}

/** Undo a rename of an imported symbol or wire. */
export function resetLabel(e: SheetEdits, id: string): SheetEdits {
  if (!(id in e.labels)) return e;
  const labels = { ...e.labels };
  delete labels[id];
  return { ...e, labels };
}

export function setParams(e: SheetEdits, id: string, params: SymParams): SheetEdits {
  return { ...e, nodes: e.nodes.map((n) => (n.id === id ? { ...n, params: { ...n.params, ...params } } : n)) };
}

export function setSlice(e: SheetEdits, id: string, slice: { lo: number; width: number } | undefined): SheetEdits {
  return { ...e, edges: e.edges.map((x) => (x.id === id ? { ...x, slice } : x)) };
}

export function setRoute(e: SheetEdits, id: string, points: Point[], manual = true): SheetEdits {
  return { ...e, routes: { ...e.routes, [id]: { points, manual } } };
}

/** Forget a hand-shaped route so the wire is routed automatically again. */
export function clearRoute(e: SheetEdits, id: string): SheetEdits {
  if (!e.routes[id]) return e;
  const routes = { ...e.routes };
  delete routes[id];
  return { ...e, routes };
}

export function restoreHidden(e: SheetEdits): SheetEdits {
  return e.hidden.length ? { ...e, hidden: [] } : e;
}

/** Positions and routes from an ELK layout. `keep` decides which existing positions survive. */
export function layoutToEdits(e: SheetEdits, layout: LayoutResult, keep: 'none' | 'existing'): SheetEdits {
  const pos: Record<string, Point> = keep === 'existing' ? { ...e.pos } : {};
  const routes: Record<string, RouteRec> = keep === 'existing' ? { ...e.routes } : {};
  for (const n of layout.nodes) if (!pos[n.id]) pos[n.id] = { x: n.x, y: n.y };
  for (const x of layout.edges) {
    if (routes[x.id] || x.points.length < 2) continue;
    routes[x.id] = { points: x.points, ...(x.labelBox ? { label: x.labelBox } : {}) };
  }
  return { ...e, pos, routes };
}

/**
 * Positions for symbols that have none yet (new in a re-import, or after a
 * drawing rule changed the netlist): each goes where ELK put it relative to
 * a neighbour that already has a position, then moves down until it does not
 * overlap anything.
 */
export function placeMissing(
  d: Diagram,
  pos: Record<string, Point>,
  elk: LayoutResult | undefined,
  size: (n: DNode) => { width: number; height: number },
): Record<string, Point> {
  const missing = d.nodes.filter((n) => !pos[n.id]);
  if (missing.length === 0) return pos;
  const out = { ...pos };
  const elkPos = new Map((elk?.nodes ?? []).map((n) => [n.id, { x: n.x, y: n.y }]));
  const neighbours = new Map<string, string[]>();
  for (const x of d.edges) {
    neighbours.set(x.source.node, [...(neighbours.get(x.source.node) ?? []), x.target.node]);
    neighbours.set(x.target.node, [...(neighbours.get(x.target.node) ?? []), x.source.node]);
  }
  const rects: { x: number; y: number; w: number; h: number }[] = [];
  const sizes = new Map(d.nodes.map((n) => [n.id, size(n)]));
  for (const n of d.nodes) {
    const p = out[n.id];
    if (p) rects.push({ x: p.x, y: p.y, w: sizes.get(n.id)!.width, h: sizes.get(n.id)!.height });
  }
  let maxX = 0;
  let minY = 0;
  for (const r of rects) {
    maxX = Math.max(maxX, r.x + r.w);
    minY = Math.min(minY, r.y);
  }
  let fallbackY = minY;
  const overlaps = (x: number, y: number, w: number, h: number) =>
    rects.some((r) => x < r.x + r.w + 10 && x + w + 10 > r.x && y < r.y + r.h + 10 && y + h + 10 > r.y);
  // Place nodes with placed neighbours first, so chains of new nodes follow each other.
  const queue = [...missing];
  let guard = queue.length * queue.length + 10;
  while (queue.length && guard-- > 0) {
    const idx = queue.findIndex((n) => (neighbours.get(n.id) ?? []).some((m) => out[m] && elkPos.has(m)));
    const n = queue.splice(idx >= 0 ? idx : 0, 1)[0];
    const s = sizes.get(n.id)!;
    const mine = elkPos.get(n.id);
    let p: Point | undefined;
    if (mine) {
      const anchors = (neighbours.get(n.id) ?? []).filter((m) => out[m] && elkPos.has(m));
      const pool = anchors.length ? anchors : [...elkPos.keys()].filter((m) => out[m]);
      let best: string | undefined;
      let bestD = Infinity;
      for (const m of pool) {
        const q = elkPos.get(m)!;
        const dist = Math.abs(q.x - mine.x) + Math.abs(q.y - mine.y);
        if (dist < bestD) {
          bestD = dist;
          best = m;
        }
      }
      if (best) {
        const q = elkPos.get(best)!;
        p = { x: out[best].x + (mine.x - q.x), y: out[best].y + (mine.y - q.y) };
      }
    }
    if (!p) {
      p = { x: maxX + 60, y: fallbackY };
      fallbackY += s.height + 20;
    }
    let tries = 0;
    while (overlaps(p.x, p.y, s.width, s.height) && tries++ < 400) p = { x: p.x, y: p.y + 10 };
    p = { x: Math.round(p.x), y: Math.round(p.y) };
    out[n.id] = p;
    rects.push({ x: p.x, y: p.y, w: s.width, h: s.height });
  }
  return out;
}

// ---------- converting imported symbols to editable ones ----------

const CELL_TO_SYM: Record<string, SymKey> = {
  $and: 'and',
  $or: 'or',
  $xor: 'xor',
  $xnor: 'xnor',
  'dc:nand': 'nand',
  'dc:nor': 'nor',
  $not: 'not',
  'dc:buf': 'buf',
  $add: 'add',
  $sub: 'sub',
  $mul: 'mul',
  $eq: 'eq',
  $ne: 'ne',
  $lt: 'lt',
  $le: 'le',
  $gt: 'gt',
  $ge: 'ge',
  $shl: 'shl',
  $shr: 'shr',
  'dc:decoder': 'decoder',
  $dff: 'dff',
  $dffe: 'dffe',
  $adff: 'adff',
  $mux: 'mux',
  'dc:mux': 'mux',
};

function signature(n: DNode): string {
  return n.ports
    .map((p) => `${p.name}:${p.dir}:${p.side}:${p.width}`)
    .sort()
    .join(',');
}

/**
 * An editable symbol for a drawing node: a library symbol when one draws
 * exactly the same ports, otherwise a frozen copy (`raw`).
 */
export function toUserNode(n: DNode, id: string, iface: InterfaceOf): UserNode {
  const width = (name: string) => n.ports.find((p) => p.name === name)?.width;
  switch (n.kind) {
    case 'input':
    case 'output':
    case 'inout':
      return { id, sym: n.kind, params: { width: n.ports[0]?.width ?? 1 }, name: n.label };
    case 'const':
      return { id, sym: 'const', params: { value: n.label } };
    case 'text':
      return { id, sym: 'text', params: {}, name: n.label };
    case 'instance':
      if (n.moduleName && iface(n.moduleName)) {
        const block: UserNode = { id, sym: 'block', params: { module: n.moduleName }, name: n.subLabel ?? n.instanceName };
        if (signature(symbolNode(block, iface)) === signature(n)) return block;
      }
      break;
    case 'cell': {
      const sym = n.cellType ? CELL_TO_SYM[n.cellType] : undefined;
      if (!sym || n.attrs?.invertB) break;
      const ins = n.ports.filter((p) => p.dir === 'in' && p.side === 'WEST');
      const params: SymParams = {};
      if (sym === 'decoder') params.width = width('A');
      else if (sym === 'dff' || sym === 'dffe' || sym === 'adff') params.width = width('D');
      else if (sym === 'shl' || sym === 'shr') {
        params.width = width('A');
        params.shift = width('B');
      } else if (['eq', 'ne', 'lt', 'le', 'gt', 'ge'].includes(sym)) params.width = width('A');
      else params.width = width('Y');
      if (['and', 'or', 'xor', 'nand', 'nor', 'xnor', 'mux'].includes(sym)) params.inputs = ins.length;
      const u: UserNode = { id, sym, params };
      if (signature(symbolNode(u, iface)) === signature(n)) return u;
      break;
    }
  }
  // Frozen copy: the node as it is drawn, ports renamed to the new ID.
  const raw: DNode = { ...n, id, ports: n.ports.map((p) => ({ ...p, id: `${id}.${p.name}` })) };
  return { id, sym: 'raw', params: {}, raw, ...(n.kind === 'instance' ? { name: n.subLabel ?? n.instanceName } : {}) };
}

// ---------- copy and paste ----------

export interface Clip {
  nodes: { node: UserNode; pos: Point }[];
  edges: UserEdge[];
  routes: Record<string, RouteRec>;
}

/** Copy symbols (and the wires between them). Positions are relative to the selection's top-left corner. */
export function copyNodes(d: Diagram, e: SheetEdits, layout: LayoutResult, ids: ReadonlySet<string>, iface: InterfaceOf): Clip | undefined {
  const lnodes = layout.nodes.filter((n) => ids.has(n.id));
  if (lnodes.length === 0) return undefined;
  const minX = Math.min(...lnodes.map((n) => n.x));
  const minY = Math.min(...lnodes.map((n) => n.y));
  const own = new Map(e.nodes.map((n) => [n.id, n]));
  const dnode = new Map(d.nodes.map((n) => [n.id, n]));
  const nodes = lnodes.map((n) => {
    const u = own.get(n.id) ?? toUserNode(dnode.get(n.id)!, n.id, iface);
    return { node: structuredClone(u), pos: { x: n.x - minX, y: n.y - minY } };
  });
  const ledge = new Map(layout.edges.map((x) => [x.id, x]));
  const edges: UserEdge[] = [];
  const routes: Record<string, RouteRec> = {};
  for (const x of d.edges) {
    if (!ids.has(x.source.node) || !ids.has(x.target.node)) continue;
    edges.push({
      id: x.id,
      source: { ...x.source },
      target: { ...x.target },
      ...(x.label ? { label: x.label } : {}),
      ...(x.bits ? { slice: { ...x.bits } } : {}),
    });
    const l = ledge.get(x.id);
    if (l && l.points.length >= 2) {
      routes[x.id] = {
        points: l.points.map((p) => ({ x: p.x - minX, y: p.y - minY })),
        manual: !!e.routes[x.id]?.manual,
        ...(l.labelBox ? { label: { ...l.labelBox, x: l.labelBox.x - minX, y: l.labelBox.y - minY } } : {}),
      };
    }
  }
  return { nodes, edges, routes };
}

/** Paste a clip with its top-left corner at `at`. Returns the new edits and the IDs of what was pasted. */
export function pasteClip(e: SheetEdits, clip: Clip, at: Point): [SheetEdits, string[]] {
  let cur = e;
  const map = new Map<string, string>();
  const items: { node: UserNode; pos: Point }[] = [];
  for (const it of clip.nodes) {
    const [id, next] = newId(cur, 'u');
    cur = next;
    map.set(it.node.id, id);
    const node: UserNode = structuredClone(it.node);
    node.id = id;
    if (node.raw) node.raw = { ...node.raw, id, ports: node.raw.ports.map((p) => ({ ...p, id: `${id}.${p.name}` })) };
    items.push({ node, pos: { x: it.pos.x + at.x, y: it.pos.y + at.y } });
  }
  cur = addNodes(cur, items);
  const remapPort = (port: string, oldNode: string, newNode: string) => newNode + port.slice(oldNode.length);
  const newEdges: UserEdge[] = [];
  const routes = { ...cur.routes };
  for (const x of clip.edges) {
    const s = map.get(x.source.node);
    const t = map.get(x.target.node);
    if (!s || !t) continue;
    const [id, next] = newId(cur, 'w');
    cur = next;
    newEdges.push({
      id,
      source: { node: s, port: remapPort(x.source.port, x.source.node, s) },
      target: { node: t, port: remapPort(x.target.port, x.target.node, t) },
      ...(x.label ? { label: x.label } : {}),
      ...(x.slice ? { slice: { ...x.slice } } : {}),
    });
    const r = clip.routes[x.id];
    if (r) {
      routes[id] = {
        points: r.points.map((p) => ({ x: p.x + at.x, y: p.y + at.y })),
        ...(r.manual ? { manual: true } : {}),
        ...(r.label ? { label: { ...r.label, x: r.label.x + at.x, y: r.label.y + at.y } } : {}),
      };
    }
  }
  return [{ ...cur, edges: [...cur.edges, ...newEdges], routes }, [...map.values(), ...newEdges.map((x) => x.id)]];
}

/** All of a sheet as a drawing: every symbol becomes editable, positions and routes are kept. */
export function toDrawing(d: Diagram, layout: LayoutResult, e: SheetEdits, iface: InterfaceOf): SheetEdits {
  const ids = new Set(d.nodes.map((n) => n.id));
  const clip = copyNodes(d, e, layout, ids, iface);
  const out: SheetEdits = { pos: {}, routes: {}, hidden: [], labels: {}, nodes: [], edges: [], next: 1 };
  if (!clip) return out;
  const minX = Math.min(...layout.nodes.map((n) => n.x));
  const minY = Math.min(...layout.nodes.map((n) => n.y));
  // Keep the IDs: nothing else is on the new sheet.
  for (const it of clip.nodes) {
    out.nodes.push(it.node);
    out.pos[it.node.id] = { x: it.pos.x + minX, y: it.pos.y + minY };
  }
  let n = 1;
  for (const x of clip.edges) {
    const id = `w:${n++}`;
    out.edges.push({ ...x, id });
    const r = clip.routes[x.id];
    if (r) {
      out.routes[id] = {
        ...r,
        points: r.points.map((p) => ({ x: p.x + minX, y: p.y + minY })),
        ...(r.label ? { label: { ...r.label, x: r.label.x + minX, y: r.label.y + minY } } : {}),
      };
    }
  }
  out.next = n;
  return out;
}
