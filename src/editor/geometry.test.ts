import { describe, expect, it } from 'vitest';
import { buildDiagram } from '../core/diagram';
import { design } from '../core/test-utils';
import { AUCTION_FILE, AUCTION_SOURCE } from '../examples/auction';
import { approxMeasure, layoutDiagram } from '../layout/elk-layout';
import { emptyEdits } from './doc';
import { buildGeometry } from './geometry';
import { polylineHitsRect } from './router';
import { addNodes, connect, effectiveDiagram, layoutToEdits, moveNodes, resolveConnection } from './sheet';
import { type InterfaceOf, newUserNode } from './symbols';

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
