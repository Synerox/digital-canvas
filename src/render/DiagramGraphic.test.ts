import { describe, expect, it } from 'vitest';
import type { DNode } from '../core/diagram';
import { buildGeometry } from '../editor/geometry';
import { type UserNode, symbolNode } from '../editor/symbols';
import { type LEdge, type LNode, type LayoutResult, type Point, approxMeasure } from '../layout/elk-layout';
import { exportSvg } from './export';
import { THEMES } from './theme';

interface Text {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

const unescape = (s: string) => s.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&').replace(/&#x27;/g, "'");

/** Every text the SVG draws, with the box it covers (the same rough metrics the renderer uses). */
function texts(svg: string): Text[] {
  const out: Text[] = [];
  for (const m of svg.matchAll(/<text([^>]*)>([^<]*)<\/text>/g)) {
    const attr = (k: string) => new RegExp(`\\s${k}="([^"]*)"`).exec(m[1])?.[1];
    const size = Number(attr('font-size'));
    const text = unescape(m[2]);
    const width = approxMeasure(text, size);
    const x = Number(attr('x'));
    const anchor = attr('text-anchor') ?? 'start';
    const left = anchor === 'end' ? x - width : anchor === 'middle' ? x - width / 2 : x;
    out.push({ text, x: left, y: Number(attr('y')) - size * 0.78, width, height: size * 0.88 });
  }
  return out;
}

const overlap = (a: Text, b: { x: number; y: number; width: number; height: number }) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Pairs of texts that overlap. */
function clashes(list: Text[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) if (overlap(list[i], list[j])) out.push(`${list[i].text} / ${list[j].text}`);
  return out;
}

/** Texts a wire segment runs through. */
function crossed(list: Text[], edges: LEdge[]): string[] {
  const out: string[] = [];
  for (const e of edges) {
    for (let i = 1; i < e.points.length; i++) {
      const [a, b] = [e.points[i - 1], e.points[i]];
      const seg = { x: Math.min(a.x, b.x) - 0.5, y: Math.min(a.y, b.y) - 0.5, width: Math.abs(a.x - b.x) + 1, height: Math.abs(a.y - b.y) + 1 };
      for (const t of list) if (overlap(t, seg)) out.push(`${e.id} through ${t.text}`);
    }
  }
  return out;
}

const port = (id: string, name: string, side: 'WEST' | 'EAST' | 'SOUTH', dir: 'in' | 'out', width: number, at: Point) => ({ id, name, side, dir, width, ...at });

function edge(id: string, from: string, to: string, width: number, points: Point[], extra: Partial<LEdge> = {}): LEdge {
  return { id, source: { node: from.split('.')[0], port: from }, target: { node: to.split('.')[0], port: to }, width, fullSource: true, points, junctions: [], ...extra };
}

function layout(nodes: LNode[], edges: LEdge[]): LayoutResult {
  return { module: 't', x: 0, y: 0, width: 600, height: 300, nodes, edges };
}

describe('width marks and slice names', () => {
  // A split whose upper slice turns up right after the bar and whose lower slice turns down (N19).
  const split: LNode = {
    id: 's',
    kind: 'split',
    label: '}{',
    src: [],
    x: 250,
    y: 100,
    width: 6,
    height: 40,
    ports: [port('s.in', 'in', 'WEST', 'in', 8, { x: 250, y: 120 }), port('s.[7:4]', '[7:4]', 'EAST', 'out', 4, { x: 256, y: 110 }), port('s.[3:0]', '[3:0]', 'EAST', 'out', 4, { x: 256, y: 130 })],
  };
  const pin = (id: string, kind: 'input' | 'output', x: number, y: number, width: number): LNode => ({
    id,
    kind,
    label: id,
    src: [],
    x,
    y,
    width: 40,
    height: 20,
    ports: [kind === 'input' ? port(`${id}.out`, 'out', 'EAST', 'out', width, { x: x + 40, y: y + 10 }) : port(`${id}.in`, 'in', 'WEST', 'in', width, { x, y: y + 10 })],
  });

  it('keeps marks and slice names off each other and off the wires that leave a split', () => {
    const nodes = [pin('a', 'input', 100, 110, 8), split, pin('hi', 'output', 450, 60, 4), pin('lo', 'output', 450, 160, 4)];
    const edges = [
      edge('a.out>s.in', 'a.out', 's.in', 8, [{ x: 140, y: 120 }, { x: 250, y: 120 }]),
      edge('s.[7:4]>hi.in', 's.[7:4]', 'hi.in', 4, [{ x: 256, y: 110 }, { x: 266, y: 110 }, { x: 266, y: 70 }, { x: 450, y: 70 }]),
      edge('s.[3:0]>lo.in', 's.[3:0]', 'lo.in', 4, [{ x: 256, y: 130 }, { x: 266, y: 130 }, { x: 266, y: 170 }, { x: 450, y: 170 }]),
    ];
    const list = texts(exportSvg(layout(nodes, edges), THEMES.report));
    expect(list.map((t) => t.text).sort()).toEqual(['4', '4', '8', '[3:0]', '[7:4]', 'a', 'hi', 'lo']);
    expect(clashes(list)).toEqual([]);
    // No wire runs through a slice name or a width; the upper name moved past its wire's bend.
    expect(crossed(list, edges)).toEqual([]);
    const upper = list.find((t) => t.text === '[7:4]')!;
    expect(upper.x).toBeGreaterThan(266);
    expect(upper.y + upper.height).toBeLessThan(110);
  });

  it('keeps the mark of a slice clear of the wire label at its end', () => {
    // A 3-bit slice of a wider bus, labelled where the mark goes by default (the C/N19 'workers_a[2:03' case).
    const nodes = [pin('a', 'input', 100, 110, 12), pin('y', 'output', 400, 110, 3)];
    const label = 'workers_a[2:0]';
    const w = Math.ceil(approxMeasure(label, 11)) + 4;
    const edges = [
      edge('a.out>y.in', 'a.out', 'y.in', 3, [{ x: 140, y: 120 }, { x: 400, y: 120 }], {
        fullSource: false,
        bits: { lo: 0, width: 3 },
        label,
        labelBox: { x: 396 - w, y: 106, width: w, height: 13 },
      }),
    ];
    const list = texts(exportSvg(layout(nodes, edges), THEMES.report));
    expect(list.map((t) => t.text).sort()).toEqual(['3', 'a', label, 'y']);
    expect(clashes(list)).toEqual([]);
    expect(crossed(list, edges)).toEqual([]);
  });

  it('keeps marks and names apart on a split drawn and routed in the editor', () => {
    const iface = () => undefined;
    const u = (id: string, sym: UserNode['sym'], params: UserNode['params'], name?: string): DNode => symbolNode({ id, sym, params, name }, iface);
    const nodes = [u('u:1', 'input', { width: 8 }, 'a'), u('u:2', 'split', { parts: 2, width: 4 }), u('u:3', 'output', { width: 4 }, 'hi'), u('u:4', 'output', { width: 4 }, 'lo')];
    const port = (n: DNode, name: string) => n.ports.find((p) => p.name === name)!.id;
    const wire = (id: string, a: DNode, pa: string, b: DNode, pb: string, width: number) => ({
      id,
      source: { node: a.id, port: port(a, pa) },
      target: { node: b.id, port: port(b, pb) },
      width,
      fullSource: true,
    });
    const netlist = {
      module: 't',
      nodes,
      edges: [wire('w:1', nodes[0], 'out', nodes[1], 'in', 8), wire('w:2', nodes[1], '[7:4]', nodes[2], 'in', 4), wire('w:3', nodes[1], '[3:0]', nodes[3], 'in', 4)],
    };
    const pos = { 'u:1': { x: 80, y: 100 }, 'u:2': { x: 250, y: 100 }, 'u:3': { x: 450, y: 60 }, 'u:4': { x: 450, y: 160 } };
    const { layout: l } = buildGeometry({ netlist, pos, routes: {}, measure: approxMeasure });
    const list = texts(exportSvg(l, THEMES.report));
    expect(clashes(list)).toEqual([]);
    expect(crossed(list, l.edges)).toEqual([]);
  });
});

describe('registers', () => {
  it('names the enable and reset pins, so a register with an enable and one with a reset look different', () => {
    const iface = () => undefined;
    const draw = (sym: 'dffe' | 'adff') => {
      const n = symbolNode({ id: 'u:1', sym, params: { width: 4 } }, iface);
      const { layout: l } = buildGeometry({ netlist: { module: 't', nodes: [n], edges: [] }, pos: { 'u:1': { x: 100, y: 100 } }, routes: {}, measure: approxMeasure });
      return texts(exportSvg(l, THEMES.report)).map((t) => t.text);
    };
    expect(draw('dffe')).toContain('EN');
    expect(draw('dffe')).not.toContain('ARST');
    expect(draw('adff')).toContain('ARST');
    expect(draw('adff')).not.toContain('EN');
  });
});
