/**
 * Cases from the review of the automatic blocks and the full circuit view.
 * Each one failed before the fix it is named after.
 */
import { describe, expect, it } from 'vitest';
import { buildDiagram, type Diagram } from './diagram';
import { flatCellCount, flattenModule, withFlattened } from './flatten';
import type { IRCell, IRDesign, IRModule } from './ir';
import { paragraphs, partitionModule, siblingKeys, withAutoBlocks } from './partition';
import { design } from './test-utils';
import { AUCTION_FILE, AUCTION_SOURCE } from '../examples/auction';

const T = 60_000;

/** Undriven bits are drawn as constants that contain x. */
const xConsts = (d: Diagram) => d.nodes.filter((n) => n.kind === 'const' && /x/.test(n.label)).map((n) => n.label);

/** Auto block instance names, and the edges between them (from block -> to block). */
function blockGraph(d: IRDesign, parent: string) {
  const cells = d.modules[parent].cells.filter((c) => c.attrs?.auto);
  const driver = new Map<number, string>();
  for (const c of cells)
    for (const [p, bits] of Object.entries(c.connections))
      if (c.directions[p] === 'output') for (const b of bits) if (typeof b === 'number') driver.set(b, c.name);
  const edges = new Set<string>();
  for (const c of cells)
    for (const [p, bits] of Object.entries(c.connections))
      if (c.directions[p] === 'input')
        for (const b of bits) {
          const from = typeof b === 'number' ? driver.get(b) : undefined;
          if (from && from !== c.name) edges.add(`${from}->${c.name}`);
        }
  return { names: cells.map((c) => c.name), edges: [...edges] };
}

function hasCycle(names: string[], edges: string[]): boolean {
  const next = new Map(names.map((n) => [n, [] as string[]]));
  for (const e of edges) {
    const [a, b] = e.split('->');
    next.get(a)!.push(b);
  }
  const state = new Map<string, 1 | 2>();
  const visit = (n: string): boolean => {
    if (state.get(n) === 1) return true;
    if (state.get(n) === 2) return false;
    state.set(n, 1);
    if (next.get(n)!.some(visit)) return true;
    state.set(n, 2);
    return false;
  };
  return names.some(visit);
}

describe('block ports', () => {
  it('does not widen a port to bits no block drives', async () => {
    const src = `module timer(input clk, rst, input [7:0] limit, input [3:0] mask, output tick, output [3:0] phase, output done);
  // Free-running counter
  reg [7:0] count;
  always @(posedge clk) if (rst) count <= 8'd0; else count <= count + 8'd1;

  // Phase decode from the low bits
  wire [3:0] low = count[3:0] & mask;
  wire low_zero = low == 4'd0;
  assign phase = low ^ 4'b1010;
  assign tick = low_zero & ~rst;

  // Limit check
  reg hit;
  always @(posedge clk) hit <= (limit == 8'd0) | count[7];
  assign done = hit & ~rst;
endmodule`;
    const files = { 't.v': src };
    const d = withAutoBlocks(await design(files), files, { minCells: 4 });
    expect(d.modules.timer.cells.filter((c) => c.attrs?.auto).length).toBeGreaterThanOrEqual(2);
    expect(xConsts(buildDiagram(d, 'timer'))).toEqual([]);
  }, T);

  it('does not draw a false loop through a wide output net', async () => {
    const src = `module fb(input [7:0] a, b, c, d, output [7:0] y, output [7:0] z);
  // Low half
  wire [3:0] lo1 = a[3:0] + b[3:0];
  wire [3:0] lo2 = lo1 ^ c[3:0];
  wire [3:0] lo = lo2 & d[3:0];

  // Consumer
  wire [7:0] k1 = {4'd0, lo} + a;
  wire [7:0] k2 = k1 ^ b;
  wire [7:0] k3 = k2 | c;
  assign y = k3;

  // High half
  wire [3:0] hi1 = k3[7:4] - d[7:4];
  wire [3:0] hi2 = hi1 & c[7:4];
  wire [3:0] hi = hi2 | b[7:4];

  assign z = {hi, lo};
endmodule`;
    const files = { 'fb.v': src };
    const d = withAutoBlocks(await design(files), files, { minCells: 4 });
    const g = blockGraph(d, 'fb');
    expect(g.names.sort()).toEqual(['Consumer', 'High half', 'Low half']);
    expect(hasCycle(g.names, g.edges)).toBe(false);
    expect(xConsts(buildDiagram(d, 'fb'))).toEqual([]);
  }, T);
});

