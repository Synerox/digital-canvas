/** Regression tests for issues found in the first code review. */
import { describe, expect, it } from 'vitest';
import { runYosys } from '@yowasp/yosys';
import { buildDiagram } from './diagram';
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
