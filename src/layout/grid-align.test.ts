import { describe, expect, it } from 'vitest';
import { buildDiagram } from '../core/diagram';
import { withAutoBlocks } from '../core/partition';
import { design } from '../core/test-utils';
import { AUCTION_FILE, AUCTION_SOURCE } from '../examples/auction';
import { FRUIT_FILE, FRUIT_SOURCE } from '../examples/fruit-battle';
import { GRID, type LayoutResult, type Point, layoutDiagram } from './elk-layout';
import { onGrid } from './grid-align';

const onTheGrid = (v: number) => Math.abs(v - Math.round(v / GRID) * GRID) < 0.01;

/**
 * What is wrong with the wires of a layout: ends off their pins, slanted legs, points off the grid and
 * legs shorter than a grid step (the small steps and gaps the eye catches). A pin that is off the grid
 * itself (a MUX's select, on its sloped side) may take the legs that end on it off the grid too.
 */
function problems(l: LayoutResult): string[] {
  const out: string[] = [];
  const pins = new Map<string, Point>();
  for (const n of l.nodes) {
    if (!onTheGrid(n.x) || !onTheGrid(n.y)) out.push(`${n.id} at ${n.x},${n.y}`);
    for (const p of n.ports) pins.set(p.id, p);
  }
  for (const e of l.edges) {
    const s = pins.get(e.source.port)!;
    const t = pins.get(e.target.port)!;
    const pts = e.points;
    const a = pts[0];
    const z = pts[pts.length - 1];
    if (Math.hypot(a.x - s.x, a.y - s.y) > 0.01) out.push(`${e.id} starts off its pin`);
    if (Math.hypot(z.x - t.x, z.y - t.y) > 0.01) out.push(`${e.id} ends off its pin`);
    const offPin = (q: Point) => (!onTheGrid(s.x) || !onTheGrid(s.y) ? q.x === s.x || q.y === s.y : false) || (!onTheGrid(t.x) || !onTheGrid(t.y) ? q.x === t.x || q.y === t.y : false);
    for (let i = 1; i < pts.length; i++) {
      const u = pts[i - 1];
      const v = pts[i];
      const dx = Math.abs(u.x - v.x);
      const dy = Math.abs(u.y - v.y);
      if (dx > 0.01 && dy > 0.01) out.push(`${e.id} leg ${i} is slanted`);
      const len = dx + dy;
      if (len > 0.01 && len < GRID - 0.01 && !offPin(u) && !offPin(v)) out.push(`${e.id} leg ${i} is ${len.toFixed(1)} px`);
    }
    for (const q of pts) if ((!onTheGrid(q.x) || !onTheGrid(q.y)) && !offPin(q)) out.push(`${e.id} point ${q.x},${q.y} off the grid`);
  }
  return out;
}

describe('layouts on the grid', () => {
  it('puts every symbol and wire of the examples on the grid, with no small steps', async () => {
    let wires = 0;
    for (const [file, source] of [
      [AUCTION_FILE, AUCTION_SOURCE],
      [FRUIT_FILE, FRUIT_SOURCE],
    ]) {
      const flat = await design({ [file]: source });
      const blocks = withAutoBlocks(flat, { [file]: source });
      for (const d of [flat, blocks]) {
        for (const m of Object.keys(d.modules)) {
          const l = await layoutDiagram(buildDiagram(d, m));
          expect(problems(l), `${file} ${m}`).toEqual([]);
          wires += l.edges.length;
        }
      }
    }
    expect(wires).toBeGreaterThan(200);
  }, 120_000);
});

describe('onGrid', () => {
  const snap = (v: number) => Math.round(v / GRID) * GRID;
  it('moves a route along with pins that moved onto the grid', () => {
    // From a pin at (103,47) to one at (296,152), both moved to the grid: (100,50) and (300,150).
    const r = onGrid(
      [
        { x: 103, y: 47 },
        { x: 197, y: 47 },
        { x: 197, y: 152 },
        { x: 296, y: 152 },
      ],
      { point: { x: 100, y: 50 }, side: 'EAST', rect: { x: 60, y: 30, width: 40, height: 40 } },
      { point: { x: 300, y: 150 }, side: 'WEST', rect: { x: 300, y: 130, width: 40, height: 40 } },
      { x: 103, y: 47 },
      { x: 296, y: 152 },
      snap,
    );
    expect(r).toEqual([
      { x: 100, y: 50 },
      { x: 200, y: 50 },
      { x: 200, y: 150 },
      { x: 300, y: 150 },
    ]);
  });
});
