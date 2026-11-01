import { describe, expect, it } from 'vitest';
import { type Diagram, buildDiagram } from '../core/diagram';
import { DEFAULT_RULES } from '../core/rules';
import { design } from '../core/test-utils';
import { AUCTION_FILE, AUCTION_SOURCE } from '../examples/auction';
import { approxMeasure, layoutDiagram, sizeNode } from '../layout/elk-layout';
import { checkSheet } from './check';
import { type SheetEdits, emptyEdits, parseSavedFile, type SavedFile } from './doc';
import {
  type WireEnd,
  addNodes,
  connect,
  copyNodes,
  deleteItems,
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
import { diagramToVerilog } from './verilog-export';

const noModules: InterfaceOf = () => undefined;

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
    for (const def of SYMBOLS) {
      if (def.key === 'block') continue;
      const n = symbolNode(newUserNode('u:1', def.key), noModules);
      const s = sizeNode(n, approxMeasure);
      expect(s.width).toBeGreaterThan(0);
      for (const p of n.ports) {
        // Ports on the left/right edge sit on the 10 px grid vertically, so straight wires are possible.
        if (p.side === 'WEST' || p.side === 'EAST') expect(s.ports[p.id].y % 10, `${def.key}.${p.name}`).toBe(0);
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
    const v = diagramToVerilog(d, 'm');
    for (const y of ['y1', 'y2', 'y3']) expect(v.code).toContain(`assign ${y} = ~a[3:2];`);
    expect(v.warnings).toEqual([]);
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
    expect(diagramToVerilog(s.d, 't').code).toContain('assign y2 = a[3:2];');
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
});

describe('imported symbols', () => {
  it('never change a constant when it is renamed', async () => {
    const base = buildDiagram(await design({ 't.v': "module t(input [3:0] b, output y);\n  assign y = b != 4'd5;\nendmodule\n" }), 't');
    const k = base.nodes.find((n) => n.kind === 'const')!;
    expect(k.label).toBe("4'd5");
    const before = diagramToVerilog(effectiveDiagram('t', base, emptyEdits(), noModules), 't');
    for (const text of ['ZERO', "4'd7"]) {
      const d = effectiveDiagram('t', base, rename(emptyEdits(), k.id, text), noModules);
      const n = d.nodes.find((x) => x.id === k.id)!;
      expect(n.label).toBe("4'd5");
      expect(diagramToVerilog(d, 't')).toEqual(before);
      expect(toUserNode(n, 'u:1', noModules).params.value).toBe("4'd5");
    }
  });

  it('keep pins wider than the library allows as frozen copies', async () => {
    const base = buildDiagram(await design({ 'w.v': 'module w(input [299:0] a, output [299:0] y);\n  assign y = ~a;\nendmodule\n' }), 'w');
    const drawing = toDrawing(base, await layoutDiagram(base), emptyEdits(), noModules);
    const d = effectiveDiagram('w2', undefined, drawing, noModules);
    for (const n of d.nodes) for (const p of n.ports) expect(p.width, `${n.id}.${p.name}`).toBe(300);
    expect(checkSheet(d).messages).toEqual([]);
    const v = diagramToVerilog(d, 'w2');
    expect(v.code).toContain('input wire [299:0] a');
    expect(v.code).toContain('output wire [299:0] y');
    expect(v.warnings).toEqual([]);
  });
});

describe('Copy to new drawing', () => {
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
      theme: 'slides',
      doc: { drawn: ['d1'], sheets: { 'd:d1': e } },
      path: [{ instance: 'd1', module: 'd1', drawn: true }],
    };
    const back = parseSavedFile(JSON.stringify(f));
    expect(back.doc.sheets['d:d1'].nodes[0]).toMatchObject({ id: 'u:7', sym: 'and', params: { inputs: 3 } });
    expect(back.doc.sheets['d:d1'].next).toBe(8);
    expect(back.theme).toBe('slides');
    expect(back.path[0].drawn).toBe(true);
    expect(() => parseSavedFile('{"hello":1}')).toThrow(/not a Digital Canvas/);
    expect(() => parseSavedFile('not json')).toThrow(/not valid JSON/);
    expect(() => parseSavedFile(JSON.stringify({ ...f, version: 9 }))).toThrow(/newer version/);
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
