import { describe, expect, it } from 'vitest';
import type { DNode } from '../core/diagram';
import { buildGeometry } from '../editor/geometry';
import { type SymKey, type SymParams, type UserNode, newUserNode, symbolNode } from '../editor/symbols';
import { type LEdge, type LNode, type LayoutResult, type Point, approxMeasure } from '../layout/elk-layout';
import { exportSvg } from './export';
import { THEME } from './theme';

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
    const list = texts(exportSvg(layout(nodes, edges), THEME));
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
    const list = texts(exportSvg(layout(nodes, edges), THEME));
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
    const list = texts(exportSvg(l, THEME));
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
      return texts(exportSvg(l, THEME)).map((t) => t.text);
    };
    expect(draw('dffe')).toContain('EN');
    expect(draw('dffe')).not.toContain('ARST');
    expect(draw('adff')).toContain('ARST');
    expect(draw('adff')).not.toContain('EN');
  });
});

describe('textbook symbols', () => {
  const iface = () => undefined;
  /** One symbol drawn on the grid at (100, 100), its pins, and the SVG it draws. */
  const draw = (sym: SymKey, params: SymParams = {}) => {
    const u = newUserNode('u:1', sym);
    const n = symbolNode({ ...u, params: { ...u.params, ...params } }, iface);
    const { layout: l } = buildGeometry({ netlist: { module: 't', nodes: [n], edges: [] }, pos: { 'u:1': { x: 100, y: 100 } }, routes: {}, measure: approxMeasure });
    const node = l.nodes[0];
    const pin = (name: string) => node.ports.find((q) => q.name === name)!;
    return { node, pin, svg: exportSvg(l, THEME) };
  };
  const polygon = (svg: string): Point[] =>
    /<polygon points="([^"]+)"/
      .exec(svg)![1]
      .trim()
      .split(/\s+/)
      .map((p) => {
        const [x, y] = p.split(',').map(Number);
        return { x, y };
      });
  const lines = (svg: string) => [...svg.matchAll(/<line x1="([^"]+)" y1="([^"]+)" x2="([^"]+)" y2="([^"]+)"/g)].map((m) => m.slice(1, 5).map(Number));

  it('draws an adder as an ALU, its operands coming in above and below the notch', () => {
    const { node, pin, svg } = draw('add');
    expect([node.width, node.height]).toEqual([40, 60]);
    const [a, b, y] = [pin('A'), pin('B'), pin('Y')];
    expect([a.x, a.y, b.x, b.y, y.x, y.y]).toEqual([100, 110, 100, 150, 140, 130]);
    // Left edge (0,0)-(0,h): broken by the notch; right edge a quarter of the height in from top and bottom.
    const pts = polygon(svg);
    expect(pts).toHaveLength(7);
    const notch = pts.filter((p) => p.x === 100 && p.y > 100 && p.y < 160).map((p) => p.y);
    expect(notch).toHaveLength(2);
    // Each operand meets the straight part of the left edge, clear of the notch.
    expect(a.y).toBeLessThan(Math.min(...notch) - 5);
    expect(b.y).toBeGreaterThan(Math.max(...notch) + 5);
    expect(pts).toContainEqual({ x: 140, y: 115 });
    expect(pts).toContainEqual({ x: 140, y: 145 });
    expect(texts(svg).map((t) => t.text)).toEqual(['+']);
  });

  it('draws a MUX narrowing towards its output, with the select pin on the grid joined to its sloped edge', () => {
    for (const inputs of [2, 4, 8]) {
      const { node, pin, svg } = draw('mux', { inputs });
      expect(node.width, `${inputs}`).toBe(40);
      const s = pin('S');
      expect([s.x % 10, s.y % 10, s.y], `${inputs}`).toEqual([0, 0, node.y + node.height]);
      const [tl, tr, br, bl] = polygon(svg);
      expect([tl, bl]).toEqual([
        { x: 100, y: 100 },
        { x: 100, y: 100 + node.height },
      ]);
      // The output edge is clearly shorter (a 2:1 MUX's is half as long), but never under half a MUX of many inputs.
      const drop = tr.y - tl.y;
      expect(drop, `${inputs}`).toBe(inputs === 2 ? 15 : 20);
      expect(br.y - tr.y).toBe(node.height - 2 * drop);
      // The select lead runs from the sloped bottom edge straight down to the pin.
      const slope = bl.y - ((bl.y - br.y) * (s.x - bl.x)) / (br.x - bl.x);
      expect(lines(svg)).toContainEqual([s.x, slope, s.x, s.y]);
      expect(texts(svg).map((t) => t.text)).toEqual(Array.from({ length: inputs }, (_, k) => String(k)));
    }
  });

  it('keeps a gate with many inputs in shape, its back edge running on to the outer inputs', () => {
    const sizes = (inputs: number) => {
      const { node } = draw('and', { inputs });
      return [node.width, node.height];
    };
    expect([2, 3, 4, 5, 8, 32].map(sizes)).toEqual([
      [40, 40],
      [50, 60],
      [60, 80],
      [60, 100],
      [60, 160],
      [60, 640],
    ]);
    for (const sym of ['and', 'or', 'xor', 'nand', 'nor', 'xnor'] as const) {
      for (const inputs of [2, 4, 5, 6, 8]) {
        const { node, svg } = draw(sym, { inputs });
        const ins = node.ports.filter((q) => q.side === 'WEST').map((q) => q.y);
        const back = lines(svg).filter(([x1, y1, x2, y2]) => x1 === node.x && x2 === node.x && y1 !== y2);
        // Above and below a body four inputs tall (five for an odd count), the outer inputs end on a straight back edge.
        const body = inputs <= 4 ? node.height : inputs % 2 ? 100 : 80;
        const top = node.y + (node.height - body) / 2;
        expect(back.length, `${sym} ${inputs}`).toBe(body < node.height ? 2 : 0);
        if (back.length) {
          expect(back[0][1]).toBe(Math.min(...ins));
          expect(back[1][3]).toBe(Math.max(...ins));
        }
        // No input lands on a corner of a body shorter than the gate.
        if (body < node.height) for (const y of ins) expect(y === top || y === top + body, `${sym} ${inputs}: input at ${y}`).toBe(false);
        // The body drawn is that tall (its outline starts at its top corner), and the back lines meet it.
        const m = /<path d="M([-\d.]+),([-\d.]+)/.exec(svg)!;
        expect([Number(m[1]), Number(m[2])], `${sym} ${inputs} body top`).toEqual([node.x, top]);
        if (back.length) {
          expect(back[0][3]).toBe(top);
          expect(back[1][1]).toBe(top + body);
        }
        // An OR or XOR has a curved back: inputs on the body run on to it, the others end on the straight back line.
        if (sym !== 'and' && sym !== 'nand') {
          const stubs = lines(svg).filter(([x1, y1, , y2]) => x1 === node.x && y1 === y2);
          const inside = ins.filter((y) => y > top && y < top + body);
          expect(stubs.map(([, y]) => y).sort((a, b) => a - b), `${sym} ${inputs} stubs`).toEqual(inside);
          for (const [, y, x2] of stubs) {
            const t = (y - top) / body;
            expect(x2 - node.x, `${sym} ${inputs} stub at ${y}`).toBeCloseTo(2 * (1 - t) * t * Math.min(body, node.width) * 0.25, 6);
          }
        }
      }
    }
  });

  it('writes D and Q next to their pins in a register', () => {
    const { pin, svg } = draw('dff');
    const list = texts(svg);
    const d = list.find((t) => t.text === 'D')!;
    const q = list.find((t) => t.text === 'Q')!;
    expect(d.x).toBeGreaterThan(pin('D').x);
    expect(d.x).toBeLessThan(pin('D').x + 10);
    expect(q.x + q.width).toBeLessThan(pin('Q').x);
    expect(q.x + q.width).toBeGreaterThan(pin('Q').x - 10);
    for (const t of [d, q]) expect(Math.abs(t.y + t.height / 2 - pin('D').y)).toBeLessThan(3);
  });
});
