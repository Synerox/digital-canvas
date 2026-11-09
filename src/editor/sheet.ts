/**
 * One sheet: its effective netlist (the Verilog-derived diagram with the
 * user's edits applied) and the pure edit operations on its SheetEdits.
 *
 * Every operation returns a new SheetEdits and never changes its input, so
 * undo/redo can keep old versions as they are.
 */
import { type DEdge, type DNode, type DPort, type Diagram, type PinStyle, isPinKind, pinStyleOf, withPinStyle } from '../core/diagram';
import { GRID, type LayoutResult, type MeasureText, type Point, isReduceType, legacyCellSize, sizeNode } from '../layout/elk-layout';
import { scaleNote, wireShift } from './check';
import { type Box, type RouteRec, type SheetEdits, freeIdFloor } from './doc';
import { polylineHitsRect } from './router';
import { type InterfaceOf, type ModulePort, PARAM_LIMITS, type SymKey, type SymParams, type UserEdge, type UserNode, clampParam, isGateSym, symbolNode } from './symbols';
import { verilogIdent } from './verilog-ident';
import { type ComponentDef, componentSymbol, followsPreset, fullSettings, isPart, sameSettings } from './components';

// ---------- effective netlist ----------

/**
 * A symbol's drawn text after a rename. A constant is never renamed: its
 * label is its Verilog value (Copy to new drawing reads it), so
 * a stale label saved for one has no effect.
 */
export function applyLabel(n: DNode, text: string | undefined): DNode {
  if (text === undefined) return n;
  switch (n.kind) {
    case 'instance':
      return { ...n, subLabel: text || undefined };
    case 'input':
    case 'output':
    case 'inout':
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
 * deleted, with renamed labels and pins drawn as text, plus the symbols and wires drawn by hand.
 * Wires whose ports no longer exist (after a re-import or a parameter
 * change) are left out.
 */
export function effectiveDiagram(module: string, base: Diagram | undefined, e: SheetEdits, iface: InterfaceOf): Diagram {
  const hidden = new Set(e.hidden);
  const nodes: DNode[] = [];
  for (const n of base?.nodes ?? []) {
    if (hidden.has(n.id)) continue;
    nodes.push(withPinStyle(applyLabel(n, e.labels[n.id]), e.pinStyles?.[n.id]));
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
      ...(full ? {} : { bits: sl }),
      ...(u.shift ? { shift: u.shift } : {}),
    });
  }
  return { module, nodes, edges };
}

// ---------- connecting ----------

export type WireEnd =
  | { kind: 'port'; node: string; port: string }
  /** A point on an existing wire: connects to the wire's net (its driver). */
  | { kind: 'wire'; edge: string; at: Point };

export type Slice = { lo: number; width: number };

export interface Connection {
  source: { node: string; port: string };
  target: { node: string; port: string };
  /** True when the user drew from the target to the source (the drawn route must be reversed). */
  reversed: boolean;
  /** The bits of the source the new wire carries, when not all of them (it joins a wire that carries a slice). */
  slice?: Slice;
  /** Low zero bits the new wire appends, like the `×4` wire it joins. */
  shift?: number;
}

const sameSlice = (a: Slice | undefined, b: Slice | undefined) => a?.lo === b?.lo && a?.width === b?.width;

/**
 * Decide which end drives: an output port or a wire's net drives an input
 * port. A wire joined to an existing wire (or to an input that wire feeds)
 * carries the same bits as that wire, so a slice stays a slice and a scaled
 * (`×4`) wire stays scaled.
 */
