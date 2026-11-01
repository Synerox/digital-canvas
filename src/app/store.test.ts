import { describe, expect, it, vi } from 'vitest';

// The app runs Yosys in a Web Worker; the tests run the same script in Node.
vi.mock('../yosys/client', async () => {
  const { runYosys } = await import('@yowasp/yosys');
  const { JSON_OUT, yosysArgs } = await import('../yosys/script');
  class YosysError extends Error {
    log?: string;
  }
  return {
    YosysError,
    async elaborate(files: Record<string, string>, top?: string) {
      const out = (await runYosys(yosysArgs(files, { top }), files, { stdout: () => {}, stderr: () => {} })) as Record<string, string | Uint8Array>;
      const raw = out[JSON_OUT];
      if (raw === undefined) throw new YosysError('Yosys failed');
      return { json: typeof raw === 'string' ? raw : new TextDecoder().decode(raw), log: '' };
    },
  };
});

import { DEFAULT_RULES, RULES } from '../core/rules';
import type { EditDoc, SavedFile, SheetEdits } from '../editor/doc';
import { emptyEdits } from '../editor/doc';
import { polylineHitsRect } from '../editor/router';
import { effectiveDiagram } from '../editor/sheet';
import { type InterfaceOf, type UserNode, newUserNode, symbolNode } from '../editor/symbols';
import { diagramToVerilog } from '../editor/verilog-export';
import { type Point, sizeNode } from '../layout/elk-layout';
import {
  drawingPorts,
  drawnRoute,
  followPinRenames,
  importedTop,
  measureFor,
  renameDrawingIn,
  sheetsUsing,
  useStore,
  viewModeOf,
  withoutVerilogEdits,
} from './store';
import { AUCTION_FILE, AUCTION_SOURCE } from '../examples/auction';

const st = () => useStore.getState();

/** Start over with these files (and document), as File › Open drawing does. */
async function open(files: Record<string, string>, extra: Partial<SavedFile> = {}) {
  const f: SavedFile = {
    format: 'digital-canvas',
    version: 1,
    files,
    rules: [...DEFAULT_RULES],
    viewMode: 'blocks',
    theme: 'report',
    doc: { sheets: {}, drawn: [] },
    path: [],
    ...extra,
  };
  await st().loadSaved(JSON.stringify(f));
}

/** Wait until the sheet on screen is laid out. */
async function settle() {
  await vi.waitFor(
    () => {
      const s = st();
      if (s.status === 'layout' || s.status === 'elaborating' || s.status === 'loading') throw new Error(`status ${s.status}`);
      if (!s.sheet.startsWith('d:') && s.loadedSheet !== s.sheet) throw new Error('sheet not loaded');
    },
    { timeout: 30_000, interval: 5 },
  );
}

const nodeOf = (pred: (n: { kind: string; label: string; instanceName?: string }) => boolean) => {
  const n = st().layout?.nodes.find(pred);
  if (!n) throw new Error('no such node');
  return n;
};
const input = (name: string) => nodeOf((n) => n.kind === 'input' && n.label === name);

const pin = (id: string, sym: 'input' | 'output' | 'inout', name: string): UserNode => ({ ...newUserNode(id, sym), name });
const drawing = (nodes: UserNode[], edges: SheetEdits['edges'] = []): SheetEdits => ({ ...emptyEdits(), nodes, edges, next: 100 });

