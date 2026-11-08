import { describe, expect, it } from 'vitest';
import { buildDiagram } from '../core/diagram';
import { withFlattened } from '../core/flatten';
import { withAutoBlocks } from '../core/partition';
import { design } from '../core/test-utils';
import { AUCTION_FILE, AUCTION_SOURCE } from '../examples/auction';
import { FRUIT_FILE, FRUIT_SOURCE } from '../examples/fruit-battle';
import { type LayoutResult, type Point, approxMeasure, layoutDiagram } from '../layout/elk-layout';
import { type SheetEdits, emptyEdits } from './doc';
import { buildGeometry, labelBox, runTogether, sliceNameBox } from './geometry';
import { polylineCrowdsRect, polylineHitsRect, wiresMeet } from './router';
import { addNodes, connect, copyNodes, effectiveDiagram, layoutToEdits, moveNodes, pasteClip, rename, resolveConnection, setParams } from './sheet';
import { type InterfaceOf, type SymKey, type SymParams, newUserNode } from './symbols';

const noModules: InterfaceOf = () => undefined;

function orthogonal(points: { x: number; y: number }[]): boolean {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (Math.abs(a.x - b.x) > 0.01 && Math.abs(a.y - b.y) > 0.01) return false;
  }
  return true;
}

describe('sheet geometry', () => {
  it('draws an imported sheet exactly where ELK put it, with the same junctions', async () => {
    const files = { [AUCTION_FILE]: AUCTION_SOURCE };
    const d = await design(files);
    const base = buildDiagram(d, d.top);
    const elk = await layoutDiagram(base);
    const e = layoutToEdits(emptyEdits(), elk, 'existing');
    const g = buildGeometry({ netlist: base, pos: e.pos, routes: e.routes, measure: approxMeasure });
    // Nothing needed routing: every ELK route still meets its pins.
    expect(Object.keys(g.routed)).toHaveLength(0);
    for (const n of g.layout.nodes) {
      const o = elk.nodes.find((x) => x.id === n.id)!;
      expect([n.x, n.y, n.width, n.height]).toEqual([o.x, o.y, o.width, o.height]);
    }
    const dots = (l: { edges: { junctions: { x: number; y: number }[] }[] }) =>
      new Set(l.edges.flatMap((x) => x.junctions.map((j) => `${Math.round(j.x)},${Math.round(j.y)}`)));
    expect(dots(g.layout)).toEqual(dots(elk));
    // The first test of the file also starts Yosys, which can take over 5 s on a busy machine.
  }, 30_000);

  it('routes wires again when a symbol moves, around the other symbols', async () => {
    const files = { [AUCTION_FILE]: AUCTION_SOURCE };
    const d = await design(files);
    const base = buildDiagram(d, d.top);
    const elk = await layoutDiagram(base);
    let e = layoutToEdits(emptyEdits(), elk, 'existing');
    const block = base.nodes.find((n) => n.kind === 'instance')!;
    e = moveNodes(e, base, [block.id], 0, 200);
    const g = buildGeometry({ netlist: base, pos: e.pos, routes: e.routes, measure: approxMeasure, moved: new Set([block.id]) });
    const touched = base.edges.filter((x) => x.source.node === block.id || x.target.node === block.id);
    expect(touched.length).toBeGreaterThan(0);
    for (const x of touched) {
      expect(g.routed[x.id], x.id).toBeDefined();
      const l = g.layout.edges.find((y) => y.id === x.id)!;
      expect(orthogonal(l.points)).toBe(true);
      const s = g.layout.nodes.flatMap((n) => n.ports).find((p) => p.id === x.source.port)!;
      const t = g.layout.nodes.flatMap((n) => n.ports).find((p) => p.id === x.target.port)!;
      expect(l.points[0]).toEqual({ x: s.x, y: s.y });
      expect(l.points[l.points.length - 1]).toEqual({ x: t.x, y: t.y });
      // The new route does not cut through other symbols.
      for (const n of g.layout.nodes) {
        if (n.id === x.source.node || n.id === x.target.node) continue;
        expect(polylineHitsRect(l.points, n), `${x.id} crosses ${n.id}`).toBe(false);
      }
    }
    // Stored routes are used as they are next time.
    const again = buildGeometry({ netlist: base, pos: e.pos, routes: { ...e.routes, ...g.routed }, measure: approxMeasure });
    expect(Object.keys(again.routed)).toHaveLength(0);
  });

  it('draws a fan-out drawn by hand as a tree with one junction dot', () => {
    let e = emptyEdits();
    e = addNodes(e, [
      { node: newUserNode('u:1', 'input', { name: 'a' }), pos: { x: 0, y: 100 } },
      { node: newUserNode('u:2', 'not'), pos: { x: 200, y: 20 } },
      { node: newUserNode('u:3', 'not'), pos: { x: 200, y: 180 } },
    ]);
    for (const t of ['u:2', 'u:3']) {
      const d = effectiveDiagram('m', undefined, e, noModules);
      const c = resolveConnection(d, { kind: 'port', node: 'u:1', port: 'u:1.out' }, { kind: 'port', node: t, port: `${t}.A` });
      if ('error' in c) throw new Error(c.error);
      [, e] = connect(e, c);
    }
    const d = effectiveDiagram('m', undefined, e, noModules);
    const g = buildGeometry({ netlist: d, pos: e.pos, routes: e.routes, measure: approxMeasure });
    expect(g.layout.edges).toHaveLength(2);
    for (const x of g.layout.edges) expect(orthogonal(x.points)).toBe(true);
    const dots = g.layout.edges.flatMap((x) => x.junctions);
    expect(dots).toHaveLength(1);
    // Bounds cover everything.
    const l = g.layout;
    for (const n of l.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(l.x!);
      expect(n.x + n.width).toBeLessThanOrEqual(l.x! + l.width);
    }
  });

  it('stretches hand-shaped wires instead of routing them again', () => {
    let e = emptyEdits();
    e = addNodes(e, [
      { node: newUserNode('u:1', 'input', { name: 'a' }), pos: { x: 0, y: 0 } },
      { node: newUserNode('u:2', 'output', { name: 'y' }), pos: { x: 300, y: 100 } },
    ]);
    const d0 = effectiveDiagram('m', undefined, e, noModules);
    const g0 = buildGeometry({ netlist: d0, pos: e.pos, routes: e.routes, measure: approxMeasure });
    const out = g0.layout.nodes[0].ports[0];
    const inp = g0.layout.nodes[1].ports[0];
    const c = resolveConnection(d0, { kind: 'port', node: 'u:1', port: 'u:1.out' }, { kind: 'port', node: 'u:2', port: 'u:2.in' });
    if ('error' in c) throw new Error(c.error);
    // A hand-drawn route with its corner at x = 150.
    const route = [
      { x: out.x, y: out.y },
      { x: 150, y: out.y },
      { x: 150, y: inp.y },
      { x: inp.x, y: inp.y },
    ];
    let wid: string;
    [wid, e] = connect(e, c, route);
    const d = effectiveDiagram('m', undefined, e, noModules);
    e = moveNodes(e, d, ['u:2'], 50, 40);
    const g = buildGeometry({ netlist: d, pos: e.pos, routes: e.routes, measure: approxMeasure });
    const l = g.layout.edges.find((x) => x.id === wid)!;
    expect(orthogonal(l.points)).toBe(true);
    // The corner the user made stays at x = 150.
    expect(l.points.some((p) => p.x === 150)).toBe(true);
    expect(g.routed[wid]?.manual).toBe(true);
  });
});

