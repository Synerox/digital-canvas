import { describe, expect, it } from 'vitest';
import { type DNode, type Diagram, buildDiagram } from '../core/diagram';
import { design } from '../core/test-utils';
import { openBusHints } from '../app/pin-hints';
import { type LayoutResult, REDUCE_FAN, approxMeasure, fannedInput, sizeNode } from '../layout/elk-layout';
import { exportSvg } from '../render/export';
import { THEME } from '../render/theme';
import { checkSheet } from './check';
import { componentSymbol, followsPreset, parseComponents, parseSymbolJson, sameSettings, symbolJson } from './components';
import { type SheetEdits, emptyEdits, parseEdits } from './doc';
import { effectiveDiagram, setParams, toUserNode } from './sheet';
import { GATE_SYMS, type InterfaceOf, type SymKey, type UserEdge, type UserNode, newUserNode, symbolNode } from './symbols';

const noModules: InterfaceOf = () => undefined;
const ports = (n: DNode) => n.ports.map((p) => `${p.name}:${p.dir}:${p.width}`);
const wire = (id: string, from: string, fromPort: string, to: string, toPort: string): UserEdge => ({
  id,
  source: { node: from, port: `${from}.${fromPort}` },
  target: { node: to, port: `${to}.${toPort}` },
});

/** The nodes of a diagram laid out one under the other, with their wires straight from pin to pin. */
function laidOut(d: Diagram, at: Record<string, { x: number; y: number }> = {}): LayoutResult {
  const nodes = d.nodes.map((n, i) => {
    const s = sizeNode(n, approxMeasure);
    const { x, y } = at[n.id] ?? { x: 100, y: 60 * i };
    return { ...n, x, y, width: s.width, height: s.height, ports: n.ports.map((p) => ({ ...p, x: x + s.ports[p.id].x, y: y + s.ports[p.id].y })) };
  });
  const pin = new Map(nodes.flatMap((n) => n.ports.map((p) => [p.id, p] as const)));
  const edges = d.edges.map((e) => {
    const a = pin.get(e.source.port)!;
    const b = pin.get(e.target.port)!;
    return { ...e, points: [{ x: a.x, y: a.y }, { x: b.x, y: b.y }], junctions: [] };
  });
  return { module: d.module, width: 600, height: 60 * nodes.length, nodes, edges };
}