export function resolveConnection(d: Diagram, a: WireEnd, b: WireEnd): Connection | { error: string } {
  const portOf = new Map<string, { node: DNode; port: DPort }>();
  for (const n of d.nodes) for (const p of n.ports) portOf.set(p.id, { node: n, port: p });
  const edgeOf = new Map(d.edges.map((x) => [x.id, x]));
  type Driver = { source: { node: string; port: string }; slice?: Slice; shift?: number };
  /** What an existing wire carries: its driver, and which of its bits, scaled as the wire is. */
  const carried = (x: DEdge): Driver => ({ source: x.source, slice: x.bits, shift: wireShift(x) || undefined });
  /** Driver of an end, if it is a driving end. */
  const driver = (end: WireEnd): Driver | undefined => {
    if (end.kind === 'wire') {
      const x = edgeOf.get(end.edge);
      return x && carried(x);
    }
    const p = portOf.get(end.port);
    return p && p.port.dir === 'out' ? { source: { node: end.node, port: end.port } } : undefined;
  };
  const sink = (end: WireEnd): { node: string; port: string } | undefined => {
    if (end.kind !== 'port') return undefined;
    const p = portOf.get(end.port);
    return p && p.port.dir === 'in' ? { node: end.node, port: end.port } : undefined;
  };
  // Inout ports of blocks are wired as inputs, but they can drive their net too.
  const isInout = (s: { port: string }) => !!portOf.get(s.port)?.port.inout;
  const conn = (dr: Driver, target: { node: string; port: string }, reversed: boolean): Connection => ({
    source: dr.source,
    target,
    reversed,
    ...(dr.slice ? { slice: dr.slice } : {}),
    ...(dr.shift ? { shift: dr.shift } : {}),
  });
  if (a.kind === 'port' && b.kind === 'port' && a.node === b.node && a.port === b.port) return { error: 'Pick a different pin.' };
  const da = driver(a);
  const db = driver(b);
  const sa = sink(a);
  const sb = sink(b);
  let c: Connection | undefined;
  if (da && sb) c = conn(da, sb, false);
  else if (db && sa) c = conn(db, sa, true);
  else if (sa && sb) {
    // Two inputs: join the undriven one to the other's driver, with the bits that wire carries.
    const into = (s: { port: string }): Driver | undefined => {
      const x = d.edges.find((y) => y.target.port === s.port);
      return x && carried(x);
    };
    const fa = into(sa);
    const fb = into(sb);
    // An inout port can be the source of the wire into the other end.
    if (fa?.source.port === sb.port || fb?.source.port === sa.port) return { error: 'These pins are already connected.' };
    if (fa && !fb) c = conn(fa, sb, false);
    else if (fb && !fa) c = conn(fb, sa, true);
    else if (fa && fb) return { error: 'Both inputs already have a driver.' };
    // Neither has a driver: an inout port may be the one that drives (two blocks sharing a bus).
    else if (isInout(sa)) c = conn({ source: sa }, sb, false);
    else if (isInout(sb)) c = conn({ source: sb }, sa, true);
    else return { error: 'Connect an output to an input (neither of these inputs has a driver yet).' };
  } else if (da && db) {
    return { error: 'Both ends are outputs. Connect an output to an input.' };
  } else {
    return { error: 'Connect an output to an input.' };
  }
  if (c.source.node === c.target.node && c.source.port === c.target.port) return { error: 'Pick a different pin.' };
  // The same bits, scaled the same way, between the same pins.
  const same = (x: DEdge) =>
    x.source.port === c!.source.port && x.target.port === c!.target.port && sameSlice(x.bits, c!.slice) && wireShift(x) === (c!.shift ?? 0);
  if (d.edges.some(same)) return { error: 'These pins are already connected.' };
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
  // A wire that appends zero bits (it taps or joins a `×4` wire) says so as the imported one does:
  // without the note it would read as the plain bus, while it carries the bits scaled.
  const text = label || (c.shift ? scaleNote(c.shift) : undefined);
  const edge: UserEdge = {
    id,
    source: c.source,
    target: c.target,
    ...(text ? { label: text } : {}),
    ...(c.slice ? { slice: { ...c.slice } } : {}),
    ...(c.shift ? { shift: c.shift } : {}),
  };
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

/**
 * Draw the pins among `ids` (symbols of the netlist `d`) in `style`: a pin drawn by hand takes it as its setting, an
 * imported pin keeps it in the sheet's pinStyles. What is no pin is left as it is.
 */
export function stylePins(e: SheetEdits, d: Diagram, ids: Iterable<string>, style: PinStyle): SheetEdits {
  const want = new Set(ids);
  const own = new Set(e.nodes.map((n) => n.id));
  const styles = { ...e.pinStyles };
  const restyled = new Set<string>();
  for (const n of d.nodes) {
    if (!want.has(n.id) || !isPinKind(n.kind) || pinStyleOf(n) === style) continue;
    if (own.has(n.id)) restyled.add(n.id);
    else if (style === 'text') styles[n.id] = style;
    else delete styles[n.id];
  }
  const nodes = restyled.size ? e.nodes.map((n) => (restyled.has(n.id) ? { ...n, params: { ...n.params, style } } : n)) : e.nodes;
  const same = (a: Record<string, PinStyle> | undefined, b: Record<string, PinStyle>) =>
    Object.keys(a ?? {}).length === Object.keys(b).length && Object.entries(b).every(([k, v]) => a?.[k] === v);
  if (nodes === e.nodes && same(e.pinStyles, styles)) return e;
  const out: SheetEdits = { ...e, nodes, pinStyles: styles };
  if (Object.keys(styles).length === 0) delete out.pinStyles;
  return out;
}

/** Undo a rename of an imported symbol or wire. */
export function resetLabel(e: SheetEdits, id: string): SheetEdits {
  if (!(id in e.labels)) return e;
  const labels = { ...e.labels };
  delete labels[id];
  return { ...e, labels };
}

/**
 * Which port takes the place of each port of `before` that `after` no longer
 * has. Ports are matched by their position among the ports with the same
 * direction and side; bus slices count from the LSB, so a concatenation or
 * split keeps its low part on its low part. Only a port that is new in
 * `after` can take a place, so an existing wire is never doubled.
 */
function portSuccessors(before: DNode, after: DNode): Map<string, string> {
  const slots = (n: DNode) => {
    const fromLsb = n.kind === 'join' || n.kind === 'split';
    const groups = new Map<string, DPort[]>();
    for (const p of n.ports) groups.set(`${p.dir}:${p.side}`, [...(groups.get(`${p.dir}:${p.side}`) ?? []), p]);
    const out = new Map<string, DPort>();
    for (const [g, ps] of groups) ps.forEach((p, k) => out.set(`${g}:${fromLsb ? ps.length - 1 - k : k}`, p));
    return out;
  };
  const beforeNames = new Set(before.ports.map((p) => p.name));
  const afterNames = new Set(after.ports.map((p) => p.name));
  const afterSlots = slots(after);
  const map = new Map<string, string>();
  for (const [slot, p] of slots(before)) {
    if (afterNames.has(p.name)) continue;
    const q = afterSlots.get(slot);
    if (q && !beforeNames.has(q.name)) map.set(p.id, q.id);
  }
  return map;
}

/**
 * Change a symbol's parameters. Port names can depend on them (a 2-input MUX
 * has A and B, a wider one I0..In; concatenation and split ports are named by
 * their bit ranges), so the wires on a port that goes away move to the port
 * that takes its place instead of being dropped. A wire whose port went away
 * with no successor is kept (hidden), and comes back with its port, unless the
 * input it feeds is driven by another wire by then.
 */
export function setParams(e: SheetEdits, id: string, params: SymParams, iface: InterfaceOf = () => undefined): SheetEdits {
  const old = e.nodes.find((n) => n.id === id);
  if (!old) return e;
  const u: UserNode = { ...old, params: { ...old.params, ...params } };
  const nodes = e.nodes.map((n) => (n.id === id ? u : n));
  // Blocks are left alone: their ports come from the module, not from parameters
  // (and the ports of another module are not the same signals by position).
  const noModules: InterfaceOf = () => undefined;
  const before = symbolNode(old, noModules);
  const after = symbolNode(u, noModules);
  const moved = portSuccessors(before, after);
  if ((u.sym === 'concat' || u.sym === 'split') && (old.params.width ?? 1) !== (u.params.width ?? 1)) {
    // Slices are named by their bits, which change with the width: a wire hidden on a slice that is gone (fewer
    // slices) moves to that slice's new name too, so that it still comes back with it.
    // Not onto a slice name a stored wire already ends on (a file saved before hidden wires moved with the width
    // can hold one there): that wire stays where it is.
    const all = (n: UserNode) => symbolNode({ ...n, params: { ...n.params, parts: PARAM_LIMITS.parts[1] } }, noModules);
    const used = new Set(e.edges.filter((x) => x.target.node === id).map((x) => x.target.port));
    for (const [from, to] of portSuccessors(all(old), all(u))) if (!moved.has(from) && !used.has(to)) moved.set(from, to);
  }
  const remap = (end: { node: string; port: string }) => (end.node === id && moved.has(end.port) ? { node: id, port: moved.get(end.port)! } : end);
  const remapped = e.edges.map((x) => {
    const source = remap(x.source);
    const target = remap(x.target);
    return source === x.source && target === x.target ? x : { ...x, source, target };
  });
  // The pins of the symbols after the change, to tell which wires show (both ends there) and which drive (an
  // inout's wire only shares a net, as checkSheet counts). Imported symbols are not in the edits, nor the module
  // of a block `iface` does not know: their ends count as there, and as driving.
  const userNodes = new Map(nodes.map((n) => [n.id, n]));
  const pinsOf = new Map<string, Map<string, DPort> | null>();
  const pinOf = (end: { node: string; port: string }): DPort | null | undefined => {
    if (!pinsOf.has(end.node)) {
      const n = userNodes.get(end.node);
      const known = n && (n.sym !== 'block' || iface(n.params.module ?? ''));
      pinsOf.set(end.node, known ? new Map((n.id === id ? after : symbolNode(n, iface)).ports.map((p) => [p.id, p])) : null);
    }
    const pins = pinsOf.get(end.node);
    return pins === null ? null : pins!.get(end.port);
  };
  const shown = (x: UserEdge) => pinOf(x.source) !== undefined && pinOf(x.target) !== undefined;
  const drives = (x: UserEdge) => !pinOf(x.source)?.inout;
  // Wires that come back: stored on a port of this symbol that was not there (hidden by an earlier change), shown
  // now (on that port under its old name, or its new one after a change of width).
  const beforeIds = new Set(before.ports.map((p) => p.id));
  const hidden = (end: { node: string; port: string }) => end.node === id && !beforeIds.has(end.port);
  const returns = e.edges.map((x, i) => (hidden(x.source) || hidden(x.target)) && shown(remapped[i]));
  if (!returns.includes(true) && remapped.every((x, i) => x === e.edges[i])) return { ...e, nodes };
  // A returning wire would be a second driver of an input that a shown wire drives by now (one moved onto a slice
  // port that is back under its old name, or one wired while it was hidden; a wire that stays hidden drives
  // nothing), or that a wire coming back before it drives: drop it.
  const driven = new Set(remapped.filter((x, i) => !returns[i] && shown(x) && drives(x)).map((x) => x.target.port));
  const edges = remapped.filter((x, i) => {
    if (!returns[i] || !drives(x)) return true;
    if (driven.has(x.target.port)) return false;
    driven.add(x.target.port);
    return true;
  });
  if (edges.length === remapped.length) return { ...e, nodes, edges };
  const routes = { ...e.routes };
  for (const x of remapped) if (!edges.includes(x)) delete routes[x.id];
  return { ...e, nodes, edges, routes };
}

/** The symbol `id` placed from a preset of the library, linked to the preset `component`, or to none. */
function linkTo(e: SheetEdits, id: string, component: string | undefined): SheetEdits {
  const n = e.nodes.find((x) => x.id === id);
  if (!n || n.component === component) return e;
  const linked: UserNode = { ...n, component };
  if (!component) delete linked.component;
  return { ...e, nodes: e.nodes.map((x) => (x === n ? linked : x)) };
}

/**
 * After the user changed the settings of the symbol `id` by itself: when it was placed from a preset and
 * no longer has the preset's settings, it is a symbol of its own from now on (changing the preset leaves it).
 */
export function unlinkChanged(e: SheetEdits, id: string, defs: readonly ComponentDef[] | undefined): SheetEdits {
  const n = e.nodes.find((x) => x.id === id);
  if (!n?.component) return e;
  return followsPreset(n, defs) ? e : linkTo(e, id, undefined);
}

/** The sheet with the links that do not hold (see followsPreset) taken off: those symbols are symbols of their own. */
export function keepLinks(e: SheetEdits, defs: readonly ComponentDef[] | undefined): SheetEdits {
  let out = e;
  for (const n of e.nodes) if (n.component && !followsPreset(n, defs)) out = linkTo(out, n.id, undefined);
  return out;
}

/**
 * The sheets after the library changed from `before` to `after`: the symbols placed from a preset take
 * its new settings (with their wires, as a change in Properties would), and follow it when it is renamed
 * (`renamed`, old name to new). A symbol whose preset is gone, became a part or another symbol keeps its
 * settings and is a symbol of its own, as is one whose link no longer held (see followsPreset). Returns
 * `sheets` itself when nothing changes.
 */
export function followComponents(
  sheets: Record<string, SheetEdits>,
  before: readonly ComponentDef[] | undefined,
  after: readonly ComponentDef[] | undefined,
  renamed?: Readonly<Record<string, string>>,
  iface?: InterfaceOf,
): Record<string, SheetEdits> {
  /** What the symbols placed from each preset become: the preset now (by its name now), or none. */
  const plan = new Map<string, ComponentDef | undefined>();
  for (const old of before ?? []) {
    if (isPart(old)) continue;
    const name = renamed && Object.hasOwn(renamed, old.name) ? renamed[old.name] : old.name;
    const now = after?.find((c) => c.name === name);
    plan.set(old.name, now && !isPart(now) && now.base === old.base ? now : undefined);
  }
  let out: Record<string, SheetEdits> | undefined;
  for (const [key, e] of Object.entries(sheets)) {
    let next = e;
    for (const n of e.nodes) {
      if (!n.component) continue;
      const to = plan.get(n.component);
      // Only a symbol that still has its preset's settings follows the preset's change.
      if (!to || to.base !== n.sym || !followsPreset(n, before)) {
        next = linkTo(next, n.id, undefined);
        continue;
      }
      // All of them: a setting the preset leaves out is the default, not what the symbol had.
      const params = fullSettings(n.sym, componentSymbol(to).params);
      if (!sameSettings(n.sym, n.params, params)) next = setParams(next, n.id, params, iface);
      next = linkTo(next, n.id, to.name);
    }
    if (next !== e) (out ??= { ...sheets })[key] = next;
  }
  return out ?? sheets;
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
 * Room placeMissing keeps between symbols: a pin's stub on each side (the router's straight piece at a
 * pin reaches one or two grid steps past the outline, e.g. below a MUX's select or a register's clock)
 * and a grid step between them, so a wire can pass and never runs along the other symbol's edge.
 */
const PLACE_CLEARANCE = 30;
/** Room placeMissing keeps between a new symbol and a stored wire: a pin's stub and a grid step. */
const PLACE_WIRE_CLEARANCE = 20;
/** How far below the first spot clear of symbols placeMissing looks for one clear of wires too. */
const PLACE_WIRE_SEARCH = 200;

/**
 * Positions for symbols that have none yet (new in a re-import, or in a file
 * saved while the drawing rules could be switched off): each goes where ELK put it relative to
 * a neighbour that already has a position, then moves down until it keeps
 * clear of the other symbols and, when it can nearby, of the stored wires in
 * `routes` (a wire on its outline or a stub's length from it would read as
 * connected to its pins).
 */
export function placeMissing(
  d: Diagram,
  pos: Record<string, Point>,
  elk: LayoutResult | undefined,
  size: (n: DNode) => { width: number; height: number },
  routes: Record<string, RouteRec> = {},
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
  const c = PLACE_CLEARANCE;
  const overlaps = (x: number, y: number, w: number, h: number) =>
    rects.some((r) => x < r.x + r.w + c && x + w + c > r.x && y < r.y + r.h + c && y + h + c > r.y);
  // Stored wires between symbols that had a place: a wire of a symbol placed here has no route yet.
  const wires = d.edges.filter((x) => pos[x.source.node] && pos[x.target.node] && (routes[x.id]?.points.length ?? 0) >= 2).map((x) => routes[x.id].points);
  const cw = PLACE_WIRE_CLEARANCE;
  const nearWire = (x: number, y: number, w: number, h: number) =>
    wires.some((pts) => polylineHitsRect(pts, { x: x - cw, y: y - cw, width: w + 2 * cw, height: h + 2 * cw }));
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
      fallbackY += s.height + PLACE_CLEARANCE;
    }
    // The first spot below clear of symbols; then, a little further down, one clear of wires too. Past
    // that the symbol stays at the first spot: a wire it lands on is routed again (see buildGeometry).
    let free: Point | undefined;
    for (let k = 0; k <= 400; k++) {
      const q = { x: p.x, y: p.y + 10 * k };
      if (free && q.y - free.y > PLACE_WIRE_SEARCH) break;
      if (overlaps(q.x, q.y, s.width, s.height)) continue;
      if (!nearWire(q.x, q.y, s.width, s.height)) {
        free = q;
        break;
      }
      free ??= q;
    }
    p = free ?? { x: p.x, y: p.y + 4000 };
    // On the grid, like every symbol: its pins line up with the others'.
    p = { x: Math.round(p.x / GRID) * GRID, y: Math.round(p.y / GRID) * GRID };
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
  // Reductions are gates in reduce mode (see GateMode); `$reduce_bool`, the `|a` of a condition, is an OR.
  $reduce_and: 'and',
  $reduce_or: 'or',
  $reduce_bool: 'or',
  $reduce_xor: 'xor',
  $reduce_xnor: 'xnor',
  'dc:reduce_nand': 'nand',
  'dc:reduce_nor': 'nor',
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
    case 'inout': {
      // A library pin is at most PARAM_LIMITS.width bits; a wider one stays a frozen copy.
      const w = n.ports[0]?.width ?? 1;
      if (w <= PARAM_LIMITS.width[1]) return { id, sym: n.kind, params: { width: w, style: pinStyleOf(n) }, name: n.label };
      break;
    }
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
    case 'join':
    case 'split': {
      // Slices of one width are the library's Concatenate or Split, whose slices and width can be changed.
      const slices = n.ports.filter((p) => p.dir === (n.kind === 'join' ? 'in' : 'out'));
      const w = slices[0]?.width ?? 0;
      const [lo, hi] = PARAM_LIMITS.parts;
      if (slices.length < lo || slices.length > hi || w < 1 || w > PARAM_LIMITS.width[1]) break;
      const u: UserNode = { id, sym: n.kind === 'join' ? 'concat' : 'split', params: { parts: slices.length, width: w } };
      const drawn = symbolNode(u, iface);
      // In the same order too: the slices of a bus declared [0:3] are named [0] [1] [2] [3] from the top, and a
      // Concatenate's [3] [2] [1] [0], so a wire moved by name would take the bit at the other end.
      const order = (d: DNode) => d.ports.filter((p) => p.dir === slices[0].dir).map((p) => p.name).join(',');
      if (signature(drawn) === signature(n) && order(drawn) === order(n)) return u;
      break;
    }
    case 'cell': {
      const sym = n.cellType ? CELL_TO_SYM[n.cellType] : undefined;
      // Cells with non-default parameters (negedge clock, reset value, signed operands) have no
      // library symbol that says so: keep them as frozen copies, which keep the parameters.
      if (!sym || n.attrs?.invertB || n.params) break;
      const ins = n.ports.filter((p) => p.dir === 'in' && p.side === 'WEST');
      const params: SymParams = {};
      if (isReduceType(n.cellType)) {
        // |a: its one input is as wide as the bus (and the 2 inputs of the library's gate wait for bitwise mode).
        const u: UserNode = { id, sym, params: { inputs: 2, width: width('A'), mode: 'reduce' } };
        if (signature(symbolNode(u, iface)) === signature(n)) return u;
        break;
      }
      if (sym === 'decoder') params.width = width('A');
      else if (sym === 'dff' || sym === 'dffe' || sym === 'adff') params.width = width('D');
      else if (sym === 'shl' || sym === 'shr') {
        params.width = width('A');
        params.shift = width('B');
      } else if (['eq', 'ne', 'lt', 'le', 'gt', 'ge'].includes(sym)) params.width = width('A');
      else params.width = width('Y');
      if (['and', 'or', 'xor', 'nand', 'nor', 'xnor', 'mux'].includes(sym)) params.inputs = ins.length;
      if (isGateSym(sym)) params.mode = 'bitwise';
      const u: UserNode = { id, sym, params };
      if (signature(symbolNode(u, iface)) === signature(n)) return u;
      break;
    }
  }
  // Frozen copy: the node as it is drawn, ports renamed to the new ID. A pin's look is a setting (see symbolNode).
  const raw: DNode = { ...withPinStyle(n, 'label'), id, ports: n.ports.map((p) => ({ ...p, id: `${id}.${p.name}` })) };
  const params: SymParams = isPinKind(n.kind) ? { style: pinStyleOf(n) } : {};
  return { id, sym: 'raw', params, raw, ...(n.kind === 'instance' ? { name: n.subLabel ?? n.instanceName } : {}) };
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
      ...(x.shift ? { shift: x.shift } : {}),
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