/**
 * A hand-drawn sheet refreshed the way the store does it: every refresh passes the layout on screen as
 * `previous` and keeps the routes found; a drag shows quick previews, then moves the symbols for good.
 */
class Sheet {
  e: SheetEdits;
  layout?: LayoutResult;

  constructor(items: [string, SymKey, number, number, SymParams?][]) {
    this.e = addNodes(
      emptyEdits(),
      items.map(([id, sym, x, y, params]) => {
        const node = newUserNode(id, sym, { name: id.replace(':', '') });
        return { node: params ? { ...node, params: { ...node.params, ...params } } : node, pos: { x, y } };
      }),
    );
    this.e = { ...this.e, next: 100 };
    this.refresh();
  }

  get d() {
    return effectiveDiagram('m', undefined, this.e, noModules);
  }

  refresh(moved?: string[]) {
    const g = buildGeometry({ netlist: this.d, pos: this.e.pos, routes: this.e.routes, measure: approxMeasure, moved: moved && new Set(moved), previous: this.layout });
    this.e = { ...this.e, routes: { ...this.e.routes, ...g.routed } };
    this.layout = g.layout;
    return g;
  }

  /** A wire between two pins, drawn through bends when a route is given (a hand-shaped one). */
  wire(from: string, to: string, route?: Point[]): string {
    const c = resolveConnection(this.d, { kind: 'port', node: from.split('.')[0], port: from }, { kind: 'port', node: to.split('.')[0], port: to });
    if ('error' in c) throw new Error(c.error);
    let id: string;
    [id, this.e] = connect(this.e, c, route);
    this.refresh();
    return id;
  }

  preview(ids: string[], dx: number, dy: number) {
    const e = moveNodes(this.e, this.d, ids, dx, dy);
    this.layout = buildGeometry({ netlist: this.d, pos: e.pos, routes: e.routes, measure: approxMeasure, fast: true, previous: this.layout }).layout;
  }

  move(ids: string[], dx: number, dy: number) {
    this.e = moveNodes(this.e, this.d, ids, dx, dy);
    return this.refresh(ids);
  }

  points(id: string): Point[] {
    return this.layout!.edges.find((x) => x.id === id)!.points;
  }

  pin(id: string): Point {
    const p = this.layout!.nodes.flatMap((n) => n.ports).find((q) => q.id === id)!;
    return { x: p.x, y: p.y };
  }
}

/** Wires that come closer to a symbol other than their own two than the router keeps them (along its edge, through its pins). */
function crowded(l: LayoutResult): string[] {
  const out: string[] = [];
  for (const x of l.edges)
    for (const n of l.nodes) if (n.id !== x.source.node && n.id !== x.target.node && polylineCrowdsRect(x.points, n)) out.push(`${x.id} at ${n.id}`);
  return out;
}

/**
 * Wires that come closer to one of their own symbols than routed wires do, but for their pieces running
 * straight out of their pins there, or that pass over another pin of it.
 */
