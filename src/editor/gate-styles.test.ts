/**
 * The three ways a gate is drawn (Timmy's reference, HDLBits' top_module: out_or_bitwise = a | b,
 * out_or_logical = a || b, out_not = ~{b, a}):
 *
 * - bitwise of a bus (`a | b`, `~a`): a stack of gates, one per bit (at most three drawn);
 * - logical (`a || b`, `a && b`, `!a`): one gate, the buses going straight into it, a 1-bit output;
 * - reduce (`|a`): one gate, its bus fanned out into bits just before it (see gate-mode.test).
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { type DNode, type Diagram, buildDiagram } from '../core/diagram';
import { design } from '../core/test-utils';
import { type LayoutResult, MAX_STACK, approxMeasure, gateShape, invertsOutput, isLogicType, sizeNode, stackedGates } from '../layout/elk-layout';
import { DiagramGraphic } from '../render/DiagramGraphic';
import { exportSvg } from '../render/export';
import { THEME } from '../render/theme';
import { checkSheet } from './check';
import { componentSymbol, parseComponents, parseSymbolJson, sameSettings, symbolJson } from './components';
import { type SheetEdits, emptyEdits, parseEdits } from './doc';
import { effectiveDiagram, setParams, toUserNode } from './sheet';
import { GATE_SYMS, type InterfaceOf, type SymKey, type SymParams, type UserEdge, type UserNode, gateMode, gateModesOf, gateNotation, hasMode, newUserNode, symbolNode } from './symbols';

const noModules: InterfaceOf = () => undefined;
const ports = (n: Pick<DNode, 'ports'>) => n.ports.map((p) => `${p.name}:${p.dir}:${p.width}`);
const wire = (id: string, from: string, fromPort: string, to: string, toPort: string): UserEdge => ({
  id,
  source: { node: from, port: `${from}.${fromPort}` },
  target: { node: to, port: `${to}.${toPort}` },
});
const gate = (sym: SymKey, params: SymParams, id = 'u:1'): UserNode => ({ ...newUserNode(id, sym), params: { ...newUserNode(id, sym).params, ...params } });

/** One symbol at (100, 100), drawn alone. */
function drawn(n: DNode, selected = false): { svg: string; box: { x: number; y: number; width: number; height: number }; out: { x: number; y: number } } {
  const s = sizeNode(n, approxMeasure);
  const [x, y] = [100, 100];
  const node = { ...n, x, y, width: s.width, height: s.height, ports: n.ports.map((p) => ({ ...p, x: x + s.ports[p.id].x, y: y + s.ports[p.id].y })) };
  const layout: LayoutResult = { module: 'm', x: 0, y: 0, width: 300, height: 300, nodes: [node], edges: [] };
  const out = node.ports.find((p) => p.side === 'EAST')!;
  const svg = selected ? renderToStaticMarkup(createElement(DiagramGraphic, { layout, theme: THEME, selection: new Set([n.id]) })) : exportSvg(layout, THEME);
  return { svg, box: { x, y, width: s.width, height: s.height }, out: { x: out.x, y: out.y } };
}

/** The outlines a gate is drawn with: filled paths (AND, OR, XOR bodies) and polygons (inverters, buffers). */
const outlines = (svg: string) => [...svg.matchAll(/<(path|polygon) (?:d|points)="([^"]+)" fill="#ffffff"/g)].map((m) => m[2]);
const bubbles = (svg: string) => [...svg.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="4"/g)].length;
const numbers = (d: string) => [...d.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));

