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