describe('drawing interfaces (pins → block ports)', () => {
  it('names block ports as the exported module names its pins, so no pin is lost (C37)', () => {
    const leaf = drawing([
      pin('u:1', 'input', 'a b'),
      pin('u:2', 'input', 'a_b'),
      pin('u:3', 'input', 'x'),
      pin('u:4', 'output', 'x'),
      pin('u:5', 'output', 'y'),
    ]);
    const ports = drawingPorts(leaf);
    // The first a_b keeps its own name; the repeated ones take the exported name.
    expect(ports.map((p) => p.name)).toEqual(['a b', 'a_b_2', 'x', 'x_2', 'y']);
    const iface: InterfaceOf = (m) => (m === 'leaf' ? { label: 'leaf', ports: drawingPorts(leaf) } : undefined);
    const leafV = diagramToVerilog(effectiveDiagram('leaf', undefined, leaf, iface), 'leaf').code;
    const header = /module leaf \(([\s\S]*?)\);/.exec(leafV)![1];
    const modulePorts = [...header.matchAll(/(?:input|output|inout) wire (?:\[[^\]]*\] )?(\w+)/g)].map((m) => m[1]);
    const block: UserNode = { ...newUserNode('u:9', 'block'), params: { module: 'leaf' }, name: 'u1' };
    const top = drawing([block]);
    const topV = diagramToVerilog(effectiveDiagram('top', undefined, top, iface), 'top').code;
    const connected = [...topV.matchAll(/\.(\w+)\(/g)].map((m) => m[1]);
    // Every port of the module is connected once by the instance.
    expect(connected.slice().sort()).toEqual(modulePorts.slice().sort());
  });

  it('keeps the port name (and port ID) of a pin whose name only needs illegal characters replaced', () => {
    expect(drawingPorts(drawing([pin('u:1', 'input', ' data in ')])).map((p) => p.name)).toEqual(['data in']);
    expect(drawingPorts(drawing([pin('u:1', 'input', '')])).map((p) => p.name)).toEqual(['in']);
  });

  it('moves wires to a renamed pin on every sheet that uses the drawing (C17)', () => {
    const inner = drawing([pin('u:1', 'input', 'in1'), pin('u:2', 'input', 'in2'), pin('u:3', 'output', 'out1')]);
    const block: UserNode = { ...newUserNode('u:1', 'block'), params: { module: 'inner' } };
    const outer = drawing(
      [pin('u:2', 'input', 'a'), pin('u:3', 'input', 'b'), block],
      [
        { id: 'w:4', source: { node: 'u:2', port: 'u:2.out' }, target: { node: 'u:1', port: 'u:1.in1' } },
        { id: 'w:5', source: { node: 'u:3', port: 'u:3.out' }, target: { node: 'u:1', port: 'u:1.in2' } },
      ],
    );
    const doc: EditDoc = { drawn: ['inner', 'outer'], sheets: { 'd:inner': inner, 'd:outer': outer } };
    // Swap the two input names in one step: each wire follows its own pin.
    const after: SheetEdits = { ...inner, nodes: inner.nodes.map((n) => (n.id === 'u:1' ? { ...n, name: 'in2' } : n.id === 'u:2' ? { ...n, name: 'in1' } : n)) };
    const next = followPinRenames({ ...doc, sheets: { ...doc.sheets, 'd:inner': after } }, 'inner', inner, after);
    expect(next.sheets['d:outer'].edges.map((x) => x.target.port)).toEqual(['u:1.in2', 'u:1.in1']);
    // Nothing to follow: the same document.
    expect(followPinRenames(doc, 'inner', inner, inner)).toBe(doc);
  });
});

