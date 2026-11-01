import { describe, expect, it } from 'vitest';
import { buildDiagram } from '../core/diagram';
import { design } from '../core/test-utils';
import { approxMeasure, layoutDiagram, sizeNode } from '../layout/elk-layout';
import { emptyEdits, parseSavedFile, type SavedFile } from './doc';
import {
  addNodes,
  connect,
  copyNodes,
  deleteItems,
  effectiveDiagram,
  layoutToEdits,
  moveNodes,
  pasteClip,
  placeMissing,
  rename,
  resolveConnection,
  toDrawing,
  toUserNode,
} from './sheet';
import { type InterfaceOf, SYMBOLS, newUserNode, symbolNode } from './symbols';

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
});
