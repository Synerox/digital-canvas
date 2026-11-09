import { describe, expect, it } from 'vitest';
import { type DEdge, type DNode, type DPort, type Diagram, type Side, buildDiagram } from '../core/diagram';
import { DEFAULT_RULES } from '../core/rules';
import { design } from '../core/test-utils';
import { AUCTION_FILE, AUCTION_SOURCE } from '../examples/auction';
import { type LayoutResult, type MeasureText, approxMeasure, layoutDiagram, sizeNode } from '../layout/elk-layout';
import { checkSheet, wireShift } from './check';
import { buildGeometry } from './geometry';
import { polylineHitsRect } from './router';
import { type SheetEdits, emptyEdits, parseSavedFile, type SavedFile } from './doc';
import {
  type WireEnd,
  addNodes,
  connect,
  copyNodes,
  deleteItems,
  drawingPorts,
  effectiveDiagram,
  layoutToEdits,
  moveNodes,
  newId,
  pasteClip,
  placeMissing,
  rename,
  resolveConnection,
  setParams,
  setSlice,
  toDrawing,
  toUserNode,
} from './sheet';
import { type InterfaceOf, SYMBOLS, type SymKey, type SymParams, newUserNode, symbolNode } from './symbols';

const noModules: InterfaceOf = () => undefined;

/**
 * What a wire carries: its source port, `[hi:lo]` when it carries a slice of it, and `<<n` when it
 * appends n low zero bits. The zero bits are read from `shift` as the editor reads them: a label is only text.
 */
const carried = (x: DEdge) =>
  `${x.source.port}${x.bits ? `[${x.bits.lo + x.bits.width - 1}:${x.bits.lo}]` : ''}${wireShift(x) ? `<<${wireShift(x)}` : ''}`;

/** What drives an input port: what each wire into it carries. */
const feeds = (d: Diagram, port: string) => d.edges.filter((x) => x.target.port === port).map(carried);

/**
 * What a diagram computes, to compare two that must do the same: each symbol's kind, cell type,
 * Yosys parameters, block module and ports in order (a concatenation joins its inputs in that order,
 * the first on top), the names of pins (the module's ports) and values of constants, and which bits
 * every wire carries from where to where. Display text (operators, wire labels, instance names) is left out.
 */