describe('block count', () => {
  it('keeps the block cap when blocks only share module inputs', async () => {
    const ops = ['+', '-', '&', '|', '^', '*', '<<', '>>'];
    const lines = Array.from({ length: 40 }, (_, i) => `  assign o${String.fromCharCode(97 + (i % 26))}${i} = (a ${ops[i % ops.length]} b) + 8'd${i};`);
    const outs = Array.from({ length: 40 }, (_, i) => `o${String.fromCharCode(97 + (i % 26))}${i}`);
    const src = `module wide(input [7:0] a, b, output [7:0] ${outs.join(', ')});\n${lines.join('\n')}\nendmodule`;
    const files = { 'w.v': src };
    const m = (await design(files)).modules.wide;
    const blocks = partitionModule(m, files);
    // Either drawn as it is, or at most 9 blocks: never one block per operator.
    if (blocks) expect(blocks.length).toBeLessThanOrEqual(9);
  }, T);

  it('groups generate-loop copies instead of splitting them per lane', async () => {
    expect(siblingKeys('lane[3].s').some((k) => siblingKeys('lane[12].s').includes(k))).toBe(true);
    expect(siblingKeys('acc[0]').some((k) => siblingKeys('acc[7]').includes(k))).toBe(true);
    const src = `module lanes(input [63:0] a, b, input [15:0] k, output [63:0] y);
  genvar i;
  generate for (i = 0; i < 16; i = i + 1) begin : lane
    wire [3:0] s = a[4*i+3:4*i] + b[4*i+3:4*i];
    assign y[4*i+3:4*i] = s ^ {4{k[i]}};
  end endgenerate
endmodule`;
    const files = { 'l.v': src };
    const blocks = partitionModule((await design(files)).modules.lanes, files)!;
    expect(blocks.length).toBeLessThanOrEqual(3);
    for (const b of blocks) expect(b.label).not.toMatch(/\[\d+\]/);
  }, T);
});

describe('block names', () => {
  it('does not give one comment to several blocks', async () => {
    const src = `module regs(input clk, input [7:0] a, b, c, output reg [7:0] acc, cnt, mx);
  // State registers
  always @(posedge clk) begin
    acc <= acc + a;
    cnt <= cnt + 8'd1;
    mx <= (b > c) ? b : c;
  end
endmodule`;
    const files = { 'r.v': src };
    const blocks = partitionModule((await design(files)).modules.regs, files, { minCells: 4 })!;
    expect(blocks.map((b) => b.label).sort()).toEqual(['acc', 'cnt', 'mx']);
  }, T);

  it('reads banner comments and skips pragmas', async () => {
    const src = `module m(input [7:0] a, b, c, output [7:0] y, output z);
  //----------------------------
  // Adder tree
  //----------------------------
  wire [7:0] s1 = a + b;
  wire [7:0] s2 = s1 + c;
  wire [7:0] s3 = s2 + 8'd1;

  // ---- Compare ----
  // verilator lint_off WIDTH
  wire g1 = a > b;
  wire g2 = b > c;
  wire g3 = g1 & g2;
  wire g4 = g3 | (a == c);

  assign y = s3;
  assign z = g4;
endmodule`;
    const files = { 'm.v': src };
    const blocks = partitionModule((await design(files)).modules.m, files, { minCells: 4 })!;
    expect(blocks.map((b) => b.label)).toEqual(['Adder tree', 'Compare']);
  }, T);

  it('keeps headings that start with a tool name, and skips lint_off', async () => {
    const src = `module m(input [7:0] a, b, c, output [7:0] y, output z);
  // Coverage counters
  wire [7:0] s1 = a + b;
  wire [7:0] s2 = s1 + c;
  wire [7:0] s3 = s2 + 8'd1;

  // Compare
  // lint_off WIDTH
  wire g1 = a > b;
  wire g2 = b > c;
  wire g3 = g1 & g2;
  wire g4 = g3 | (a == c);

  assign y = s3;
  assign z = g4;
endmodule`;
    const files = { 'm.v': src };
    const blocks = partitionModule((await design(files)).modules.m, files, { minCells: 4 })!;
    expect(blocks.map((b) => b.label)).toEqual(['Coverage counters', 'Compare']);
  }, T);

  it('gives every block its own module when names collide', async () => {
    const src = `module \\top/x (input [7:0] p, output [7:0] q);
  assign q = p + 8'd1;
endmodule
module top(input [7:0] a, b, c, output [7:0] y, z);
  // x
  wire [7:0] s0 = a + b;
  wire [7:0] s1 = s0 ^ c;
  wire [7:0] s2 = s1 & a;

  // x_2
  wire [7:0] t1 = a - c;
  wire [7:0] t2 = t1 | b;
  wire [7:0] t3 = t2 + s2;
  wire [7:0] w;
  \\top/x u(.p(t3), .q(w));
  assign y = w;
  assign z = s2;
endmodule`;
    const files = { 'c.v': src };
    const plain = await design(files, 'top');
    const d = withAutoBlocks(plain, files, { minCells: 4 });
    const auto = d.modules.top.cells.filter((c) => c.attrs?.auto);
    expect(auto.length).toBe(2);
    expect(new Set(auto.map((c) => c.type)).size).toBe(2);
    // The real module keeps its own body.
    expect(d.modules['top/x']).toBe(plain.modules['top/x']);
    // Every primitive cell is still in one of the blocks.
    const inBlocks = auto.reduce((n, c) => n + d.modules[c.type].cells.length, 0);
    expect(inBlocks + 1).toBe(plain.modules.top.cells.length);
  }, T);
});