function crowdedOwn(l: LayoutResult): string[] {
  const out: string[] = [];
  const dir = { EAST: [1, 0], WEST: [-1, 0], NORTH: [0, -1], SOUTH: [0, 1] };
  const pins = new Map(l.nodes.flatMap((n) => n.ports.map((p) => [p.id, p])));
  const leaves = (port: string, a: Point, b: Point) => {
    const [dx, dy] = dir[pins.get(port)!.side];
    return Math.sign(b.x - a.x) === dx && Math.sign(b.y - a.y) === dy;
  };
  for (const x of l.edges)
    for (const n of l.nodes) {
      let line = x.points;
      if (n.id === x.source.node && leaves(x.source.port, line[0], line[1])) line = line.slice(1);
      if (n.id === x.target.node && line.length > 1 && leaves(x.target.port, line[line.length - 1], line[line.length - 2])) line = line.slice(0, -1);
      if ((n.id !== x.source.node && n.id !== x.target.node) || line.length < 2) continue;
      if (polylineCrowdsRect(line, n)) out.push(`${x.id} at ${n.id}`);
      for (const p of n.ports)
        if (p.id !== x.source.port && p.id !== x.target.port && x.points.some((a, i) => i > 0 && polylineHitsRect([a, x.points[i - 1]], { x: p.x - 1, y: p.y - 1, width: 2, height: 2 })))
          out.push(`${x.id} over ${p.id}`);
    }
  return out;
}

/** Pairs of wires of different nets that look connected. */
function touching(l: LayoutResult): string[] {
  const out: string[] = [];
  for (const a of l.edges)
    for (const b of l.edges) if (a.source.port < b.source.port && wiresMeet(a.points, b.points)) out.push(`${a.id} / ${b.id}`);
  return out;
}

const verticalX = (points: Point[]) => points.find((p, i) => i > 0 && p.x === points[i - 1].x)!.x;

type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const segmentBox = (p: Point, q: Point): Box => ({ x: Math.min(p.x, q.x) - 0.5, y: Math.min(p.y, q.y) - 0.5, width: Math.abs(p.x - q.x) + 1, height: Math.abs(p.y - q.y) + 1 });

/** Wire labels drawn on a symbol, on another label, or with a wire running through them. */
function labelClashes(l: LayoutResult): string[] {
  const out: string[] = [];
  const labelled = l.edges.filter((x) => x.label && x.labelBox);
  for (const x of labelled) {
    const b = x.labelBox!;
    for (const n of l.nodes) if (overlaps(b, n)) out.push(`${x.label} on ${n.id}`);
    for (const y of labelled) if (y.id > x.id && overlaps(b, y.labelBox!)) out.push(`${x.label} on ${y.label}`);
    for (const y of l.edges) if (y.points.some((q, i) => i > 0 && overlaps(b, segmentBox(y.points[i - 1], q)))) out.push(`${x.label} crossed by ${y.id}`);
  }
  return out;
}

/** Whether a label sits along its wire: just above or below one of its horizontal stretches, or beside a vertical one. */
function alongWire(b: Box, points: Point[]): boolean {
  return points.some((q, i) => {
    if (i === 0) return false;
    const p = points[i - 1];
    if (p.y === q.y) return (b.y + b.height === p.y - 3 || b.y === p.y + 3) && b.x < Math.max(p.x, q.x) && b.x + b.width > Math.min(p.x, q.x);
    return (b.x === p.x + 3 || b.x + b.width === p.x - 3) && b.y < Math.max(p.y, q.y) && b.y + b.height > Math.min(p.y, q.y);
  });
}

