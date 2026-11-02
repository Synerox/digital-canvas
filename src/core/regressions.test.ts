/** Regression tests for issues found in the first code review. */
import { describe, expect, it } from 'vitest';
import { runYosys } from '@yowasp/yosys';
import { buildDiagram } from './diagram';
import type { IRDesign } from './ir';
import { design } from './test-utils';
import { layoutDiagram } from '../layout/elk-layout';
import { errorLine, stripAnsi } from '../yosys/runner';
import { declaredModules, yosysArgs } from '../yosys/script';

const T = 60_000;
const edgesInto = (d: ReturnType<typeof buildDiagram>, node: string) => d.edges.filter((e) => e.target.node === node);

describe('netlist edge cases', () => {
  it('connects a sub-instance inout port instead of drawing x constants', async () => {
    const src = `module sub(inout [3:0] io, input oe, input [3:0] d); assign io = oe ? d : 4'bz; endmodule
module top(input oe, input [3:0] d, output [3:0] q); wire [3:0] bus; sub u(.io(bus), .oe(oe), .d(d)); assign q = bus; endmodule`;
    const d = buildDiagram(await design({ 't.v': src }), 'top');
    expect(d.nodes.some((n) => n.kind === 'const')).toBe(false);
    expect(edgesInto(d, 'out:q').map((e) => e.source.node)).toEqual(['cell:u']);
  }, T);

  it('lets internal logic drive a top-level inout pin', async () => {
    const src = `module m(inout [3:0] io, input oe, input [3:0] d, output [3:0] q); assign io = oe ? d : 4'bz; assign q = io; endmodule`;
    const d = buildDiagram(await design({ 'm.v': src }), 'm');
    const pin = d.nodes.find((n) => n.id === 'io:io');
    expect(pin?.kind).toBe('inout');
    expect(edgesInto(d, 'io:io')).toHaveLength(1);
  }, T);

  it('keeps every driver of a tristate bus', async () => {
    const src = `module m(input e1, e2, input [3:0] d1, d2, output [3:0] bus);
  assign bus = e1 ? d1 : 4'bz; assign bus = e2 ? d2 : 4'bz; endmodule`;
    const d = buildDiagram(await design({ 'm.v': src }), 'm');
    expect(edgesInto(d, 'out:bus')).toHaveLength(2);
  }, T);

  it('records which bits a second driver of a bus drives, not only in its label', async () => {
    const src = `module m(input e1, e2, input [3:0] d1, d2, output [1:0] bus);
  wire [3:0] t2 = e2 ? d2 : 4'bz;
  assign bus = e1 ? d1[1:0] : 2'bz;
  assign bus = t2[3:2];
endmodule`;
    const d = buildDiagram(await design({ 'm.v': src }), 'm');
    const partial = edgesInto(d, 'out:bus').filter((e) => !e.fullSource);
    expect(partial.map((e) => [e.label, e.bits])).toEqual([['t2[3:2]', { lo: 2, width: 2 }]]);
  }, T);

  it('draws a memory as one block linking writes and reads', async () => {
    const src = `module m(input clk, we, input [1:0] wa, ra, input [7:0] wd, output [7:0] rd);
  reg [7:0] mem [0:3]; always @(posedge clk) if (we) mem[wa] <= wd; assign rd = mem[ra]; endmodule`;
    const d = buildDiagram(await design({ 'm.v': src }), 'm');
    const mems = d.nodes.filter((n) => n.cellType?.startsWith('$mem'));
    expect(mems).toHaveLength(1);
    expect(edgesInto(d, 'out:rd')[0].source.node).toBe(mems[0].id);
  }, T);

  it('labels concatenation pieces with the declared output range', async () => {
    const src = `module m(input [7:0] b, output [7:4] z); assign z = {b[5:4], b[7:6]}; endmodule`;
    const d = buildDiagram(await design({ 'm.v': src }), 'm');
    const bar = d.nodes.find((n) => n.kind === 'join');
    expect(bar?.ports.filter((p) => p.dir === 'in').map((p) => p.name)).toEqual(['[7:6]', '[5:4]']);
  }, T);

  it('names slices after the signal they are taken from', async () => {
    const src = `module m(input [7:0] a, input [3:0] c, output [7:0] s, output [3:0] lo, output [3:0] t);
  assign s = a + 8'd1; assign lo = s[3:0]; assign t = s[3:0] ^ c; endmodule`;
    const d = buildDiagram(await design({ 'm.v': src }), 'm');
    const xor = d.nodes.find((n) => n.cellType === '$xor')!;
    const into = d.edges.find((e) => e.target.node === xor.id && e.label);
    expect(into?.label).toBe('s[3:0]');
  }, T);

  it('does not draw a signed -1 shift as a decoder', async () => {
    const src = `module m(input [2:0] s, output [7:0] y); wire signed [0:0] one = 1'b1; assign y = one << s; endmodule`;
    const d = buildDiagram(await design({ 'm.v': src }), 'm');
    expect(d.nodes.some((n) => n.cellType === 'dc:decoder')).toBe(false);
  }, T);

  it('lays out a parameterized instance with a CLK input', async () => {
    const src = `module sub #(parameter W = 4)(input CLK, input [W-1:0] d, output reg [W-1:0] q); always @(posedge CLK) q <= d; endmodule
module top(input clk, input [7:0] d, output [7:0] q); sub #(.W(8)) u(.CLK(clk), .d(d), .q(q)); endmodule`;
    const ds = await design({ 't.v': src });
    const layout = await layoutDiagram(buildDiagram(ds, 'top'));
    const inst = layout.nodes.find((n) => n.kind === 'instance')!;
    expect(inst.ports.find((p) => p.name === 'CLK')?.side).toBe('WEST');
  }, T);

  it('keeps non-ASCII file names in src attributes', async () => {
    const src = 'module m(input a, output y); assign y = ~a; endmodule\n';
    const ds = await design({ '加法器.v': src });
    expect(ds.modules.m.src[0].file).toBe('加法器.v');
  }, T);

  it('gives an empty module a non-zero canvas', async () => {
    const ds = await design({ 'm.v': 'module m; wire x; endmodule' });
    const layout = await layoutDiagram(buildDiagram(ds, 'm'));
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
  }, T);

  it('reads packages first and lists declared modules', () => {
    const files = { 'top.sv': 'module top; endmodule', 'pkg.sv': 'package p; endpackage', 'a.v': '// module fake;\nmodule a; endmodule' };
    expect(yosysArgs(files)[1]).toMatch(/^read_verilog -sv pkg\.sv /);
    expect(declaredModules(files)).toEqual(['a', 'top']);
  });
});

