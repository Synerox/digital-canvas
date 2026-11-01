import { describe, expect, it } from 'vitest';
import { buildDiagram } from '../core/diagram';
import { design } from '../core/test-utils';
import { AUCTION_FILE, AUCTION_SOURCE } from '../examples/auction';
import { type LayoutResult, type Point, approxMeasure, layoutDiagram } from '../layout/elk-layout';
import { type SheetEdits, emptyEdits } from './doc';
import { buildGeometry, labelBox, runTogether } from './geometry';
import { polylineCrowdsRect, polylineHitsRect, wiresMeet } from './router';
import { addNodes, connect, effectiveDiagram, layoutToEdits, moveNodes, rename, resolveConnection, setParams } from './sheet';
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
  });

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

  wire(from: string, to: string): string {
    const c = resolveConnection(this.d, { kind: 'port', node: from.split('.')[0], port: from }, { kind: 'port', node: to.split('.')[0], port: to });
    if ('error' in c) throw new Error(c.error);
    let id: string;
    [id, this.e] = connect(this.e, c);
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
}

/** Wires that come closer to a symbol other than their own two than the router keeps them (along its edge, through its pins). */
function crowded(l: LayoutResult): string[] {
  const out: string[] = [];
  for (const x of l.edges)
    for (const n of l.nodes) if (n.id !== x.source.node && n.id !== x.target.node && polylineCrowdsRect(x.points, n)) out.push(`${x.id} at ${n.id}`);
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