describe('wire labels', () => {
  const m = approxMeasure;
  const line = [
    { x: 0, y: 100 },
    { x: 300, y: 100 },
  ];

  it('goes above the wire next to its target when nothing is in the way', () => {
    const b = labelBox(line, 'data_bus', m, { nodes: [], wires: [], labels: [] });
    expect(b.x + b.width).toBe(296);
    expect(b.y + b.height).toBe(97);
  });

  it('moves along its wire, or below it, away from wires, symbols and labels in the way', () => {
    const scene = { nodes: [] as Box[], wires: [segmentBox({ x: 280, y: 0 }, { x: 280, y: 200 })], labels: [] as Box[] };
    let b = labelBox(line, 'data_bus', m, scene);
    expect(b.x + b.width).toBeLessThan(279.5);
    expect(b.y + b.height).toBe(97);
    // A symbol over the whole wire: below it.
    scene.nodes.push({ x: 0, y: 40, width: 300, height: 50 });
    b = labelBox(line, 'data_bus', m, scene);
    expect(b.y).toBe(103);
    expect(b.x + b.width).toBeLessThan(279.5);
    // And another label there too: further along.
    scene.labels.push({ ...b });
    const c = labelBox(line, 'data_bus', m, scene);
    expect(c.y).toBe(103);
    expect(c.x + c.width + 2).toBeLessThan(b.x);
  });

  it('keeps off the stretch a wire shares with others of its net, when it can', () => {
    // The wire runs along another wire of its net up to (100, 100), then turns off down to its target.
    const branch = [
      { x: 0, y: 100 },
      { x: 100, y: 100 },
      { x: 100, y: 200 },
      { x: 300, y: 200 },
    ];
    const b = labelBox(branch, 'data_bus', m, { nodes: [], wires: [], labels: [] }, 100);
    expect(b.y + b.height).toBe(197);
    // A symbol on the stretch it has to itself: beside the vertical, still past the branch.
    const c = labelBox(branch, 'data_bus', m, { nodes: [{ x: 100, y: 150, width: 200, height: 46 }], wires: [], labels: [] }, 100);
    expect(alongWire(c, branch.slice(1))).toBe(true);
    expect(c.y).toBeGreaterThan(100);
  });

  it('takes the least cluttered spot when no spot is clear', () => {
    const scene = { nodes: [{ x: -50, y: 0, width: 400, height: 96 }], wires: [segmentBox({ x: 150, y: 90 }, { x: 150, y: 300 })], labels: [] };
    // Above: on the symbol; below: crossed by the wire, unless it fits on one side of it.
    const b = labelBox(line, 'a_long_signal_name_that_does_not_fit', m, scene);
    expect(b.y).toBe(103);
  });

  it('keeps a label drawn by hand on a wire clear of the symbols, when the last stretch is too short for it', () => {
    // A counter's feedback wire round the top (F11): its last stretch into the adder is 10px long.
    const s = new Sheet([
      ['u:1', 'add', 200, 140],
      ['u:2', 'dff', 360, 140],
    ]);
    const q = s.pin('u:2.Q');
    const a = s.pin('u:1.A');
    const route = [q, { x: q.x + 10, y: q.y }, { x: q.x + 10, y: 100 }, { x: a.x - 10, y: 100 }, { x: a.x - 10, y: a.y }, a];
    const w = s.wire('u:2.Q', 'u:1.A', route);
    s.e = rename(s.e, w, 'count');
    const g = s.refresh();
    const x = g.layout.edges.find((y) => y.id === w)!;
    expect(x.points).toEqual(route);
    expect(labelClashes(g.layout)).toEqual([]);
    // Above the stretch along the top, at its end nearest the adder.
    expect(x.labelBox!.y + x.labelBox!.height).toBe(97);
    expect(x.labelBox!.x).toBe(a.x - 8);
  });

  it('stays where it is while nothing comes into its way', () => {
    const s = new Sheet([
      ['u:1', 'input', 0, 90],
      ['u:2', 'output', 400, 90],
      ['u:3', 'input', 0, 300],
      ['u:4', 'output', 400, 300],
    ]);
    const w = s.wire('u:1.out', 'u:2.in');
    s.e = rename(s.e, w, 'data_bus');
    s.refresh();
    const before = s.layout!.edges.find((y) => y.id === w)!.labelBox!;
    // A wire of another net drawn by hand through the label's spot moves it; it stays put after that.
    const v = s.wire('u:3.out', 'u:4.in', [s.pin('u:3.out'), { x: 380, y: 310 }, { x: 380, y: 60 }, { x: 390, y: 60 }, { x: 390, y: 310 }, s.pin('u:4.in')]);
    const moved = s.layout!.edges.find((y) => y.id === w)!.labelBox!;
    expect(moved).not.toEqual(before);
    expect(labelClashes(s.layout!)).toEqual([]);
    s.move(['u:3'], 0, 20);
    expect(s.layout!.edges.find((y) => y.id === v)!.points.some((p) => p.x === 380)).toBe(true);
    expect(s.layout!.edges.find((y) => y.id === w)!.labelBox).toEqual(moved);
  });

  it('does not keep an ELK box as close to another net wire as to its own (G6)', () => {
    // Two wires 20px apart; ELK put `count` under the upper one, 3px over the lower one.
    const s = new Sheet([
      ['u:1', 'input', 0, 38],
      ['u:2', 'output', 300, 38],
      ['u:3', 'input', 0, 58],
      ['u:4', 'output', 300, 58],
    ]);
    const w = s.wire('u:1.out', 'u:2.in');
    s.wire('u:3.out', 'u:4.in');
    const own = s.pin('u:1.out').y;
    const other = s.pin('u:3.out').y;
    expect(other - own).toBe(20);
    s.e = rename(s.e, w, 'count');
    const width = Math.ceil(approxMeasure('count', 11)) + 4;
    const elk = { x: 150, y: own + 4, width, height: 13 };
    expect(other - (elk.y + elk.height)).toBe(3);
    s.e = { ...s.e, routes: { ...s.e.routes, [w]: { ...s.e.routes[w], label: elk } } };
    const g = buildGeometry({ netlist: s.d, pos: s.e.pos, routes: s.e.routes, measure: approxMeasure });
    const b = g.layout.edges.find((x) => x.id === w)!.labelBox!;
    expect(b).not.toEqual(elk);
    expect(alongWire(b, s.points(w))).toBe(true);
    expect(b.y + b.height).toBe(own - 3);
    // A box that is nearer its own wire than any other stays where it is.
    const fine = { ...elk, y: own - 16 };
    s.e = { ...s.e, routes: { ...s.e.routes, [w]: { ...s.e.routes[w], label: fine } } };
    expect(buildGeometry({ netlist: s.d, pos: s.e.pos, routes: s.e.routes, measure: approxMeasure }).layout.edges.find((x) => x.id === w)!.labelBox).toEqual(fine);
  });

  it('places a label off spots as close to another net wire as to its own', () => {
    // Under the wire is clear, above it another net runs 3px over the label: below it goes.
    const other = { ...segmentBox({ x: 0, y: 81 }, { x: 300, y: 81 }), net: 'b' };
    const own = { ...segmentBox(line[0], line[1]), net: 'a' };
    const b = labelBox(line, 'data_bus', m, { nodes: [], wires: [own, other], labels: [] }, 0, 'a');
    expect(b.y).toBe(103);
    // Without knowing the nets, both are just wires that it does not cross.
    expect(labelBox(line, 'data_bus', m, { nodes: [], wires: [own, other], labels: [] }).y).toBe(84);
  });

  it('routes new wires around the slice names of a concatenation (F12)', () => {
    // Four inputs below a concatenation bar: the wires into the upper slices come up past the lower ones' names.
    const s = new Sheet([
      ['u:1', 'concat', 400, 100, { parts: 4, width: 1 }],
      ['u:2', 'input', 300, 300],
      ['u:3', 'input', 300, 340],
      ['u:4', 'input', 300, 380],
      ['u:5', 'input', 300, 420],
    ]);
    const bar = s.layout!.nodes.find((n) => n.id === 'u:1')!;
    const slices = bar.ports.filter((q) => q.side === 'WEST');
    expect(slices.map((q) => q.name)).toEqual(['[3]', '[2]', '[1]', '[0]']);
    ['u:2', 'u:3', 'u:4', 'u:5'].forEach((id, k) => s.wire(`${id}.out`, slices[3 - k].id));
    const names = slices.map((q) => sliceNameBox(bar, q)!);
    const hits = s.layout!.edges.flatMap((x) => names.filter((r) => polylineHitsRect(x.points, { x: r.x - 0.5, y: r.y - 0.5, width: r.width + 1, height: r.height + 1 })).map((r) => `${x.id} through ${JSON.stringify(r)}`));
    expect(hits).toEqual([]);
    expect(crowded(s.layout!)).toEqual([]);
  });

  it('keeps the labels of the Fruit Battle sheets off symbols, wires and each other', async () => {
    const files = { [FRUIT_FILE]: FRUIT_SOURCE };
    const d = await design(files);
    const blocks = withAutoBlocks(d, files);
    const sheets = [buildDiagram(withFlattened(d, d.top), d.top), buildDiagram(blocks, 'top/field_owner'), buildDiagram(blocks, 'top/crop_points')];
    for (const sheet of sheets) {
      const e = layoutToEdits(emptyEdits(), await layoutDiagram(sheet), 'none');
      const g = buildGeometry({ netlist: sheet, pos: e.pos, routes: e.routes, measure: approxMeasure });
      const labelled = g.layout.edges.filter((x) => x.labelBox);
      expect(labelled.length, sheet.module).toBeGreaterThan(8);
      expect(labelClashes(g.layout), sheet.module).toEqual([]);
      for (const x of labelled) expect(alongWire(x.labelBox!, x.points), `${x.label} on ${sheet.module}`).toBe(true);
    }
  }, 120_000);
});