describe('the modes a symbol has', () => {
  it('AND, OR, NAND and NOR: bitwise, logical and reduce; XOR and XNOR no logical; NOT bitwise and logical; nothing else', () => {
    for (const sym of ['and', 'or', 'nand', 'nor'] as const) expect(gateModesOf(sym)).toEqual(['bitwise', 'logical', 'reduce']);
    for (const sym of ['xor', 'xnor'] as const) expect(gateModesOf(sym)).toEqual(['bitwise', 'reduce']);
    expect(gateModesOf('not')).toEqual(['bitwise', 'logical']);
    for (const sym of ['buf', 'add', 'mux', 'input', 'raw'] as const) {
      expect(gateModesOf(sym)).toEqual([]);
      expect(hasMode(sym)).toBe(false);
    }
    expect(gateNotation('or')).toEqual({ bitwise: 'a | b', logical: 'a || b', reduce: '|a' });
    expect(gateNotation('nand')).toEqual({ bitwise: '~(a & b)', logical: '!(a && b)', reduce: '~&a' });
    expect(gateNotation('xnor')).toEqual({ bitwise: '~(a ^ b)', reduce: '~^a' });
    expect(gateNotation('not')).toEqual({ bitwise: '~a', logical: '!a' });
    // A mode a symbol does not have is no mode of it: drawn bitwise.
    expect(gateMode({ mode: 'logical' }, 'xor')).toBe('bitwise');
    expect(gateMode({ mode: 'reduce' }, 'not')).toBe('bitwise');
    expect(gateMode({ mode: 'logical' }, 'nor')).toBe('logical');
  });

  it('logical: inputs of Width bits each and a 1-bit output, drawn as the logical cell, as big as the bitwise gate', () => {
    const cells: Partial<Record<SymKey, string>> = { and: '$logic_and', or: '$logic_or', nand: 'dc:logic_nand', nor: 'dc:logic_nor' };
    for (const [sym, type] of Object.entries(cells) as [SymKey, string][]) {
      const logical = symbolNode(gate(sym, { inputs: 3, width: 4, mode: 'logical' }), noModules);
      expect(logical.cellType).toBe(type);
      expect(isLogicType(logical.cellType)).toBe(true);
      expect(ports(logical)).toEqual(['A:in:4', 'B:in:4', 'C:in:4', 'Y:out:1']);
      const bitwise = symbolNode(gate(sym, { inputs: 3, width: 4, mode: 'bitwise' }), noModules);
      // The same outline (a bubble for a NAND or NOR), the same size and pins: switching the mode moves nothing.
      expect(gateShape(logical.cellType)).toBe(gateShape(bitwise.cellType));
      expect(invertsOutput(logical.cellType)).toBe(invertsOutput(bitwise.cellType));
      expect(Object.values(sizeNode(logical, approxMeasure).ports)).toEqual(Object.values(sizeNode(bitwise, approxMeasure).ports));
      expect(sizeNode(logical, approxMeasure)).toMatchObject({ width: sizeNode(bitwise, approxMeasure).width, height: sizeNode(bitwise, approxMeasure).height });
    }
    const not = symbolNode(gate('not', { width: 6, mode: 'logical' }), noModules);
    expect([not.cellType, ...ports(not)]).toEqual(['$logic_not', 'A:in:6', 'Y:out:1']);
    expect(ports(symbolNode(gate('not', { width: 6 }), noModules))).toEqual(['A:in:6', 'Y:out:6']);
    // A XOR saved (or pasted) with a mode it has not got is a bitwise XOR.
    expect(symbolNode(gate('xor', { width: 4, mode: 'logical' }), noModules)).toEqual(symbolNode(gate('xor', { width: 4 }), noModules));
  });
});