describe('document helpers', () => {
  it('reads the view of a sheet key', () => {
    expect(viewModeOf('v:blocks:top')).toBe('blocks');
    expect(viewModeOf('v:flat:a/b')).toBe('flat');
    expect(viewModeOf('d:drawing')).toBeUndefined();
    expect(viewModeOf('')).toBeUndefined();
  });

  it('drops the edits of Verilog sheets and keeps drawings (C5)', () => {
    const edited: SheetEdits = { ...emptyEdits(), hidden: ['in:clk'] };
    const doc: EditDoc = { drawn: ['d1'], sheets: { 'v:blocks:top': edited, 'v:flat:top': emptyEdits(), 'd:d1': drawing([]) } };
    expect(withoutVerilogEdits(doc)).toEqual({ drawn: ['d1'], sheets: { 'd:d1': doc.sheets['d:d1'] } });
    const clean: EditDoc = { drawn: [], sheets: { 'v:blocks:top': emptyEdits() } };
    expect(withoutVerilogEdits(clean)).toBe(clean);
  });

  it('renames a drawing with its blocks, and lists where it is used (C7, C21)', () => {
    const block: UserNode = { ...newUserNode('u:1', 'block'), params: { module: 'leaf' } };
    const doc: EditDoc = { drawn: ['leaf', 'top'], sheets: { 'd:leaf': drawing([]), 'd:top': drawing([block]), 'v:blocks:m': drawing([block]) } };
    expect(sheetsUsing(doc, 'leaf')).toEqual(['top', 'm']);
    const r = renameDrawingIn(doc, 'leaf', 'leaf_2');
    expect(r.drawn).toEqual(['leaf_2', 'top']);
    expect(Object.keys(r.sheets).sort()).toEqual(['d:leaf_2', 'd:top', 'v:blocks:m']);
    expect(r.sheets['d:top'].nodes[0].params.module).toBe('leaf_2');
    expect(sheetsUsing(r, 'leaf')).toEqual([]);
  });

  it('guesses the top of imported code (C19)', () => {
    const adders = {
      'add.v': `module half_adder(input a, input b, output s, output c); assign s = a ^ b; assign c = a & b; endmodule
// full_adder uses half_adder twice
module full_adder #(parameter W = 1) (input a, input b, input ci, output s, output co);
  wire s1, c1, c2;
  half_adder h1 (.a(a), .b(b), .s(s1), .c(c1));
  half_adder #() h2 (.a(s1), .b(ci), .s(s), .c(c2));
  assign co = c1 | c2;
endmodule : full_adder
module other(input a, output y); assign y = a; endmodule`,
    };
    expect(importedTop(adders, ['full_adder', 'half_adder', 'other'])).toBe('full_adder');
    expect(importedTop(adders, ['half_adder'])).toBe('half_adder');
    expect(importedTop({ 'p.v': 'module m(input a, output y); /* sub u (.a(a)); */ assign y = a; endmodule\nmodule sub(input a); endmodule' }, ['sub', 'm'])).toBe('m');
  });

  it('draws a wire through bends leaving and entering pins straight (C18)', () => {
    // From an EAST output at (280,260) through a bend above-left of it, into a WEST input at (540,260).
    const r = drawnRoute([{ x: 280, y: 260 }, { x: 240, y: 140 }, { x: 540, y: 260 }], 'EAST', 'WEST');
    expect(r).toEqual([
      { x: 280, y: 260 },
      { x: 290, y: 260 },
      { x: 290, y: 140 },
      { x: 530, y: 140 },
      { x: 530, y: 260 },
      { x: 540, y: 260 },
    ]);
    // Never left of the output pin (back through its symbol).
    expect(r.every((p) => p.x >= 280)).toBe(true);
    // Without pins it is orthogonalize: horizontal first.
    expect(drawnRoute([{ x: 0, y: 0 }, { x: 50, y: 30 }])).toEqual([{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 30 }]);
    // A SOUTH pin (a mux select) leaves downwards, then turns.
    expect(drawnRoute([{ x: 100, y: 100 }, { x: 60, y: 200 }], 'SOUTH')).toEqual([{ x: 100, y: 100 }, { x: 100, y: 110 }, { x: 60, y: 110 }, { x: 60, y: 200 }]);
  });
});

const HALF = 'module half_adder(input a, input b, output s, output c); assign s = a ^ b; assign c = a & b; endmodule\n';

