import { describe, expect, it } from 'vitest';
import { type LEdge, type LNode, type LayoutResult, approxMeasure } from '../layout/elk-layout';
import { sliceNameBox } from '../editor/geometry';
import { exportSvg } from './export';
import { THEME } from './theme';

const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

function layout(nodes: LNode[], edges: LEdge[]): LayoutResult {
  return { module: 't', x: 0, y: 0, width: 600, height: 300, nodes, edges };
}

/** The x and y of the text element that writes `text`. */
function textAt(svg: string, text: string): { x: number; y: number } {
  const m = new RegExp(`<text([^>]*)>${text.replace(/[[\]]/g, '\\$&')}</text>`).exec(svg)!;
  const attr = (k: string) => Number(new RegExp(`\\s${k}="([^"]*)"`).exec(m[1])![1]);
  return { x: attr('x'), y: attr('y') };
}

describe('wire labels', () => {
  const pin = (id: string, kind: 'input' | 'output', x: number, y: number, width: number): LNode => ({
    id,
    kind,
    label: id,
    x,
    y,
    width: 40,
    height: 20,
    ports: [
      kind === 'input'
        ? { id: `${id}.out`, name: 'out', side: 'EAST', dir: 'out', width, x: x + 40, y: y + 10 }
        : { id: `${id}.in`, name: 'in', side: 'WEST', dir: 'in', width, x, y: y + 10 },
    ],
  });
  const wire = (id: string, from: string, to: string, points: { x: number; y: number }[], extra: Partial<LEdge> = {}): LEdge => ({
    id,
    source: { node: from.split('.')[0], port: from },
    target: { node: to.split('.')[0], port: to },
    width: 1,
    fullSource: true,
    points,
    junctions: [],
    ...extra,
  });

  it('are drawn over the symbols, with a rim of background over what is behind them, and let clicks through', () => {
    // Where no clear spot was left, the text stays readable rather than hidden under the symbol.
    const nodes = [pin('a', 'input', 100, 110, 1), pin('y', 'output', 300, 110, 1)];
    const edges = [wire('a.out>y.in', 'a.out', 'y.in', [{ x: 140, y: 120 }, { x: 300, y: 120 }], { label: 'busy', labelBox: box(280, 104, 30, 13) })];
    const svg = exportSvg(layout(nodes, edges), THEME);
    expect(svg.indexOf('>busy</text>')).toBeGreaterThan(svg.lastIndexOf('<polygon'));
    expect(svg).toMatch(/<g pointer-events="none"><text[^>]*stroke="#ffffff"[^>]*paint-order="stroke"[^>]*>busy</);
  });

  it('keep the slice names of a split off them', () => {
    // A split whose upper slice carries a label right where that slice's name goes.
    const split: LNode = {
      id: 's',
      kind: 'split',
      label: '}{',
      x: 250,
      y: 100,
      width: 10,
      height: 40,
      ports: [
        { id: 's.in', name: 'in', side: 'WEST', dir: 'in', width: 8, x: 250, y: 120 },
        { id: 's.[7:4]', name: '[7:4]', side: 'EAST', dir: 'out', width: 4, x: 260, y: 110 },
        { id: 's.[3:0]', name: '[3:0]', side: 'EAST', dir: 'out', width: 4, x: 260, y: 130 },
      ],
    };
    const nodes = [pin('a', 'input', 100, 110, 8), split, pin('hi', 'output', 450, 100, 4), pin('lo', 'output', 450, 120, 4)];
    const label = 'high_nibble';
    const w = Math.ceil(approxMeasure(label, 11)) + 4;
    const edges = [
      wire('a.out>s.in', 'a.out', 's.in', [{ x: 140, y: 120 }, { x: 250, y: 120 }], { width: 8 }),
      wire('s.[7:4]>hi.in', 's.[7:4]', 'hi.in', [{ x: 260, y: 110 }, { x: 450, y: 110 }], { width: 4, label, labelBox: box(262, 94, w, 13) }),
      wire('s.[3:0]>lo.in', 's.[3:0]', 'lo.in', [{ x: 260, y: 130 }, { x: 450, y: 130 }], { width: 4 }),
    ];
    const svg = exportSvg(layout(nodes, edges), THEME);
    // Below its wire instead of above it, under the label.
    expect(textAt(svg, '[7:4]').y).toBeGreaterThan(110);
  });

  it('write slice names where the router keeps wires off them, when nothing is in the way', () => {
    // sliceNameBox (the sheet geometry's copy of the usual spot) and placeSliceNames must agree.
    const port = (id: string, name: string, side: 'WEST' | 'EAST', x: number, y: number) =>
      ({ id, name, side, dir: side === 'WEST' ? 'in' : 'out', width: 4, x, y }) as const;
    const split: LNode = {
      id: 's',
      kind: 'split',
      label: '}{',
      x: 250,
      y: 100,
      width: 10,
      height: 40,
      ports: [port('s.in', 'in', 'WEST', 250, 120), port('s.[7:4]', '[7:4]', 'EAST', 260, 110), port('s.[3:0]', '[3:0]', 'EAST', 260, 130)],
    };
    const join: LNode = {
      id: 'j',
      kind: 'join',
      label: '{ }',
      x: 450,
      y: 100,
      width: 10,
      height: 40,
      ports: [port('j.[15:12]', '[15:12]', 'WEST', 450, 110), port('j.[11:8]', '[11:8]', 'WEST', 450, 130), port('j.out', 'out', 'EAST', 460, 120)],
    };
    const svg = exportSvg(layout([split, join], []), THEME);
    for (const n of [split, join])
      for (const q of n.ports) {
        const b = sliceNameBox(n, q);
        if (!b) continue;
        const t = textAt(svg, q.name);
        expect(n.kind === 'split' ? b.x : b.x + b.width, q.name).toBeCloseTo(t.x, 6);
        expect(b.y + 9 * 0.78, q.name).toBeCloseTo(t.y, 6);
      }
    expect(sliceNameBox(split, split.ports[0])).toBeUndefined();
    expect(sliceNameBox(join, join.ports[2])).toBeUndefined();
  });
});