describe('source paragraphs', () => {
  it('keeps `ifdef alternatives from unbalancing begin/end', () => {
    const src = [
      '`ifdef ASYNC',
      'always @(posedge clk or negedge rst) begin',
      '`else',
      'always @(posedge clk) begin',
      '`endif',
      '  q <= d;',
      'end',
      '',
      'assign a = q;',
      '',
      'assign b = a;',
    ].join('\n');
    const p = paragraphs(src);
    expect(p[5]).toBe(p[3]);
    expect(p[8]).not.toBe(p[6]);
    expect(p[10]).not.toBe(p[8]);
  });

  it('splits paragraphs inside every `ifdef branch', () => {
    const src = [
      '`ifdef SIM',
      'assign m = 0;',
      '`else',
      'assign a = x;',
      '',
      'always @(posedge clk) q <= a;',
      'assign b = q;',
      '',
      'assign c = b;',
      '`endif',
      'assign d = c;',
      '',
      'assign e = d;',
    ].join('\n');
    const p = paragraphs(src);
    expect(p[5]).not.toBe(p[3]);
    expect(p[6]).not.toBe(p[5]);
    expect(p[8]).not.toBe(p[6]);
    // Lines after `endif never share a paragraph number with the longer branch.
    expect(p[12]).not.toBe(p[8]);
    expect(p[12]).not.toBe(p[10]);
  });

  it('skips escaped quotes in strings', () => {
    const src = ['initial $display("a \\" begin");', '', 'assign a = 1;', '', 'assign b = 2;'].join('\n');
    const p = paragraphs(src);
    expect(p[2]).not.toBe(p[0]);
    expect(p[4]).not.toBe(p[2]);
  });

  it('keeps a begin-less if/else in its always block', () => {
    const src = ['always @(posedge clk)', '  if (rst) cnt <= 0;', '  else cnt <= cnt + a;', 'assign y = cnt ^ b;'].join('\n');
    const p = paragraphs(src);
    expect(p[1]).toBe(p[0]);
    expect(p[2]).toBe(p[0]);
    expect(p[3]).not.toBe(p[2]);
  });

  it('starts again at the next module after a miscount', () => {
    const src = ['module a;', '  begin', 'endmodule', 'module b;', '  assign x = 1;', '', '  assign y = 2;', 'endmodule'].join('\n');
    const p = paragraphs(src);
    expect(p[6]).not.toBe(p[4]);
  });
});