describe('store', () => {
  it('keeps the ports of a block copied from an automatic block in the full circuit (C1)', async () => {
    await open({ 'fruit.v': (await import('../examples/fruit-battle')).FRUIT_SOURCE });
    const auto = Object.values(st().blockDesign!.modules).find((m) => m.auto)!;
    expect(auto).toBeDefined();
    const ports = st().interfaceOf(auto.name)!.ports.length;
    expect(ports).toBeGreaterThan(0);
    st().convertToDrawing();
    await settle();
    const wires = st().netlist!.edges.length;
    expect(wires).toBeGreaterThan(0);
    await st().setViewMode('flat');
    await settle();
    expect(st().interfaceOf(auto.name)?.ports.length).toBe(ports);
    // The drawing is still on screen, with all its wires.
    expect(st().sheet.startsWith('d:')).toBe(true);
    expect(st().netlist!.edges.length).toBe(wires);
  }, 60_000);

  it('lays out a sheet again when undo unpins it after a rule change (C2)', async () => {
    await open({ [AUCTION_FILE]: AUCTION_SOURCE });
    const key = st().sheet;
    const y0 = input('clk').y;
    st().moveSelection(new Set([input('clk').id]), 0, 150);
    expect(input('clk').y).toBe(y0 + 150);
    // Every symbol has a position: the new rules' layout is not computed.
    await st().toggleRule(RULES[0].id);
    st().undo();
    await settle();
    expect(st().doc.sheets[key]).toBeUndefined();
    expect(input('clk').y).toBe(y0);
    // Edits work again.
    st().moveSelection(new Set([input('clk').id]), 0, 50);
    expect(input('clk').y).toBe(y0 + 50);
  }, 60_000);

  it('does not edit a sheet while it is still being opened (C3, C44)', async () => {
    await open({ [AUCTION_FILE]: AUCTION_SOURCE });
    const clk = input('clk').id;
    st().select([clk]);
    expect(st().copy()).toBe(true);
    const going = st().setViewMode('flat');
    // The block diagram is still on screen, the full circuit is being laid out.
    expect(st().sheet).toBe('v:flat:auction_top');
    st().moveSelection(new Set([input('bonus').id]), 0, 50);
    st().paste();
    expect(st().doc.sheets['v:flat:auction_top']).toBeUndefined();
    expect(st().past.length).toBe(0);
    await going;
    await settle();
    expect(st().doc.sheets['v:flat:auction_top']).toBeUndefined();
    // Once it is there, editing works.
    st().moveSelection(new Set([input('bonus').id]), 0, 50);
    expect(st().doc.sheets['v:flat:auction_top']).toBeDefined();
  }, 60_000);

  it('undo shows the view the change was made in, and so does redo (C8)', async () => {
    await open({ [AUCTION_FILE]: AUCTION_SOURCE });
    const y0 = input('clk').y;
    st().moveSelection(new Set([input('clk').id]), 0, 120);
    await st().setViewMode('flat');
    await settle();
    st().undo();
    await settle();
    expect(st().viewMode).toBe('blocks');
    expect(st().sheet).toBe('v:blocks:auction_top');
    expect(input('clk').y).toBe(y0);
    await st().setViewMode('flat');
    await settle();
    st().redo();
    await settle();
    expect(st().viewMode).toBe('blocks');
    expect(input('clk').y).toBe(y0 + 120);
  }, 60_000);

  it('does not give another design the edits of a module with the same name (C5, C41)', async () => {
    await open({ 'mine.v': 'module top(input clk, input rst, output y); assign y = clk & rst; endmodule\n' });
    st().select([input('clk').id]);
    st().deleteSelection();
    expect(st().doc.sheets['v:blocks:top'].hidden.length).toBe(1);
    // A new version of the same file keeps the edits.
    await st().setFiles({ 'mine.v': 'module top(input clk, input rst, output y); assign y = clk | rst; endmodule\n' }, true);
    expect(st().doc.sheets['v:blocks:top'].hidden.length).toBe(1);
    // Another design whose module is also called top does not get them.
    await st().setFiles({ 'other.v': 'module top(input clk, input rst, input [7:0] d, output reg [7:0] q); always @(posedge clk) if (rst) q <= 0; else q <= d; endmodule\n' }, true);
    expect(st().doc.sheets['v:blocks:top']).toBeUndefined();
    expect(input('clk')).toBeDefined();
    // One undo step brings them back.
    st().undo();
    await settle();
    expect(st().doc.sheets['v:blocks:top'].hidden.length).toBe(1);
    // An example always opens clean.
    await st().loadExample('fruit');
    expect(Object.keys(st().doc.sheets).filter((k) => k.startsWith('v:'))).toEqual([]);
  }, 60_000);

  it('renames a drawing whose name an imported module takes, and opens imported instances as Verilog (C7)', async () => {
    await open({}, { doc: { drawn: ['bid_check'], sheets: { 'd:bid_check': drawing([pin('u:1', 'input', 'in1')]) } }, path: [{ instance: 'bid_check', module: 'bid_check', drawn: true }] });
    st().newDrawing('other');
    await settle();
    await st().setFiles({ [AUCTION_FILE]: AUCTION_SOURCE }, true);
    await settle();
    expect(st().doc.drawn).toEqual(['bid_check_2', 'other']);
    expect(st().past.every((h) => !h.doc.drawn.includes('bid_check'))).toBe(true);
    expect(st().notice).toMatch(/bid_check → bid_check_2/);
    // Even if a drawing had the name, an instance from the Verilog opens the Verilog module.
    useStore.setState({ doc: { ...st().doc, drawn: [...st().doc.drawn, 'bid_check'], sheets: { ...st().doc.sheets, 'd:bid_check': drawing([]) } } });
    st().openNode(nodeOf((n) => n.instanceName === 'u_check_a').id);
    await settle();
    expect(st().path.at(-1)).toEqual({ instance: 'u_check_a', module: 'bid_check' });
    expect(st().sheet).toBe('v:blocks:bid_check');
  }, 60_000);

  it('shows imported Verilog that the open design does not use (C19)', async () => {
    await open({ [AUCTION_FILE]: AUCTION_SOURCE });
    await st().setFiles({ 'pasted.v': HALF }, false);
    await settle();
    expect(st().design!.top).toBe('half_adder');
    expect(st().topOverride).toBe('half_adder');
    expect(st().path).toEqual([{ instance: 'half_adder', module: 'half_adder' }]);
    // A new version of an open file that adds a module nothing uses yet keeps the top.
    await open({ [AUCTION_FILE]: AUCTION_SOURCE });
    await st().setFiles({ [AUCTION_FILE]: AUCTION_SOURCE + HALF }, false);
    await settle();
    expect(st().design!.top).toBe('auction_top');
    // A module the top uses is just added.
    await open({ 'top.v': 'module top(input a, output y); sub u (.a(a), .y(y)); endmodule\n' });
    await st().setFiles({ 'sub.v': 'module sub(input a, output y); assign y = ~a; endmodule\n' }, false);
    await settle();
    expect(st().design!.top).toBe('top');
    expect(st().topOverride).toBeUndefined();
  }, 60_000);

  it('routes a stored wire again when a symbol is placed on it (C16)', async () => {
    const measure = measureFor('report');
    const a: UserNode = pin('u:1', 'input', 'a');
    const y: UserNode = pin('u:2', 'output', 'y');
    const inv: UserNode = newUserNode('u:3', 'not');
    const none: InterfaceOf = () => undefined;
    const pos = { 'u:1': { x: 0, y: 0 }, 'u:2': { x: 400, y: 0 } };
    const portAt = (u: UserNode, port: string): Point => {
      const s = sizeNode(symbolNode(u, none), measure);
      const p = pos[u.id as keyof typeof pos];
      return { x: p.x + s.ports[port].x, y: p.y + s.ports[port].y };
    };
    const s0 = portAt(a, 'u:1.out');
    const t0 = portAt(y, 'u:2.in');
    // A stored (automatic) route that sweeps the whole area, wherever the inverter is placed.
    const sweep: Point[] = [s0, { x: s0.x + 20, y: s0.y }, { x: s0.x + 20, y: -300 }];
    let x = s0.x + 20;
    for (let yy = -300; yy <= 600; yy += 10) {
      const nx = x < 500 ? 1500 : -300;
      sweep.push({ x, y: yy }, { x: nx, y: yy });
      x = nx;
    }
    sweep.push({ x: t0.x - 20, y: 600 }, { x: t0.x - 20, y: t0.y }, t0);
    const e: SheetEdits = {
      ...drawing([a, y, inv], [{ id: 'w:4', source: { node: 'u:1', port: 'u:1.out' }, target: { node: 'u:2', port: 'u:2.in' } }]),
      pos,
      routes: { 'w:4': { points: sweep } },
    };
    await open({}, { doc: { drawn: ['d'], sheets: { 'd:d': e } }, path: [{ instance: 'd', module: 'd', drawn: true }] });
    const placed = st().layout!.nodes.find((n) => n.id === 'u:3')!;
    const wire = st().layout!.edges.find((x) => x.id === 'w:4')!;
    expect(polylineHitsRect(wire.points, placed)).toBe(false);
    // The new route is stored with the new position.
    expect(st().doc.sheets['d:d'].pos['u:3']).toBeDefined();
    expect(st().doc.sheets['d:d'].routes['w:4'].points).toEqual(wire.points);
  }, 60_000);

  it('keeps wires to a block connected when a pin of its drawing is renamed (C17), and says where a deleted drawing is used (C21)', async () => {
    const inner = drawing([pin('u:1', 'input', 'in1'), pin('u:2', 'output', 'out1')]);
    const block: UserNode = { ...newUserNode('u:3', 'block'), params: { module: 'inner' } };
    const outer = drawing(
      [pin('u:1', 'input', 'a'), pin('u:2', 'output', 'y'), block],
      [
        { id: 'w:4', source: { node: 'u:1', port: 'u:1.out' }, target: { node: 'u:3', port: 'u:3.in1' } },
        { id: 'w:5', source: { node: 'u:3', port: 'u:3.out1' }, target: { node: 'u:2', port: 'u:2.in' } },
      ],
    );
    await open({}, { doc: { drawn: ['inner', 'outer'], sheets: { 'd:inner': inner, 'd:outer': outer } }, path: [{ instance: 'inner', module: 'inner', drawn: true }] });
    st().renameItem('u:1', 'data');
    await st().openPath([{ instance: 'outer', module: 'outer', drawn: true }]);
    expect(st().netlist!.edges.map((x) => x.id).sort()).toEqual(['w:4', 'w:5']);
    expect(st().doc.sheets['d:outer'].edges[0].target.port).toBe('u:3.data');
    st().deleteDrawing('inner');
    expect(st().notice).toMatch(/still used as a block on outer/);
  }, 60_000);
});