describe('logic gates: bitwise (a | b) or reduce (|a)', () => {
  it('reduce: one input of "width" bits and a 1-bit output, drawn as the reduction cell; bitwise as before', () => {
    const cells: Record<string, string> = {
      and: '$reduce_and',
      or: '$reduce_or',
      xor: '$reduce_xor',
      xnor: '$reduce_xnor',
      nand: 'dc:reduce_nand',
      nor: 'dc:reduce_nor',
    };
    for (const sym of GATE_SYMS) {
      const u = newUserNode('u:1', sym);
      expect(u.params).toEqual({ inputs: 2, width: 1, mode: 'bitwise' });
      const bitwise = symbolNode({ ...u, params: { inputs: 3, width: 4, mode: 'bitwise' } }, noModules);
      expect(ports(bitwise)).toEqual(['A:in:4', 'B:in:4', 'C:in:4', 'Y:out:4']);
      // A gate saved before modes existed is bitwise.
      expect(symbolNode({ ...u, params: { inputs: 3, width: 4 } }, noModules)).toEqual(bitwise);
      const reduce = symbolNode({ ...u, params: { inputs: 3, width: 4, mode: 'reduce' } }, noModules);
      expect(reduce.cellType).toBe(cells[sym]);
      expect(ports(reduce)).toEqual(['A:in:4', 'Y:out:1']);
      // As big as a 2-input gate, its input in the middle of its back (on the grid).
      const s = sizeNode(reduce, approxMeasure);
      expect(s).toMatchObject({ width: 40, height: 40 });
      expect(s.ports['u:1.A']).toEqual({ x: 0, y: 20 });
      expect(fannedInput(reduce)?.name).toBe('A');
      expect(fannedInput(bitwise)).toBeUndefined();
    }
    // NOT and Buffer have no mode.
    expect(newUserNode('u:1', 'not').params).toEqual({ width: 1 });
  });

  it('switching the mode keeps the wire on A and hides the others until the gate is bitwise again', () => {
    const nodes: UserNode[] = [
      newUserNode('u:1', 'input', { name: 'a', params: { width: 4, style: 'label' } }),
      newUserNode('u:2', 'input', { name: 'b', params: { width: 4, style: 'label' } }),
      newUserNode('u:3', 'or', { params: { inputs: 3, width: 4, mode: 'bitwise' } }),
      newUserNode('u:4', 'output', { name: 'y', params: { width: 4, style: 'label' } }),
    ];
    const start: SheetEdits = { ...emptyEdits(), nodes, edges: [wire('w:1', 'u:1', 'out', 'u:3', 'A'), wire('w:2', 'u:2', 'out', 'u:3', 'B'), wire('w:3', 'u:3', 'Y', 'u:4', 'in')], next: 9 };
    const reduced = setParams(start, 'u:3', { mode: 'reduce' }, noModules);
    const d = effectiveDiagram('d', undefined, reduced, noModules);
    expect(d.edges.map((x) => `${x.id}:${x.width}`)).toEqual(['w:1:4', 'w:3:1']);
    // The 1-bit output into a 4-bit pin is flagged; the 4-bit bus into the reduction is not.
    expect([...checkSheet(d).flagged]).toEqual(['w:3']);
    // The input count waits for bitwise mode, and so does the wire on B.
    expect(reduced.nodes[2].params).toEqual({ inputs: 3, width: 4, mode: 'reduce' });
    expect(reduced.edges).toHaveLength(3);
    const back = setParams(reduced, 'u:3', { mode: 'bitwise' }, noModules);
    expect(effectiveDiagram('d', undefined, back, noModules).edges.map((x) => `${x.id}:${x.width}`)).toEqual(['w:1:4', 'w:2:4', 'w:3:4']);
    expect(ports(symbolNode(back.nodes[2], noModules))).toEqual(['A:in:4', 'B:in:4', 'C:in:4', 'Y:out:4']);
    // A wire drawn on B while it was hidden is dropped when the hidden one comes back (one driver per input).
    const both = setParams({ ...reduced, edges: [...reduced.edges, wire('w:5', 'u:1', 'out', 'u:3', 'B')] }, 'u:3', { mode: 'bitwise' }, noModules);
    expect(both.edges.filter((x) => x.target.port === 'u:3.B').map((x) => x.id)).toHaveLength(1);
  });

  it('checks a reduction of a bus into one bit as right', () => {
    const nodes: UserNode[] = [
      newUserNode('u:1', 'input', { name: 'a', params: { width: 3, style: 'label' } }),
      newUserNode('u:2', 'nor', { params: { inputs: 2, width: 3, mode: 'reduce' } }),
      newUserNode('u:3', 'output', { name: 'zero', params: { width: 1, style: 'label' } }),
    ];
    const e: SheetEdits = { ...emptyEdits(), nodes, edges: [wire('w:1', 'u:1', 'out', 'u:2', 'A'), wire('w:2', 'u:2', 'Y', 'u:3', 'in')], next: 9 };
    const issues = checkSheet(effectiveDiagram('d', undefined, e, noModules));
    expect(issues.flagged.size).toBe(0);
    expect(issues.messages).toEqual([]);
  });

  it('reads and writes "mode" in the JSON of symbols and components, and in saved files', () => {
    const r = parseComponents('[{ "name": "any8", "title": "OR of 8 bits", "base": "or", "width": 8, "mode": "reduce" }]');
    expect(r.defs?.[0].params).toEqual({ width: 8, mode: 'reduce' });
    expect(parseComponents('[{ "name": "g", "base": "or", "mode": "unary" }]').error).toBe('g: "mode" is "bitwise" (a | b) or "reduce" (|a: one input, a 1-bit output).');
    expect(parseComponents('[{ "name": "g", "base": "add", "mode": "reduce" }]').error).toMatch(/Adder has "width", not "mode"/);
    expect(parseComponents('[{ "name": "g", "base": "not", "mode": "reduce" }]').error).toMatch(/NOT has "width", not "mode"/);
    // A reduce gate's JSON has no "inputs" (it has one); one written there anyway is kept for bitwise mode.
    expect(symbolJson('or', { inputs: 3, width: 8, mode: 'reduce' })).toBe('{\n  "sym": "or",\n  "width": 8,\n  "mode": "reduce"\n}');
    expect(symbolJson('or', { inputs: 3, width: 8, mode: 'bitwise' })).toBe('{\n  "sym": "or",\n  "inputs": 3,\n  "width": 8,\n  "mode": "bitwise"\n}');
    expect(parseSymbolJson('{ "sym": "or", "inputs": 3, "width": 8, "mode": "reduce" }', 'or')).toEqual({ params: { inputs: 3, width: 8, mode: 'reduce' } });
    expect(parseSymbolJson('{ "mode": "reduce" }', 'nand')).toEqual({ params: { mode: 'reduce' } });
    // Two reduce gates of one width are the same, whatever input count waits for bitwise mode.
    expect(sameSettings('or', { inputs: 3, width: 8, mode: 'reduce' }, { width: 8, mode: 'reduce' })).toBe(true);
    expect(sameSettings('or', { inputs: 3, width: 8, mode: 'bitwise' }, { width: 8, mode: 'bitwise' })).toBe(false);
    expect(sameSettings('or', { inputs: 2, width: 8 }, { width: 8, mode: 'bitwise' })).toBe(true);
    expect(sameSettings('or', { width: 8, mode: 'reduce' }, { width: 8 })).toBe(false);
    const placed: UserNode = { id: 'u:1', sym: 'or', params: { inputs: 5, width: 8, mode: 'reduce' }, component: 'any8' };
    expect(followsPreset(placed, r.defs)).toBe(true);
    expect(componentSymbol(r.defs![0])).toEqual({ sym: 'or', params: { width: 8, mode: 'reduce' } });
    // Saved files: a gate keeps its mode; a file from before modes has none (bitwise); nothing else has one.
    const e = parseEdits({
      nodes: [
        { id: 'u:1', sym: 'or', params: { inputs: 2, width: 8, mode: 'reduce' } },
        { id: 'u:2', sym: 'and', params: { inputs: 2, width: 1 } },
        { id: 'u:3', sym: 'xor', params: { mode: 'unary' } },
        { id: 'u:4', sym: 'add', params: { width: 4, mode: 'reduce' } },
      ],
    });
    expect(e.nodes.map((n) => n.params.mode)).toEqual(['reduce', undefined, undefined, undefined]);
  });

  it('draws the bus into a reduction fanned out into its bits, with its bus mark and open-pin hint clear of the fan', () => {
    const gate = (id: string, sym: SymKey, width: number, mode: 'bitwise' | 'reduce'): UserNode => newUserNode(id, sym, { params: { inputs: 2, width, mode } });
    const lines = (u: UserNode) => {
      const svg = exportSvg(laidOut(effectiveDiagram('d', undefined, { ...emptyEdits(), nodes: [u], next: 9 }, noModules)), THEME);
      return (svg.match(/<polyline /g) ?? []).length;
    };
    expect(lines(gate('u:1', 'or', 8, 'reduce'))).toBe(3);
    expect(lines(gate('u:1', 'and', 3, 'reduce'))).toBe(3);
    expect(lines(gate('u:1', 'xnor', 2, 'reduce'))).toBe(2);
    // One bit is no bus to fan out; a bitwise gate has its inputs.
    expect(lines(gate('u:1', 'nand', 1, 'reduce'))).toBe(0);
    expect(lines(gate('u:1', 'or', 8, 'bitwise'))).toBe(0);

    // A wire carrying 4 of the 8 bits of a: its mark goes near its end, past the fan.
    const nodes = [newUserNode('u:1', 'input', { name: 'a', params: { width: 8, style: 'label' } }), gate('u:2', 'or', 4, 'reduce'), gate('u:3', 'or', 4, 'reduce')];
    const e: SheetEdits = { ...emptyEdits(), nodes, edges: [{ ...wire('w:1', 'u:1', 'out', 'u:2', 'A'), slice: { lo: 0, width: 4 } }], next: 9 };
    const layout = laidOut(effectiveDiagram('d', undefined, e, noModules), { 'u:1': { x: 0, y: 10 }, 'u:2': { x: 200, y: 0 }, 'u:3': { x: 200, y: 100 } });
    const svg = exportSvg(layout, THEME);
    const slashes = [...svg.matchAll(/<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"/g)]
      .map((m) => m.slice(1).map(Number))
      .filter(([x1, y1, x2, y2]) => x2 - x1 === 8 && y1 - y2 === 10);
    expect(slashes).toHaveLength(1);
    expect(200 - (slashes[0][0] + 4)).toBe(REDUCE_FAN + 10);
    // The open input of the other one: a longer stub, its slash past the fan; a bitwise gate's as before.
    const hint = openBusHints(layout).find((h) => h.port === 'u:3.A')!;
    expect(hint.from.x - hint.to.x).toBe(30);
    expect(hint.from.x - hint.slash.x).toBe(20);
    const plain = laidOut(effectiveDiagram('d', undefined, { ...emptyEdits(), nodes: [gate('u:1', 'or', 4, 'bitwise')], next: 9 }, noModules));
    const h2 = openBusHints(plain).find((h) => h.port === 'u:1.A')!;
    expect([h2.from.x - h2.to.x, h2.from.x - h2.slash.x]).toEqual([20, 10]);
  });
});

const V = `module r(input [2:0] a, input [3:0] b, input c, output any, output all, output odd, output even, output nand_all, output none,
  output zero, output not_c, output t_bar, output u_bar, output u_too, output both);
  assign any = |a;
  assign all = &a;
  assign odd = ^a;
  assign even = ~^a;
  assign nand_all = ~&a;
  assign none = ~|a;
  assign zero = !b;
  assign not_c = !c;
  wire t = |b;
  assign t_bar = ~t;
  wire u_bus = &b;
  assign u_bar = !(^b);
  assign u_too = ~(|b) & c;
  assign both = (b != 0) && c;
endmodule
`;

describe('reductions imported from Verilog', () => {
  it('are drawn as one gate each, ~&a and ~|a too, and !a of a bus as a NOR of its bits', async () => {
    const d = buildDiagram(await design({ 'r.v': V }), 'r');
    const cells = d.nodes.filter((n) => n.kind === 'cell');
    const typeOf = (out: string) => {
      const e = d.edges.find((x) => x.target.node === `out:${out}`)!;
      return d.nodes.find((n) => n.id === e.source.node)!.cellType;
    };
    expect(typeOf('any')).toBe('$reduce_or');
    expect(typeOf('all')).toBe('$reduce_and');
    expect(typeOf('odd')).toBe('$reduce_xor');
    expect(typeOf('even')).toBe('$reduce_xnor');
    expect(typeOf('nand_all')).toBe('dc:reduce_nand');
    expect(typeOf('none')).toBe('dc:reduce_nor');
    expect(typeOf('zero')).toBe('dc:reduce_nor');
    expect(typeOf('u_bar')).toBe('$reduce_xnor');
    // A 1-bit ! stays an inverter; a NOT of a named wire stays a NOT after its own gate.
    expect(typeOf('not_c')).toBe('$logic_not');
    expect(typeOf('t_bar')).toBe('$not');
    expect(cells.some((n) => n.cellType === '$reduce_or' && d.edges.some((x) => x.source.node === n.id && x.target.node === `out:t_bar`))).toBe(false);
    // The NOT of ~(|b) & c is part of the NOR gate: nothing is left of it.
    expect(cells.filter((n) => n.cellType === '$not' || n.cellType === '$logic_not').map((n) => n.id).sort()).toEqual(
      cells.filter((n) => (n.cellType === '$not' || n.cellType === '$logic_not') && ['out:t_bar', 'out:not_c'].includes(d.edges.find((x) => x.source.node === n.id)?.target.node ?? '')).map((n) => n.id).sort(),
    );
    // Merged gates keep the reduction's ID, and say what made them.
    const nand = cells.find((n) => n.cellType === 'dc:reduce_nand')!;
    expect(nand.id).toMatch(/^cell:\$reduce_and/);
    expect(nand.rule).toBe('reduce-not');
    expect(ports(nand)).toEqual(['A:in:3', 'Y:out:1']);

    // Each is a gate of the library in reduce mode, drawn the same, when copied to a drawing.
    for (const n of cells.filter((c) => fannedInput(c) || /reduce/.test(c.cellType ?? ''))) {
      const u = toUserNode(n, 'u:1', noModules);
      expect(u.sym).not.toBe('raw');
      expect(u.params.mode).toBe('reduce');
      const drawn = symbolNode(u, noModules);
      expect(ports(drawn)).toEqual(ports(n));
      expect(sizeNode(drawn, approxMeasure)).toEqual(sizeNode({ ...n, id: 'u:1', ports: n.ports.map((p) => ({ ...p, id: `u:1.${p.name}` })) }, approxMeasure));
    }
    // A bitwise gate copies as a bitwise one.
    const and = cells.find((n) => n.cellType === '$and')!;
    expect(toUserNode(and, 'u:1', noModules).params).toEqual({ width: 1, inputs: 2, mode: 'bitwise' });
  });
});