describe('full circuit wiring', () => {
  it('connects a sub-module that passes an input straight through', async () => {
    const src = `module pass(input [3:0] a, output [3:0] y);
  assign y = a;
endmodule
module top(input [3:0] x, output [3:0] z);
  wire [3:0] w;
  pass u(.a(x), .y(w));
  assign z = w + 4'd1;
endmodule`;
    const d = await design({ 'p.v': src }, 'top');
    const dg = buildDiagram(withFlattened(d, 'top'), 'top');
    expect(xConsts(dg)).toEqual([]);
    expect(dg.edges.some((e) => e.source.node === 'in:x')).toBe(true);
  }, T);

  it('connects two outputs that carry the same signal, in any port order', async () => {
    const src = `module c(output y, input a, input b, output t, output y2);
  assign y = a;
  assign t = a ^ b;
  assign y2 = t;
endmodule
module top(input p, q, output r, s, s2);
  c u(.y(r), .a(p), .b(q), .t(s), .y2(s2));
endmodule`;
    const d = await design({ 'c.v': src }, 'top');
    const dg = buildDiagram(withFlattened(d, 'top'), 'top');
    expect(xConsts(dg)).toEqual([]);
    // r is p itself, so the xor reads p, not r.
    const xor = dg.nodes.find((n) => n.cellType === '$xor')!;
    const inputs = dg.edges.filter((e) => e.target.node === xor.id).map((e) => e.source.node);
    expect(inputs.sort()).toEqual(['in:p', 'in:q']);
  }, T);

  it('keeps constants a sub-module drives on its outputs', async () => {
    const src = `module k(input a, output [3:0] y, output r);
  assign y = 4'd5;
  assign r = ~a;
endmodule
module top(input x, output [3:0] z, output q);
  wire [3:0] w;
  k u(.a(x), .y(w), .r(q));
  assign z = w + 4'd1;
endmodule`;
    const d = await design({ 'k.v': src }, 'top');
    const dg = buildDiagram(withFlattened(d, 'top'), 'top');
    expect(xConsts(dg)).toEqual([]);
  }, T);

  it('labels slices of signals inside sub-modules', async () => {
    const src = `module c(input [7:0] a, b, output [3:0] hi, lo);
  wire [7:0] bus = a + b;
  assign hi = bus[7:4] ^ a[3:0];
  assign lo = bus[3:0] & b[7:4];
endmodule
module top(input [7:0] a, b, output [3:0] h, l);
  c u(.a(a), .b(b), .hi(h), .lo(l));
endmodule`;
    const d = await design({ 'c.v': src }, 'top');
    const labels = buildDiagram(withFlattened(d, 'top'), 'top').edges.map((e) => e.label);
    expect(labels).toContain('u.bus[7:4]');
    expect(labels).toContain('u.bus[3:0]');
  }, T);

  it('counts the cells of the full circuit before building it', async () => {
    const a = await design({ [AUCTION_FILE]: AUCTION_SOURCE });
    expect(flatCellCount(a, a.top)).toBe(flattenModule(a, a.top).cells.length);
  }, T);

  it('counts a deep, wide hierarchy without visiting every copy', () => {
    // 8 instances per level, 8 levels: 8^8 = 16.7M leaf cells.
    const cell = (type: string, i: number): IRCell => ({
      id: `c${i}`,
      name: `c${i}`,
      hidden: false,
      type,
      isInstance: !type.startsWith('$'),
      parameters: {},
      directions: {},
      connections: {},
      src: [],
    });
    const mod = (name: string, cells: IRCell[]): IRModule => ({ name, displayName: name, isTop: false, ports: [], cells, nets: [], src: [] });
    const modules: Record<string, IRModule> = { l0: mod('l0', [cell('$add', 0)]) };
    for (let k = 1; k <= 8; k++) modules[`l${k}`] = mod(`l${k}`, Array.from({ length: 8 }, (_, i) => cell(`l${k - 1}`, i)));
    const t0 = performance.now();
    expect(flatCellCount({ top: 'l8', modules }, 'l8')).toBe(8 ** 8);
    expect(performance.now() - t0).toBeLessThan(100);
  });
});

describe('speed', () => {
  it('partitions a long exported chain quickly', async () => {
    const n = 1200;
    const lines = ['  wire [7:0] w0 = x + 8\'d1;'];
    for (let k = 1; k < n; k++) lines.push(`  wire [7:0] w${k} = w${k - 1} + x;`);
    for (let k = 0; k < n; k++) lines.push(`  assign t[${k}] = w${k}[0];`);
    const src = `module chain(input [7:0] x, output [${n - 1}:0] t);\n${lines.join('\n')}\nendmodule`;
    const files = { 'ch.v': src };
    const m = (await design(files)).modules.chain;
    const t0 = performance.now();
    partitionModule(m, files);
    // About 5 s before the fix; well under a second after it.
    expect(performance.now() - t0).toBeLessThan(2500);
  }, T);
});