export interface DrawingPort extends ModulePort {
  /** The pin symbol (u:<n>) the port comes from. */
  pin: string;
}

/**
 * The ports of a block that instantiates a drawing: one per pin, in drawing
 * order. Each pin's Verilog name is verilogIdent(label), made unique with _2,
 * _3… in the same order. A port is named like its pin when that is its Verilog
 * name, and takes the unique name when the pin had to be made unique (`a b`
 * and `a_b` are both a_b; input x and output x): two ports of one name would
 * make wires to the block connect the wrong one, and a pin is lost. Pins keep
 * their names in the common case, so block port IDs (`<block>.<name>`) in
 * saved work stay valid.
 */
export function drawingPorts(e: SheetEdits | undefined): DrawingPort[] {
  const ports: DrawingPort[] = [];
  const used = new Set<string>();
  const seen = new Set<string>();
  for (const n of e?.nodes ?? []) {
    // A pin wider than a library pin is a frozen copy (`raw`, see toUserNode); it is a port all the same.
    const raw = n.sym === 'raw' ? n.raw : undefined;
    const dir = raw ? raw.kind : n.sym;
    if (dir !== 'input' && dir !== 'output' && dir !== 'inout') continue;
    // effectiveDiagram draws a repeated ID once.
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    // The label symbolNode gives the pin.
    const label = raw ? n.name || raw.label : n.name || (dir === 'input' ? 'in' : dir === 'output' ? 'out' : 'io');
    const ident = verilogIdent(label);
    let written = ident;
    for (let i = 2; used.has(written); i++) written = `${ident}_${i}`;
    used.add(written);
    const own = label.trim();
    // The width of the pin's own port (a frozen copy's), or its width setting.
    const width = raw ? Math.max(1, (raw.ports.find((q) => q.dir === (dir === 'output' ? 'in' : 'out')) ?? raw.ports[0])?.width ?? 1) : clampParam('width', n.params.width, 1);
    ports.push({ pin: n.id, name: own && verilogIdent(own) === written ? own : written, dir, width });
  }
  return ports;
}