describe('stored wires after edits', () => {
  it('routes a wire again when a symbol lands with its edge on it, or with its pins next to it', () => {
    for (const gap of [0, 10]) {
      const s = new Sheet([
        ['u:1', 'input', 0, 0],
        ['u:2', 'output', 400, 400],
        ['u:3', 'and', 600, 150],
      ]);
      const w = s.wire('u:1.out', 'u:2.in');
      const x = verticalX(s.points(w));
      // Nudged left until its input pins are on the wire (gap 0), or their stubs end on it (gap 10).
      const g = s.move(['u:3'], x + gap - 600, 0);
      expect(g.routed[w], `gap ${gap}`).toBeDefined();
      expect(crowded(g.layout)).toEqual([]);
      expect(verticalX(s.points(w))).not.toBe(x);
    }
  });

  it('routes a wire again when a symbol grows over it', () => {
    const s = new Sheet([
      ['u:1', 'and', 400, 200],
      ['u:2', 'input', 150, 245],
      ['u:3', 'output', 650, 245],
    ]);
    const w = s.wire('u:2.out', 'u:3.in');
    expect(s.points(w)).toHaveLength(2); // straight, just under the gate
    s.e = setParams(s.e, 'u:1', { inputs: 4 });
    const g = s.refresh();
    expect(g.routed[w]).toBeDefined();
    expect(crowded(g.layout)).toEqual([]);
  });

  it('routes a wire again when a symbol is placed on it', () => {
    const s = new Sheet([
      ['u:1', 'input', 0, 100],
      ['u:2', 'output', 400, 100],
    ]);
    const w = s.wire('u:1.out', 'u:2.in');
    s.e = addNodes(s.e, [{ node: newUserNode('u:3', 'and'), pos: { x: 200, y: 90 } }]);
    // Seen as new against the layout on screen, or named as moved (a symbol placed after a Verilog re-import).
    const named = buildGeometry({ netlist: s.d, pos: s.e.pos, routes: s.e.routes, measure: approxMeasure, moved: new Set(['u:3']) });
    const g = s.refresh();
    for (const x of [g, named]) {
      expect(x.routed[w]).toBeDefined();
      expect(crowded(x.layout)).toEqual([]);
    }
  });

  it('routes a wire again when its own gate grows over it', () => {
    for (const [sym, manual] of [
      ['and', false],
      ['mux', false],
      ['and', true],
    ] as const) {
      // The input sits to the right of the gate: its wire into B wraps around under the gate.
      const s = new Sheet([
        ['u:1', sym, 340, 240],
        ['u:2', 'input', 500, 280],
      ]);
      let w = s.wire('u:2.out', 'u:1.B');
      if (manual) {
        const route = s.points(w);
        s.e = { ...s.e, edges: [], routes: {} };
        w = s.wire('u:2.out', 'u:1.B', route);
      }
      const label = `${sym}${manual ? ' drawn by hand' : ''}`;
      const below = Math.max(...s.points(w).map((p) => p.y));
      expect(below, label).toBeGreaterThan(s.pin('u:1.B').y + 20);
      expect(crowdedOwn(s.layout!), label).toEqual([]);
      // Four inputs: B stays where it was, the gate now reaches down over the wire, and C and D are on it.
      s.e = setParams(s.e, 'u:1', { inputs: 4 });
      const g = s.refresh();
      expect(g.layout.nodes[0].y + g.layout.nodes[0].height, label).toBeGreaterThan(below);
      expect(g.routed[w], label).toBeDefined();
      expect(g.routed[w].manual, label).toBeUndefined();
      expect(crowdedOwn(g.layout), label).toEqual([]);
    }
  });

  it('connects wires saved before the adder and MUX outlines changed to their pins now', () => {
    // An adder was 40x40 (B at y+30, Y at y+20) and a 2:1 MUX 60x60 (select at (30, 55), Y at x+60): pins
    // that moved since. Wires saved then end where those pins were; drawn by hand or not, they now end on them.
    const old: Record<string, Point[]> = {
      'u:1.out>u:4.A': [{ x: 30, y: 110 }, { x: 200, y: 110 }],
      'u:2.out>u:4.B': [{ x: 30, y: 210 }, { x: 150, y: 210 }, { x: 150, y: 130 }, { x: 200, y: 130 }],
      'u:4.Y>u:5.A': [{ x: 240, y: 120 }, { x: 400, y: 120 }],
      'u:2.out>u:5.B': [{ x: 30, y: 210 }, { x: 380, y: 210 }, { x: 380, y: 140 }, { x: 400, y: 140 }],
      'u:3.out>u:5.S': [{ x: 30, y: 310 }, { x: 430, y: 310 }, { x: 430, y: 155 }],
      'u:5.Y>u:6.in': [{ x: 460, y: 130 }, { x: 600, y: 130 }],
    };
    for (const manual of [false, true]) {
      const s = new Sheet([
        ['u:1', 'input', 0, 100],
        ['u:2', 'input', 0, 200],
        ['u:3', 'input', 0, 300],
        ['u:4', 'add', 200, 100],
        ['u:5', 'mux', 400, 100],
        ['u:6', 'output', 600, 120],
      ]);
      const ids = Object.keys(old).map((k) => {
        const [from, to] = k.split('>');
        return [s.wire(from, to), k] as const;
      });
      // As loaded from the file: the old routes, and nothing drawn before.
      const routes = Object.fromEntries(ids.map(([id, k]) => [id, { points: old[k], ...(manual ? { manual: true } : {}) }]));
      const g = buildGeometry({ netlist: s.d, pos: s.e.pos, routes, measure: approxMeasure });
      const pins = new Map(g.layout.nodes.flatMap((n) => n.ports.map((p) => [p.id, { x: p.x, y: p.y }])));
      const label = manual ? 'drawn by hand' : 'routed';
      // The pins that moved did move (so the old routes cannot be used as they are).
      expect(pins.get('u:4.B'), label).toEqual({ x: 200, y: 150 });
      expect(pins.get('u:5.S'), label).toEqual({ x: 420, y: 160 });
      expect(pins.get('u:5.Y'), label).toEqual({ x: 440, y: 130 });
      for (const x of g.layout.edges) {
        const what = `${label}: ${x.id}`;
        expect(x.points[0], what).toEqual(pins.get(x.source.port));
        expect(x.points[x.points.length - 1], what).toEqual(pins.get(x.target.port));
        expect(orthogonal(x.points), what).toBe(true);
        for (const p of x.points) expect([p.x % 10, p.y % 10], what).toEqual([0, 0]);
      }
      expect(crowded(g.layout), label).toEqual([]);
      expect(crowdedOwn(g.layout), label).toEqual([]);
      expect(touching(g.layout), label).toEqual([]);
    }
  });

  it('routes a wire drawn by hand again when a symbol is moved, placed or pasted onto it', () => {
    const sheet = () => {
      const s = new Sheet([
        ['u:1', 'input', 20, 150],
        ['u:2', 'output', 580, 150],
        ['u:3', 'xor', 294, 380],
        ['u:4', 'not', 300, 30],
      ]);
      const a = s.pin('u:1.out');
      const b = s.pin('u:2.in');
      // Through two bends, down to y = 220 and back up.
      const route = [a, { x: a.x + 10, y: a.y }, { x: a.x + 10, y: 220 }, { x: b.x - 10, y: 220 }, { x: b.x - 10, y: b.y }, b];
      const w = s.wire('u:1.out', 'u:2.in', route);
      expect(s.points(w)).toEqual(route);
      return { s, w, route };
    };

    // A move far from it leaves it as it is.
    let { s, w, route } = sheet();
    let g = s.move(['u:4'], 40, 0);
    expect(s.points(w)).toEqual(route);
    expect(s.e.routes[w].manual).toBe(true);

    // The XOR moved up with its body and its output pin on the wire.
    g = s.move(['u:3'], 0, -180);
    expect(g.routed[w]).toBeDefined();
    expect(s.e.routes[w].manual).toBeUndefined();
    expect(crowded(g.layout)).toEqual([]);

    // Placed on it: seen as new against the layout on screen, or named as moved (placed after a Verilog re-import).
    ({ s, w } = sheet());
    s.e = addNodes(s.e, [{ node: newUserNode('u:5', 'and'), pos: { x: 300, y: 200 } }]);
    const named = buildGeometry({ netlist: s.d, pos: s.e.pos, routes: s.e.routes, measure: approxMeasure, moved: new Set(['u:5']) });
    g = s.refresh();
    for (const x of [g, named]) {
      expect(x.routed[w]).toBeDefined();
      expect(x.routed[w].manual).toBeUndefined();
      expect(crowded(x.layout)).toEqual([]);
    }

    // Pasted on it.
    ({ s, w } = sheet());
    const clip = copyNodes(s.d, s.e, s.layout!, new Set(['u:4']), noModules)!;
    [s.e] = pasteClip(s.e, clip, { x: 300, y: 210 });
    g = s.refresh();
    expect(g.routed[w]).toBeDefined();
    expect(crowded(g.layout)).toEqual([]);
  });

  it('routes a wire drawn by hand again when it is moved with its symbols onto another symbol', () => {
    const s = new Sheet([
      ['u:1', 'input', 0, 0],
      ['u:2', 'output', 400, 0],
      ['u:3', 'and', 200, 200],
    ]);
    const a = s.pin('u:1.out');
    const b = s.pin('u:2.in');
    const w = s.wire('u:1.out', 'u:2.in', [a, { x: a.x + 10, y: a.y }, { x: a.x + 10, y: 40 }, { x: b.x - 10, y: 40 }, { x: b.x - 10, y: b.y }, b]);
    const g = s.move(['u:1', 'u:2'], 0, 180);
    expect(g.routed[w]).toBeDefined();
    expect(crowded(g.layout)).toEqual([]);
  });

  it('keeps a stretched wire drawn by hand leaving and entering its pins on a stub', () => {
    const sheet = () => {
      const s = new Sheet([
        ['u:1', 'and', 240, 240],
        ['u:2', 'output', 540, 250],
        ['u:3', 'not', 500, 290],
      ]);
      const y = s.pin('u:1.Y');
      const i = s.pin('u:2.in');
      // Out of Y, up over the gate, across and down into the output.
      const route = [y, { x: y.x + 10, y: y.y }, { x: y.x + 10, y: 140 }, { x: i.x - 10, y: 140 }, { x: i.x - 10, y: i.y }, i];
      return { s, w: s.wire('u:1.Y', 'u:2.in', route) };
    };
    const stub = (from: Point, to: Point, dx: number) => to.y === from.y && (to.x - from.x) * dx >= 10;
    for (const [id, dx, dy] of [
      ['u:1', 20, 0],
      ['u:1', 20, 40],
      ['u:1', 0, -150],
      ['u:2', -20, 0],
    ] as const) {
      const { s, w } = sheet();
      const g = s.move([id], dx, dy);
      const p = s.points(w);
      const label = `${id} by ${dx}, ${dy}: ${JSON.stringify(p)}`;
      expect(g.routed[w]?.manual, label).toBe(true);
      // Still through the bend the user made above the gate.
      expect(p.some((q) => q.y === 140), label).toBe(true);
      expect(stub(p[0], p[1], 1), label).toBe(true);
      expect(stub(p[p.length - 1], p[p.length - 2], -1), label).toBe(true);
      expect(crowdedOwn(g.layout), label).toEqual([]);
    }
    // Stretched down onto the NOT gate below the output: routed again.
    const { s, w } = sheet();
    const g = s.move(['u:2'], 0, 100);
    expect(g.routed[w]).toBeDefined();
    expect(g.routed[w].manual).toBeUndefined();
    expect(crowded(g.layout)).toEqual([]);
  });

  it('checks a wire moved along with both of its symbols against the symbols and wires it now meets', () => {
    // Moved onto a gate that stays.
    const s = new Sheet([
      ['u:1', 'input', 0, 0],
      ['u:2', 'output', 400, 0],
      ['u:3', 'and', 200, 200],
    ]);
    const w = s.wire('u:1.out', 'u:2.in');
    const g = s.move(['u:1', 'u:2'], 0, 210);
    expect(g.routed[w]).toBeDefined();
    expect(crowded(g.layout)).toEqual([]);

    // Moved onto another net's wire: only the moved one is routed again.
    const t = new Sheet([
      ['u:1', 'input', 0, 0],
      ['u:2', 'output', 600, 400],
      ['u:3', 'input', 0, 600],
      ['u:4', 'output', 300, 700],
    ]);
    const a = t.wire('u:1.out', 'u:2.in');
    const b = t.wire('u:3.out', 'u:4.in');
    const h = t.move(['u:3', 'u:4'], verticalX(t.points(a)) - verticalX(t.points(b)), -450);
    expect(h.routed[a]).toBeUndefined();
    expect(h.routed[b]).toBeDefined();
    expect(touching(h.layout)).toEqual([]);
  });

  it('routes a branch again with the wire it branched off when that wire is routed to a moved symbol', () => {
    const s = new Sheet([
      ['u:1', 'or', 140, 140],
      ['u:2', 'nand', 340, 80],
      ['u:3', 'output', 360, 310],
    ]);
    const trunk = s.wire('u:1.Y', 'u:2.B');
    const branch = s.wire('u:1.Y', 'u:3.in');
    // The branch follows the trunk up toward the NAND before it turns down to the output.
    expect(runTogether(s.points(branch), s.points(trunk)).len).toBeGreaterThan(100);
    expect(Math.min(...s.points(branch).map((p) => p.y))).toBeLessThan(150);
    // Drag the NAND down: previews while dragging, then the drop.
    s.preview(['u:2'], 0, 70);
    s.preview(['u:2'], 0, 150);
    const g = s.move(['u:2'], 0, 150);
    expect(g.routed[trunk]).toBeDefined();
    expect(g.routed[branch]).toBeDefined();
    // Nothing goes up to where the NAND was any more.
    for (const id of [trunk, branch]) expect(Math.min(...s.points(id).map((p) => p.y))).toBeGreaterThanOrEqual(160);
    expect(g.layout.edges.flatMap((x) => x.junctions)).toHaveLength(1);
  });

  it('draws the earlier wires as they were when an edit is undone', () => {
    const s = new Sheet([
      ['u:1', 'or', 140, 140],
      ['u:2', 'nand', 340, 80],
      ['u:3', 'output', 360, 310],
    ]);
    s.wire('u:1.Y', 'u:2.B');
    s.wire('u:1.Y', 'u:3.in');
    const before = s.e;
    const drawn = s.layout!.edges.map((x) => x.points);
    s.move(['u:2'], 0, 150);
    s.e = before;
    const g = s.refresh();
    expect(g.routed).toEqual({});
    expect(g.layout.edges.map((x) => x.points)).toEqual(drawn);
  });

  it('does not route a wire along the wire of another net far away', () => {
    // A wall of three tall symbols: the second wire has to go around it, over the first wire.
    const s = new Sheet([
      ['u:1', 'concat', 400, 0, { parts: 16, width: 1 }],
      ['u:2', 'concat', 400, 320, { parts: 16, width: 1 }],
      ['u:3', 'concat', 400, 640, { parts: 16, width: 1 }],
      ['u:4', 'input', 100, -20],
      ['u:5', 'output', 800, -20],
      ['u:6', 'input', 100, 420],
      ['u:7', 'output', 800, 420],
    ]);
    const a = s.wire('u:4.out', 'u:5.in');
    const b = s.wire('u:6.out', 'u:7.in');
    expect(wiresMeet(s.points(b), s.points(a))).toBe(false);
    expect(crowded(s.layout!)).toEqual([]);
  });

  it('keeps the stubs of pins not wired yet clear, so later wires do not meet earlier ones there', () => {
    const s = new Sheet([
      ['u:1', 'input', 40, 340],
      ['u:2', 'not', 510, 170],
      ['u:3', 'not', 320, 180],
      ['u:4', 'output', 310, 40],
      ['u:5', 'not', 600, 160],
      ['u:6', 'output', 380, 340],
    ]);
    s.wire('u:1.out', 'u:2.A');
    s.wire('u:5.Y', 'u:6.in');
    s.wire('u:3.Y', 'u:4.in');
    expect(touching(s.layout!)).toEqual([]);
    expect(s.layout!.edges.flatMap((x) => x.junctions)).toEqual([]);
  });

  it('places a renamed label from its new text', () => {
    const s = new Sheet([
      ['u:1', 'input', 0, 0],
      ['u:2', 'output', 300, 100],
    ]);
    const w = s.wire('u:1.out', 'u:2.in');
    s.e = rename(s.e, w, 'a');
    s.refresh();
    s.move(['u:2'], 0, 40); // routes the wire again, which stores its label box
    expect(s.e.routes[w].label).toBeDefined();
    s.e = rename(s.e, w, 'a_much_longer_signal_name');
    const g = s.refresh();
    const x = g.layout.edges.find((y) => y.id === w)!;
    expect(x.labelBox).toEqual(labelBox(x.points, 'a_much_longer_signal_name', approxMeasure));
    // It ends before the pin, and the sheet's bounds (the exported picture) take it in.
    expect(x.labelBox!.x + x.labelBox!.width).toBeLessThanOrEqual(x.points[x.points.length - 1].x);
    expect(x.labelBox!.x).toBeGreaterThanOrEqual(g.layout.x!);
  });

  it('keeps wires off symbols as random groups of symbols move', () => {
    const syms: SymKey[] = ['input', 'output', 'and', 'or', 'xor', 'not', 'add', 'mux', 'dff', 'eq', 'concat', 'split'];
    let seed = 7;
    const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
    for (let sheet = 0; sheet < 25; sheet++) {
      const items: [string, SymKey, number, number][] = [];
      for (let k = 0; k < 40 && items.length < 10; k++) {
        const [x, y] = [Math.round(rnd() * 80) * 10, Math.round(rnd() * 50) * 10];
        if (items.every(([, , u, v]) => Math.abs(u - x) > 110 || Math.abs(v - y) > 110)) items.push([`u:${items.length + 1}`, syms[Math.floor(rnd() * syms.length)], x, y]);
      }
      const s = new Sheet(items);
      const d = s.d;
      const outs = d.nodes.flatMap((n) => n.ports.filter((p) => p.dir === 'out').map((p) => p.id));
      for (const n of d.nodes) for (const p of n.ports) if (p.dir === 'in' && outs.length && rnd() < 0.7) s.wire(outs[Math.floor(rnd() * outs.length)], p.id);
      for (let step = 0; step < 6; step++) {
        const ids = d.nodes.filter(() => rnd() < 0.2).map((n) => n.id);
        const [dx, dy] = [Math.round((rnd() - 0.5) * 30) * 10, Math.round((rnd() - 0.5) * 30) * 10];
        // Only moves that leave the symbols apart: no wire keeps clear of symbols on top of each other.
        const placed = s.layout!.nodes.map((n) => (ids.includes(n.id) ? { ...n, x: n.x + dx, y: n.y + dy } : n));
        const apart = placed.every((a, i) =>
          placed.every((b, j) => i === j || a.x > b.x + b.width + 30 || b.x > a.x + a.width + 30 || a.y > b.y + b.height + 30 || b.y > a.y + a.height + 30),
        );
        if (!ids.length || !apart) continue;
        const g = s.move(ids, dx, dy);
        const near = g.layout.edges.flatMap((x) =>
          g.layout.nodes
            .filter((n) => n.id !== x.source.node && n.id !== x.target.node)
            .filter((n) => polylineHitsRect(x.points, { x: n.x - 1, y: n.y - 1, width: n.width + 2, height: n.height + 2 }))
            .map((n) => `${x.id} at ${n.id}`),
        );
        expect(near, `sheet ${sheet} step ${step}`).toEqual([]);
      }
    }
  });
});
