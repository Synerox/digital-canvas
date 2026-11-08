import { describe, expect, it, vi } from 'vitest';

// The app runs Yosys in a Web Worker; the tests run the same script in Node.
vi.mock('../yosys/client', async () => {
  const { runYosys } = await import('@yowasp/yosys');
  const { JSON_OUT, yosysArgs } = await import('../yosys/script');
  class YosysError extends Error {
    log?: string;
    kind?: string;
  }
  return {
    YosysError,
    elaborate: vi.fn(async (files: Record<string, string>, top?: string) => {
      const out = (await runYosys(yosysArgs(files, { top }), files, { stdout: () => {}, stderr: () => {} })) as Record<string, string | Uint8Array>;
      const raw = out[JSON_OUT];
      if (raw === undefined) throw new YosysError('Yosys failed');
      return { json: typeof raw === 'string' ? raw : new TextDecoder().decode(raw), log: '' };
    }),
  };
});

import { DEFAULT_RULES, RULES } from '../core/rules';
import type { EditDoc, SavedFile, SheetEdits } from '../editor/doc';
import { OUTLINES, emptyEdits, parseSavedFile } from '../editor/doc';
import { componentSymbol, parseComponents } from '../editor/components';
import { polylineHitsRect } from '../editor/router';
import { effectiveDiagram } from '../editor/sheet';
import { type InterfaceOf, type UserNode, newUserNode, symbolNode } from '../editor/symbols';
import { diagramToVerilog } from '../editor/verilog-export';
import { type Point, sizeNode } from '../layout/elk-layout';
import {
  AUTOSAVE_KEY,
  changeFiles,
  copyKeys,
  drawingPorts,
  followPinRenames,
  importedTop,
  measureFor,
  moduleTitle,
  pasteSpot,
  planDrop,
  planImport,
  planOpen,
  renameDrawingIn,
  sheetsUsing,
  useStore,
  viewModeOf,
  withoutModuleDefinitions,
  withoutVerilogEdits,
  wireUpTo,
} from './store';
import { exportCurrent } from './Dialogs';
import { elaborate } from '../yosys/client';
import { declaredModules } from '../yosys/script';
import { AUCTION_FILE, AUCTION_SOURCE } from '../examples/auction';
import { FRUIT_FILE, FRUIT_SOURCE } from '../examples/fruit-battle';

const st = () => useStore.getState();