describe('stable cell IDs', () => {
  const mux4 = (items: string[]) => ({
    'mux4.v': `module mux4(input [3:0] d0, d1, d2, d3, input [1:0] sel, output reg [3:0] y);
  always @* case (sel)
${items.map((x) => `    ${x}`).join('\n')}
  endcase
endmodule
`,
  });
  const consts = (d: ReturnType<typeof buildDiagram>) => new Map(d.nodes.filter((n) => n.kind === 'const').map((n) => [n.id, n.label]));

  it('tells equal compares apart by their constant operands, so reordered case items keep their IDs', async () => {
    const ordered = await design(mux4(["2'd0: y = d0;", "2'd1: y = d1;", "2'd2: y = d2;", 'default: y = d3;']));
    const reordered = await design(mux4(["2'd2: y = d2;", "2'd1: y = d1;", "2'd0: y = d0;", 'default: y = d3;']));
    // Yosys gives these compares no source text, so the ID is made of what they connect to.
    const eqs = ordered.modules.mux4.cells.filter((c) => c.type === '$eq').map((c) => c.id);
    expect(eqs.sort()).toEqual(["$eq{A=sel,B=2'd0,Y=}", "$eq{A=sel,B=2'd1,Y=}", "$eq{A=sel,B=2'd2,Y=}"]);
    // Saved positions and deletions are keyed by these IDs: each must still name the same constant.
    const before = consts(buildDiagram(ordered, 'mux4'));
    expect([...before.values()].sort()).toEqual(["2'd0", "2'd1", "2'd2"]);
    expect(consts(buildDiagram(reordered, 'mux4'))).toEqual(before);
  }, T);

  it('keeps the IDs of cells with source text or no constant operands', async () => {
    const d = await design({ 'g.v': "module g(input [3:0] a, b, output [3:0] y, z); assign y = a & b; assign z = a + 4'd1; endmodule" });
    expect(d.modules.g.cells.map((c) => c.id).sort()).toEqual(["$add{a + 4'd1}", '$and{a & b}']);
  }, T);

  // Yosys gives a register the source range of its whole always block: an ID made of that text
  // changed with any comment or statement in the block, and the edits saved for it were lost.
  const cnt = (comment: string, wrapAt = 15) => ({
    'cnt.v': `module cnt (input clk, rst, en, output reg [3:0] q, output reg wrap);
  always @(posedge clk) begin
${comment}    if (rst) begin q <= 4'd0; wrap <= 1'b0; end
    else if (en) begin q <= q + 4'd1; wrap <= (q == 4'd${wrapAt}); end
  end
endmodule
`,
  });
  const nodeIds = (d: ReturnType<typeof buildDiagram>) => d.nodes.map((n) => n.id).sort();

  it('names a register by the signal it drives, so a comment in its always block keeps its ID', async () => {
    const before = await design(cnt(''));
    const after = await design(cnt('    // synchronous reset\n'));
    expect(before.modules.cnt.cells.filter((c) => c.type === '$dff').map((c) => c.id).sort()).toEqual(['$dff{Q=q}', '$dff{Q=wrap}']);
    expect(nodeIds(buildDiagram(after, 'cnt'))).toEqual(nodeIds(buildDiagram(before, 'cnt')));
    // Another statement of the block changes: the register of q keeps its ID too.
    const other = await design(cnt('', 14));
    expect(other.modules.cnt.cells.filter((c) => c.type === '$dff').map((c) => c.id).sort()).toEqual(['$dff{Q=q}', '$dff{Q=wrap}']);
  }, T);

  it('names a register after the signal its block assigns, not another name of the same bits', async () => {
    const src = `module fsm(input clk, rst, go, output reg [1:0] light);
  reg [1:0] state;
  always @(posedge clk or posedge rst) if (rst) state <= 2'd0; else if (go) state <= state + 2'd1;
  always @* light = state;
endmodule
`;
    const d = await design({ 'fsm.v': src });
    expect(d.modules.fsm.cells.find((c) => c.type === '$adff')?.id).toBe('$adff{Q=state}');
  }, T);

  // A case table is a $pmux whose inputs are the values of its cases: an ID made of them changed with
  // every edited entry, and the moves of the MUX, the wires drawn from it and the edits of its
  // constants were lost.
  const seg7 = (seven: string) => ({
    'seg7.v': `module seg7(input [3:0] bcd, output reg [6:0] seg);
  always @*
    case (bcd)
      4'h0: seg = 7'b1000000; 4'h1: seg = 7'b1111001; 4'h2: seg = 7'b0100100; 4'h3: seg = 7'b0110000;
      4'h4: seg = 7'b0011001; 4'h5: seg = 7'b0010010; 4'h6: seg = 7'b0000010; 4'h7: seg = ${seven};
      4'h8: seg = 7'b0000000; 4'h9: seg = 7'b0010000; 4'hA: seg = 7'b0001000; 4'hB: seg = 7'b0000011;
      4'hC: seg = 7'b1000110; 4'hD: seg = 7'b0100001; 4'hE: seg = 7'b0000110; 4'hF: seg = 7'b0001110;
    endcase
endmodule
`,
  });
  const edgeIds = (d: ReturnType<typeof buildDiagram>) => d.edges.map((e) => e.id).sort();

  it('names a case table MUX by the signal it drives, so a changed entry keeps it and its constants', async () => {
    const before = buildDiagram(await design(seg7("7'b1111000")), 'seg7');
    const after = buildDiagram(await design(seg7("7'b1011000")), 'seg7');
    expect(before.nodes.filter((n) => n.cellType === '$pmux').map((n) => n.id)).toEqual(['cell:$pmux{Y=seg}']);
    expect(nodeIds(after)).toEqual(nodeIds(before));
    expect(edgeIds(after)).toEqual(edgeIds(before));
    // Each constant is named by the case it belongs to: the edited one keeps its ID with the new value.
    expect(consts(before).get("const:cell:$pmux{Y=seg}.B[4'd7]")).toBe("7'd120");
    expect(consts(after).get("const:cell:$pmux{Y=seg}.B[4'd7]")).toBe("7'd88");
    expect(consts(after).get("const:cell:$pmux{Y=seg}.B[4'd8]")).toBe("7'd0");
    const unchanged = (d: ReturnType<typeof buildDiagram>) => [...consts(d)].filter(([id]) => !id.endsWith("[4'd7]"));
    expect(unchanged(after)).toEqual(unchanged(before));
  }, T);

  it('keeps the constants of a case with its value when other cases are added or reordered', async () => {
    const table = (items: string[]) => ({
      't.v': `module t(input [1:0] s, output reg [3:0] y);\n  always @* case (s)\n${items.join('\n')}\n    default: y = 4'd0;\n  endcase\nendmodule\n`,
    });
    const before = consts(buildDiagram(await design(table(["    2'd0: y = 4'd5;", "    2'd1: y = 4'd9;"])), 't'));
    const after = consts(buildDiagram(await design(table(["    2'd1: y = 4'd9;", "    2'd2: y = 4'd3;", "    2'd0: y = 4'd5;"])), 't'));
    expect(after.get("const:cell:$pmux{Y=y}.B[2'd0]")).toBe("4'd5");
    expect(before.get("const:cell:$pmux{Y=y}.B[2'd0]")).toBe("4'd5");
    expect(after.get("const:cell:$pmux{Y=y}.B[2'd1]")).toBe("4'd9");
    expect(after.get("const:cell:$pmux{Y=y}.B[2'd2]")).toBe("4'd3");
    // An item with two labels is named by both; a casez bit that is no compare, by its case index.
    const z = consts(
      buildDiagram(
        await design({
          'z.v': `module z(input [2:0] s, output reg [1:0] a, output reg [3:0] b);
  always @* begin
    casez (s) 3'b1??: a = 2'd1; 3'b01?: a = 2'd2; default: a = 2'd3; endcase
    case (s) 3'd0, 3'd1: b = 4'd3; 3'd5: b = 4'd9; default: b = 4'd0; endcase
  end
endmodule
`,
        }),
        'z',
      ),
    );
    expect(z.get("const:cell:$pmux{Y=a}.B[2'd1]")).toBe("2'd2");
    expect(z.get('const:cell:$pmux{Y=a}.B[1]')).toBe("2'd1");
    expect(z.get("const:cell:$pmux{Y=b}.B[3'd0,3'd1]")).toBe("4'd3");
  }, T);

  it('names the case MUXes of a state machine by what they drive, and leaves the other IDs alone', async () => {
    const fsm = (redCode: string, next: string) => ({
      'fsm.v': `module fsm(input clk, rst, car, output reg [2:0] ew);
  reg [1:0] state;
  always @(posedge clk or posedge rst)
    if (rst) state <= 2'd0;
    else case (state)
      2'd0: if (car) state <= ${next};
      2'd1: state <= 2'd2;
      default: state <= 2'd0;
    endcase
  always @* case (state) 2'd0: ew = ${redCode}; 2'd1: ew = 3'b100; default: ew = 3'b001; endcase
endmodule
`,
    });
    const before = await design(fsm("3'b100", "2'd1"));
    const after = await design(fsm("3'b010", "2'd2"));
    const ids = (d: typeof before) => d.modules.fsm.cells.map((c) => c.id).sort();
    // The next-state MUX of the clocked block drives no named signal: it is named by proc's wire for the next state.
    expect(ids(before)).toEqual(expect.arrayContaining(['$pmux{Y=$0\\state}', '$pmux{Y=ew}', '$mux{car}', "$eq{A=state,B=2'd0,Y=}", '$adff{Q=state}']));
    expect(ids(after)).toEqual(ids(before));
    expect(nodeIds(buildDiagram(after, 'fsm'))).toEqual(nodeIds(buildDiagram(before, 'fsm')));
  }, T);

  it('names a case nested in another case by the MUX it feeds, so an item added to one swaps no IDs', async () => {
    const nested = (extra: string) => {
      const item = (k: number) =>
        `      2'd${k}: case (s) ${[0, 1, 2].map((j) => `2'd${j}: y = 4'd${(k * 3 + j) % 16};`).join(' ')} ${k ? '' : extra}default: y = 4'd${k}; endcase`;
      return { 'n.v': `module n(input [1:0] m, s, output reg [3:0] y);\n  always @* case (m)\n${[0, 1, 2, 3].map(item).join('\n')}\n  endcase\nendmodule\n` };
    };
    // Each inner case by the line it is on: their Yosys cell names change order when the first one grows.
    const inner = (d: IRDesign) =>
      d.modules.n.cells
        .filter((c) => c.type === '$pmux' && c.id !== '$pmux{Y=y}')
        .map((c) => `${c.src[1]?.startLine}:${c.id}`)
        .sort();
    const before = inner(await design(nested('')));
    expect(before).toEqual(['3:$pmux{Y>$mux.B>Y=$2\\y}', '4:$pmux{Y>$mux.B>Y=$3\\y}', '5:$pmux{Y>$mux.B>Y=$4\\y}', '6:$pmux{Y>$mux.B>Y=$5\\y}']);
    expect(inner(await design(nested("2'd3: y = 4'd15; ")))).toEqual(before);
    // `case (1'b1)` makes a chain of MUXes: each is named by the inputs down the chain.
    const onehot = await design({
      'h.v': `module h(input clk, reset, go, output reg [3:0] st);
  always @(posedge clk)
    if (reset) st <= 4'b0001;
    else case (1'b1)
      st[0]: if (go) st <= 4'b0010;
      st[1]: st <= 4'b0100;
      st[2]: st <= 4'b1000;
      default: st <= 4'b0001;
    endcase
endmodule
`,
    });
    expect(onehot.modules.h.cells.map((c) => c.id)).toEqual(
      expect.arrayContaining(['$mux{Y>$mux.A>Y=$0\\st}', '$mux{Y>$mux.A>$mux.A>Y=$0\\st}', '$mux{reset}', '$mux{go}']),
    );
  }, T);

  it('names the enable logic of a latch by the latch it serves, not by the text of its always block', async () => {
    const latch = (body: string) =>
      design({ 'l.v': `module l(input en, input [3:0] d, e, output reg [3:0] q, r);\n  always @* if (en) ${body}\nendmodule\n` });
    const helpers = (d: IRDesign) => d.modules.l.cells.filter((c) => /;Q=/.test(c.id)).map((c) => c.id).sort();
    const before = helpers(await latch('q = d;'));
    expect(before).toEqual(['$and{A=,B=,Y=;Q=q}', '$not{A=en,Y=;Q=q}', '$reduce_or{A=,Y=;Q=q}', "$reduce_or{A=1'b1,Y=;Q=q}"]);
    expect(helpers(await latch('q = d ^ e;'))).toEqual(before);
    expect(helpers(await latch('begin q = d; r = e; end'))).toEqual(before);
  }, T);

  it('leaves comments out of the source text an ID is made of', async () => {
    const add = (body: string) => design({ 'a.v': `module a(input [3:0] x, y, output [3:0] s);\n  assign s = ${body};\nendmodule\n` });
    const plain = await add('x +\n    y');
    const commented = await add('x + // the carry is dropped\n    /* second */ y');
    expect(commented.modules.a.cells.map((c) => c.id)).toEqual(['$add{x + y}']);
    expect(plain.modules.a.cells.map((c) => c.id)).toEqual(['$add{x + y}']);
  }, T);
});

describe('Yosys errors', () => {
  it('reports the ERROR line without colour codes', async () => {
    const chunks: string[] = [];
    const sink = (b: Uint8Array | null) => b && chunks.push(new TextDecoder().decode(b));
    await expect(
      runYosys(yosysArgs({ 'bad.v': 'module m(input a, output y)\n assign y = a\nendmodule\n' }), {
        'bad.v': 'module m(input a, output y)\n assign y = a\nendmodule\n',
      }, { stdout: sink, stderr: sink }),
    ).rejects.toThrow();
    const log = stripAnsi(chunks.join(''));
    expect(log.includes(String.fromCharCode(27))).toBe(false);
    expect(errorLine(log, 'fallback')).toMatch(/^bad\.v:2: ERROR: syntax error/);
  }, T);
});