function logic(d: Diagram) {
  const named = new Set(['input', 'output', 'inout', 'const']);
  const nodes = d.nodes
    .filter((n) => n.kind !== 'text')
    .map((n) => ({
      id: n.id,
      kind: n.kind,
      cellType: n.cellType,
      module: n.moduleName,
      params: n.params,
      invertB: n.attrs?.invertB,
      name: named.has(n.kind) ? n.label : undefined,
      ports: n.ports.map((p) => `${p.name}:${p.dir}${p.inout ? ':inout' : ''}:${p.width}`),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const edges = d.edges.map((x) => `${carried(x)} -> ${x.target.port} (${x.width})`).sort();
  return { nodes, edges };
}

const V1 = `module t(input [3:0] a, input [3:0] b, input s, output [3:0] y, output z);
  wire [3:0] sum = a + b;
  assign y = s ? sum : a;
  assign z = a == b;
endmodule
`;

// The same module with one more operator (an XOR feeding a new output).
const V2 = `module t(input [3:0] a, input [3:0] b, input s, output [3:0] y, output z, output [3:0] w);
  wire [3:0] sum = a + b;
  assign y = s ? sum : a;
  assign z = a == b;
  assign w = a ^ b;
endmodule
`;

describe('symbol library', () => {
  it('derives ports from parameters', () => {
    const and3 = symbolNode({ ...newUserNode('u:1', 'and'), params: { inputs: 3, width: 4 } }, noModules);
    expect(and3.ports.map((p) => `${p.name}:${p.dir}:${p.width}`)).toEqual(['A:in:4', 'B:in:4', 'C:in:4', 'Y:out:4']);
    const mux4 = symbolNode({ ...newUserNode('u:2', 'mux'), params: { inputs: 4, width: 8 } }, noModules);
    expect(mux4.cellType).toBe('dc:mux');
    expect(mux4.ports.find((p) => p.name === 'S')).toMatchObject({ width: 2, side: 'SOUTH' });
    const dec = symbolNode({ ...newUserNode('u:3', 'decoder'), params: { width: 3 } }, noModules);
    expect(dec.ports.map((p) => p.width)).toEqual([3, 8]);
    const k = symbolNode({ ...newUserNode('u:4', 'const'), params: { value: "4'd2" } }, noModules);
    expect(k.ports[0].width).toBe(4);
    const split = symbolNode({ ...newUserNode('u:5', 'split'), params: { parts: 2, width: 4 } }, noModules);
    expect(split.ports.map((p) => p.name)).toEqual(['in', '[7:4]', '[3:0]']);
  });

  it('gives every library symbol a size and grid-aligned ports', () => {
    // Text widths as a browser measures them: fractional, and not what approxMeasure says.
    const fractional: MeasureText = (text, size, bold) => [...text].length * size * 0.5731 * (bold ? 1.07 : 1) + 0.29;
    const iface: InterfaceOf = (m) =>
      m === 'core'
        ? {
            label: 'core_with_a_long_name',
            ports: [
              { name: 'clk', dir: 'input', width: 1 },
              { name: 'data_in', dir: 'input', width: 8 },
              { name: 'q', dir: 'output', width: 8 },
            ],
          }
        : undefined;
    const variants: SymParams[] = [
      {},
      { width: 1 },
      { width: 3 },
      { width: 13 },
      { width: 256 },
      { inputs: 3, width: 7 },
      { inputs: 8 },
      { parts: 3, width: 5 },
      { parts: 16, width: 1 },
      { shift: 16 },
      { value: "8'hFF" },
      { value: "32'd1234567" },
      { module: 'core' },
    ];
    const names = [undefined, 'a', 'clk_enable', 'Wide_Bus_Name[7:0]', 'u7'];
    let checked = 0;
    for (const measure of [approxMeasure, fractional]) {
      for (const def of SYMBOLS) {
        for (const params of variants) {
          for (const name of names) {
            const u = newUserNode('u:1', def.key, name === undefined ? {} : { name });
            const n = symbolNode({ ...u, params: { ...u.params, ...params } }, iface);
            const s = sizeNode(n, measure);
            const what = `${def.key} ${JSON.stringify(params)} ${name ?? ''}`;
            expect(s.width, what).toBeGreaterThan(0);
            if (n.kind === 'text') continue;
            // A symbol placed on the 10 px grid has every pin on it, so wires between pins run on the grid.
            expect(s.width % 10, `${what} width`).toBe(0);
            expect(s.height % 10, `${what} height`).toBe(0);
            for (const p of n.ports) {
              const at = s.ports[p.id];
              expect(at.x % 10, `${what}: ${p.name}.x`).toBe(0);
              // A MUX's select pin too: it is on the grid line under its sloped bottom edge.
              expect(at.y % 10, `${what}: ${p.name}.y`).toBe(0);
              if (p.side === 'SOUTH') expect(at.y, `${what}: ${p.name} on the bottom edge`).toBe(s.height);
              checked++;
            }
            // Bottom pins (CLK, EN, ARST, S) are apart, inside the edge, and centred on it.
            const south = n.ports.filter((p) => p.side === 'SOUTH').map((p) => s.ports[p.id].x);
            for (const [k, x] of south.entries()) {
              expect(x > 0 && x < s.width, `${what}: bottom pin inside`).toBe(true);
              if (k) expect(x - south[k - 1], `${what}: bottom pins apart`).toBeGreaterThanOrEqual(20);
            }
            if (south.length) expect(south[0] + south[south.length - 1], `${what}: bottom pins centred`).toBe(s.width);
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('puts the bottom and top pins of imported cells and instances on the grid', () => {
    const fractional: MeasureText = (text, size) => text.length * size * 0.6173 + 0.41;
    const port = (name: string, dir: 'in' | 'out', side: Side): DPort => ({ id: `n.${name}`, name, dir, side, width: 1 });
    const nodes: DNode[] = [
      // A register with an enable and an asynchronous reset has three pins at the bottom.
      { id: 'n', kind: 'cell', label: 'DFF', cellType: '$adffe', src: [], ports: [port('D', 'in', 'WEST'), port('CLK', 'in', 'SOUTH'), port('EN', 'in', 'SOUTH'), port('ARST', 'in', 'SOUTH'), port('Q', 'out', 'EAST')] },
      { id: 'n', kind: 'cell', label: 'MUX', cellType: '$pmux', src: [], ports: [port('A', 'in', 'WEST'), port('B', 'in', 'WEST'), port('C', 'in', 'WEST'), port('S', 'in', 'SOUTH'), port('Y', 'out', 'EAST')] },
      { id: 'n', kind: 'instance', label: 'odd', src: [], ports: [port('a', 'in', 'WEST'), port('t1', 'in', 'NORTH'), port('t2', 'in', 'NORTH'), port('b1', 'in', 'SOUTH'), port('y', 'out', 'EAST')] },
    ];
    for (const n of nodes) {
      for (const measure of [approxMeasure, fractional]) {
        const s = sizeNode(n, measure);
        for (const p of n.ports) {
          expect(s.ports[p.id].x % 10, `${n.cellType ?? n.kind}.${p.name}.x`).toBe(0);
          expect(s.ports[p.id].y % 10, `${n.cellType ?? n.kind}.${p.name}.y`).toBe(0);
        }
        const xs = n.ports.filter((p) => p.side === 'SOUTH' || p.side === 'NORTH').map((p) => s.ports[p.id].x);
        for (const x of xs) expect(x > 0 && x < s.width).toBe(true);
      }
    }
  });

  it('blocks take their ports from the module interface', () => {
    const iface: InterfaceOf = (m) =>
      m === 'inc' ? { label: 'inc', ports: [{ name: 'a', dir: 'input', width: 4 }, { name: 'y', dir: 'output', width: 4 }] } : undefined;
    const b = symbolNode({ id: 'u:1', sym: 'block', params: { module: 'inc' }, name: 'u0' }, iface);
    expect(b.kind).toBe('instance');
    expect(b.ports.map((p) => `${p.name}:${p.side}`)).toEqual(['a:WEST', 'y:EAST']);
    expect(b.subLabel).toBe('u0');
  });
});

describe('edits over an imported sheet', () => {
  it('keeps manual positions and hand-drawn parts when the Verilog changes', async () => {
    const d1 = await design({ 't.v': V1 });
    const base1 = buildDiagram(d1, 't');
    const elk1 = await layoutDiagram(base1);
    // First edit pins the ELK layout.
    let e = layoutToEdits(emptyEdits(), elk1, 'existing');
    const add = base1.nodes.find((n) => n.cellType === '$add')!;
    e = moveNodes(e, base1, [add.id], 100, 40);
    const moved = e.pos[add.id];
    // Draw a NOT gate fed by input a, and rename the input pin.
    e = addNodes(e, [{ node: newUserNode('u:1', 'not', { params: { width: 4 } }), pos: { x: 500, y: 500 } }]);
    e = { ...e, next: 2 };
    let d = effectiveDiagram('t', base1, e, noModules);
    const c = resolveConnection(d, { kind: 'port', node: 'in:a', port: 'in:a.out' }, { kind: 'port', node: 'u:1', port: 'u:1.A' });
    expect('error' in c).toBe(false);
    if ('error' in c) return;
    let wid: string;
    [wid, e] = connect(e, c);
    e = rename(e, 'in:a', 'alpha');
    d = effectiveDiagram('t', base1, e, noModules);
    expect(d.edges.some((x) => x.id === wid && x.width === 4)).toBe(true);
    expect(d.nodes.find((n) => n.id === 'in:a')!.label).toBe('alpha');

    // Re-import with an extra XOR.
    const d2 = await design({ 't.v': V2 });
    const base2 = buildDiagram(d2, 't');
    const elk2 = await layoutDiagram(base2);
    const eff2 = effectiveDiagram('t', base2, e, noModules);
    expect(eff2.nodes.find((n) => n.id === add.id)).toBeDefined();
    const pos2 = placeMissing(eff2, e.pos, elk2, (n) => sizeNode(n, approxMeasure));
    // The moved adder stays where the user put it; the new XOR and pin get a place.
    expect(pos2[add.id]).toEqual(moved);
    const xor = eff2.nodes.find((n) => n.cellType === '$xor')!;
    expect(pos2[xor.id]).toBeDefined();
    expect(pos2['out:w']).toBeDefined();
    // The hand-drawn wire and the rename survive.
    expect(eff2.edges.some((x) => x.id === wid)).toBe(true);
    expect(eff2.nodes.find((n) => n.id === 'in:a')!.label).toBe('alpha');
    // New symbols do not overlap old ones.
    const rect = (id: string) => {
      const n = eff2.nodes.find((x) => x.id === id)!;
      const s = sizeNode(n, approxMeasure);
      return { x: pos2[id].x, y: pos2[id].y, w: s.width, h: s.height };
    };
    const r = rect(xor.id);
    for (const n of eff2.nodes) {
      if (n.id === xor.id || !e.pos[n.id]) continue;
      const o = rect(n.id);
      const overlap = r.x < o.x + o.w && r.x + r.w > o.x && r.y < o.y + o.h && r.y + r.h > o.y;
      expect(overlap, `${xor.id} overlaps ${n.id}`).toBe(false);
    }
  });

  it('hides deleted imported items and removes hand-drawn ones', async () => {
    const d1 = await design({ 't.v': V1 });
    const base = buildDiagram(d1, 't');
    let e = layoutToEdits(emptyEdits(), await layoutDiagram(base), 'existing');
    e = addNodes(e, [{ node: newUserNode('u:1', 'text', { name: 'hello' }), pos: { x: 0, y: 0 } }]);
    const eq = base.nodes.find((n) => n.cellType === '$eq')!;
    const d = effectiveDiagram('t', base, e, noModules);
    e = deleteItems(e, d, [eq.id, 'u:1']);
    const after = effectiveDiagram('t', base, e, noModules);
    expect(after.nodes.some((n) => n.id === eq.id)).toBe(false);
    expect(after.nodes.some((n) => n.id === 'u:1')).toBe(false);
    expect(e.hidden).toContain(eq.id);
    // Wires on the deleted operator go too.
    expect(after.edges.some((x) => x.source.node === eq.id || x.target.node === eq.id)).toBe(false);
  });

  it('refuses output-to-output and joins an undriven input to a driven one', () => {
    let e = emptyEdits();
    e = addNodes(e, [
      { node: newUserNode('u:1', 'input', { name: 'a' }), pos: { x: 0, y: 0 } },
      { node: newUserNode('u:2', 'not'), pos: { x: 100, y: 0 } },
      { node: newUserNode('u:3', 'not'), pos: { x: 100, y: 100 } },
    ]);
    let d = effectiveDiagram('m', undefined, e, noModules);
    const bad = resolveConnection(d, { kind: 'port', node: 'u:2', port: 'u:2.Y' }, { kind: 'port', node: 'u:3', port: 'u:3.Y' });
    expect('error' in bad).toBe(true);
    const c = resolveConnection(d, { kind: 'port', node: 'u:2', port: 'u:2.A' }, { kind: 'port', node: 'u:1', port: 'u:1.out' });
    if ('error' in c) throw new Error(c.error);
    expect(c.reversed).toBe(true);
    [, e] = connect(e, c);
    d = effectiveDiagram('m', undefined, e, noModules);
    // Input to input: the second NOT gets a's driver.
    const c2 = resolveConnection(d, { kind: 'port', node: 'u:3', port: 'u:3.A' }, { kind: 'port', node: 'u:2', port: 'u:2.A' });
    if ('error' in c2) throw new Error(c2.error);
    expect(c2.source.port).toBe('u:1.out');
    // A wire end connects to the wire's driver.
    const c3 = resolveConnection(d, { kind: 'wire', edge: d.edges[0].id, at: { x: 50, y: 10 } }, { kind: 'port', node: 'u:3', port: 'u:3.A' });
    if ('error' in c3) throw new Error(c3.error);
    expect(c3.source.port).toBe('u:1.out');
  });

  it('copies imported symbols as editable ones and pastes them with new IDs', async () => {
    const d1 = await design({ 't.v': V1 });
    const base = buildDiagram(d1, 't');
    const elk = await layoutDiagram(base);
    let e = layoutToEdits(emptyEdits(), elk, 'existing');
    const add = base.nodes.find((n) => n.cellType === '$add')!;
    const u = toUserNode(add, 'x', noModules);
    expect(u.sym).toBe('add');
    expect(u.params.width).toBe(4);
    const ids = new Set([add.id, 'in:a', 'in:b']);
    const clip = copyNodes(base, e, elk, ids, noModules)!;
    expect(clip.nodes).toHaveLength(3);
    expect(clip.edges.length).toBeGreaterThanOrEqual(2);
    let pasted: string[];
    [e, pasted] = pasteClip(e, clip, { x: 1000, y: 1000 });
    const d = effectiveDiagram('t', base, e, noModules);
    for (const id of pasted) expect(d.nodes.some((n) => n.id === id) || d.edges.some((x) => x.id === id)).toBe(true);
    // The pasted adder is wired to the pasted pins, not to the originals.
    const pastedAdd = d.nodes.find((n) => pasted.includes(n.id) && n.cellType === '$add')!;
    const into = d.edges.filter((x) => x.target.node === pastedAdd.id);
    expect(into.length).toBe(2);
    for (const x of into) expect(pasted).toContain(x.source.node);
  });

  it('turns a whole sheet into a drawing that draws the same circuit', async () => {
    const d1 = await design({ 't.v': V1 });
    const base = buildDiagram(d1, 't');
    const elk = await layoutDiagram(base);
    const drawing = toDrawing(base, elk, emptyEdits(), noModules);
    const d = effectiveDiagram('t_drawing', undefined, drawing, noModules);
    expect(d.nodes.length).toBe(base.nodes.length);
    expect(d.edges.length).toBe(base.edges.length);
    const sig = (x: typeof d) =>
      x.edges.map((e) => `${e.source.port}>${e.target.port}:${e.width}`).sort();
    expect(sig(d)).toEqual(sig(base));
  });
});

/** A port end, from its port ID (port names never contain a dot). */
const at = (port: string): WireEnd => ({ kind: 'port', node: port.slice(0, port.lastIndexOf('.')), port });
const onWire = (edge: string): WireEnd => ({ kind: 'wire', edge, at: { x: 0, y: 0 } });

/** A sheet edited through the edit operations, the way the editor edits one. */
class Drawing {
  e: SheetEdits = emptyEdits();
  private iface: InterfaceOf;
  private base?: Diagram;

  constructor(iface: InterfaceOf = noModules, base?: Diagram) {
    this.iface = iface;
    this.base = base;
  }

  add(sym: SymKey, name?: string, params: SymParams = {}): string {
    const [id, e1] = newId(this.e, 'u');
    const u = newUserNode(id, sym, name === undefined ? {} : { name });
    u.params = { ...u.params, ...params };
    this.e = addNodes(e1, [{ node: u, pos: { x: 0, y: 0 } }]);
    return id;
  }

  get d(): Diagram {
    return effectiveDiagram('m', this.base, this.e, this.iface);
  }

  /** Draw a wire between two ends (port IDs or wire ends); fails the test when it is refused. */
  wire(a: string | WireEnd, b: string | WireEnd): string {
    const c = resolveConnection(this.d, typeof a === 'string' ? at(a) : a, typeof b === 'string' ? at(b) : b);
    if ('error' in c) throw new Error(c.error);
    let id: string;
    [id, this.e] = connect(this.e, c);
    return id;
  }
}

describe('wires joined to a sliced wire', () => {
  it('carry the same slice when they tap the wire or join the input it feeds', () => {
    const s = new Drawing();
    const a = s.add('input', 'a', { width: 8 });
    const n1 = s.add('not', undefined, { width: 2 });
    const n2 = s.add('not', undefined, { width: 2 });
    const n3 = s.add('not', undefined, { width: 2 });
    const w1 = s.wire(`${a}.out`, `${n1}.A`);
    s.e = setSlice(s.e, w1, { lo: 2, width: 2 });
    for (const [k, n] of [n1, n2, n3].entries()) s.wire(`${n}.Y`, `${s.add('output', `y${k + 1}`, { width: 2 })}.in`);
    // Drawn from the input to the wire (reversed), and from one input to the other.
    const w2 = s.wire(`${n2}.A`, onWire(w1));
    const w3 = s.wire(`${n3}.A`, `${n1}.A`);
    const d = s.d;
    for (const id of [w2, w3]) {
      expect(d.edges.find((x) => x.id === id)).toMatchObject({ source: { port: `${a}.out` }, width: 2, bits: { lo: 2, width: 2 } });
    }
    expect(checkSheet(d).messages).toEqual([]);
    // Each output is the inverse of a[3:2].
    for (const [k, n] of [n1, n2, n3].entries()) {
      expect(feeds(d, `${n}.A`), n).toEqual([`${a}.out[3:2]`]);
      const y = d.nodes.find((x) => x.label === `y${k + 1}`)!;
      expect(feeds(d, `${y.id}.in`), y.label).toEqual([`${n}.Y`]);
    }
    // The same bits again are a duplicate; the whole bus is a different wire.
    expect(resolveConnection(d, onWire(w1), at(`${n2}.A`))).toEqual({ error: 'These pins are already connected.' });
    expect(resolveConnection(d, at(`${a}.out`), at(`${n2}.A`))).not.toHaveProperty('error');
  });

  it('carry the slice of an imported wire', async () => {
    const base = buildDiagram(await design({ 't.v': 'module t(input [7:0] a, output [1:0] y);\n  assign y = a[3:2];\nendmodule\n' }), 't');
    const edge = base.edges.find((x) => x.target.port === 'out:y.in')!;
    expect(edge.bits).toEqual({ lo: 2, width: 2 });
    const s = new Drawing(noModules, base);
    const y2 = s.add('output', 'y2', { width: 2 });
    const w = s.wire(onWire(edge.id), `${y2}.in`);
    expect(s.d.edges.find((x) => x.id === w)).toMatchObject({ source: edge.source, width: 2, bits: { lo: 2, width: 2 } });
    expect(feeds(s.d, `${y2}.in`)).toEqual(['in:a.out[3:2]']);
  });

  it('keep the zero bits of a scaled (×4) wire they tap or join', async () => {
    const src = "module t(input [3:0] a, input [1:0] b, output [3:0] y);\n  assign y = a + {b, 2'b00};\nendmodule\n";
    const base = buildDiagram(await design({ 't.v': src }), 't', DEFAULT_RULES);
    const scaled = base.edges.find((x) => x.shift)!;
    expect(scaled).toMatchObject({ width: 2, shift: 2, label: '×4' });
    const s = new Drawing(noModules, base);
    const tap = s.add('output', 'tap', { width: 4 });
    const joined = s.add('output', 'joined', { width: 4 });
    // Tapping the wire, and joining the adder input it feeds.
    const w1 = s.wire(onWire(scaled.id), `${tap}.in`);
    const w2 = s.wire(`${joined}.in`, scaled.target.port);
    for (const id of [w1, w2]) expect(s.d.edges.find((x) => x.id === id), id).toMatchObject({ source: scaled.source, width: 2, shift: 2 });
    expect(checkSheet(s.d).messages).toEqual([]);
    // Both outputs are {b, 2'b00}.
    for (const id of [tap, joined]) expect(feeds(s.d, `${id}.in`), id).toEqual(['in:b.out<<2']);
    // The scaled bits again are a duplicate; the plain bus is a different wire.
    expect(resolveConnection(s.d, onWire(scaled.id), at(`${tap}.in`))).toEqual({ error: 'These pins are already connected.' });
    expect(resolveConnection(s.d, at(scaled.source.port), at(`${tap}.in`))).not.toHaveProperty('error');

    // A wire copied into a drawing keeps its zero bits in `shift`, and a tap of it does too.
    // A label is only text: writing `×4` on a hand-drawn wire changes nothing.
    const d = new Drawing();
    const b = d.add('input', 'b', { width: 2 });
    const add = d.add('add', undefined, { width: 4 });
    const y = d.add('output', 'y', { width: 4 });
    const w = d.wire(`${b}.out`, `${add}.B`);
    d.e = { ...d.e, edges: d.e.edges.map((x) => (x.id === w ? { ...x, shift: 2 } : x)) };
    const t = d.wire(onWire(w), `${y}.in`);
    expect(d.d.edges.find((x) => x.id === t)).toMatchObject({ source: { port: `${b}.out` }, width: 2, shift: 2 });
    expect(feeds(d.d, `${add}.B`)).toEqual([`${b}.out<<2`]);
    expect(feeds(d.d, `${y}.in`)).toEqual([`${b}.out<<2`]);
    d.e = { ...d.e, edges: d.e.edges.map((x) => (x.id === w || x.id === t ? { ...x, shift: undefined, label: '×4' } : x)) };
    for (const id of [w, t]) {
      const x = d.d.edges.find((x) => x.id === id)!;
      expect(x.label, id).toBe('×4');
      expect(x.shift, id).toBeUndefined();
      expect(wireShift(x), id).toBe(0);
    }
    expect(feeds(d.d, `${y}.in`)).toEqual([`${b}.out`]);
    expect(feeds(d.d, `${add}.B`)).toEqual([`${b}.out`]);
  });
});

describe('inout ports of blocks', () => {
  const iface: InterfaceOf = (m) =>
    m === 'child'
      ? {
          label: 'child',
          ports: [
            { name: 'bus', dir: 'inout', width: 4 },
            { name: 'en', dir: 'input', width: 1 },
          ],
        }
      : undefined;

  it('can be wired to each other and to pins, and need no driver', () => {
    const s = new Drawing(iface);
    const c1 = s.add('block', 'c1', { module: 'child' });
    const c2 = s.add('block', 'c2', { module: 'child' });
    const io = s.add('inout', 'io', { width: 4 });
    const y = s.add('output', 'y', { width: 4 });
    const w = s.wire(`${c1}.bus`, `${c2}.bus`);
    expect(s.d.edges.find((x) => x.id === w)).toMatchObject({ source: { port: `${c1}.bus` }, target: { port: `${c2}.bus` } });
    expect(resolveConnection(s.d, at(`${c2}.bus`), at(`${c1}.bus`))).toEqual({ error: 'These pins are already connected.' });
    // The inside end of an inout pin and an output pin join the same bus.
    s.wire(`${io}.in`, `${c2}.bus`);
    s.wire(`${y}.in`, `${c1}.bus`);
    const targets = s.d.edges.filter((x) => x.source.port === `${c1}.bus`).map((x) => x.target.port);
    expect(targets.sort()).toEqual([`${c2}.bus`, `${io}.in`, `${y}.in`].sort());
    const issues = checkSheet(s.d);
    // Only the plain inputs are open; nothing is a second driver.
    expect([...issues.openPorts!].sort()).toEqual([`${c1}.en`, `${c2}.en`]);
    expect(issues.flagged.size).toBe(0);
    // Two plain inputs without a driver still cannot be joined.
    expect(resolveConnection(s.d, at(`${c1}.en`), at(`${c2}.en`))).toHaveProperty('error');
  });

  it('do not count as a second driver of a net', () => {
    const s = new Drawing(iface);
    const c1 = s.add('block', 'c1', { module: 'child' });
    const c2 = s.add('block', 'c2', { module: 'child' });
    const d1 = s.add('input', 'd1', { width: 4 });
    const d2 = s.add('input', 'd2', { width: 4 });
    s.wire(`${c1}.bus`, `${c2}.bus`);
    const w1 = s.wire(`${d1}.out`, `${c2}.bus`);
    expect(checkSheet(s.d).flagged.size).toBe(0);
    const w2 = s.wire(`${d2}.out`, `${c2}.bus`);
    expect([...checkSheet(s.d).flagged].sort()).toEqual([w1, w2].sort());
  });

  it('of imported instances are not reported as open inputs', async () => {
    const v = `module child(inout [3:0] bus, input en, input [3:0] d, output [3:0] q);
  assign bus = en ? d : 4'bz;
  assign q = bus;
endmodule
module top(input e1, input e2, input [3:0] d, output [3:0] q1, output [3:0] q2);
  wire [3:0] bus;
  child c1(.bus(bus), .en(e1), .d(d), .q(q1));
  child c2(.bus(bus), .en(e2), .d(d), .q(q2));
endmodule
`;
    const base = buildDiagram(await design({ 't.v': v }, 'top'), 'top');
    expect(base.nodes.flatMap((n) => n.ports).filter((p) => p.inout)).toHaveLength(2);
    expect(checkSheet(base).messages).toEqual([]);
  });
});

describe('sheet checks', () => {
  it('say why a wire is flagged: a width mismatch, or another driver of its input', () => {
    const s = new Drawing();
    const [i1, i2] = ['in1', 'in2'].map((n) => s.add('input', n));
    const wide = s.add('input', 'wide', { width: 4 });
    const g = s.add('and');
    s.wire(`${i1}.out`, `${g}.A`);
    const w2 = s.wire(`${i2}.out`, `${g}.B`);
    const w3 = s.wire(`${i1}.out`, `${g}.B`);
    let issues = checkSheet(s.d);
    expect([...issues.flagged].sort()).toEqual([w2, w3].sort());
    for (const id of [w2, w3]) expect(issues.reasons?.get(id)).toBe('its input has another driver');
    expect(issues.messages).toEqual(['1 input driven by more than one wire.']);
    // A third wire, 4 bits wide, into the same 1-bit input is both.
    const w4 = s.wire(`${wide}.out`, `${g}.B`);
    issues = checkSheet(s.d);
    expect(issues.reasons?.get(w4)).toBe('does not match the input it feeds, and its input has another driver');
    expect(issues.reasons?.get(w2)).toBe('its input has another driver');
    s.e = deleteItems(s.e, s.d, [w2, w3]);
    expect(checkSheet(s.d).reasons?.get(w4)).toBe('does not match the input it feeds');
  });
});

describe('changing parameters', () => {
  /** `<source node>><target port name>` of the wires into a node. */
  const into = (d: Diagram, id: string) =>
    d.edges
      .filter((x) => x.target.node === id)
      .map((x) => `${x.source.node}>${x.target.port.slice(id.length + 1)}`)
      .sort();
  const outOf = (d: Diagram, id: string) =>
    d.edges
      .filter((x) => x.source.node === id)
      .map((x) => `${x.source.port.slice(id.length + 1)}>${x.target.node}`)
      .sort();

  it('keeps the wires of a MUX when its number of inputs changes', () => {
    const s = new Drawing();
    const [a, b, c, sel] = ['a', 'b', 'c', 's'].map((n) => s.add('input', n));
    const m = s.add('mux');
    s.wire(`${a}.out`, `${m}.A`);
    s.wire(`${b}.out`, `${m}.B`);
    s.wire(`${sel}.out`, `${m}.S`);
    s.wire(`${m}.Y`, `${s.add('output', 'y')}.in`);
    s.e = setParams(s.e, m, { inputs: 3 });
    expect(into(s.d, m)).toEqual([`${a}>I0`, `${b}>I1`, `${sel}>S`]);
    expect(s.d.edges).toHaveLength(4);
    s.wire(`${c}.out`, `${m}.I2`);
    // Back to two inputs: the third wire has no input to go to, and comes back with it.
    s.e = setParams(s.e, m, { inputs: 2 });
    expect(into(s.d, m)).toEqual([`${a}>A`, `${b}>B`, `${sel}>S`]);
    s.e = setParams(s.e, m, { inputs: 3 });
    expect(into(s.d, m)).toEqual([`${a}>I0`, `${b}>I1`, `${c}>I2`, `${sel}>S`]);
  });

  it('keeps the wires of a concatenation and a split when their slices change', () => {
    const s = new Drawing();
    const hi = s.add('input', 'hi', { width: 4 });
    const lo = s.add('input', 'lo', { width: 4 });
    const cat = s.add('concat', undefined, { parts: 2, width: 4 });
    const sp = s.add('split', undefined, { parts: 2, width: 4 });
    const y1 = s.add('output', 'y1', { width: 4 });
    const y0 = s.add('output', 'y0', { width: 4 });
    s.wire(`${hi}.out`, `${cat}.[7:4]`);
    s.wire(`${lo}.out`, `${cat}.[3:0]`);
    s.wire(`${cat}.out`, `${sp}.in`);
    s.wire(`${sp}.[7:4]`, `${y1}.in`);
    s.wire(`${sp}.[3:0]`, `${y0}.in`);
    s.e = setParams(s.e, cat, { width: 8 });
    s.e = setParams(s.e, sp, { width: 8 });
    expect(s.d.edges).toHaveLength(5);
    expect(into(s.d, cat)).toEqual([`${hi}>[15:8]`, `${lo}>[7:0]`]);
    expect(outOf(s.d, sp)).toEqual([`[15:8]>${y1}`, `[7:0]>${y0}`]);
    // One more part: the existing parts keep their bits, the new top part is open.
    s.e = setParams(s.e, cat, { parts: 3 });
    expect(into(s.d, cat)).toEqual([`${hi}>[15:8]`, `${lo}>[7:0]`]);
    // Slices are matched from the LSB, also when both parameters change at once.
    s.e = setParams(s.e, cat, { parts: 2, width: 2 });
    expect(into(s.d, cat)).toEqual([`${hi}>[3:2]`, `${lo}>[1:0]`]);
  });

  it('drops the wire of a gate input that goes away, and only that one', () => {
    const s = new Drawing();
    const [a, b, c] = ['a', 'b', 'c'].map((n) => s.add('input', n));
    const g = s.add('and', undefined, { inputs: 3 });
    s.wire(`${a}.out`, `${g}.A`);
    s.wire(`${b}.out`, `${g}.B`);
    s.wire(`${c}.out`, `${g}.C`);
    s.e = setParams(s.e, g, { inputs: 2 });
    expect(into(s.d, g)).toEqual([`${a}>A`, `${b}>B`]);
  });

  it("brings a slice's hidden wire back with the slice, also after the width changed", () => {
    const s = new Drawing();
    const [a, b, c] = ['a', 'b', 'c'].map((n) => s.add('input', n, { width: 4 }));
    const cat = s.add('concat', undefined, { parts: 3, width: 4 });
    s.wire(`${a}.out`, `${cat}.[11:8]`);
    s.wire(`${b}.out`, `${cat}.[7:4]`);
    s.wire(`${c}.out`, `${cat}.[3:0]`);
    // a's wire is hidden with the top slice; the slices are then 8 bits wide, and the top one is back as [23:16].
    s.e = setParams(s.e, cat, { parts: 2 });
    expect(into(s.d, cat)).toEqual([`${b}>[7:4]`, `${c}>[3:0]`]);
    s.e = setParams(s.e, cat, { width: 8 });
    s.e = setParams(s.e, cat, { parts: 3 });
    expect(into(s.d, cat)).toEqual([`${a}>[23:16]`, `${b}>[15:8]`, `${c}>[7:0]`]);
    // Both at once: fewer slices of another width.
    s.e = setParams(s.e, cat, { parts: 2, width: 2 });
    expect(into(s.d, cat)).toEqual([`${b}>[3:2]`, `${c}>[1:0]`]);
    s.e = setParams(s.e, cat, { parts: 3, width: 4 });
    expect(into(s.d, cat)).toEqual([`${a}>[11:8]`, `${b}>[7:4]`, `${c}>[3:0]`]);
    expect(checkSheet(s.d).messages.join(' ')).not.toContain('more than one wire');
  });

  it('brings back one wire only when two were hidden on one slice (a file saved before hidden wires followed the width)', () => {
    const s = new Drawing();
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((n) => s.add('input', n, { width: 8 }));
    const cat = s.add('concat', undefined, { parts: 3, width: 8 });
    s.wire(`${d}.out`, `${cat}.[23:16]`);
    s.wire(`${b}.out`, `${cat}.[15:8]`);
    s.wire(`${c}.out`, `${cat}.[7:0]`);
    // a's wire as such a file keeps it: hidden on [11:8], a slice of the width before.
    s.e = { ...s.e, edges: [...s.e.edges, { id: 'w:old', source: { node: a, port: `${a}.out` }, target: { node: cat, port: `${cat}.[11:8]` } }] };
    const start = s.e;
    for (const steps of [[{ parts: 2 }, { width: 4 }, { parts: 3 }], [{ parts: 2, width: 4 }, { parts: 3 }]]) {
      s.e = start;
      for (const p of steps) s.e = setParams(s.e, cat, p);
      expect(into(s.d, cat)).toEqual([`${a}>[11:8]`, `${b}>[7:4]`, `${c}>[3:0]`]);
      expect(checkSheet(s.d).messages.join(' ')).not.toContain('more than one wire');
    }
  });

  it('brings back a wire before an older one that stays hidden, and both wires of an input shared with an inout', () => {
    // A split's output: [31:24] to y is hidden, [23:16] to y wired meanwhile and hidden too.
    const s = new Drawing();
    const bus = s.add('input', 'bus', { width: 32 });
    const sp = s.add('split', undefined, { parts: 4, width: 8 });
    const y = s.add('output', 'y', { width: 8 });
    s.wire(`${bus}.out`, `${sp}.in`);
    s.wire(`${sp}.[31:24]`, `${y}.in`);
    s.e = setParams(s.e, sp, { parts: 3 });
    s.wire(`${sp}.[23:16]`, `${y}.in`);
    s.e = setParams(s.e, sp, { parts: 2 });
    // Three slices of 4 bits: the newer wire is back on [11:8]; the older one ([15:12] now) stays hidden.
    s.e = setParams(s.e, sp, { parts: 3, width: 4 });
    expect(s.d.edges.filter((w) => w.target.node === y).map((w) => w.source.port)).toEqual([`${sp}.[11:8]`]);
    expect(s.e.edges).toHaveLength(3);
    // Four slices: the older one would be a second driver of y.
    s.e = setParams(s.e, sp, { parts: 4 });
    expect(s.d.edges.filter((w) => w.target.node === y).map((w) => w.source.port)).toEqual([`${sp}.[11:8]`]);
    expect(checkSheet(s.d).messages.join(' ')).not.toContain('more than one wire');

    // Two wires hidden at different times, on two slices, coming back at once: one drives y.
    const r = new Drawing();
    const rb = r.add('input', 'bus', { width: 32 });
    const rs = r.add('split', undefined, { parts: 4, width: 8 });
    const ry = r.add('output', 'y', { width: 8 });
    r.wire(`${rb}.out`, `${rs}.in`);
    r.wire(`${rs}.[31:24]`, `${ry}.in`);
    r.e = setParams(r.e, rs, { parts: 3 });
    r.wire(`${rs}.[23:16]`, `${ry}.in`);
    r.e = setParams(r.e, rs, { parts: 2 });
    r.e = setParams(r.e, rs, { parts: 4 });
    expect(r.d.edges.filter((w) => w.target.node === ry)).toHaveLength(1);
    expect(checkSheet(r.d).messages.join(' ')).not.toContain('more than one wire');

    // A wire hidden on another symbol drives nothing: the returning one comes back.
    const q = new Drawing();
    const qb = q.add('input', 'bus', { width: 24 });
    const [q1, q2] = [0, 1].map(() => q.add('split', undefined, { parts: 3, width: 8 }));
    const qy = q.add('output', 'y', { width: 8 });
    q.wire(`${qb}.out`, `${q1}.in`);
    q.wire(`${qb}.out`, `${q2}.in`);
    q.wire(`${q1}.[23:16]`, `${qy}.in`);
    q.e = setParams(q.e, q1, { parts: 2 });
    q.wire(`${q2}.[23:16]`, `${qy}.in`);
    q.e = setParams(q.e, q2, { parts: 2 });
    q.e = setParams(q.e, q1, { parts: 3 });
    expect(q.d.edges.filter((w) => w.target.node === qy).map((w) => w.source.port)).toEqual([`${q1}.[23:16]`]);
    q.e = setParams(q.e, q2, { parts: 3 });
    expect(q.d.edges.filter((w) => w.target.node === qy).map((w) => w.source.port)).toEqual([`${q1}.[23:16]`]);

    // An inout's wire and a driver on one slice: both are hidden, and both come back.
    const iface: InterfaceOf = (m) => (m === 'pad' ? { label: 'pad', ports: [{ name: 'io', dir: 'inout', width: 8 }] } : undefined);
    const t = new Drawing(iface);
    const a = t.add('input', 'a', { width: 8 });
    const cat = t.add('concat', undefined, { parts: 3, width: 8 });
    const pad = t.add('block', 'p', { module: 'pad' });
    t.wire(`${pad}.io`, `${cat}.[23:16]`);
    t.wire(`${a}.out`, `${cat}.[23:16]`);
    const before = t.d.edges.filter((w) => w.target.node === cat).length;
    for (const steps of [[{ parts: 2 }, { parts: 3 }], [{ parts: 2 }, { parts: 3, width: 4 }]]) {
      let e = t.e;
      for (const p of steps) e = setParams(e, cat, p, iface);
      expect(effectiveDiagram('m', undefined, e, iface).edges.filter((w) => w.target.node === cat)).toHaveLength(before);
    }
  });

  it('never brings back a hidden wire onto an input that another wire drives', () => {
    // A split's output: a hidden wire stays away from an input wired meanwhile.
    const t = new Drawing();
    const bus = t.add('input', 'bus', { width: 12 });
    const x = t.add('input', 'x', { width: 4 });
    const sp = t.add('split', undefined, { parts: 3, width: 4 });
    const [y2, y1] = ['y2', 'y1'].map((n) => t.add('output', n, { width: 4 }));
    t.wire(`${bus}.out`, `${sp}.in`);
    t.wire(`${sp}.[11:8]`, `${y2}.in`);
    t.wire(`${sp}.[7:4]`, `${y1}.in`);
    t.e = setParams(t.e, sp, { parts: 2 });
    t.wire(`${x}.out`, `${y2}.in`);
    // Slices and width at once (the JSON window, a preset): the wire would come back on [23:16].
    const once = setParams(t.e, sp, { parts: 3, width: 8 });
    t.e = setParams(t.e, sp, { parts: 3 });
    expect(t.d.edges.filter((w) => w.target.node === y2).map((w) => w.source.node)).toEqual([x]);
    expect(checkSheet(t.d).messages.join(' ')).not.toContain('more than one wire');
    t.e = once;
    expect(t.d.edges.filter((w) => w.target.node === y2).map((w) => w.source.node)).toEqual([x]);
    expect(checkSheet(t.d).messages.join(' ')).not.toContain('more than one wire');
  });
});

describe('imported symbols', () => {
  it('never change a constant when it is renamed', async () => {
    const base = buildDiagram(await design({ 't.v': "module t(input [3:0] b, output y);\n  assign y = b != 4'd5;\nendmodule\n" }), 't');
    const k = base.nodes.find((n) => n.kind === 'const')!;
    expect(k.label).toBe("4'd5");
    const before = effectiveDiagram('t', base, emptyEdits(), noModules);
    for (const text of ['ZERO', "4'd7"]) {
      const d = effectiveDiagram('t', base, rename(emptyEdits(), k.id, text), noModules);
      const n = d.nodes.find((x) => x.id === k.id)!;
      expect(n.label).toBe("4'd5");
      // The sheet is the same in every way, its logic included.
      expect(d).toEqual(before);
      expect(toUserNode(n, 'u:1', noModules).params.value).toBe("4'd5");
    }
  });

  it('keep pins wider than the library allows as frozen copies', async () => {
    const base = buildDiagram(await design({ 'w.v': 'module w(input [299:0] a, output [299:0] y);\n  assign y = ~a;\nendmodule\n' }), 'w');
    const drawing = toDrawing(base, await layoutDiagram(base), emptyEdits(), noModules);
    const d = effectiveDiagram('w2', undefined, drawing, noModules);
    for (const n of d.nodes) for (const p of n.ports) expect(p.width, `${n.id}.${p.name}`).toBe(300);
    expect(checkSheet(d).messages).toEqual([]);
    expect(drawing.nodes.filter((n) => n.raw?.kind === 'input' || n.raw?.kind === 'output').map((n) => n.raw!.label)).toEqual(['a', 'y']);
    // The frozen copies are pins all the same: the drawing computes what the sheet did, and its blocks have both ports.
    expect(logic(d)).toEqual(logic(base));
    expect(drawingPorts(drawing).map(({ name, dir, width }) => ({ name, dir, width }))).toEqual([
      { name: 'a', dir: 'input', width: 300 },
      { name: 'y', dir: 'output', width: 300 },
    ]);
  });
});

describe('Copy to new drawing', () => {
  it('keeps the bit order of a concatenation into a bus declared [0:n]', async () => {
    const body = (range: string, rhs: string) => `module t(input a, input b, input c, input d, output ${range} y);\n  assign y = ${rhs};\nendmodule\n`;
    for (const [range, rhs, bar] of [
      ['[0:3]', '{a, b, c, d}', 'raw'],
      ['[0:2]', "{a, 1'b0, b}", 'raw'],
      ['[3:0]', '{a, b, c, d}', 'concat'],
    ]) {
      const base = buildDiagram(await design({ 't.v': body(range, rhs) }), 't');
      const drawing = toDrawing(base, await layoutDiagram(base), emptyEdits(), noModules);
      // The bar stays a frozen copy when a Concatenate would name its slices from the other end.
      expect(drawing.nodes.find((n) => n.sym === 'concat' || n.raw?.kind === 'join')?.sym, range).toBe(bar);
      // Every input of the bar is in its place, and wired as before.
      expect(logic(effectiveDiagram('t', undefined, drawing, noModules)), range).toEqual(logic(base));
    }
  });

  it('never hands out an ID the drawing already uses', async () => {
    const base = buildDiagram(await design({ 't.v': 'module t(input a, output y);\n  assign y = a;\nendmodule\n' }), 't');
    let e = layoutToEdits(emptyEdits(), await layoutDiagram(base), 'existing');
    for (let i = 0; i < 3; i++) {
      const [id, e1] = newId(e, 'u');
      e = addNodes(e1, [{ node: newUserNode(id, 'not'), pos: { x: 300 + 100 * i, y: 0 } }]);
    }
    const net = effectiveDiagram('t', base, e, noModules);
    const drawing = toDrawing(net, await layoutDiagram(net), e, noModules);
    expect(drawing.nodes.map((n) => n.id)).toContain('u:3');
    const used = new Set([...drawing.nodes, ...drawing.edges].map((x) => x.id));
    for (const prefix of ['u', 'w'] as const) expect(used.has(newId(drawing, prefix)[0])).toBe(false);
  });

  it('raises no width warnings for zero-extended or scaled operands', async () => {
    const base = buildDiagram(await design({ [AUCTION_FILE]: AUCTION_SOURCE }), 'score_calc', DEFAULT_RULES);
    expect(checkSheet(base).messages).toEqual([]);
    const drawing = toDrawing(base, await layoutDiagram(base), emptyEdits(), noModules);
    expect(checkSheet(effectiveDiagram('x', undefined, drawing, noModules)).messages).toEqual([]);
  });
});

describe('Copy to new drawing keeps what the library symbols cannot say', () => {
  it('keeps negedge, reset-value and signed cells as frozen copies with their parameters', async () => {
    const src = `module t(input clk, input rst, input signed [3:0] a, input signed [3:0] b, output reg [3:0] q, output lt);
  always @(negedge clk or posedge rst) if (rst) q <= 4'd5; else q <= a;
  assign lt = a < b;
endmodule
`;
    const base = buildDiagram(await design({ 't.v': src }), 't');
    const drawing = toDrawing(base, await layoutDiagram(base), emptyEdits(), noModules);
    const withParams = base.nodes.filter((n) => n.params);
    expect(withParams.length).toBeGreaterThanOrEqual(2);
    // A falling clock edge, a reset to 5 and signed operands (Yosys writes them in binary).
    const set = (v: string | undefined) => v !== undefined && /1/.test(v);
    expect(withParams.some((n) => n.params?.CLK_POLARITY !== undefined && !set(n.params.CLK_POLARITY))).toBe(true);
    expect(withParams.some((n) => n.params?.ARST_VALUE !== undefined && parseInt(n.params.ARST_VALUE, 2) === 5)).toBe(true);
    expect(withParams.some((n) => set(n.params?.A_SIGNED) && set(n.params?.B_SIGNED))).toBe(true);
    const d = effectiveDiagram('t', undefined, drawing, noModules);
    for (const n of withParams) {
      const u = drawing.nodes.find((x) => x.raw?.cellType === n.cellType);
      expect(u?.sym, n.cellType).toBe('raw');
      expect(u?.raw?.params).toEqual(n.params);
      // The drawn symbol carries them too.
      expect(d.nodes.find((x) => x.id === u?.id)?.params, n.cellType).toEqual(n.params);
    }
    expect(logic(d)).toEqual(logic(base));
  });

  it('keeps the zero bits of scaled wires when they are copied and renamed', async () => {
    const base = buildDiagram(await design({ [AUCTION_FILE]: AUCTION_SOURCE }), 'score_calc', DEFAULT_RULES);
    const scaled = base.edges.filter((x) => x.shift);
    expect(scaled.length).toBeGreaterThan(0);
    let drawing = toDrawing(base, await layoutDiagram(base), emptyEdits(), noModules);
    expect(drawing.edges.filter((x) => x.shift).length).toBe(scaled.length);
    // A renamed label no longer says ×4, but the wire still carries the low zero bits.
    drawing = { ...drawing, edges: drawing.edges.map((x) => (x.shift ? { ...x, label: 'renamed' } : x)) };
    const after = effectiveDiagram('score_calc', undefined, drawing, noModules);
    expect(after.edges.filter((x) => x.label === 'renamed' && wireShift(x) > 0).length).toBe(scaled.length);
    // Every wire carries the same bits as before, the low zero bits included.
    expect(logic(after)).toEqual(logic(base));
  });

  it('reports a block whose module is gone', () => {
    let e = emptyEdits();
    e = addNodes(e, [{ node: newUserNode('u:1', 'block', { name: 'x', params: { module: 'gone' } }), pos: { x: 0, y: 0 } }]);
    const d = effectiveDiagram('m', undefined, e, noModules);
    expect(d.nodes[0].attrs?.missingModule).toBe(true);
    expect(checkSheet(d).messages.join(' ')).toContain('gone, which no longer exists');
  });

  it('does not draw an inout pin wired to itself', async () => {
    const src = `module u(inout [3:0] io);
endmodule
module top(inout [3:0] b);
  u z(.io(b));
endmodule
`;
    const d = buildDiagram(await design({ 't.v': src }, 'top'), 'top');
    expect(d.edges.filter((x) => x.source.node === x.target.node)).toEqual([]);
    expect(d.edges.map((x) => x.target.port)).toContain('cell:z.io');
  });
});

describe('saved files', () => {
  it('round-trips through JSON and rejects other files', () => {
    let e = emptyEdits();
    e = addNodes(e, [{ node: newUserNode('u:7', 'and', { params: { inputs: 3 } }), pos: { x: 10, y: 20 } }]);
    const f: SavedFile = {
      format: 'digital-canvas',
      version: 1,
      files: { 'a.v': 'module a; endmodule' },
      rules: ['decoder'],
      viewMode: 'blocks',
      doc: { drawn: ['d1'], sheets: { 'd:d1': e } },
      path: [{ instance: 'd1', module: 'd1', drawn: true }],
    };
    const back = parseSavedFile(JSON.stringify(f));
    expect(back.doc.sheets['d:d1'].nodes[0]).toMatchObject({ id: 'u:7', sym: 'and', params: { inputs: 3 } });
    expect(back.doc.sheets['d:d1'].next).toBe(8);
    expect(back.path[0].drawn).toBe(true);
    expect(() => parseSavedFile('{"hello":1}')).toThrow(/not a Digital Canvas/);
    expect(() => parseSavedFile('not json')).toThrow(/not valid JSON/);
    expect(() => parseSavedFile(JSON.stringify({ ...f, version: 9 }))).toThrow(/newer version/);
  });

  it('of the time of the beige theme open the same, without it (there is one white look now)', () => {
    const f: SavedFile = {
      format: 'digital-canvas',
      version: 1,
      files: { 'a.v': 'module a; endmodule' },
      rules: [],
      viewMode: 'flat',
      doc: { drawn: [], sheets: {} },
      path: [{ instance: 'a', module: 'a' }],
    };
    for (const theme of ['slides', 'report', 42]) {
      const back = parseSavedFile(JSON.stringify({ ...f, theme }));
      expect(back).not.toHaveProperty('theme');
      expect(back).toMatchObject({ files: f.files, viewMode: 'flat', path: f.path });
    }
  });

  it('keeps only well-formed fields of a frozen symbol copy', () => {
    const src = { file: 'a.v', startLine: 1, startCol: 2, endLine: 1, endCol: 9 };
    const raw = {
      kind: 'cell',
      label: '&',
      cellType: '$and',
      subLabel: 5,
      moduleName: null,
      attrs: { invertB: true, n: 2, bad: { x: 1 } },
      ports: [
        { name: 'A', dir: 'in', side: 'WEST', width: 1, inout: true, extra: 'x' },
        { name: 'Y', dir: 'out', side: 'EAST', width: 1 },
        null,
        { name: 'Q', dir: 'up', side: 'WEST', width: 1 },
      ],
      src: [null, src, { file: 'a.v' }, 'a.v:1'],
    };
    const nodes = [
      { id: 'u:1', sym: 'raw', params: {}, raw },
      { id: 'u:2', sym: 'raw', params: {}, raw: { ...raw, kind: 'blob' } },
    ];
    const f = { format: 'digital-canvas', version: 1, doc: { drawn: ['d1'], sheets: { 'd:d1': { nodes } } }, path: [] };
    const back = parseSavedFile(JSON.stringify(f)).doc.sheets['d:d1'].nodes;
    expect(back).toHaveLength(1);
    expect(back[0].raw).toEqual({
      id: 'u:1',
      kind: 'cell',
      label: '&',
      cellType: '$and',
      attrs: { invertB: true, n: 2 },
      ports: [
        { id: 'u:1.A', name: 'A', dir: 'in', side: 'WEST', width: 1, inout: true },
        { id: 'u:1.Y', name: 'Y', dir: 'out', side: 'EAST', width: 1 },
      ],
      src: [src],
    });
  });
});

describe('a wire that taps or joins a scaled (×4) wire', () => {
  it('shows its zero bits as the imported one does, and is checked with them', async () => {
    const src = "module t(input [3:0] a, input [1:0] b, output [3:0] y);\n  assign y = a + {b, 2'b00};\nendmodule\n";
    const base = buildDiagram(await design({ 't.v': src }), 't', DEFAULT_RULES);
    const scaled = base.edges.find((x) => x.shift)!;
    const s = new Drawing(noModules, base);
    const tap = s.add('output', 'tap', { width: 4 });
    const joined = s.add('output', 'joined', { width: 4 });
    const w1 = s.wire(onWire(scaled.id), `${tap}.in`);
    const w2 = s.wire(`${joined}.in`, scaled.target.port);
    // Without the note the new wire would read as b zero-extended, while it carries {b, 2'b00}.
    for (const id of [w1, w2]) expect(s.d.edges.find((x) => x.id === id), id).toMatchObject({ width: 2, shift: 2, label: scaled.label });
    expect(checkSheet(s.d).messages).toEqual([]);

    // Its width is judged with the zero bits: 2 bits ×4 are 4 bits, too wide for a 2-bit pin.
    const narrow = s.add('output', 'narrow', { width: 2 });
    const w3 = s.wire(onWire(scaled.id), `${narrow}.in`);
    const issues = checkSheet(s.d);
    expect([...issues.flagged]).toEqual([w3]);
    expect(issues.messages).toEqual(['A 2-bit wire ×4 (4 bits) feeds the 2-bit input in of narrow.']);

    // A label given with the wire wins; a plain wire gets none.
    const named = s.add('output', 'named', { width: 4 });
    const c = resolveConnection(s.d, onWire(scaled.id), at(`${named}.in`));
    if ('error' in c) throw new Error(c.error);
    const [w4, e4] = connect(s.e, c, undefined, 'b4');
    expect(e4.edges.find((x) => x.id === w4)?.label).toBe('b4');
    const plain = s.wire(at(scaled.source.port), `${s.add('output', 'plain', { width: 2 })}.in`);
    expect(s.d.edges.find((x) => x.id === plain)?.label).toBeUndefined();
  });
});

describe('repeated pin names', () => {
  /** A layout of a drawing's symbols where they are stored, as the editor shows it. */
  const shown = (s: Drawing) => buildGeometry({ netlist: s.d, pos: s.e.pos, routes: s.e.routes, measure: approxMeasure }).layout;
  const pinLabels = (s: Drawing) => s.d.nodes.filter((n) => n.kind === 'input' || n.kind === 'output').map((n) => n.label);

  it('are reported with the port names blocks of the drawing give them', () => {
    const s = new Drawing();
    const a = s.add('input', 'a');
    const y = s.add('output', 'y');
    s.wire(`${a}.out`, `${y}.in`);
    expect(checkSheet(s.d).messages).toEqual([]);
    const a2 = s.add('input', 'a');
    const y2 = s.add('output', 'y');
    s.wire(`${a2}.out`, `${y2}.in`);
    // Each pair keeps its own wire, and a block of the drawing has a port for each pin.
    expect(feeds(s.d, `${y}.in`)).toEqual([`${a}.out`]);
    expect(feeds(s.d, `${y2}.in`)).toEqual([`${a2}.out`]);
    expect(drawingPorts(s.e).map((p) => `${p.pin}:${p.name}`)).toEqual([`${a}:a`, `${y}:y`, `${a2}:a_2`, `${y2}:y_2`]);
    expect(checkSheet(s.d).messages).toEqual([
      'Two pins are named a; blocks of this drawing call the second a_2.',
      'Two pins are named y; blocks of this drawing call the second y_2.',
    ]);
    // Names that only become the same in Verilog, three of a name, and a name another pin's port has taken.
    const t = new Drawing();
    for (const n of ['a b', 'a_b', 'q', 'q', 'q', 'q_2']) t.add('input', n);
    expect(drawingPorts(t.e).map((p) => p.name)).toEqual(['a b', 'a_b_2', 'q', 'q_2', 'q_3', 'q_2_2']);
    expect(checkSheet(t.d).messages).toEqual([
      'Pins a b and a_b have the same Verilog name a_b; blocks of this drawing call the second a_b_2.',
      '3 pins are named q; blocks of this drawing call the others q_2 and q_3.',
      "Another pin's port is q_2, so blocks of this drawing call pin q_2 q_2_2.",
    ]);
  });

  it('are not made by Duplicate or Paste: a pasted pin or block whose name is taken gets a free one', () => {
    const iface: InterfaceOf = (m) => (m === 'child' ? { label: 'child', ports: [{ name: 'x', dir: 'input', width: 1 }] } : undefined);
    const s = new Drawing(iface);
    const a = s.add('input', 'a');
    const y = s.add('output', 'y');
    const in1 = s.add('input', 'in1');
    s.add('input', 'in2');
    const blk = s.add('block', 'u1', { module: 'child' });
    s.wire(`${a}.out`, `${y}.in`);
    s.wire(`${in1}.out`, `${blk}.x`);
    // Select all, Duplicate.
    const all = new Set(s.e.nodes.map((n) => n.id));
    const clip = copyNodes(s.d, s.e, shown(s), all, iface)!;
    let pasted: string[];
    [s.e, pasted] = pasteClip(s.e, clip, { x: 0, y: 200 });
    expect(pinLabels(s)).toEqual(['a', 'y', 'in1', 'in2', 'a2', 'y2', 'in3', 'in4']);
    expect(s.d.nodes.filter((n) => n.kind === 'instance').map((n) => n.subLabel)).toEqual(['u1', 'u2']);
    expect(checkSheet(s.d).messages).toEqual([]);
    // Every pin is a port of its own name; the pasted y is fed by the pasted a.
    expect(drawingPorts(s.e).map((p) => p.name)).toEqual(pinLabels(s));
    const pin = (label: string) => s.d.nodes.find((n) => n.label === label)!.id;
    expect(feeds(s.d, `${pin('y2')}.in`)).toEqual([`${pin('a2')}.out`]);
    // The pasted wires join the pasted symbols.
    const copies = s.d.edges.filter((x) => pasted.includes(x.id));
    expect(copies).toHaveLength(2);
    for (const x of copies) expect(pasted).toEqual(expect.arrayContaining([x.source.node, x.target.node]));

    // Into another drawing, where the names are free, they stay; the names of an imported sheet count too.
    const t = new Drawing(iface);
    [t.e] = pasteClip(t.e, clip, { x: 0, y: 0 });
    expect(pinLabels(t)).toEqual(['a', 'y', 'in1', 'in2']);
    const imported: Diagram = { module: 'm', nodes: [symbolNode(newUserNode('in:a', 'input', { name: 'a' }), noModules)], edges: [] };
    const [e3] = pasteClip(emptyEdits(), clip, { x: 0, y: 0 }, imported);
    expect(e3.nodes.map((n) => n.name)).toEqual(['a2', 'y', 'in1', 'in2', 'u1']);
  });
});

describe('placing symbols that have no position', () => {
  /** A MUX that has its place, wired to a register that is new (as after a re-import). */
  const setup = () => {
    const mux = newUserNode('u:1', 'mux', { params: { width: 2 } });
    const reg = newUserNode('u:2', 'dff', { params: { width: 2 } });
    const e = addNodes({ ...emptyEdits(), next: 3 }, [
      { node: mux, pos: { x: 100, y: 100 } },
      { node: reg, pos: { x: 0, y: 0 } },
    ]);
    const d = effectiveDiagram('m', undefined, e, noModules);
    const c = resolveConnection(d, at('u:1.Y'), at('u:2.D'));
    if ('error' in c) throw new Error(c.error);
    const [, e2] = connect(e, c);
    const size = (id: string) => sizeNode(d.nodes.find((n) => n.id === id)!, approxMeasure);
    // ELK put the register right under the MUX, a little apart (it had no select wire there).
    const lnode = (id: string, x: number, y: number) => ({ ...d.nodes.find((n) => n.id === id)!, x, y, ...size(id), ports: [] });
    const elk: LayoutResult = { module: 'm', width: 400, height: 400, nodes: [lnode('u:1', 0, 0), lnode('u:2', 0, size('u:1').height + 10)], edges: [] };
    const pos = { 'u:1': e.pos['u:1'] };
    return { d: effectiveDiagram('m', undefined, e2, noModules), elk, pos, size };
  };
  const measured = (n: DNode) => sizeNode(n, approxMeasure);

  it('keeps a stub and a grid step clear of its neighbours, below their bottom pins too', () => {
    const { d, elk, pos, size } = setup();
    const out = placeMissing(d, pos, elk, measured);
    const bottom = pos['u:1'].y + size('u:1').height;
    expect(out['u:2'].x).toBe(pos['u:1'].x);
    expect(out['u:2'].y - bottom).toBeGreaterThanOrEqual(30);
    expect(out['u:2'].y - bottom).toBeLessThan(40);
  });

  it('keeps off stored wires nearby, and stays put when only a far move would clear them', () => {
    const { d, elk, pos, size } = setup();
    const first = placeMissing(d, pos, elk, measured)['u:2'];
    const reg = size('u:2');
    // Another net's wire runs across where the register would go (the MUX's select wire, say).
    const across: Diagram = {
      ...d,
      nodes: [
        ...d.nodes,
        symbolNode(newUserNode('u:3', 'input', { name: 's' }), noModules),
        symbolNode(newUserNode('u:4', 'output', { name: 't' }), noModules),
      ],
      edges: [...d.edges, { id: 'w:9', source: { node: 'u:3', port: 'u:3.out' }, target: { node: 'u:4', port: 'u:4.in' }, width: 1, fullSource: true }],
    };
    const wireY = first.y + 20;
    const routes = { 'w:9': { points: [{ x: -200, y: wireY }, { x: 600, y: wireY }] } };
    const pos2 = { ...pos, 'u:3': { x: -260, y: wireY - 10 }, 'u:4': { x: 600, y: wireY - 10 } };
    const out = placeMissing(across, pos2, elk, measured, routes)['u:2'];
    expect(out.x).toBe(first.x);
    expect(out.y).toBeGreaterThanOrEqual(wireY + 20);
    const r = { x: out.x - 19, y: out.y - 19, width: reg.width + 38, height: reg.height + 38 };
    expect(polylineHitsRect(routes['w:9'].points, r)).toBe(false);
    // Without the routes the wire is not known, and the register takes the first free spot.
    expect(placeMissing(across, pos2, elk, measured)['u:2']).toEqual(first);
    // A wire running down a long way there is not worth a long move: it is routed again instead.
    const down = { 'w:9': { points: [{ x: first.x + 10, y: first.y - 5 }, { x: first.x + 10, y: first.y + 2000 }] } };
    expect(placeMissing(across, pos2, elk, measured, down)['u:2']).toEqual(first);
  });
});