/** Start over with these files (and document), as File › Open drawing does. */
async function open(files: Record<string, string>, extra: Partial<SavedFile> = {}) {
  const f: SavedFile = {
    format: 'digital-canvas',
    version: 1,
    outlines: OUTLINES,
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

/** A UART transmitter's state machine, which the block diagram cuts into a few automatic blocks. */
const UART_FSM = `module uart_tx_fsm (
  input  wire       clk,
  input  wire       rst,
  input  wire       start,
  input  wire       tick,
  input  wire [7:0] data,
  output reg        tx,
  output wire       busy
);
  localparam IDLE = 2'd0, START = 2'd1, DATA = 2'd2, STOP = 2'd3;
  reg [1:0] state;
  reg [2:0] bitidx;
  reg [7:0] shreg;
  always @(posedge clk) begin
    if (rst) begin
      state <= IDLE; bitidx <= 3'd0; shreg <= 8'd0;
    end else begin
      case (state)
        IDLE:  if (start) begin shreg <= data; bitidx <= 3'd0; state <= START; end
        START: if (tick) state <= DATA;
        DATA:  if (tick) begin
                 shreg <= {1'b0, shreg[7:1]};
                 bitidx <= bitidx + 3'd1;
                 if (bitidx == 3'd7) state <= STOP;
               end
        STOP:  if (tick) state <= IDLE;
      endcase
    end
  end
  always @(*) begin
    case (state)
      START:   tx = 1'b0;
      DATA:    tx = shreg[0];
      default: tx = 1'b1;
    endcase
  end
  assign busy = (state != IDLE);
endmodule
`;
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

  it('drops the wires of a deleted pin instead of moving them to the pin that inherits its name (N3)', () => {
    // Two inputs named x: the block's ports are x and x_2.
    const inner = drawing([pin('u:1', 'input', 'x'), pin('u:2', 'input', 'x'), pin('u:3', 'output', 'out1')]);
    const block: UserNode = { ...newUserNode('u:1', 'block'), params: { module: 'inner' } };
    const outer = drawing(
      [block, pin('u:2', 'input', 'in1'), pin('u:3', 'input', 'in2')],
      [
        { id: 'w:5', source: { node: 'u:2', port: 'u:2.out' }, target: { node: 'u:1', port: 'u:1.x' } },
        { id: 'w:6', source: { node: 'u:3', port: 'u:3.out' }, target: { node: 'u:1', port: 'u:1.x_2' } },
      ],
    );
    outer.routes = { 'w:5': { points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] } };
    const doc: EditDoc = { drawn: ['inner', 'outer'], sheets: { 'd:inner': inner, 'd:outer': outer } };
    // Delete the first x: the second one is x now.
    const after: SheetEdits = { ...inner, nodes: inner.nodes.filter((n) => n.id !== 'u:1') };
    expect(drawingPorts(after).map((p) => p.name)).toEqual(['x', 'out1']);
    const next = followPinRenames({ ...doc, sheets: { ...doc.sheets, 'd:inner': after } }, 'inner', inner, after);
    // in2 still drives the pin it drove; in1's wire is gone with its pin.
    expect(next.sheets['d:outer'].edges.map((x) => [x.id, x.target.port])).toEqual([['w:6', 'u:1.x']]);
    expect(next.sheets['d:outer'].routes['w:5']).toBeUndefined();
  });

  it('gives a block the ports of frozen pins wider than a library pin (N10)', () => {
    const wide = (id: string, kind: 'input' | 'output', name: string, width: number): UserNode => ({
      id,
      sym: 'raw',
      params: {},
      raw: { id, kind, label: name, ports: [{ id: `${id}.${kind === 'input' ? 'out' : 'in'}`, name: kind === 'input' ? 'out' : 'in', dir: kind === 'input' ? 'out' : 'in', side: kind === 'input' ? 'EAST' : 'WEST', width }], src: [] },
    });
    const leaf = drawing([wide('a', 'input', 'a', 300), pin('b', 'input', 'b'), wide('y', 'output', 'y', 300), pin('z', 'output', 'z')]);
    expect(drawingPorts(leaf).map((p) => [p.name, p.dir, p.width])).toEqual([
      ['a', 'input', 300],
      ['b', 'input', 1],
      ['y', 'output', 300],
      ['z', 'output', 1],
    ]);
    // The exported module has the same ports, in the same order.
    const iface: InterfaceOf = () => undefined;
    const header = /module leaf \(([\s\S]*?)\);/.exec(diagramToVerilog(effectiveDiagram('leaf', undefined, leaf, iface), 'leaf').code)![1];
    expect([...header.matchAll(/(input|output) wire (?:\[(\d+):0\] )?(\w+)/g)].map((m) => [m[3], m[1], Number(m[2] ?? 0) + 1])).toEqual([
      ['a', 'input', 300],
      ['b', 'input', 1],
      ['y', 'output', 300],
      ['z', 'output', 1],
    ]);
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

  it('puts aside the edits of modules no file declares, and brings them back with a file of that name (C5, F3)', () => {
    const edits = (id: string): SheetEdits => ({ ...emptyEdits(), hidden: [id] });
    const doc: EditDoc = {
      drawn: ['d1'],
      sheets: {
        'v:blocks:top': edits('in:a'),
        'v:flat:top': edits('in:a'),
        'v:blocks:top/x': edits('in:b'),
        'v:blocks:topx': edits('in:d'),
        'v:blocks:sub': edits('in:c'),
        'd:d1': drawing([]),
      },
    };
    const a = 'module top(input a, output y); sub s(.c(a), .y(y)); endmodule\n';
    const b = 'module sub(input c, output y); assign y = c; endmodule\n';
    // a.v removed: the edits of top (both views, its automatic blocks) go aside under a.v; sub and topx keep theirs.
    const removed = changeFiles(doc, {}, { 'a.v': a, 'b.v': b }, { 'b.v': b });
    expect(Object.keys(removed.doc.sheets).sort()).toEqual(['d:d1', 'v:blocks:sub', 'v:blocks:topx']);
    expect(Object.keys(removed.putAside)).toEqual(['a.v']);
    expect(Object.keys(removed.putAside['a.v']).sort()).toEqual(['v:blocks:top', 'v:blocks:top/x', 'v:flat:top']);
    // Another file with a module called top does not get them.
    const other = changeFiles(removed.doc, removed.putAside, { 'b.v': b }, { 'b.v': b, 'o.v': 'module top(input q, output y); assign y = q; endmodule\n' });
    expect(other.doc).toBe(removed.doc);
    expect(other.putAside).toBe(removed.putAside);
    expect(other.restored).toEqual([]);
    // A new version of a.v does, and they are no longer put aside (the undo history keeps them).
    const back = changeFiles(removed.doc, removed.putAside, { 'b.v': b }, { 'b.v': b, 'a.v': `${a}// v2\n` });
    expect(back.doc.sheets).toEqual(doc.sheets);
    expect(back.restored).toEqual(['top']);
    expect(back.putAside).toEqual({});
    // A new version of a file that no longer declares a module puts that module's edits aside too.
    const lost = changeFiles(doc, {}, { 'a.v': a, 'b.v': b }, { 'a.v': a, 'b.v': 'module sub2(input c, output y); assign y = c; endmodule\n' });
    expect(Object.keys(lost.putAside['b.v'])).toEqual(['v:blocks:sub']);
    // No module goes: the same objects.
    const same = changeFiles(doc, {}, { 'a.v': a }, { 'a.v': a, 'b.v': b });
    expect(same.doc).toBe(doc);
    expect(same.putAside).toEqual({});
  });

  it('cuts module definitions out of Verilog text, or says it cannot (N6)', () => {
    const text = `// two modules
module a(input x, output y); // module b inside a comment
  assign y = x; /* endmodule */
endmodule : a
module b(input x, output y);
  initial $display("endmodule");
  assign y = ~x;
endmodule
module c(); endmodule
`;
    expect(withoutModuleDefinitions(text, new Set(['b']))).toBe(`// two modules
module a(input x, output y); // module b inside a comment
  assign y = x; /* endmodule */
endmodule : a
module c(); endmodule
`);
    expect(withoutModuleDefinitions(text, new Set(['a', 'c']))).toBe(`// two modules
module b(input x, output y);
  initial $display("endmodule");
  assign y = ~x;
endmodule
`);
    // A module that never ends is not cut by guessing.
    expect(withoutModuleDefinitions('module a(); \nmodule b(); endmodule\n', new Set(['b']))).toBeUndefined();
    // Its attributes go with it (left behind, they would stand before nothing: a Yosys error).
    const attrs = 'module top(input x, output y); a u(.x(x), .y(y)); endmodule\n(* keep_hierarchy *)\n(* blackbox=0 *) module a(input x, output y); always @(*) ; assign y = x; endmodule\n';
    expect(withoutModuleDefinitions(attrs, new Set(['a']))).toBe('module top(input x, output y); a u(.x(x), .y(y)); endmodule\n');
    expect(withoutModuleDefinitions(attrs, new Set(['top']))).toBe(attrs.slice(attrs.indexOf('(* keep')));
  });

  it('plans an import of a new version of open files (N5, N6)', () => {
    const open = { [AUCTION_FILE]: AUCTION_SOURCE, 'other.v': 'module other(input a, output y); assign y = a; endmodule\n' };
    // Every module again, under another name: the file is replaced.
    const all = planImport(open, { 'auction_v2.v': AUCTION_SOURCE.replace('4\'d0', '4\'d1') });
    expect(all.replaced).toEqual([AUCTION_FILE]);
    expect(Object.keys(all.files)).toEqual(['other.v', 'auction_v2.v']);
    // One module of a file: the file keeps the others, and the import has the new one.
    const one = planImport(open, { 'bid_check.v': 'module bid_check(input [3:0] bid, input [3:0] budget, output valid); assign valid = bid < budget; endmodule\n' });
    expect(one.replaced).toEqual([]);
    expect(one.trimmed).toEqual([AUCTION_FILE]);
    expect(declaredModules({ [AUCTION_FILE]: one.files[AUCTION_FILE] })).toEqual(['auction_top', 'max_select', 'result_decode', 'score_board', 'score_calc']);
    expect(declaredModules(one.files)).toContain('bid_check');
    expect(Object.keys(one.files)).toEqual([AUCTION_FILE, 'other.v', 'bid_check.v']);
  });

  it("names Yosys's copies of parameterized modules as the user wrote them (G12b)", () => {
    expect(moduleTitle("$paramod\\ripple\\N=s32'00000000000000000000000000001000")).toBe('ripple #(N=8)');
    expect(moduleTitle("$paramod\\fifo\\W=32'00000000000000000000000000010000\\OFF=s8'11111110")).toBe('fifo #(W=16, OFF=-2)');
    expect(moduleTitle('$paramod$4be1c0ffee\\fifo')).toBe('fifo #(…)');
    expect(moduleTitle('full_adder')).toBe('full_adder');
  });

  it('takes a dropped file for a new version of an open file only by its file name (G1)', () => {
    const top = 'module top(input clk, input rst, output y); assign y = clk & rst; endmodule\n';
    const open = { [AUCTION_FILE]: AUCTION_SOURCE, 'top.v': top };
    // Another design's top under a name no open file has: Import Verilog shows what importing it does.
    const fruit = 'module top(input clk, output y); assign y = clk; endmodule\nmodule crop(input a, output y); assign y = a; endmodule\n';
    expect(planDrop(open, {}, { 'fruit_battle.v': fruit })).toEqual({ kind: 'ask', name: 'fruit_battle.v', code: fruit });
    // So does one module of an open file.
    const mine = 'module max_select(input [3:0] bid_a, input [3:0] bid_b, input valid_a, input valid_b, output [3:0] max_bid, output winner); endmodule\n';
    expect(planDrop(open, {}, { 'my_max.v': mine }).kind).toBe('ask');
    // Several such files are added as they are; the modules declared twice are named.
    expect(planDrop(open, {}, { 'fruit_battle.v': fruit, 'my_max.v': mine })).toEqual({ kind: 'add', twice: ['top', 'max_select'] });
    // The name of an open file, or of a removed one whose edits are put aside: a new version, as Import does.
    expect(planDrop(open, {}, { 'top.v': fruit })).toMatchObject({ kind: 'update', plan: { replaced: [], trimmed: [] } });
    expect(planDrop({ [AUCTION_FILE]: AUCTION_SOURCE }, { 'top.v': {} }, { 'top.v': fruit }).kind).toBe('update');
    // A new version of an open file that declares a module another open file declares: that file changes, and the plan says so.
    const back = planDrop({ [AUCTION_FILE]: AUCTION_SOURCE.replace(/module max_select[\s\S]*?endmodule\n/, ''), 'my_max.v': mine }, {}, { [AUCTION_FILE]: AUCTION_SOURCE });
    expect(back).toMatchObject({ kind: 'update', plan: { replaced: ['my_max.v'] } });
    // Nothing in common: added.
    expect(planDrop(open, {}, { 'c.v': 'module c(input a, output y); assign y = a; endmodule\n' })).toMatchObject({ kind: 'update', plan: { replaced: [], trimmed: [] } });
  });

  it('pastes a copy where it overlaps nothing (N30)', () => {
    const a = { x: 0, y: 0, width: 40, height: 40 };
    const b = { x: 100, y: 60, width: 40, height: 40 };
    const box = { x: 0, y: 0, width: 140, height: 100 };
    // On the sheet it was copied from: straight below the original.
    expect(pasteSpot(box, [a, b])).toEqual({ x: 0, y: 120 });
    // Below a symbol that is in the way there too.
    expect(pasteSpot(box, [a, b, { x: 50, y: 150, width: 40, height: 40 }])).toEqual({ x: 0, y: 210 });
    // On an empty sheet: the same place.
    expect(pasteSpot(box, [])).toEqual({ x: 0, y: 0 });
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

  it('finds the stretch of a wire up to a point on it', () => {
    const w = [
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 50, y: 80 },
      { x: 120, y: 80 },
    ];
    expect(wireUpTo(w, { x: 30, y: 0 })).toEqual([{ x: 0, y: 0 }]);
    expect(wireUpTo(w, { x: 50, y: 40 })).toEqual([{ x: 0, y: 0 }, { x: 50, y: 0 }]);
    expect(wireUpTo(w, { x: 90, y: 80 })).toEqual([{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 80 }]);
    // Not on it (the wire was redrawn): nothing, rather than the whole wire up to its pin.
    expect(wireUpTo(w, { x: 200, y: 200 })).toEqual([]);
  });
});

const HALF = 'module half_adder(input a, input b, output s, output c); assign s = a ^ b; assign c = a & b; endmodule\n';

describe('store', () => {
  it('copies a sheet with automatic blocks into drawings that need no Verilog (C1)', async () => {
    await open({ 'fruit.v': FRUIT_SOURCE });
    const autos = Object.values(st().blockDesign!.modules).filter((m) => m.auto);
    expect(autos.length).toBeGreaterThan(0);
    const before = st().netlist!;
    const drawnBefore = st().doc.drawn.length;
    await st().convertToDrawing();
    await settle();
    expect(st().path).toEqual([{ instance: 'top_drawing', module: 'top_drawing', drawn: true }]);
    const wires = st().netlist!.edges.length;
    expect(wires).toBe(before.edges.length);
    // Each automatic block is a drawing of its own (named after the copy and the block), and the copy's blocks use those.
    const blocks = st().doc.sheets['d:top_drawing'].nodes.filter((n) => n.sym === 'block');
    expect(blocks.length).toBe(autos.length);
    expect(st().doc.drawn).toEqual(['top_drawing', ...autos.map((m) => m.name.replace('top/', 'top_drawing_'))]);
    expect(blocks.every((b) => st().doc.drawn.includes(b.params.module!))).toBe(true);
    // Every block keeps all its pins (named as before) and wires.
    for (const b of blocks) {
      const n = st().netlist!.nodes.find((x) => x.id === b.id)!;
      const was = before.nodes.find((x) => x.id === b.id)!;
      expect(n.ports.map((p) => p.name)).toEqual(was.ports.map((p) => p.name));
    }
    expect(st().notice).toMatch(/drawings of their own/);
    // One undo step.
    const drawn = st().doc.drawn;
    st().undo();
    await settle();
    expect(st().doc.drawn.length).toBe(drawnBefore);
    st().redo();
    await settle();
    expect(st().doc.drawn).toEqual(drawn);
    await st().openPath([{ instance: 'top_drawing', module: 'top_drawing', drawn: true }]);
    // The full circuit does not change what the drawing shows.
    await st().setViewMode('flat');
    await settle();
    expect(st().sheet).toBe('d:top_drawing');
    expect(st().netlist!.edges.length).toBe(wires);
    // Nor does another design: no block loses its pins, and Yosys reads the exported Verilog alone.
    await st().loadExample('auction');
    await settle();
    await st().openPath([{ instance: 'top_drawing', module: 'top_drawing', drawn: true }]);
    expect(st().netlist!.edges.length).toBe(wires);
    expect(st().netlist!.nodes.filter((n) => n.attrs?.missingModule)).toEqual([]);
    const out = exportCurrent();
    expect(Object.keys(out.check.files)).toEqual(['top_drawing.v']);
    await expect(elaborate(out.check.files, out.check.top)).resolves.toBeDefined();
    // Instances of Verilog modules stay instances of those modules, and the notice says so.
    await st().openPath([{ instance: 'auction_top', module: 'auction_top' }]);
    await st().setViewMode('blocks');
    await settle();
    await st().convertToDrawing();
    expect(st().notice).toMatch(/Instances of .*bid_check.* still use those modules from your Verilog files/);
  }, 60_000);

  it('lays out a sheet again when undo unpins it after a rule change (C2)', async () => {
    await open({ [AUCTION_FILE]: AUCTION_SOURCE });
    const key = st().sheet;
    const y0 = input('clk').y;
    st().moveSelection(new Set([input('clk').id]), 0, 150);
    expect(input('clk').y).toBe(y0 + 150);
    // Every symbol has a position: the new rules' layout is not computed.
    const rules = st().rules;
    await st().toggleRule(RULES[0].id);
    // The rule change is an undo step of its own (G12h), and so is the move before it.
    st().undo();
    await settle();
    expect([...st().rules].sort()).toEqual([...rules].sort());
    expect(input('clk').y).toBe(y0 + 150);
    st().redo();
    await settle();
    expect(st().rules.has(RULES[0].id)).toBe(!rules.has(RULES[0].id));
    st().undo();
    await settle();
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
    // Only the switch itself is a step (Undo goes back to the block diagram).
    expect(st().past.map((h) => !!h.nav)).toEqual([true]);
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
    // The first Undo goes back to the block diagram, the next one takes the move back.
    st().undo();
    await settle();
    expect(st().viewMode).toBe('blocks');
    expect(st().sheet).toBe('v:blocks:auction_top');
    expect(input('clk').y).toBe(y0 + 120);
    st().undo();
    await settle();
    expect(input('clk').y).toBe(y0);
    // Switching views keeps the redo history; Redo shows the view the move was made in.
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
    // One undo step brings them back, with the file they belong to.
    st().undo();
    await settle();
    expect(Object.keys(st().files)).toEqual(['mine.v']);
    expect(st().doc.sheets['v:blocks:top'].hidden.length).toBe(1);
    // An example always opens clean.
    await st().loadExample('fruit');
    expect(Object.keys(st().doc.sheets).filter((k) => k.startsWith('v:'))).toEqual([]);
  }, 60_000);

  it('undoes opening another design with its files, so no edit lands on the other design (N1)', async () => {
    await open({ 'mine.v': 'module top(input clk, input rst, output y); assign y = clk & rst; endmodule\n' });
    st().select([input('clk').id]);
    st().deleteSelection();
    await st().loadExample('fruit');
    await settle();
    const fruitInputs = st().layout!.nodes.filter((n) => n.kind === 'input').length;
    st().undo();
    await settle();
    // The other design is back, with its edit; Fruit's top never shows it.
    expect(Object.keys(st().files)).toEqual(['mine.v']);
    expect(st().doc.sheets['v:blocks:top'].hidden.length).toBe(1);
    expect(st().layout!.nodes.some((n) => n.kind === 'input' && n.label === 'clk')).toBe(false);
    st().redo();
    await settle();
    expect(Object.keys(st().files)).toEqual([FRUIT_FILE]);
    expect(st().doc.sheets['v:blocks:top']).toBeUndefined();
    expect(st().layout!.nodes.filter((n) => n.kind === 'input').length).toBe(fruitInputs);

    // Undo twice after a move on Auction and Load example: Auction, then the move undone, on screen.
    await open({ [AUCTION_FILE]: AUCTION_SOURCE });
    const y0 = input('clk').y;
    st().moveSelection(new Set([input('clk').id]), 0, 100);
    await st().loadExample('fruit');
    await settle();
    st().undo();
    await settle();
    expect(st().path).toEqual([{ instance: 'auction_top', module: 'auction_top' }]);
    expect(input('clk').y).toBe(y0 + 100);
    st().undo();
    await settle();
    expect(input('clk').y).toBe(y0);
    expect(st().past).toEqual([]);
    // Opening the first example at start is not a step.
    await open({});
    await st().loadExample();
    expect(st().past).toEqual([]);
  }, 60_000);

  it('keeps the edits when an import replaces an open file under another name, and Undo brings the file back (N5, N6)', async () => {
    await open({ [AUCTION_FILE]: AUCTION_SOURCE });
    const y0 = input('clk').y;
    st().moveSelection(new Set([input('clk').id]), 0, 100);
    await st().setFiles({ 'auction_v2.v': AUCTION_SOURCE.replace("bid != 4'd0", "bid != 4'd1") }, false, { newVersion: true });
    await settle();
    expect(Object.keys(st().files)).toEqual(['auction_v2.v']);
    expect(input('clk').y).toBe(y0 + 100);
    st().undo();
    await settle();
    expect(Object.keys(st().files)).toEqual([AUCTION_FILE]);
    expect(input('clk').y).toBe(y0 + 100);

    // A file with one module of auction.v replaces that module only.
    await st().setFiles({ 'bid_check.v': 'module bid_check(input [3:0] bid, input [3:0] budget, output valid); assign valid = bid < budget; endmodule\n' }, false, { newVersion: true });
    await settle();
    expect(st().error).toBeUndefined();
    expect(Object.keys(st().files)).toEqual([AUCTION_FILE, 'bid_check.v']);
    expect(st().design!.top).toBe('auction_top');
    expect(Object.keys(st().design!.modules).sort()).toEqual(['auction_top', 'bid_check', 'max_select', 'result_decode', 'score_board', 'score_calc']);
    expect(input('clk').y).toBe(y0 + 100);
    st().undo();
    await settle();
    expect(st().files).toEqual({ [AUCTION_FILE]: AUCTION_SOURCE });

    // Replacing all files with some of the same names keeps the edits; Undo brings back the files left out.
    await st().setFiles({ 'other.v': HALF }, false);
    await st().setTop('auction_top');
    await settle();
    await st().setFiles({ 'other.v': HALF, 'auction_v2.v': AUCTION_SOURCE }, true);
    await settle();
    expect(input('clk').y).toBe(y0 + 100);
    st().undo();
    await settle();
    expect(Object.keys(st().files).sort()).toEqual([AUCTION_FILE, 'other.v']);
  }, 60_000);

  it('opens files picked as a new version of the design, with a file split in two, in place of the old file', async () => {
    const top = 'module top(input a, input b, output y, output z); sub_a u_a(.a(a), .b(b), .y(y)); sub_b u_b(.a(a), .b(b), .z(z)); endmodule\n';
    const subA = 'module sub_a(input a, input b, output y); assign y = a & b; endmodule\n';
    const subB = 'module sub_b(input a, input b, output z); assign z = a | b; endmodule\n';
    await open({ 'top.v': top, 'parts.v': subA + subB });
    const y0 = input('a').y;
    st().moveSelection(new Set([input('a').id]), 0, 100);
    const split = { 'top.v': top, 'sub_a.v': subA, 'sub_b.v': subB };
    // Dropped, the files of other names would be added as they are, with sub_a and sub_b declared twice.
    expect(planDrop(st().files, st().putAside, split)).toEqual({ kind: 'add', twice: ['sub_a', 'sub_b'] });
    // Picked in File › Open Verilog files with top.v, they are parts of the design: parts.v gives way to them.
    const plan = planOpen(st().files, st().putAside, split);
    expect(plan).toMatchObject({ replaced: ['parts.v'], trimmed: [], clashes: [] });
    expect(Object.keys(plan!.files)).toEqual(['top.v', 'sub_a.v', 'sub_b.v']);
    await st().setFiles(split, false, { newVersion: true });
    await settle();
    expect(st().error).toBeUndefined();
    expect(Object.keys(st().files)).toEqual(['top.v', 'sub_a.v', 'sub_b.v']);
    expect(input('a').y).toBe(y0 + 100);
    st().undo();
    await settle();
    expect(Object.keys(st().files)).toEqual(['top.v', 'parts.v']);
    // Files of other names only are another design; a file of a removed one's name is a new version of it.
    expect(planOpen(st().files, st().putAside, { 'other.v': HALF })).toBeUndefined();
    expect(planOpen(st().files, { 'gone.v': {} }, { 'gone.v': HALF })).toMatchObject({ replaced: [], trimmed: [] });
  }, 60_000);

  it('drops the edits of the modules a removed file declared, in one undo step (C5)', async () => {
    await open({ 'pasted.v': 'module top(input clk, input rst, output y); assign y = clk & rst; endmodule\n', 'keep.v': 'module keep(input a, output y); assign y = a; endmodule\n' }, { top: 'top' });
    st().select([input('clk').id]);
    st().deleteSelection();
    useStore.setState({ doc: { ...st().doc, sheets: { ...st().doc.sheets, 'v:blocks:keep': { ...emptyEdits(), hidden: ['in:a'] } } } });
    await st().removeFile('pasted.v');
    await settle();
    expect(st().doc.sheets['v:blocks:top']).toBeUndefined();
    expect(st().doc.sheets['v:blocks:keep'].hidden).toEqual(['in:a']);
    // Another file with a module of that name does not get them.
    await st().setFiles({ [FRUIT_FILE]: FRUIT_SOURCE }, false);
    await settle();
    expect(st().doc.sheets['v:blocks:top']).toBeUndefined();
    await st().removeFile(FRUIT_FILE);
    await settle();
    // Undo puts back the file and its edits, one step at a time.
    st().undo();
    await settle();
    expect(Object.keys(st().files).sort()).toEqual([FRUIT_FILE, 'keep.v']);
    st().undo();
    await settle();
    expect(Object.keys(st().files)).toEqual(['keep.v']);
    st().undo();
    await settle();
    expect(Object.keys(st().files).sort()).toEqual(['keep.v', 'pasted.v']);
    expect(st().doc.sheets['v:blocks:top'].hidden.length).toBe(1);
  }, 60_000);

  it('drops the edits of modules only the files left out declared when all files are replaced by some of the same names (C5)', async () => {
    await open({ [AUCTION_FILE]: AUCTION_SOURCE, 'pasted.v': 'module top(input clk, input rst, output y); assign y = clk & rst; endmodule\n' }, { top: 'top' });
    await settle();
    st().select([input('clk').id]);
    st().deleteSelection();
    // File › Open Verilog files with auction.v alone.
    await st().setFiles({ [AUCTION_FILE]: AUCTION_SOURCE }, true);
    await settle();
    expect(Object.keys(st().files)).toEqual([AUCTION_FILE]);
    expect(st().doc.sheets['v:blocks:top']).toBeUndefined();
    // Another design's top does not get them.
    await st().setFiles({ [FRUIT_FILE]: FRUIT_SOURCE }, false, { newVersion: true });
    await settle();
    await st().openPath([{ instance: 'top', module: 'top' }]);
    await settle();
    expect(st().doc.sheets['v:blocks:top']).toBeUndefined();
    expect(input('seed')).toBeDefined();
    expect(st().layout!.nodes.some((n) => n.id.startsWith('u:'))).toBe(false);
    // Undo, one step at a time: without Fruit Battle, then with pasted.v and its edits.
    st().undo();
    await settle();
    expect(Object.keys(st().files)).toEqual([AUCTION_FILE]);
    st().undo();
    await settle();
    expect(Object.keys(st().files).sort()).toEqual([AUCTION_FILE, 'pasted.v']);
    expect(st().doc.sheets['v:blocks:top'].hidden.length).toBe(1);
  }, 60_000);

  it('makes every import that changes the open files one undo step that brings them back, with the Top choice (F1, F10)', async () => {
    await open({ [AUCTION_FILE]: AUCTION_SOURCE });
    const y0 = input('clk').y;
    st().moveSelection(new Set([input('clk').id]), 0, 100);
    const steps = st().past.length;
    // A new file (shown as the top, as the design does not use it), then a new version under its own name.
    const fsm1 = 'module fsm(input clk, input go, output reg st); always @(posedge clk) st <= go; endmodule\n';
    const fsm2 = fsm1.replace('st <= go', 'st <= !go');
    await st().setFiles({ 'fsm.v': fsm1 }, false, { newVersion: true });
    await settle();
    expect(st().design!.top).toBe('fsm');
    await st().setFiles({ 'fsm.v': fsm2 }, false, { newVersion: true });
    await settle();
    // Nothing changes: no step.
    await st().setFiles({ 'fsm.v': fsm2 }, false, { newVersion: true });
    await settle();
    expect(st().past.length).toBe(steps + 2);
    st().undo();
    await settle();
    expect(st().files).toEqual({ [AUCTION_FILE]: AUCTION_SOURCE, 'fsm.v': fsm1 });
    st().undo();
    await settle();
    expect(st().files).toEqual({ [AUCTION_FILE]: AUCTION_SOURCE });
    expect(st().design!.top).toBe('auction_top');
    expect(input('clk').y).toBe(y0 + 100);
    st().redo();
    st().redo();
    await vi.waitFor(() => expect(st().files['fsm.v']).toBe(fsm2));
    await settle();

    // A new version of auction.v under its own name: Undo brings back the old text, not the move before it.
    await open({ [AUCTION_FILE]: AUCTION_SOURCE });
    st().moveSelection(new Set([input('clk').id]), 0, 100);
    const v2 = AUCTION_SOURCE.replace("bid != 4'd0", "bid != 4'd1");
    await st().setFiles({ [AUCTION_FILE]: v2 }, false, { newVersion: true });
    await settle();
    expect(input('clk').y).toBe(y0 + 100);
    st().undo();
    await settle();
    expect(st().files).toEqual({ [AUCTION_FILE]: AUCTION_SOURCE });
    expect(input('clk').y).toBe(y0 + 100);
    // And with Replace (File › Open Verilog files of the same file).
    await st().setFiles({ [AUCTION_FILE]: v2 }, true);
    await settle();
    st().undo();
    await settle();
    expect(st().files).toEqual({ [AUCTION_FILE]: AUCTION_SOURCE });
    expect(input('clk').y).toBe(y0 + 100);
  }, 60_000);

  it('keeps the edits of a removed file for a new version under the same name, and only for it (F3)', async () => {
    const keep = { 'keep.v': 'module keep(input a, output y); assign y = a; endmodule\n' };
    await open({ [AUCTION_FILE]: AUCTION_SOURCE, ...keep }, { top: 'auction_top' });
    const y0 = input('clk').y;
    st().moveSelection(new Set([input('clk').id]), 0, 100);
    await st().removeFile(AUCTION_FILE);
    await settle();
    expect(Object.keys(st().doc.sheets).filter((k) => k.startsWith('v:') && !k.endsWith(':keep'))).toEqual([]);
    // Dropped onto the app, a new version under the same name brings them back.
    const v2 = AUCTION_SOURCE.replace("bid != 4'd0", "bid != 4'd1");
    await st().setFiles({ [AUCTION_FILE]: v2 }, false, { newVersion: true });
    await settle();
    await st().setTop('auction_top');
    await settle();
    expect(input('clk').y).toBe(y0 + 100);
    // Undo the import and import it again: still there (Undo brings back what was put aside).
    st().undo();
    await vi.waitFor(() => expect(Object.keys(st().files)).toEqual(['keep.v']));
    await settle();
    await st().setFiles({ [AUCTION_FILE]: v2 }, true);
    await settle();
    expect(input('clk').y).toBe(y0 + 100);
    // Undo twice: the removal undone, the file and the edits as they were.
    st().undo();
    await settle();
    st().undo();
    await settle();
    expect(st().files).toEqual({ [AUCTION_FILE]: AUCTION_SOURCE, ...keep });
    expect(input('clk').y).toBe(y0 + 100);
    // Under another name, or after another design was opened, it is another file: no edits.
    await st().removeFile(AUCTION_FILE);
    await settle();
    await st().setFiles({ 'auction2.v': v2 }, false, { newVersion: true });
    await settle();
    await st().setTop('auction_top');
    await settle();
    expect(st().doc.sheets['v:blocks:auction_top']).toBeUndefined();
    expect(st().putAside[AUCTION_FILE]).toBeDefined();
    // Saved (to a file, or the browser's copy) and opened again, they are still kept (G3).
    const saved = JSON.stringify(st().savedFile());
    await st().loadSaved(saved);
    await settle();
    expect(Object.keys(st().putAside)).toEqual([AUCTION_FILE]);
    await st().removeFile('auction2.v');
    await settle();
    await st().setFiles({ [AUCTION_FILE]: v2 }, false, { newVersion: true });
    await settle();
    await st().setTop('auction_top');
    await settle();
    expect(input('clk').y).toBe(y0 + 100);
    await st().loadExample('fruit');
    expect(st().putAside).toEqual({});
  }, 60_000);

  it('makes room for the symbols that grew when it opens a drawing saved with the old outlines, once', async () => {
    // An adder (40x40 then) with an inverter 10 px under it and another right over it, wired as they were drawn.
    const d: SheetEdits = {
      ...drawing(
        [{ ...newUserNode('u:1', 'add'), params: { width: 4 } }, newUserNode('u:2', 'not'), newUserNode('u:3', 'not'), pin('u:4', 'input', 'a')],
        [{ id: 'w:1', source: { node: 'u:4', port: 'u:4.out' }, target: { node: 'u:1', port: 'u:1.B' } }],
      ),
      pos: { 'u:1': { x: 200, y: 100 }, 'u:2': { x: 200, y: 150 }, 'u:3': { x: 200, y: 50 }, 'u:4': { x: 0, y: 120 } },
      routes: { 'w:1': { points: [{ x: 40, y: 130 }, { x: 200, y: 130 }] } },
    };
    await open({}, { outlines: undefined, doc: { drawn: ['old'], sheets: { 'd:old': d } }, path: [{ instance: 'old', module: 'old', drawn: true }] });
    const box = (id: string) => st().layout!.nodes.find((n) => n.id === id)!;
    // The adder grew down and the inverter under it moved down as far; the wire meets the adder's B pin again.
    expect([box('u:1').y, box('u:1').height]).toEqual([100, 60]);
    expect(box('u:2').y).toBe(170);
    expect(box('u:3').y).toBe(50);
    const w = st().layout!.edges.find((x) => x.id === 'w:1')!;
    const b = box('u:1').ports.find((q) => q.name === 'B')!;
    expect(w.points[w.points.length - 1]).toEqual({ x: b.x, y: b.y });
    // Stored as the drawing is now, and saved with today's outlines: opened again, nothing moves.
    expect(st().doc.sheets['d:old'].oldOutlines).toBeUndefined();
    expect(st().doc.sheets['d:old'].pos['u:2']).toEqual({ x: 200, y: 170 });
    const saved = JSON.parse(JSON.stringify(st().savedFile())) as SavedFile;
    expect(saved.outlines).toBe(OUTLINES);
    expect(saved.doc.sheets['d:old'].oldOutlines).toBeUndefined();
    await st().loadSaved(JSON.stringify(saved));
    expect(box('u:2').y).toBe(170);
    expect(box('u:1').y).toBe(100);
  });

  it('makes that room clear of a block whose Verilog failed, as tall as the block turns out once it loads', async () => {
    // A block of alu8 right over an adder that grows by 20 px. Without the Verilog the block has no pins and is
    // drawn much shorter: the adder must not grow up into where the block reaches once its Verilog is fixed.
    const alu = 'module alu8(input [7:0] a, input [7:0] b, input [2:0] op, input c, output [7:0] y, output z);\n  assign y = a + b;\n  assign z = c;\nendmodule\n';
    const d: SheetEdits = {
      ...drawing([
        { ...newUserNode('u:1', 'block'), params: { module: 'alu8' }, name: 'u_alu' },
        { ...newUserNode('u:2', 'add'), params: { width: 4 } },
      ]),
      pos: { 'u:1': { x: 200, y: 0 }, 'u:2': { x: 200, y: 140 } },
    };
    const path = [{ instance: 'old', module: 'old', drawn: true }];
    await open({ 'alu.v': alu.replace('a + b', 'a +') }, { outlines: undefined, doc: { drawn: ['old'], sheets: { 'd:old': d } }, path });
    await settle();
    const box = (id: string) => st().layout!.nodes.find((n) => n.id === id)!;
    expect(st().status).toBe('error');
    expect(st().path).toEqual(path);
    expect(box('u:1').ports).toEqual([]);
    expect(box('u:1').height).toBeLessThan(140 - 20);
    // The adder grew down, and the drawing is stored as it is now.
    expect([box('u:2').y, box('u:2').height]).toEqual([140, 60]);
    expect(st().doc.sheets['d:old'].oldOutlines).toBeUndefined();
    expect(st().doc.sheets['d:old'].pos).toEqual(d.pos);
    // With the Verilog fixed the block has its pins and is taller, still clear of the adder.
    await st().setFiles({ 'alu.v': alu }, true);
    await settle();
    expect(st().status).toBe('ready');
    await st().openPath(path);
    expect(box('u:1').ports.length).toBe(6);
    expect(box('u:1').y + box('u:1').height).toBeLessThanOrEqual(140);
    expect([box('u:2').y, box('u:2').height]).toEqual([140, 60]);
  });

  it('pastes onto another sheet where the user looks, and on its own sheet beside the original (F2, N30)', async () => {
    const far = { ...drawing([pin('u:1', 'input', 'a')]), pos: { 'u:1': { x: 1200, y: 600 } } };
    await open({}, { doc: { drawn: ['a', 'b'], sheets: { 'd:a': far, 'd:b': drawing([]) } }, path: [{ instance: 'a', module: 'a', drawn: true }] });
    st().select(['u:1']);
    expect(st().copy()).toBe(true);
    const box = (id: string) => st().layout!.nodes.find((n) => n.id === id)!;
    await st().openPath([{ instance: 'b', module: 'b', drawn: true }]);
    st().paste({ x: 100, y: 80 });
    const p1 = box([...st().selection][0]);
    expect(Math.abs(p1.x + p1.width / 2 - 100)).toBeLessThanOrEqual(10);
    expect(Math.abs(p1.y + p1.height / 2 - 80)).toBeLessThanOrEqual(10);
    // Again at the same spot: below the first copy, not on top of it.
    st().paste({ x: 100, y: 80 });
    const p2 = box([...st().selection][0]);
    expect(p2.x).toBe(p1.x);
    expect(p2.y).toBeGreaterThanOrEqual(p1.y + p1.height);
    // Back on the sheet it was copied from, while the original is on screen: beside it, wherever the pointer is.
    await st().openPath([{ instance: 'a', module: 'a', drawn: true }]);
    st().paste({ x: 1000, y: 500 }, { x: 900, y: 400, width: 800, height: 600 });
    const p3 = box([...st().selection][0]);
    expect(p3.x).toBe(1200);
    expect(p3.y).toBeGreaterThan(600);
    // With that spot out of view (the view moved away, or after a Cut): where the user looks (G2).
    st().select(['u:1']);
    st().cut();
    expect(st().layout!.nodes.some((n) => n.id === 'u:1')).toBe(false);
    st().paste({ x: 100, y: 80 }, { x: 0, y: 0, width: 400, height: 300 });
    const p4 = box([...st().selection][0]);
    expect(Math.abs(p4.x + p4.width / 2 - 100)).toBeLessThanOrEqual(10);
    expect(Math.abs(p4.y + p4.height / 2 - 80)).toBeLessThanOrEqual(10);
    // A Cut pasted while its spot is still on screen goes back there.
    st().select([...st().selection]);
    st().cut();
    st().paste({ x: 300, y: 200 }, { x: 0, y: 0, width: 800, height: 600 });
    expect(box([...st().selection][0])).toMatchObject({ x: p4.x, y: p4.y });
  }, 60_000);

  it('names the drawings of a copy apart from the automatic blocks the Verilog export writes (F6)', async () => {
    await open({ [FRUIT_FILE]: FRUIT_SOURCE });
    const before = exportCurrent();
    await st().convertToDrawing();
    await settle();
    // The copy's export is as quiet as the sheet's: the block that drives output game_result is named apart from it, as the export names the instance.
    expect(st().sheet).toBe('d:top_drawing');
    expect(exportCurrent().warnings).toEqual([]);
    expect(st().doc.sheets['d:top_drawing'].nodes.find((n) => n.params.module === 'top_drawing_game_result')?.name).toBe('game_result_2');
    await st().openPath([{ instance: 'top', module: 'top' }]);
    await settle();
    const after = exportCurrent();
    expect(after.warnings).toEqual(before.warnings);
    expect(after.code).toBe(before.code);
  }, 60_000);

  it('keeps the notice about a renamed drawing when an import is shown as the top (N25)', async () => {
    await open({ [AUCTION_FILE]: AUCTION_SOURCE });
    st().newDrawing('fa');
    await settle();
    await st().setFiles({ 'pasted.v': 'module fa (input a, input b, input cin, output s, output cout); assign {cout, s} = a + b + cin; endmodule\n' }, false);
    await settle();
    expect(st().doc.drawn).toEqual(['fa_2']);
    expect(st().notice).toMatch(/Renamed drawing fa → fa_2.*Showing fa/);
  }, 60_000);

  it('keeps the browser copy in step with an opened or saved file (N27, N28)', async () => {
    const store = new Map<string, string>();
    let writes = 0;
    const setItem = (k: string, v: string) => {
      writes++;
      store.set(k, v);
    };
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem });
    try {
      const stored = () => JSON.parse(store.get(AUTOSAVE_KEY) ?? '{}') as SavedFile & { saved?: boolean };
      // Opening a file updates the copy at once (a reload must not bring back the work before it).
      await open({}, { doc: { drawn: ['ripple'], sheets: { 'd:ripple': drawing([pin('u:1', 'input', 'a')]) } }, path: [{ instance: 'ripple', module: 'ripple', drawn: true }] });
      await vi.waitFor(() => expect(stored().doc?.drawn).toEqual(['ripple']));
      expect(stored().saved).toBe(true);
      // An edit is unsaved work; Save makes it saved, and a reload says so.
      st().renameItem('u:1', 'b');
      await vi.waitFor(() => expect(stored().saved).toBeUndefined());
      st().markSaved();
      await vi.waitFor(() => expect(stored().saved).toBe(true));
      await st().restoreAutosave();
      expect(st().dirty).toBe(false);
      st().renameItem('u:1', 'c');
      await vi.waitFor(() => expect(stored().saved).toBeUndefined());
      const n = writes;
      await st().restoreAutosave();
      expect(st().dirty).toBe(true);
      // Opening the copy changes nothing in it, so it is not written again (other tabs would take that for new work: H1).
      await new Promise((r) => setTimeout(r, 500));
      expect(writes).toBe(n);
    } finally {
      vi.unstubAllGlobals();
    }
  }, 60_000);

  it("never overwrites another tab's copy of its work unasked, and writes a waiting copy when the page goes (G10)", async () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) });
    try {
      const stored = () => JSON.parse(store.get(AUTOSAVE_KEY) ?? '{}') as SavedFile;
      await open({}, { doc: { drawn: ['mine'], sheets: { 'd:mine': drawing([pin('u:1', 'input', 'a')]) } }, path: [{ instance: 'mine', module: 'mine', drawn: true }] });
      await vi.waitFor(() => expect(stored().doc?.drawn).toEqual(['mine']));
      // A copy waiting to be written goes at once when the page is closed or reloaded.
      st().renameItem('u:1', 'b');
      st().flushAutosave();
      expect(stored().doc.sheets['d:mine'].nodes[0].name).toBe('b');
      // Another tab writes its work: this tab stops writing, also what was waiting.
      st().renameItem('u:1', 'c');
      const other = JSON.stringify({ ...stored(), doc: { drawn: ['theirs'], sheets: { 'd:theirs': drawing([]) } } });
      store.set(AUTOSAVE_KEY, other);
      st().otherTabSaved(other);
      st().renameItem('u:1', 'd');
      st().flushAutosave();
      await new Promise((r) => setTimeout(r, 500));
      expect(store.get(AUTOSAVE_KEY)).toBe(other);
      expect(st().autosavePaused).toBe(true);
      // Keeping this tab's work writes it.
      st().keepThisTab();
      expect(stored().doc.sheets['d:mine'].nodes[0].name).toBe('d');
      // Or the other tab's work is opened here, and this tab keeps the copy again.
      store.set(AUTOSAVE_KEY, other);
      st().otherTabSaved(other);
      await st().restoreAutosave();
      expect(st().doc.drawn).toEqual(['theirs']);
      expect(st().autosavePaused).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  }, 60_000);

  it('goes on keeping its copy when another tab only opens the work or looks at other sheets (H1)', async () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) });
    try {
      const stored = () => JSON.parse(store.get(AUTOSAVE_KEY) ?? '{}') as SavedFile;
      const sheet = drawing([pin('u:1', 'input', 'a'), newUserNode('u:2', 'and')]);
      await open({}, { doc: { drawn: ['mine'], sheets: { 'd:mine': sheet } }, path: [{ instance: 'mine', module: 'mine', drawn: true }] });
      await vi.waitFor(() => expect(stored().doc?.drawn).toEqual(['mine']));
      // The other tab opened the copy and looks at another view and sheet: it writes the same work, read back with
      // the keys of its objects in another order.
      const reorder = (v: unknown): unknown =>
        Array.isArray(v) ? v.map(reorder) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reorder(x)])) : v;
      const theirs = JSON.stringify(reorder({ ...stored(), viewMode: 'flat', path: [{ instance: 'x', module: 'x' }] }));
      store.set(AUTOSAVE_KEY, theirs);
      st().otherTabSaved(theirs);
      expect(st().autosavePaused).toBeFalsy();
      // This tab's next edits still go to the copy.
      st().renameItem('u:1', 'b');
      st().flushAutosave();
      expect(stored().doc.sheets['d:mine'].nodes[0].name).toBe('b');
      // Other work from another tab still stops it.
      const other = JSON.stringify({ ...stored(), doc: { drawn: ['theirs'], sheets: { 'd:theirs': drawing([]) } } });
      store.set(AUTOSAVE_KEY, other);
      st().otherTabSaved(other);
      expect(st().autosavePaused).toBe(true);
      st().keepThisTab();
      expect(stored().doc.drawn).toEqual(['mine']);
    } finally {
      vi.unstubAllGlobals();
    }
  }, 60_000);

  it('does not write what drawing a sheet worked out while the tab only looks, so the tab working on it goes on (H1)', async () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) });
    try {
      const sub = (or: boolean) =>
        `module sub(input a, input b, output y${or ? ', output z' : ''}); assign y = a & b;${or ? ' assign z = a | b;' : ''} endmodule\n` +
        `module top(input a, input b, output y${or ? ', output z' : ''}); sub u_sub(.a(a), .b(b), .y(y)${or ? ', .z(z)' : ''}); endmodule\n`;
      const top = { instance: 'top', module: 'top' };
      const uSub = [top, { instance: 'u_sub', module: 'sub' }];
      const stored = () => JSON.parse(store.get(AUTOSAVE_KEY) ?? '{}') as SavedFile;
      const work = () => copyKeys(store.get(AUTOSAVE_KEY)!)!.work;
      // The working tab moves the AND on u_sub's sheet, then imports sub with an OR, while it looks at top.
      await open({ 'm.v': sub(false) });
      await st().openPath(uSub);
      await settle();
      const and = nodeOf((n) => n.kind === 'cell').id;
      st().moveSelection(new Set([and]), 0, 40);
      await st().openPath([top]);
      await settle();
      await st().setFiles({ 'm.v': sub(true) }, false, { newVersion: true });
      await settle();
      st().flushAutosave();
      const theirs = work();
      expect(Object.keys(stored().doc.sheets['v:blocks:sub'].pos)).not.toContain('out:z');
      // Another tab opens the copy and u_sub's sheet, which places the OR and z and stores where (no edit of the user's).
      await st().restoreAutosave();
      await st().openPath(uSub);
      await settle();
      expect(Object.keys(st().doc.sheets['v:blocks:sub'].pos)).toContain('out:z');
      // It shows the full circuit: what it writes holds the same work, only another view.
      await st().setViewMode('flat');
      await settle();
      st().flushAutosave();
      expect(stored().viewMode).toBe('flat');
      expect(work()).toBe(theirs);
      st().otherTabSaved(store.get(AUTOSAVE_KEY)!);
      expect(st().autosavePaused).toBeFalsy();
      // Once it edits the work, it writes all of it, with the places it worked out.
      await st().setViewMode('blocks');
      await st().openPath(uSub);
      await settle();
      st().moveSelection(new Set([and]), 0, 10);
      st().flushAutosave();
      expect(work()).not.toBe(theirs);
      expect(Object.keys(stored().doc.sheets['v:blocks:sub'].pos)).toContain('out:z');
    } finally {
      vi.unstubAllGlobals();
    }
  }, 60_000);

  it('keeps the edits of a parameterized module when new code gives it other parameters (H7)', async () => {
    const uart = (div: number, div2 = div) => `module baud_gen #(parameter DIV = 10) (input wire clk, input wire en, output wire tick);
  reg [3:0] cnt;
  always @(posedge clk) cnt <= (cnt == DIV - 1) ? 4'd0 : cnt + 4'd1;
  assign tick = en && (cnt == DIV - 1);
endmodule
module uart_top (input wire clk, input wire en, output wire tick, output wire tick2);
  baud_gen #(.DIV(${div})) u_baud (.clk(clk), .en(en), .tick(tick));
  baud_gen #(.DIV(${div2})) u_baud2 (.clk(clk), .en(en), .tick(tick2));
endmodule
`;
    await open({ 'uart.v': uart(10) });
    await st().openPath([st().path[0], { instance: 'u_baud', module: st().design!.modules.uart_top.cells.find((c) => c.name === 'u_baud')!.type }]);
    await settle();
    const div10 = st().path[1].module;
    expect(moduleTitle(div10)).toBe('baud_gen #(DIV=10)');
    st().startPlacing({ sym: 'text' });
    st().placeAt({ x: 0, y: -200 });
    st().renameItem([...st().selection][0], 'Baud tick every DIV clocks');
    const note = () => st().netlist!.nodes.find((n) => n.kind === 'text')?.label;
    expect(note()).toBe('Baud tick every DIV clocks');
    // Both instances get DIV=12: the sheet of the new copy has the edits, in the import's undo step.
    await st().setFiles({ 'uart.v': uart(12) }, false, { newVersion: true });
    await settle();
    expect(moduleTitle(st().path[1].module)).toBe('baud_gen #(DIV=12)');
    expect(note()).toBe('Baud tick every DIV clocks');
    expect(Object.keys(st().doc.sheets).filter((k) => k.includes('baud_gen'))).toEqual([`v:blocks:${st().path[1].module}`]);
    expect(st().notice).toMatch(/edits on baud_gen #\(DIV=10\) now apply to baud_gen #\(DIV=12\)/);
    st().undo();
    await settle();
    expect(st().path[1].module).toBe(div10);
    expect(note()).toBe('Baud tick every DIV clocks');
    st().redo();
    await settle();
    expect(moduleTitle(st().path[1].module)).toBe('baud_gen #(DIV=12)');
    expect(note()).toBe('Baud tick every DIV clocks');
    // Code the design does not use opens as the top: the modules of the old top are only out of sight, nothing is said about them.
    await st().setFiles({ 'other.v': 'module other (input a, output y); assign y = ~a; endmodule\n' }, false, { newVersion: true });
    await settle();
    expect(st().design!.top).toBe('other');
    expect(st().notice).not.toMatch(/no longer show/);
    await st().removeFile('other.v');
    await settle();
    await st().openPath([st().path[0], { instance: 'u_baud', module: st().design!.modules.uart_top.cells.find((c) => c.name === 'u_baud')!.type }]);
    await settle();
    expect(note()).toBe('Baud tick every DIV clocks');
    // The instances part ways: whose module would the edits be? They stay, and the notice says they no longer show.
    await st().setFiles({ 'uart.v': uart(14, 16) }, false, { newVersion: true });
    await settle();
    expect(note()).toBeUndefined();
    expect(st().notice).toMatch(/edits on baud_gen #\(DIV=12\) no longer show/);
  }, 60_000);

  /** uart_top with two baud_gen instances: `undefined` uses the module's default parameters. */
  const baudUart = (div?: number, div2 = div) => {
    const params = (d?: number) => (d === undefined ? '' : `#(.DIV(${d})) `);
    return `module baud_gen #(parameter DIV = 10) (input wire clk, input wire en, output wire tick);
  reg [3:0] cnt;
  always @(posedge clk) cnt <= (cnt == DIV - 1) ? 4'd0 : cnt + 4'd1;
  assign tick = en && (cnt == DIV - 1);
endmodule
module uart_top (input wire clk, input wire en, output wire tick, output wire tick2);
  baud_gen ${params(div)}u_baud (.clk(clk), .en(en), .tick(tick));
  baud_gen ${params(div2)}u_baud2 (.clk(clk), .en(en), .tick(tick2));
endmodule
`;
  };
  const baudOf = (instance: string) => st().design!.modules.uart_top.cells.find((c) => c.name === instance)!.type;
  const openBaud = async (instance = 'u_baud') => {
    await st().openPath([{ instance: 'uart_top', module: 'uart_top' }, { instance, module: baudOf(instance) }]);
    await settle();
  };

  it('keeps the edits of a module used with its defaults when new code gives its instances parameters, and back', async () => {
    await open({ 'uart.v': baudUart() });
    await openBaud();
    expect(st().sheet).toBe('v:blocks:baud_gen');
    st().startPlacing({ sym: 'text' });
    st().placeAt({ x: 0, y: -200 });
    st().renameItem([...st().selection][0], 'Baud tick');
    const note = () => st().netlist!.nodes.find((n) => n.kind === 'text')?.label;
    expect(note()).toBe('Baud tick');
    const baudKeys = () => Object.keys(st().doc.sheets).filter((k) => k.includes('baud_gen'));
    // Both instances get DIV=12: the edits go to the copy Yosys makes for that, in the import's undo step.
    await st().setFiles({ 'uart.v': baudUart(12) }, false, { newVersion: true });
    await settle();
    expect(moduleTitle(st().path[1].module)).toBe('baud_gen #(DIV=12)');
    expect(note()).toBe('Baud tick');
    expect(baudKeys()).toEqual([`v:blocks:${st().path[1].module}`]);
    expect(st().notice).toBe('Your edits on baud_gen now apply to baud_gen #(DIV=12), its new parameters.');
    st().undo();
    await settle();
    expect(st().path[1].module).toBe('baud_gen');
    expect(note()).toBe('Baud tick');
    expect(baudKeys()).toEqual(['v:blocks:baud_gen']);
    st().redo();
    await settle();
    expect(moduleTitle(st().path[1].module)).toBe('baud_gen #(DIV=12)');
    expect(note()).toBe('Baud tick');
    // And back to the defaults.
    await st().setFiles({ 'uart.v': baudUart() }, false, { newVersion: true });
    await settle();
    expect(st().path[1].module).toBe('baud_gen');
    expect(note()).toBe('Baud tick');
    expect(st().notice).toBe('Your edits on baud_gen #(DIV=12) now apply to baud_gen with its default parameters.');
    // One instance keeps the defaults: the edits stay with it, and nothing is said.
    st().setNotice(undefined);
    await st().setFiles({ 'uart.v': baudUart(undefined, 12) }, false, { newVersion: true });
    await settle();
    expect(baudKeys()).toEqual(['v:blocks:baud_gen']);
    expect(st().notice).toBeUndefined();
    await openBaud('u_baud');
    expect(note()).toBe('Baud tick');
    // Both use the defaults again, then part ways: whose module would the edits be? They stay, and the notice says they
    // no longer show.
    await st().setFiles({ 'uart.v': baudUart() }, false, { newVersion: true });
    await settle();
    await st().setFiles({ 'uart.v': baudUart(14, 16) }, false, { newVersion: true });
    await settle();
    expect(note()).toBeUndefined();
    expect(baudKeys()).toEqual(['v:blocks:baud_gen']);
    expect(st().notice).toBe('Your edits on baud_gen no longer show: no instance uses it with its default parameters now. Undo brings back the old code with them.');
    st().undo();
    await settle();
    await openBaud('u_baud');
    expect(note()).toBe('Baud tick');
  }, 60_000);

  it('keeps a copy to a new drawing working when new code gives its blocks other parameters, edited or not', async () => {
    await open({ 'uart.v': baudUart() });
    await st().convertToDrawing();
    await settle();
    expect(st().sheet).toBe('d:uart_top_drawing');
    // The notice names the modules as the Hierarchy does.
    expect(st().notice).toBe('Instances of baud_gen still use those modules from your Verilog files.');
    const blocks = () => st().doc.sheets['d:uart_top_drawing'].nodes.filter((n) => n.sym === 'block').map((n) => moduleTitle(n.params.module!));
    expect(blocks()).toEqual(['baud_gen', 'baud_gen']);
    const wires = st().netlist!.edges.length;
    expect(wires).toBe(6);
    /** The drawing as it is drawn and exported now. */
    const check = async () => {
      await st().openPath([{ instance: 'uart_top_drawing', module: 'uart_top_drawing', drawn: true }]);
      await settle();
      expect(st().netlist!.nodes.filter((n) => n.attrs?.missingModule)).toEqual([]);
      expect(st().layout!.edges.length).toBe(wires);
      expect(exportCurrent().warnings).toEqual([]);
    };
    // No sheet of baud_gen has edits: the blocks follow all the same.
    await st().setFiles({ 'uart.v': baudUart(12) }, false, { newVersion: true });
    await settle();
    expect(blocks()).toEqual(['baud_gen #(DIV=12)', 'baud_gen #(DIV=12)']);
    expect(st().notice).toBe('The blocks of baud_gen on uart_top_drawing now use baud_gen #(DIV=12).');
    await check();
    // From one copy of a parameterized module to another.
    await st().setFiles({ 'uart.v': baudUart(14) }, false, { newVersion: true });
    await settle();
    expect(blocks()).toEqual(['baud_gen #(DIV=14)', 'baud_gen #(DIV=14)']);
    await check();
    st().undo();
    await settle();
    expect(blocks()).toEqual(['baud_gen #(DIV=12)', 'baud_gen #(DIV=12)']);
    st().redo();
    await settle();
    expect(blocks()).toEqual(['baud_gen #(DIV=14)', 'baud_gen #(DIV=14)']);
    await check();
    // The instances part ways: the blocks keep their module, and the notice says where they lost their pins.
    await st().setFiles({ 'uart.v': baudUart(10, 12) }, false, { newVersion: true });
    await settle();
    expect(blocks()).toEqual(['baud_gen #(DIV=14)', 'baud_gen #(DIV=14)']);
    expect(st().notice).toBe(
      'The blocks of baud_gen #(DIV=14) on uart_top_drawing have no pins now: no instance uses it with those parameters now. Undo brings back the old code.',
    );
  }, 60_000);

  it('keeps a copied instance that kept its drawing (a frozen copy) working when new code gives it other parameters', async () => {
    // `half` and `wrap` are left off, so the copy keeps both instances as they are drawn, not as blocks.
    const code = (div: string, w: string) => `module baud_gen #(parameter DIV = 10) (input wire clk, input wire en, output wire tick, output wire half);
  reg [3:0] cnt;
  always @(posedge clk) cnt <= (cnt == DIV - 1) ? 4'd0 : cnt + 4'd1;
  assign tick = en && (cnt == DIV - 1);
  assign half = cnt[3];
endmodule
module counter #(parameter W = 4) (input wire clk, output reg [W-1:0] q, output wire wrap);
  always @(posedge clk) q <= q + 1'b1;
  assign wrap = &q;
endmodule
module uart_top (input wire clk, input wire en, output wire tick, output wire [7:0] q);
  baud_gen ${div}u_baud (.clk(clk), .en(en), .tick(tick));
  counter ${w}u_cnt (.clk(clk), .q(q));
endmodule
`;
    await open({ 'uart.v': code('#(.DIV(10)) ', '#(.W(8)) ') });
    await st().convertToDrawing();
    await settle();
    const copies = () => st().doc.sheets['d:uart_top_drawing'].nodes.filter((n) => n.raw?.kind === 'instance');
    const modules = () => copies().map((n) => moduleTitle(n.raw!.moduleName!));
    const qWidth = () => copies().find((n) => n.raw!.moduleName!.includes('counter'))!.raw!.ports.find((p) => p.name === 'q')!.width;
    expect(copies().map((n) => n.sym)).toEqual(['raw', 'raw']);
    expect(modules()).toEqual(['baud_gen #(DIV=10)', 'counter #(W=8)']);
    /** The drawing as it is exported now. */
    const exported = async () => {
      await st().openPath([{ instance: 'uart_top_drawing', module: 'uart_top_drawing', drawn: true }]);
      await settle();
      return exportCurrent();
    };
    expect((await exported()).warnings).toEqual([]);
    await st().setFiles({ 'uart.v': code('#(.DIV(12)) ', '#(.W(6)) ') }, false, { newVersion: true });
    await settle();
    expect(modules()).toEqual(['baud_gen #(DIV=12)', 'counter #(W=6)']);
    // Its pins take the widths of the new parameters, as a block's do: the export says the 8-bit output gets 6 bits.
    expect(qWidth()).toBe(6);
    expect(st().notice).toBe(
      'The blocks of baud_gen #(DIV=10) on uart_top_drawing now use baud_gen #(DIV=12). The blocks of counter #(W=8) on uart_top_drawing now use counter #(W=6).',
    );
    const out = await exported();
    expect(out.code).toMatch(/^\s*paramod_baud_gen_DIV_s32_0+1100 u_baud \(/m);
    expect(out.warnings).toEqual([expect.stringMatching(/^Width mismatch: output 'q' is 8 bits but its wire from instance u_cnt .* carries 6 bits/)]);
    st().undo();
    await settle();
    expect(modules()).toEqual(['baud_gen #(DIV=10)', 'counter #(W=8)']);
    expect(qWidth()).toBe(8);
    // To the defaults, which the files define themselves.
    await st().setFiles({ 'uart.v': code('', '') }, false, { newVersion: true });
    await settle();
    expect(modules()).toEqual(['baud_gen', 'counter']);
    expect(qWidth()).toBe(4);
    const plain = await exported();
    expect(plain.code).toMatch(/^\s*baud_gen u_baud \(/m);
    expect(plain.code).toMatch(/^\s*counter u_cnt \(/m);
    expect(plain.warnings).toEqual([expect.stringMatching(/^Width mismatch: output 'q' is 8 bits but its wire from instance u_cnt \(counter\) carries 4 bits/)]);
  }, 60_000);

  it("keeps a block placed by hand on its module when an instance elsewhere gets other parameters", async () => {
    await open({ 'uart.v': baudUart() });
    await st().convertToDrawing();
    await settle();
    // On the copy, a block placed by hand goes along with the copied ones.
    st().startPlacing({ sym: 'block', params: { module: 'baud_gen' } });
    st().placeAt({ x: 0, y: 400 });
    await settle();
    st().newDrawing('mine');
    await settle();
    st().startPlacing({ sym: 'block', params: { module: 'baud_gen' } });
    st().placeAt({ x: 0, y: 0 });
    await settle();
    const before = exportCurrent();
    expect(before.code).toMatch(/^\s*baud_gen u1 \(/m);
    const blocks = (sheet: string) => st().doc.sheets[`d:${sheet}`].nodes.filter((n) => n.sym === 'block').map((n) => moduleTitle(n.params.module!));
    await st().setFiles({ 'uart.v': baudUart(12) }, false, { newVersion: true });
    await settle();
    expect(blocks('uart_top_drawing')).toEqual(['baud_gen #(DIV=12)', 'baud_gen #(DIV=12)', 'baud_gen #(DIV=12)']);
    // The drawing of one's own is no copy of uart_top: its block keeps baud_gen, which no instance elaborates now, and says so.
    expect(blocks('mine')).toEqual(['baud_gen']);
    expect(st().notice).toBe(
      'The blocks of baud_gen on uart_top_drawing now use baud_gen #(DIV=12). ' +
        'The blocks of baud_gen on mine have no pins now: no instance uses it with its default parameters now. Undo brings back the old code.',
    );
    await st().openPath([{ instance: 'mine', module: 'mine', drawn: true }]);
    await settle();
    expect(st().issues.messages).toContain('Block u1 uses baud_gen, which no longer exists.');
    // Code that uses the defaults again gives it back its pins and wires.
    await st().setFiles({ 'uart.v': baudUart() }, false, { newVersion: true });
    await settle();
    expect(blocks('uart_top_drawing')).toEqual(['baud_gen', 'baud_gen', 'baud_gen']);
    await st().openPath([{ instance: 'mine', module: 'mine', drawn: true }]);
    await settle();
    expect(exportCurrent()).toEqual(before);
  }, 60_000);

  it('keeps a copy to a new drawing following new parameters after the code renamed the copied instance', async () => {
    // With `half` left off, the copy keeps the instance as it is drawn instead of as a block.
    const code = (name: string, div = '', half = true) => `module baud_gen #(parameter DIV = 10) (input wire clk, input wire en, output wire tick, output wire half);
  reg [3:0] cnt;
  always @(posedge clk) cnt <= (cnt == DIV - 1) ? 4'd0 : cnt + 4'd1;
  assign tick = en && (cnt == DIV - 1);
  assign half = cnt[3];
endmodule
module uart_top (input wire clk, input wire en, output wire tick${half ? ', output wire half' : ''});
  baud_gen ${div}${name} (.clk(clk), .en(en), .tick(tick)${half ? ', .half(half)' : ''});
endmodule
`;
    for (const half of [true, false]) {
      await open({ 'uart.v': code('u_baud', '', half) });
      await st().convertToDrawing();
      await settle();
      const copies = () => st().doc.sheets['d:uart_top_drawing'].nodes.filter((n) => n.sym === 'block' || n.raw?.kind === 'instance');
      const modules = () => copies().map((n) => `${n.id} ${n.sym} ${moduleTitle(n.sym === 'block' ? n.params.module! : n.raw!.moduleName!)}`);
      const sym = half ? 'block' : 'raw';
      expect(modules()).toEqual([`cell:u_baud ${sym} baud_gen`]);
      // The copy keeps the instance's old name (and ID).
      await st().setFiles({ 'uart.v': code('u_b', '', half) }, false, { newVersion: true });
      await settle();
      expect(modules()).toEqual([`cell:u_baud ${sym} baud_gen`]);
      await st().setFiles({ 'uart.v': code('u_b', '#(.DIV(12)) ', half) }, false, { newVersion: true });
      await settle();
      expect(modules()).toEqual([`cell:u_baud ${sym} baud_gen #(DIV=12)`]);
      expect(st().notice).toBe('The blocks of baud_gen on uart_top_drawing now use baud_gen #(DIV=12).');
      await st().openPath([{ instance: 'uart_top_drawing', module: 'uart_top_drawing', drawn: true }]);
      await settle();
      expect(st().netlist!.nodes.filter((n) => n.attrs?.missingModule)).toEqual([]);
      expect(st().netlist!.edges.length).toBe(half ? 4 : 3);
      expect(st().issues.messages).toEqual([]);
      const out = exportCurrent();
      expect(out.code).toMatch(/^\s*paramod_baud_gen_DIV_s32_0+1100 u_baud \(/m);
      expect(out.warnings).toEqual([]);
    }
  }, 60_000);

  it('makes room for the wider blocks of a copy to a new drawing (H8)', async () => {
    await open({ 'uart.v': UART_FSM });
    await st().openPath([{ instance: 'uart_tx_fsm', module: 'uart_tx_fsm' }]);
    await settle();
    /** Symbols that overlap, and wires that run through a symbol, on the sheet on screen. */
    const clashes = () => {
      const ns = st().layout!.nodes;
      const over = ns.flatMap((a, i) =>
        ns.filter((b, j) => j > i && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height).map((b) => `${a.id} × ${b.id}`),
      );
      const under = st().layout!.edges.flatMap((w) => ns.filter((n) => polylineHitsRect(w.points, n)).map((n) => `${w.id} under ${n.id}`));
      return [...over, ...under];
    };
    expect(st().layout!.nodes.filter((n) => n.kind === 'instance').length).toBeGreaterThan(2);
    expect(clashes()).toEqual([]);
    const before = st().layout!;
    await st().convertToDrawing();
    await settle();
    expect(st().sheet).toBe('d:uart_tx_fsm_drawing');
    const blocks = st().layout!.nodes.filter((n) => n.kind === 'instance');
    // The blocks are wider (their titles are their drawings' names), and nothing covers anything.
    expect(blocks.some((b) => b.width > before.nodes.find((n) => n.id === b.id)!.width)).toBe(true);
    expect(clashes()).toEqual([]);
    // The layout is kept: every symbol is where it was or right of it, with its pins at the same heights (a block's header
    // grows upwards), and the order left to right is the same.
    for (const n of st().layout!.nodes) {
      const was = before.nodes.find((x) => x.id === n.id)!;
      expect(n.ports.map((q) => q.y)).toEqual(was.ports.map((q) => q.y));
      expect(n.x).toBeGreaterThanOrEqual(was.x);
    }
    const order = (l: typeof before) => [...l.nodes].sort((a, b) => a.x - b.x || a.y - b.y).map((n) => n.id);
    expect(order(st().layout!)).toEqual(order(before));
    // No wire was routed again: they are the old routes, stretched.
    const bends = (l: typeof before) => l.edges.map((w) => w.points.length).sort((a, b) => a - b);
    expect(bends(st().layout!)).toEqual(bends(before));
  }, 60_000);

  it('says when a wire takes bits its source no longer has (G12d), and never places a symbol right over another (G12g)', async () => {
    const d = { ...pin('u:1', 'input', 'd'), params: { width: 8 } };
    const hi = { ...pin('u:2', 'output', 'hi'), params: { width: 4 } };
    const wire = { id: 'w:3', source: { node: 'u:1', port: 'u:1.out' }, target: { node: 'u:2', port: 'u:2.in' }, slice: { lo: 4, width: 4 }, label: 'd[7:4]' };
    const e: SheetEdits = { ...drawing([d, hi], [wire]), pos: { 'u:1': { x: 0, y: 0 }, 'u:2': { x: 200, y: 0 } } };
    await open({}, { doc: { drawn: ['sl'], sheets: { 'd:sl': e } }, path: [{ instance: 'sl', module: 'sl', drawn: true }] });
    expect(exportCurrent().code).toMatch(/assign hi = d\[7:4\];/);
    expect(exportCurrent().warnings).toEqual([]);
    st().setNotice(undefined);
    st().setNodeParams('u:1', { width: 4 });
    const said = 'The wire from d to hi takes bits 7:4, but d has 4 bits now: it carries all of d. Set its bits again, or widen d.';
    expect(st().notice).toBe(said);
    // The sheet says so as long as it lasts, and draws the wire in the warning colour.
    expect(st().issues.messages).toContain(said);
    expect(st().issues.flagged.has('w:3')).toBe(true);
    expect(exportCurrent().warnings).toContain(said);
    // Inside a block of another drawing too.
    st().newDrawing('outer');
    await settle();
    st().startPlacing({ sym: 'block', params: { module: 'sl' } });
    st().placeAt({ x: 0, y: 0 });
    expect(exportCurrent().warnings).toContain(`sl: ${said}`);
    // Two clicks on one spot: the second symbol goes a little down and right, not over the first.
    st().startPlacing({ sym: 'and' });
    st().placeAt({ x: 300, y: 300 }, true);
    st().placeAt({ x: 300, y: 300 }, true);
    st().placeAt({ x: 300, y: 300 });
    const ands = st().layout!.nodes.filter((n) => n.kind !== 'instance');
    expect(ands.length).toBe(3);
    expect(ands.map((n) => [n.x - ands[0].x, n.y - ands[0].y])).toEqual([
      [0, 0],
      [20, 20],
      [40, 40],
    ]);
  }, 60_000);

  it('pastes and duplicates beside the original, not on top of it (N30)', async () => {
    const and: UserNode = newUserNode('u:3', 'and');
    const e: SheetEdits = {
      ...drawing(
        [pin('u:1', 'input', 'a'), pin('u:2', 'input', 'b'), and, pin('u:4', 'output', 'y')],
        [
          { id: 'w:5', source: { node: 'u:1', port: 'u:1.out' }, target: { node: 'u:3', port: 'u:3.A' } },
          { id: 'w:6', source: { node: 'u:2', port: 'u:2.out' }, target: { node: 'u:3', port: 'u:3.B' } },
          { id: 'w:7', source: { node: 'u:3', port: 'u:3.Y' }, target: { node: 'u:4', port: 'u:4.in' } },
        ],
      ),
      pos: { 'u:1': { x: 0, y: 0 }, 'u:2': { x: 0, y: 60 }, 'u:3': { x: 120, y: 20 }, 'u:4': { x: 240, y: 30 } },
    };
    await open({}, { doc: { drawn: ['d'], sheets: { 'd:d': e } }, path: [{ instance: 'd', module: 'd', drawn: true }] });
    const overlapping = () => {
      const ns = st().layout!.nodes;
      return ns.some((a, i) => ns.some((b, j) => j > i && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height));
    };
    st().selectAll();
    expect(st().copy()).toBe(true);
    st().paste();
    st().paste();
    expect(st().layout!.nodes.length).toBe(12);
    expect(overlapping()).toBe(false);
    st().select(['u:3']);
    st().duplicate();
    expect(st().layout!.nodes.length).toBe(13);
    expect(overlapping()).toBe(false);
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

  it('goes back to the module before with Undo after opening a block, and in again with Redo', async () => {
    await open({ [AUCTION_FILE]: AUCTION_SOURCE });
    await settle();
    const top = st().path;
    expect(top).toEqual([{ instance: 'auction_top', module: 'auction_top' }]);
    st().openNode(nodeOf((n) => n.instanceName === 'u_check_a').id);
    await settle();
    const inside = st().path;
    expect(inside.at(-1)).toEqual({ instance: 'u_check_a', module: 'bid_check' });
    // An edit inside: the first Undo takes it back and stays there, the next one goes up.
    const cell = nodeOf((n) => n.kind === 'cell').id;
    st().moveSelection(new Set([cell]), 0, 40);
    const moved = st().doc;
    st().undo();
    await settle();
    expect(st().path).toEqual(inside);
    expect(st().doc).not.toBe(moved);
    st().undo();
    await settle();
    expect(st().path).toEqual(top);
    expect(st().sheet).toBe('v:blocks:auction_top');
    // Redo goes in again, then redoes the edit there.
    st().redo();
    await settle();
    expect(st().path).toEqual(inside);
    st().redo();
    await settle();
    expect(st().doc).toBe(moved);
    // The breadcrumb, the hierarchy and the Block diagram / Full circuit switch are steps too.
    await st().navigate(top);
    await settle();
    await st().navigate(top);
    expect(st().past.filter((h) => h.nav).length).toBe(2);
    await st().setViewMode('flat');
    await settle();
    st().undo();
    await settle();
    expect(st().viewMode).toBe('blocks');
    expect(st().path).toEqual(top);
    st().undo();
    await settle();
    expect(st().path).toEqual(inside);
    // A step that only navigated does not make the work unsaved.
    useStore.setState({ dirty: false });
    st().redo();
    await settle();
    expect(st().path).toEqual(top);
    expect(st().dirty).toBe(false);
  }, 60_000);

  it('keeps the edits in the history however long one browses', async () => {
    await open({}, { doc: { drawn: [], sheets: {} }, path: [] });
    st().newDrawing('a');
    await settle();
    st().newDrawing('b');
    await settle();
    for (let k = 0; k < 120; k++) await st().navigate([{ instance: k % 2 ? 'b' : 'a', module: k % 2 ? 'b' : 'a', drawn: true }]);
    expect(st().past.filter((h) => h.nav).length).toBe(50);
    expect(st().past.filter((h) => !h.nav).length).toBe(2);
  }, 60_000);

  it('passes over a sheet that is gone when Undo goes back', async () => {
    await open({}, { doc: { drawn: [], sheets: {} }, path: [] });
    st().newDrawing('a');
    await settle();
    st().newDrawing('b');
    await settle();
    await st().navigate([{ instance: 'a', module: 'a', drawn: true }]);
    await settle();
    await st().navigate([{ instance: 'b', module: 'b', drawn: true }]);
    await settle();
    // Drawing a is gone (as if deleted outside the history): Undo passes over the way back to it, and
    // over the way to b, where the user is, and takes back the step before them: the new drawing b.
    useStore.setState({ doc: { ...st().doc, drawn: ['b'] } });
    st().undo();
    await settle();
    expect(st().past.some((h) => h.nav)).toBe(false);
    expect(st().doc.drawn).toEqual(['a']);
    expect(st().path).toEqual([{ instance: 'a', module: 'a', drawn: true }]);
  }, 60_000);

  it('places components defined in JSON: a gate with more inputs, and a part exported as a black box', async () => {
    await open({}, { doc: { drawn: [], sheets: {} }, path: [] });
    st().newDrawing('top');
    await settle();
    const r = parseComponents('[{ "name": "and5", "base": "and", "inputs": 5 }, { "name": "alu", "inputs": ["a[7:0]", "b[7:0]"], "outputs": ["y[7:0]"] }]');
    st().setComponents(r.defs!);
    expect(st().doc.components?.map((c) => c.name)).toEqual(['and5', 'alu']);
    for (const c of r.defs!) {
      st().startPlacing(componentSymbol(c));
      st().placeAt({ x: c.name === 'alu' ? 300 : 0, y: 0 });
    }
    await settle();
    const gate = st().netlist!.nodes.find((n) => n.cellType === '$and')!;
    expect(gate.ports.filter((p) => p.dir === 'in').length).toBe(5);
    const block = st().netlist!.nodes.find((n) => n.moduleName === 'alu')!;
    expect(block.ports.map((p) => `${p.name}:${p.width}`)).toEqual(['a:8', 'b:8', 'y:8']);
    // A drawing cannot take a part's name.
    expect(st().renameDrawing('top', 'alu')).toMatch(/component/);
    expect(st().componentNameTaken('top')).toMatch(/drawing/);
    // The export declares the part as an empty module, and Yosys reads it.
    const out = exportCurrent();
    expect(out.code).toContain('(* blackbox *)\nmodule alu (');
    expect(out.code).toMatch(/alu u\d+ \(/);
    await expect(elaborate(out.check.files, out.check.top)).resolves.toBeDefined();
    // Saved with the work, and one undo step.
    const saved = parseSavedFile(JSON.stringify(st().savedFile()));
    expect(saved.doc.components).toEqual(st().doc.components);
    st().setComponents([]);
    expect(st().doc.components).toBeUndefined();
    st().undo();
    expect(st().doc.components?.length).toBe(2);
  }, 60_000);

  it('never gives a drawing a Verilog keyword as its name (C31)', async () => {
    await open({}, { doc: { drawn: [], sheets: {} }, path: [] });
    st().newDrawing('module');
    await settle();
    expect(st().doc.drawn).toEqual(['module_']);
    expect(st().renameDrawing('module_', 'always')).toMatch(/keyword/);
    expect(st().doc.drawn).toEqual(['module_']);
  }, 60_000);

  it('refuses to give a pin the name another pin has (F13)', async () => {
    await open({}, { doc: { drawn: [], sheets: {} }, path: [] });
    st().newDrawing('pins');
    await settle();
    st().startPlacing({ sym: 'input' });
    st().placeAt({ x: 0, y: 0 }, true);
    st().placeAt({ x: 0, y: 100 }, false);
    await settle();
    const pins = st().netlist!.nodes.filter((n) => n.kind === 'input');
    expect(pins.map((n) => n.label)).toEqual(['in1', 'in2']);
    // The Inspector shows the name in effect again, and why (G4).
    expect(st().renameItem(pins[1].id, 'in1')).toMatch(/Another pin is named in1/);
    expect(st().notice).toMatch(/Another pin is named in1/);
    expect(st().netlist!.nodes.filter((n) => n.kind === 'input').map((n) => n.label)).toEqual(['in1', 'in2']);
    expect(st().renameItem(pins[1].id, 'b')).toBeUndefined();
    expect(st().netlist!.nodes.filter((n) => n.kind === 'input').map((n) => n.label)).toEqual(['in1', 'b']);
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

describe('Yosys errors', () => {
  it('keeps the kind of a Yosys error and the last log, and the next run clears both error and kind', async () => {
    await st().loadExample('auction');
    await settle();
    const { YosysError } = await import('../yosys/client');
    vi.mocked(elaborate).mockRejectedValueOnce(Object.assign(new YosysError('Yosys stopped downloading: no data arrived for 60 s.'), { kind: 'load' }));
    useStore.setState({ log: 'previous log' });
    await st().rebuild();
    expect([st().status, st().errorKind, st().error, st().log]).toEqual(['error', 'load', 'Yosys stopped downloading: no data arrived for 60 s.', 'previous log']);
    // The diagram of the last run stays.
    expect(st().layout).toBeDefined();
    vi.mocked(elaborate).mockRejectedValueOnce(Object.assign(new YosysError('Yosys worked on the design for 60 s'), { kind: 'timeout', log: 'so far' }));
    await st().rebuild();
    expect([st().errorKind, st().log]).toEqual(['timeout', 'so far']);
    await st().rebuild();
    await settle();
    expect([st().status, st().error, st().errorKind]).toEqual(['ready', undefined, undefined]);
  }, 60_000);

  it('withdraws the Yosys run of a rebuild that a newer rebuild replaced', async () => {
    await st().loadExample('auction');
    await settle();
    vi.mocked(elaborate).mockClear();
    const first = st().rebuild();
    const second = st().rebuild();
    await Promise.all([first, second]);
    const signals = vi.mocked(elaborate).mock.calls.map((c) => c[3] as AbortSignal);
    expect(signals.map((x) => x.aborted)).toEqual([true, false]);
  }, 60_000);
});