/**
 * The Verilog name of a pin (its port) or a named block (its instance); undefined for other
 * symbols, and for a block nobody named (it gets an automatic name).
 */
function verilogName(n: DNode): string | undefined {
  if (n.kind === 'input' || n.kind === 'output' || n.kind === 'inout') return n.label;
  return n.kind === 'instance' ? n.subLabel : undefined;
}

/** A name like `name` that is not taken: in1 → in2 (the next free number, as placement numbers pins), a → a2. */
function freeName(name: string, taken: ReadonlySet<string>): string {
  const m = /^(.*\D)(\d+)$/.exec(name);
  const stem = m ? m[1] : name;
  for (let k = m ? 1 : 2; ; k++) if (!taken.has(verilogIdent(`${stem}${k}`))) return `${stem}${k}`;
}

/**
 * Paste a clip with its top-left corner at `at`. Returns the new edits and the IDs of what was pasted.
 * A pasted pin or block whose name is already used on the sheet gets a free one, as placement gives
 * (in1 → in2, a → a2): two pins drawn as `a` would read as one signal, but a block of the drawing has
 * two ports (a and a_2, see drawingPorts). `sheet` is the sheet's netlist, for the names of its imported symbols; without
 * it only the symbols drawn by hand count.
 */
export function pasteClip(e: SheetEdits, clip: Clip, at: Point, sheet?: Diagram): [SheetEdits, string[]] {
  let cur = e;
  const map = new Map<string, string>();
  const items: { node: UserNode; pos: Point }[] = [];
  const noModules: InterfaceOf = () => undefined;
  const taken = new Set<string>();
  for (const n of sheet?.nodes ?? e.nodes.map((u) => symbolNode(u, noModules))) {
    const name = verilogName(n);
    if (name !== undefined) taken.add(verilogIdent(name));
  }
  for (const it of clip.nodes) {
    const [id, next] = newId(cur, 'u');
    cur = next;
    map.set(it.node.id, id);
    const node: UserNode = structuredClone(it.node);
    node.id = id;
    if (node.raw) node.raw = { ...node.raw, id, ports: node.raw.ports.map((p) => ({ ...p, id: `${id}.${p.name}` })) };
    const name = verilogName(symbolNode(node, noModules))?.trim();
    if (name) {
      const free = taken.has(verilogIdent(name)) ? freeName(name, taken) : name;
      if (free !== name) node.name = free;
      taken.add(verilogIdent(free));
    }
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
      ...(x.shift ? { shift: x.shift } : {}),
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
  // Hand-drawn symbols keep their u:<n> IDs, which can be above the wire count.
  out.next = freeIdFloor(out);
  return out;
}

/** How big a symbol is. */
export interface Size {
  width: number;
  height: number;
}

/**
 * makeRoom for the symbols of `d` that have a position, from the size `oldSize` gives each (given its size now).
 * `d` holds the symbols the user deleted from a Verilog sheet too: they come back where they were (Restore).
 */
function growFrom(e: SheetEdits, d: Diagram, measure: MeasureText, oldSize: (n: DNode, now: Size) => Size): SheetEdits {
  const was = new Map<string, Size>();
  const now = new Map<string, Size>();
  const unsized = new Set<string>();
  for (const n of d.nodes) {
    if (!e.pos[n.id]) continue;
    const s = sizeNode(n, measure);
    const size = { width: s.width, height: s.height };
    now.set(n.id, size);
    was.set(n.id, oldSize(n, size));
    // A block of a module whose Verilog is still loading, or failed, has no pins yet: it is drawn smaller than it is.
    if (n.attrs?.missingModule) unsized.add(n.id);
  }
  return makeRoom(e, was, now, unsized);
}

/**
 * A sheet saved with the symbol outlines of before (oldOutlines, see OUTLINES), drawn with today's: the symbols
 * that grew get room as a block that grew does (makeRoom), so none covers a neighbour, a pin or a wire. An adder
 * grew 20 px down (or up, where that is free), a gate with three or more inputs 10 or 20 px right. Wires a grown
 * symbol covers are routed again; so are those to its pins that moved (their ends no longer meet them).
 * `d` is the sheet's netlist with its hidden symbols (see growFrom).
 */
export function fitNewOutlines(e: SheetEdits, d: Diagram, measure: MeasureText): SheetEdits {
  const out = { ...growFrom(e, d, measure, (n, now) => legacyCellSize(n, measure) ?? now) };
  delete out.oldOutlines;
  return out;
}

/**
 * Room right of symbols that got wider when their settings changed (a gate with more inputs; `widths`: how wide
 * each was before): what is right of one moves right as far, wires too (makeRoom), rather than being covered.
 * `d` is the sheet's netlist after the change, with its hidden symbols (see growFrom).
 */
export function fitWider(e: SheetEdits, d: Diagram, widths: ReadonlyMap<string, number>, measure: MeasureText): SheetEdits {
  return growFrom(e, d, measure, (n, now) => (widths.has(n.id) ? { width: Math.min(widths.get(n.id)!, now.width), height: now.height } : now));
}

/**
 * Room for symbols that grew (`was` → `now`: sizes by symbol), with the layout
 * kept. A wider symbol gets a column as wide as its growth put in at its old
 * right edge: everything right of that edge moves right, wire routes and labels
 * too. A point moves with its column, so routes keep their shapes, and the pins
 * on the symbol's right edge move with that edge. A taller symbol (a longer
 * header) grows upwards, so its pins stay where its wires end, when nothing is
 * there, nor close beside it; otherwise downwards, with a row as high as its
 * growth put in at its old bottom the same way, or higher up where something
 * close beside it starts, which then stays beside its pins. Stored routes that
 * run through a grown symbol are dropped, to be routed again. Symbols in
 * `unsized` may be any size right of and below their corner (a block whose
 * pins are not known yet): nothing grows upwards into where they might reach.
 */
export function makeRoom(e: SheetEdits, was: ReadonlyMap<string, Size>, now: ReadonlyMap<string, Size>, unsized?: ReadonlySet<string>): SheetEdits {
  const grown = [...now].filter(([id, s]) => e.pos[id] && was.has(id) && (s.width > was.get(id)!.width || s.height > was.get(id)!.height));
  if (grown.length === 0) return e;
  const cols = grown
    .filter(([id, s]) => s.width > was.get(id)!.width)
    .map(([id, s]) => ({ x: e.pos[id].x, right: e.pos[id].x + was.get(id)!.width, grow: s.width - was.get(id)!.width, shift: 0 }))
    .sort((a, b) => a.right - b.right);
  const shiftAt = (x: number) => cols.reduce((m, c) => (c.right <= x + 0.5 ? Math.max(m, c.shift) : m), 0);
  // Right of a symbol, things move as far as its right edge does: as its left edge, plus its growth. Its left edge
  // moves with the columns left of it, which come first.
  for (const c of cols) c.shift = shiftAt(c.x) + c.grow;
  const mx = <T extends Point>(p: T): T => ({ ...p, x: p.x + shiftAt(p.x) });
  const pos = Object.fromEntries(Object.entries(e.pos).map(([id, p]) => [id, mx(p)]));
  const routes = Object.fromEntries(
    Object.entries(e.routes).map(([id, r]): [string, RouteRec] => [id, { ...r, points: r.points.map(mx), ...(r.label ? { label: mx(r.label) } : {}) }]),
  );
  const rect = (id: string) => ({ ...pos[id], ...(now.get(id) ?? was.get(id) ?? { width: 0, height: 0 }) });
  const gap = 5;
  // Beside it, room for the stub a wire leaves a pin on (two grid steps, as the router snaps it): a pin closer than
  // that would have its wire start inside the symbol.
  const side = 2 * GRID;
  const clear = (r: Box, id: string) =>
    Object.keys(pos).every((k) => {
      const q = unsized?.has(k) ? { ...pos[k], width: Infinity, height: Infinity } : rect(k);
      return k === id || r.x >= q.x + q.width + side || q.x >= r.x + r.width + side || r.y >= q.y + q.height + gap || q.y >= r.y + r.height + gap;
    });
  for (const [id, s] of grown.sort(([a], [b]) => pos[a].y - pos[b].y)) {
    const dh = s.height - was.get(id)!.height;
    if (dh <= 0) continue;
    // Upwards: the band it grows into is free.
    if (clear({ x: pos[id].x, y: pos[id].y - dh, width: s.width, height: dh }, id)) {
      pos[id] = { ...pos[id], y: pos[id].y - dh };
      continue;
    }
    // Downwards (its wires are routed again): everything below its old bottom moves down as far, not only what is in
    // its column, which could land on what is beside it. Its pins move down too: what starts beside it, too close for
    // their stubs, moves down with them, and so does everything below that.
    const top = pos[id].y;
    const left = pos[id].x;
    const right = left + s.width;
    const bottom = top + was.get(id)!.height;
    const cut = Object.keys(pos).reduce((y, k) => {
      const q = rect(k);
      return k !== id && q.y > top && q.y < y && q.x < right + side && left < q.x + q.width + side ? q.y : y;
    }, bottom);
    const my = <T extends Point>(p: T): T => (p.y >= cut - 0.5 ? { ...p, y: p.y + dh } : p);
    for (const k of Object.keys(pos)) if (k !== id) pos[k] = my(pos[k]);
    for (const [k, r] of Object.entries(routes)) routes[k] = { ...r, points: r.points.map(my), ...(r.label ? { label: my(r.label) } : {}) };
  }
  // Not the box of a symbol the user deleted (hidden): no wire is routed around it, and those over it are routed
  // again when it comes back (Restore).
  const boxes = grown.filter(([id]) => !e.hidden.includes(id)).map(([id]) => rect(id));
  for (const [id, r] of Object.entries(routes)) if (boxes.some((b) => polylineHitsRect(r.points, b))) delete routes[id];
  return { ...e, pos, routes };
}