describe('how many gates a symbol is drawn as', () => {
  it('a bitwise gate, NOT or buffer of a bus: one per bit, at most three; a logical or reduction gate: one', () => {
    for (const sym of [...GATE_SYMS, 'not', 'buf'] as SymKey[]) {
      for (const [width, count] of [[1, 1], [2, 2], [3, 3], [8, MAX_STACK], [256, MAX_STACK]]) {
        expect(stackedGates(symbolNode(gate(sym, { width }), noModules))).toBe(count);
      }
    }
    for (const sym of ['and', 'or', 'nand', 'nor', 'not'] as SymKey[]) expect(stackedGates(symbolNode(gate(sym, { width: 8, mode: 'logical' }), noModules))).toBe(1);
    for (const sym of GATE_SYMS) expect(stackedGates(symbolNode(gate(sym, { width: 8, mode: 'reduce' }), noModules))).toBe(1);
    for (const sym of ['add', 'mux', 'eq', 'dff'] as SymKey[]) expect(stackedGates(symbolNode(gate(sym, { width: 8 }), noModules))).toBe(1);
    // An imported AND of a constant 0 MUX (dc:and) of a bus is bitwise too; a symbol that is no cell never is.
    expect(stackedGates({ kind: 'cell', cellType: 'dc:and', ports: [{ id: 'a', name: 'Y', dir: 'out', side: 'EAST', width: 4 }] })).toBe(3);
    expect(stackedGates({ kind: 'instance', cellType: '$and', ports: [{ id: 'a', name: 'Y', dir: 'out', side: 'EAST', width: 4 }] })).toBe(1);
  });

  it('draws the stack inside the symbol: the inputs into the gate in front, every gate into the output pin', () => {
    for (const sym of [...GATE_SYMS, 'not', 'buf'] as SymKey[]) {
      for (const [width, count] of [[1, 1], [2, 2], [5, 3]]) {
        for (const inputs of sym === 'not' || sym === 'buf' ? [2] : [2, 3, 6]) {
          const n = symbolNode(gate(sym, { width, inputs }), noModules);
          const { svg, box, out } = drawn(n);
          const shapes = outlines(svg);
          expect(shapes, `${sym} ${width} bits`).toHaveLength(count);
          // Inside the symbol (as sizeNode gave it), so nothing of a stack covers a wire or another symbol.
          for (const d of shapes) {
            const v = numbers(d);
            const xs = v.filter((_, i) => i % 2 === 0);
            const ys = v.filter((_, i) => i % 2 === 1);
            // A path's arcs have radii and flags among their numbers: check only the points of the others.
            if (d.includes('A')) continue;
            expect(Math.min(...xs)).toBeGreaterThanOrEqual(box.x);
            expect(Math.max(...xs)).toBeLessThanOrEqual(box.x + box.width + 1e-9);
            expect(Math.min(...ys)).toBeGreaterThanOrEqual(box.y);
            expect(Math.max(...ys)).toBeLessThanOrEqual(box.y + box.height + 1e-9);
          }
          // One bubble per gate (NAND, NOR, XNOR, NOT).
          const inverted = sym === 'nand' || sym === 'nor' || sym === 'xnor' || sym === 'not';
          expect(bubbles(svg)).toBe(inverted ? count : 0);
          // Each gate of a stack joins the output pin.
          const joins = [...svg.matchAll(/<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"[^>]*stroke-linecap="round"/g)].map((m) => m.slice(1).map(Number));
          expect(joins).toHaveLength(count > 1 ? count : 0);
          for (const [x1, y1, x2, y2] of joins) {
            expect([x2, y2]).toEqual([out.x, out.y]);
            expect(Math.hypot(x2 - x1, y2 - y1)).toBeLessThan(10);
          }
        }
      }
    }
  });

  it('selected, the gates behind do not show through the see-through fill of the one in front', () => {
    for (const sym of ['or', 'nand', 'not', 'buf'] as SymKey[]) {
      const n = symbolNode(gate(sym, { width: 4 }), noModules);
      const { svg } = drawn(n, true);
      // Under each gate (and bubble) a plain one, then the gate in the selection's colours.
      const plain = [...svg.matchAll(/<(path|polygon|circle) [^>]*fill="#ffffff" stroke="none"/g)].length;
      expect(plain, sym).toBe(3 * (sym === 'nand' || sym === 'not' ? 2 : 1));
      expect(svg).toContain(`fill="${THEME.accentFill}" stroke="${THEME.accent}"`);
      // One gate, or not selected: nothing under it.
      expect(drawn(symbolNode(gate(sym, { width: 1 }), noModules), true).svg).not.toContain('stroke="none"');
      expect(drawn(n).svg).not.toContain('stroke="none"');
    }
  });

  it('draws a logical gate, and a XOR’s second back curve, once', () => {
    for (const sym of ['and', 'or', 'nand', 'nor', 'not'] as SymKey[]) {
      const { svg } = drawn(symbolNode(gate(sym, { width: 8, mode: 'logical' }), noModules));
      expect(outlines(svg)).toHaveLength(1);
      expect(svg).not.toContain('stroke-linecap="round"');
    }
    const { svg } = drawn(symbolNode(gate('xor', { width: 8 }), noModules));
    expect(outlines(svg)).toHaveLength(3);
    expect([...svg.matchAll(/<path d="[^"]+" fill="none"/g)]).toHaveLength(1);
  });
});

describe('logical mode in the editor', () => {
  it('switching to logical keeps every input and its wire; the output is one bit', () => {
    const nodes: UserNode[] = [
      newUserNode('u:1', 'input', { name: 'a', params: { width: 3, style: 'label' } }),
      newUserNode('u:2', 'input', { name: 'b', params: { width: 3, style: 'label' } }),
      gate('or', { inputs: 2, width: 3 }, 'u:3'),
      newUserNode('u:4', 'output', { name: 'y', params: { width: 1, style: 'label' } }),
    ];
    const start: SheetEdits = { ...emptyEdits(), nodes, edges: [wire('w:1', 'u:1', 'out', 'u:3', 'A'), wire('w:2', 'u:2', 'out', 'u:3', 'B'), wire('w:3', 'u:3', 'Y', 'u:4', 'in')], next: 9 };
    // a | b into a 1-bit output: flagged.
    expect([...checkSheet(effectiveDiagram('d', undefined, start, noModules)).flagged]).toEqual(['w:3']);
    const logical = setParams(start, 'u:3', { mode: 'logical' }, noModules);
    const d = effectiveDiagram('d', undefined, logical, noModules);
    expect(d.edges.map((x) => `${x.id}:${x.width}`)).toEqual(['w:1:3', 'w:2:3', 'w:3:1']);
    // a || b: two 3-bit buses into a 1-bit output is right.
    const issues = checkSheet(d);
    expect(issues.flagged.size).toBe(0);
    expect(issues.messages).toEqual([]);
    expect(logical.nodes[2].params).toEqual({ inputs: 2, width: 3, mode: 'logical' });
    const back = setParams(logical, 'u:3', { mode: 'bitwise' }, noModules);
    expect(effectiveDiagram('d', undefined, back, noModules).edges.map((x) => `${x.id}:${x.width}`)).toEqual(['w:1:3', 'w:2:3', 'w:3:3']);
    // A NOT of a bus: ~a (as many bits out as in) or !a (one).
    const not: SheetEdits = { ...start, nodes: [nodes[0], gate('not', { width: 3 }, 'u:3'), nodes[3]], edges: [wire('w:1', 'u:1', 'out', 'u:3', 'A'), wire('w:3', 'u:3', 'Y', 'u:4', 'in')] };
    const bang = setParams(not, 'u:3', { mode: 'logical' }, noModules);
    expect(effectiveDiagram('d', undefined, bang, noModules).edges.map((x) => `${x.id}:${x.width}`)).toEqual(['w:1:3', 'w:3:1']);
    expect(checkSheet(effectiveDiagram('d', undefined, bang, noModules)).flagged.size).toBe(0);
  });

  it('reads and writes "logical" in the JSON of symbols and components, and in saved files', () => {
    const r = parseComponents('[{ "name": "both8", "base": "and", "width": 8, "mode": "logical" }, { "name": "none8", "base": "not", "width": 8, "mode": "logical" }]');
    expect(r.error).toBeUndefined();
    expect(r.defs?.map((c) => c.params)).toEqual([
      { width: 8, mode: 'logical' },
      { width: 8, mode: 'logical' },
    ]);
    expect(componentSymbol(r.defs![1])).toEqual({ sym: 'not', params: { width: 8, mode: 'logical' } });
    // A logical gate has its inputs (a reduce gate has one).
    expect(symbolJson('or', { inputs: 3, width: 8, mode: 'logical' })).toBe('{\n  "sym": "or",\n  "inputs": 3,\n  "width": 8,\n  "mode": "logical"\n}');
    expect(symbolJson('not', { width: 8, mode: 'logical' })).toBe('{\n  "sym": "not",\n  "width": 8,\n  "mode": "logical"\n}');
    // A NOT saved before it had a mode is bitwise, and its JSON says so.
    expect(symbolJson('not', { width: 8 })).toBe('{\n  "sym": "not",\n  "width": 8,\n  "mode": "bitwise"\n}');
    expect(sameSettings('not', { width: 8 }, { width: 8, mode: 'bitwise' })).toBe(true);
    expect(sameSettings('or', { inputs: 2, width: 8, mode: 'logical' }, { inputs: 2, width: 8, mode: 'bitwise' })).toBe(false);
    expect(parseSymbolJson('{ "mode": "logical" }', 'not')).toEqual({ params: { mode: 'logical' } });
    expect(parseSymbolJson('{ "mode": "logical" }', 'xnor').error).toMatch(/"mode" is "bitwise" \(~\(a \^ b\)\) or "reduce"/);
    // Saved files: a mode the symbol has is kept, any other is dropped (bitwise).
    const e = parseEdits({
      nodes: [
        { id: 'u:1', sym: 'or', params: { inputs: 2, width: 8, mode: 'logical' } },
        { id: 'u:2', sym: 'not', params: { width: 8, mode: 'logical' } },
        { id: 'u:3', sym: 'xor', params: { width: 8, mode: 'logical' } },
        { id: 'u:4', sym: 'not', params: { width: 8, mode: 'reduce' } },
        { id: 'u:5', sym: 'buf', params: { width: 8, mode: 'logical' } },
        { id: 'u:6', sym: 'not', params: { width: 8 } },
      ],
    });
    expect(e.nodes.map((n) => n.params.mode)).toEqual(['logical', 'logical', undefined, undefined, undefined, undefined]);
  });
});

/** Timmy's reference (HDLBits): a | b, a || b and ~{b, a}. */
const TOP = `module top_module(input [2:0] a, input [2:0] b, output [2:0] out_or_bitwise, output out_or_logical, output [5:0] out_not);
  assign out_or_bitwise = a | b;
  assign out_or_logical = a || b;
  assign out_not = ~{b, a};
endmodule
`;

const L = `module l(input [3:0] a, input [3:0] b, input c, input [1:0] d, output both, output either, output nand_, output nor_, output nor2,
  output kept, output mixed, output not_a, output [3:0] wide, output [3:0] inv);
  assign both = a && b;
  assign either = a || b;
  assign nand_ = !(a && b);
  assign nor_ = !(a || c);
  assign nor2 = ~(c || b);
  wire t = a && c;
  assign kept = !t;
  assign mixed = a || d;
  assign not_a = !a;
  assign wide = b + (a && c);
  assign inv = ~a;
endmodule
`;

describe('logical and bitwise gates imported from Verilog', () => {
  const sourceOf = (d: Diagram, out: string) => d.nodes.find((n) => n.id === d.edges.find((x) => x.target.node === `out:${out}`)!.source.node)!;

  it('draws the reference circuit: a | b a stack of three ORs, a || b one OR, ~{b, a} a stack of inverters', async () => {
    const d = buildDiagram(await design({ 'top.v': TOP }), 'top_module');
    const bitwise = sourceOf(d, 'out_or_bitwise');
    const logical = sourceOf(d, 'out_or_logical');
    const not = sourceOf(d, 'out_not');
    expect([bitwise.cellType, stackedGates(bitwise), ...ports(bitwise)]).toEqual(['$or', 3, 'A:in:3', 'B:in:3', 'Y:out:3']);
    expect([logical.cellType, stackedGates(logical), ...ports(logical)]).toEqual(['$logic_or', 1, 'A:in:3', 'B:in:3', 'Y:out:1']);
    expect([not.cellType, stackedGates(not), ...ports(not)]).toEqual(['$not', 3, 'A:in:6', 'Y:out:6']);
    // Each copies to a drawing as the library's gate in its mode, drawn the same.
    for (const [n, sym, params] of [
      [bitwise, 'or', { inputs: 2, width: 3, mode: 'bitwise' }],
      [logical, 'or', { inputs: 2, width: 3, mode: 'logical' }],
      [not, 'not', { width: 6, mode: 'bitwise' }],
    ] as const) {
      const u = toUserNode(n, 'u:1', noModules);
      expect(u).toMatchObject({ sym, params });
      const copy = symbolNode(u, noModules);
      expect([copy.cellType, ...ports(copy)]).toEqual([n.cellType, ...ports(n)]);
      expect(stackedGates(copy)).toBe(stackedGates(n));
    }
  });

  it('a logical gate and a NOT of its bit are one logical NAND or NOR, which takes the NOT’s ID', async () => {
    const d = buildDiagram(await design({ 'l.v': L }), 'l');
    const typeOf = (out: string) => sourceOf(d, out).cellType;
    expect(typeOf('both')).toBe('$logic_and');
    expect(typeOf('either')).toBe('$logic_or');
    expect(typeOf('nand_')).toBe('dc:logic_nand');
    expect(typeOf('nor_')).toBe('dc:logic_nor');
    // ~ of the 1-bit || too.
    expect(typeOf('nor2')).toBe('dc:logic_nor');
    // A NOT of a named wire stays a NOT after its own gate, as written.
    expect(typeOf('kept')).toBe('$logic_not');
    expect(typeOf('not_a')).toBe('$logic_not');
    expect(typeOf('mixed')).toBe('$logic_or');
    expect(typeOf('inv')).toBe('$not');
    const nand = sourceOf(d, 'nand_');
    expect(nand.id).toMatch(/^cell:\$logic_not\{/);
    expect(nand.rule).toBe('logic-not');
    expect(ports(nand)).toEqual(['A:in:4', 'B:in:4', 'Y:out:1']);
    expect([ports(sourceOf(d, 'nor_')), ports(sourceOf(d, 'nor2'))]).toEqual([
      ['A:in:4', 'B:in:1', 'Y:out:1'],
      ['A:in:1', 'B:in:4', 'Y:out:1'],
    ]);
    // Merged: no NOT is left of them, and the && and || they were are gone (nothing drives a pin twice).
    const nots = d.nodes.filter((n) => n.cellType === '$logic_not' || n.cellType === '$not');
    expect(nots.map((n) => d.edges.find((x) => x.source.node === n.id)!.target.node).sort()).toEqual(['out:inv', 'out:kept', 'out:not_a']);
    for (const out of ['both', 'either', 'nand_', 'nor_', 'nor2']) expect(d.edges.filter((x) => x.target.node === `out:${out}`)).toHaveLength(1);
    expect(stackedGates(sourceOf(d, 'inv'))).toBe(3);
    expect(stackedGates(sourceOf(d, 'not_a'))).toBe(1);

    // Copied to a drawing: a logical gate of the library when its inputs are one width and its output one bit.
    expect(toUserNode(sourceOf(d, 'both'), 'u:1', noModules)).toMatchObject({ sym: 'and', params: { inputs: 2, width: 4, mode: 'logical' } });
    expect(toUserNode(nand, 'u:1', noModules)).toMatchObject({ sym: 'nand', params: { inputs: 2, width: 4, mode: 'logical' } });
    expect(toUserNode(sourceOf(d, 'not_a'), 'u:1', noModules)).toMatchObject({ sym: 'not', params: { width: 4, mode: 'logical' } });
    // A 4-bit a || a 2-bit d, or a && padded to 4 bits (b + (a && c)): a copy as it is.
    expect(toUserNode(sourceOf(d, 'mixed'), 'u:1', noModules).sym).toBe('raw');
    const add = d.nodes.find((n) => n.cellType === '$add')!;
    const padded = d.nodes.find((n) => n.id === d.edges.find((x) => x.target.port === `${add.id}.B`)!.source.node)!;
    expect([padded.cellType, ...ports(padded)]).toEqual(['$logic_and', 'A:in:4', 'B:in:1', 'Y:out:4']);
    expect(toUserNode(padded, 'u:1', noModules).sym).toBe('raw');
    for (const n of d.nodes.filter((x) => isLogicType(x.cellType))) {
      const u = toUserNode(n, 'u:1', noModules);
      if (u.sym === 'raw') continue;
      expect(sizeNode(symbolNode(u, noModules), approxMeasure)).toEqual(sizeNode({ ...n, id: 'u:1', ports: n.ports.map((p) => ({ ...p, id: `u:1.${p.name}` })) }, approxMeasure));
    }
  });
});
