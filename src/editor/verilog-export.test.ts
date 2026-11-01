import { describe, expect, it } from 'vitest';
import { runYosys } from '@yowasp/yosys';
import { type DEdge, type DNode, type DPort, type Diagram, buildDiagram } from '../core/diagram';
import type { IRDesign } from '../core/ir';
import { DEFAULT_RULES, type RuleId } from '../core/rules';
import { design } from '../core/test-utils';
import { AUCTION_FILE, AUCTION_SOURCE } from '../examples/auction';
import { FRUIT_FILE, FRUIT_SOURCE } from '../examples/fruit-battle';
import { emptyEdits } from './doc';
import { effectiveDiagram, rename } from './sheet';
import { type InterfaceOf, type SymKey, type SymParams, newUserNode, symbolNode } from './symbols';
import { diagramToVerilog, verilogIdent } from './verilog-export';

/** A drawing built the way the editor builds one: placed symbols plus wires. */
class Sheet {
  nodes: DNode[] = [];
  edges: DEdge[] = [];
  private iface: InterfaceOf;

  constructor(iface: InterfaceOf = () => undefined) {
    this.iface = iface;
  }

  add(sym: SymKey, name?: string, params: SymParams = {}): DNode {
    const u = newUserNode(`u:${this.nodes.length + 1}`, sym, { name });
    u.params = { ...u.params, ...params };
    const n = symbolNode(u, this.iface);
    this.nodes.push(n);
    return n;
  }

  /** A raw cell, for cell types the symbol library has no symbol for. */
  cell(cellType: string, ports: [string, 'in' | 'out', number][]): DNode {
    const id = `u:${this.nodes.length + 1}`;
    const n: DNode = {
      id,
      kind: 'cell',
      label: cellType,
      cellType,
      ports: ports.map(([name, dir, width]): DPort => ({ id: `${id}.${name}`, name, dir, side: dir === 'in' ? 'WEST' : 'EAST', width })),
      src: [],
    };
    this.nodes.push(n);
    return n;
  }

  wire(from: DNode, fromPort: string, to: DNode, toPort: string, label?: string): void {
    const src = from.ports.find((p) => p.name === fromPort);
    const dst = to.ports.find((p) => p.name === toPort);
    if (!src || !dst) throw new Error(`no port ${from.id}.${fromPort} or ${to.id}.${toPort}`);
    this.edges.push({
      id: `w:${this.edges.length + 1}`,
      source: { node: from.id, port: src.id },
      target: { node: to.id, port: dst.id },
      width: src.width,
      fullSource: true,
      label,
    });
  }

  diagram(module: string): Diagram {
    return { module, nodes: this.nodes, edges: this.edges };
  }
}

const portNames = (ir: IRDesign, m: string) => ir.modules[m].ports.map((p) => p.name);
const cellTypes = (ir: IRDesign, m: string) => ir.modules[m].cells.map((c) => c.type).sort();

/**
 * Prove with Yosys (miter + SAT induction) that two designs behave the same:
 * both are flattened, registers start at zero, and every output must match on every cycle
 * (asynchronous resets are modelled as synchronous ones).
 */
async function expectEquivalent(gold: Record<string, string>, gate: Record<string, string>, top: string): Promise<void> {
  const files: Record<string, string> = {};
  const names = (prefix: string, set: Record<string, string>) =>
    Object.entries(set)
      .map(([k, v]) => {
        files[`${prefix}_${k}`] = v;
        return `${prefix}_${k}`;
      })
      .join(' ');
  const script = [
    `read_verilog -sv ${names('gate', gate)}`,
    `hierarchy -top ${top}`,
    'proc',
    'flatten',
    `rename ${top} gate`,
    'design -stash gate',
    `read_verilog -sv ${names('gold', gold)}`,
    `hierarchy -top ${top}`,
    'proc',
    'flatten',
    `rename ${top} gold`,
    'design -copy-from gate gate',
    'miter -equiv -flatten -make_assert gold gate miter',
    'hierarchy -top miter',
    // SAT models only synchronous flip-flops.
    'async2sync',
    'sat -verify -prove-asserts -set-init-zero -tempinduct miter',
  ].join('; ');
  let log = '';
  const sink = (bytes: Uint8Array | null) => {
    if (bytes) log += new TextDecoder().decode(bytes);
  };
  try {
    await runYosys(['-p', script], files, { stdout: sink, stderr: sink });
  } catch (e) {
    throw new Error(`${top}: designs differ (${String(e)})\n${log.slice(-4000)}`);
  }
}

/** Flatten a design with Yosys and check it: fails when, for example, a port of an instance drives a constant. */
async function expectFlattens(files: Record<string, string>, top: string): Promise<void> {
  let log = '';
  const sink = (bytes: Uint8Array | null) => {
    if (bytes) log += new TextDecoder().decode(bytes);
  };
  const script = `read_verilog -sv ${Object.keys(files).join(' ')}; hierarchy -check -top ${top}; proc; flatten; tribuf -merge; check -assert`;
  try {
    await runYosys(['-p', script], files, { stdout: sink, stderr: sink });
  } catch (e) {
    throw new Error(`${top}: does not flatten (${String(e)})\n${log.slice(-4000)}`);
  }
}

/** Flip-flops of a module as `type CLK=… ARST=… VALUE=…`, to compare clock edges the SAT check cannot tell apart. */
const flops = (ir: IRDesign, m: string) =>
  ir.modules[m].cells
    .filter((c) => /^\$(a|s)?dff/.test(c.type))
    .map((c) => {
      const p = c.parameters;
      return `${c.type} CLK=${p.CLK_POLARITY} ARST=${p.ARST_POLARITY ?? '-'} VALUE=${p.ARST_VALUE ?? '-'}`;
    })
    .sort();

describe('verilogIdent', () => {
  it('keeps legal names and repairs the others', () => {
    expect(verilogIdent('sum_2')).toBe('sum_2');
    expect(verilogIdent('a$b')).toBe('a$b');
    expect(verilogIdent('module')).toBe('module_');
    expect(verilogIdent('logic')).toBe('logic_');
    expect(verilogIdent('2x')).toBe('_2x');
    expect(verilogIdent('a b')).toBe('a_b');
    expect(verilogIdent('x[3:0]')).toBe('x_3_0');
    expect(verilogIdent('$add')).toBe('add');
    expect(verilogIdent('')).toBe('unnamed');
    expect(verilogIdent('計數')).toBe('u8a08_u6578');
  });
});

describe('diagramToVerilog', () => {
  it('writes a half adder that Yosys reads back', async () => {
    const s = new Sheet();
    const a = s.add('input', 'a');
    const b = s.add('input', 'b');
    const sum = s.add('output', 's');
    const carry = s.add('output', 'c');
    const x = s.add('xor');
    const g = s.add('and');
    s.wire(a, 'out', x, 'A');
    s.wire(b, 'out', x, 'B');
    s.wire(a, 'out', g, 'A');
    s.wire(b, 'out', g, 'B');
    s.wire(x, 'Y', sum, 'in');
    s.wire(g, 'Y', carry, 'in');
    const { code, warnings } = diagramToVerilog(s.diagram('half_adder'), 'half_adder');
    expect(warnings).toEqual([]);
    expect(code.startsWith('// Generated by Digital Canvas from the drawing half_adder\nmodule half_adder (\n  input wire a,')).toBe(true);
    expect(code).toContain('assign s = a ^ b;');
    expect(code).toContain('assign c = a & b;');
    // Same drawing, same text.
    expect(diagramToVerilog(s.diagram('half_adder'), 'half_adder').code).toBe(code);

    const ir = await design({ 'half_adder.v': code });
    expect(portNames(ir, 'half_adder')).toEqual(['a', 'b', 's', 'c']);
    expect(cellTypes(ir, 'half_adder')).toEqual(['$and', '$xor']);
  }, 60_000);

  it('writes gates with several inputs and inverted outputs', async () => {
    const s = new Sheet();
    const ins = ['a', 'b', 'c'].map((n) => s.add('input', n, { width: 2 }));
    const outs: [SymKey, string][] = [
      ['and', 'y_and'],
      ['or', 'y_or'],
      ['xor', 'y_xor'],
      ['nand', 'y_nand'],
      ['nor', 'y_nor'],
      ['xnor', 'y_xnor'],
    ];
    for (const [sym, name] of outs) {
      const g = s.add(sym, undefined, { inputs: 3, width: 2 });
      ins.forEach((p, k) => s.wire(p, 'out', g, 'ABC'[k]));
      s.wire(g, 'Y', s.add('output', name, { width: 2 }), 'in');
    }
    const n = s.add('not', undefined, { width: 2 });
    s.wire(ins[0], 'out', n, 'A');
    s.wire(n, 'Y', s.add('output', 'y_not', { width: 2 }), 'in');
    const { code, warnings } = diagramToVerilog(s.diagram('gates'), 'gates');
    expect(warnings).toEqual([]);
    expect(code).toContain('assign y_nand = ~(a & b & c);');
    const gold = `module gates(input [1:0] a, b, c, output [1:0] y_and, y_or, y_xor, y_nand, y_nor, y_xnor, y_not);
      assign y_and = a & b & c; assign y_or = a | b | c; assign y_xor = a ^ b ^ c;
      assign y_nand = ~(a & b & c); assign y_nor = ~(a | b | c); assign y_xnor = ~(a ^ b ^ c); assign y_not = ~a;
    endmodule`;
    await expectEquivalent({ 'g.v': gold }, { 'g.v': code }, 'gates');
  }, 60_000);

  it('writes a 4-input MUX and a 2-input MUX', async () => {
    const s = new Sheet();
    const d = ['d0', 'd1', 'd2', 'd3'].map((n) => s.add('input', n, { width: 8 }));
    const sel = s.add('input', 'sel', { width: 2 });
    const pick = s.add('input', 'pick');
    const y = s.add('output', 'y', { width: 8 });
    const z = s.add('output', 'z', { width: 8 });
    const m4 = s.add('mux', undefined, { inputs: 4, width: 8 });
    expect(m4.cellType).toBe('dc:mux');
    d.forEach((p, k) => s.wire(p, 'out', m4, `I${k}`));
    s.wire(sel, 'out', m4, 'S');
    s.wire(m4, 'Y', y, 'in');
    const m2 = s.add('mux', undefined, { inputs: 2, width: 8 });
    expect(m2.cellType).toBe('$mux');
    s.wire(d[0], 'out', m2, 'A');
    s.wire(d[1], 'out', m2, 'B');
    s.wire(pick, 'out', m2, 'S');
    s.wire(m2, 'Y', z, 'in');
    const { code, warnings } = diagramToVerilog(s.diagram('muxes'), 'muxes');
    expect(warnings).toEqual([]);
    expect(code).toContain("assign y = (sel == 2'd0) ? d0 : (sel == 2'd1) ? d1 : (sel == 2'd2) ? d2 : d3;");
    expect(code).toContain('assign z = pick ? d1 : d0;');
    const ir = await design({ 'muxes.v': code });
    expect(portNames(ir, 'muxes')).toEqual(['d0', 'd1', 'd2', 'd3', 'sel', 'pick', 'y', 'z']);
    const gold = `module muxes(input [7:0] d0, d1, d2, d3, input [1:0] sel, input pick, output reg [7:0] y, output [7:0] z);
      always @* case (sel) 0: y = d0; 1: y = d1; 2: y = d2; default: y = d3; endcase
      assign z = pick ? d1 : d0;
    endmodule`;
    await expectEquivalent({ 'm.v': gold }, { 'm.v': code }, 'muxes');
  }, 60_000);

  it('writes registers with enable and asynchronous reset', async () => {
    const s = new Sheet();
    const clk = s.add('input', 'clk');
    const en = s.add('input', 'en');
    const rst = s.add('input', 'rst');
    const d = s.add('input', 'd', { width: 4 });
    const plain = s.add('dff', undefined, { width: 4 });
    const withEn = s.add('dffe', undefined, { width: 4 });
    const withRst = s.add('adff', undefined, { width: 4 });
    for (const r of [plain, withEn, withRst]) {
      s.wire(d, 'out', r, 'D');
      s.wire(clk, 'out', r, 'CLK');
    }
    s.wire(en, 'out', withEn, 'EN');
    s.wire(rst, 'out', withRst, 'ARST');
    s.wire(plain, 'Q', s.add('output', 'q0', { width: 4 }), 'in');
    s.wire(withEn, 'Q', s.add('output', 'q1', { width: 4 }), 'in', 'held');
    s.wire(withRst, 'Q', s.add('output', 'q2', { width: 4 }), 'in');
    const { code, warnings } = diagramToVerilog(s.diagram('regs'), 'regs');
    expect(warnings).toEqual([]);
    expect(code).toContain('reg [3:0] held;');
    expect(code).toContain('always @(posedge clk) if (en) held <= d;');
    expect(code).toContain('always @(posedge clk or posedge rst)');
    expect(code).toContain('assign q1 = held;');

    const ir = await design({ 'regs.v': code });
    expect(portNames(ir, 'regs')).toEqual(['clk', 'en', 'rst', 'd', 'q0', 'q1', 'q2']);
    const ffs = cellTypes(ir, 'regs').filter((t) => /^\$(a|s)?dff/.test(t));
    expect(ffs).toHaveLength(3);
    expect(ffs).toContain('$adff');
    const gold = `module regs(input clk, en, rst, input [3:0] d, output reg [3:0] q0, q1, q2);
      always @(posedge clk) q0 <= d;
      always @(posedge clk) if (en) q1 <= d;
      always @(posedge clk or posedge rst) if (rst) q2 <= 0; else q2 <= d;
    endmodule`;
    await expectEquivalent({ 'r.v': gold }, { 'r.v': code }, 'regs');
  }, 60_000);

  it('writes every register type the import can produce', async () => {
    const s = new Sheet();
    const clk = s.add('input', 'clk');
    const en = s.add('input', 'en');
    const rst = s.add('input', 'rst');
    const d = s.add('input', 'd', { width: 2 });
    const types: [string, string[]][] = [
      ['$adffe', ['ARST', 'EN']],
      ['$sdff', ['SRST']],
      ['$sdffe', ['SRST', 'EN']],
      ['$dlatch', ['EN']],
    ];
    for (const [type, extra] of types) {
      const ports: [string, 'in' | 'out', number][] = [['D', 'in', 2], ['Q', 'out', 2]];
      if (type !== '$dlatch') ports.push(['CLK', 'in', 1]);
      for (const p of extra) ports.push([p, 'in', 1]);
      const r = s.cell(type, ports);
      s.wire(d, 'out', r, 'D');
      if (type !== '$dlatch') s.wire(clk, 'out', r, 'CLK');
      for (const p of extra) s.wire(p === 'EN' ? en : rst, 'out', r, p);
      s.wire(r, 'Q', s.add('output', `q_${type.slice(1)}`, { width: 2 }), 'in');
    }
    const { code, warnings } = diagramToVerilog(s.diagram('regs2'), 'regs2');
    expect(warnings).toEqual([]);
    expect(code).toContain('always @* if (en) dlatch1_Q = d;');
    const ir = await design({ 'regs2.v': code });
    const kinds = cellTypes(ir, 'regs2').filter((t) => /dff|dlatch/.test(t));
    expect(kinds).toHaveLength(4);
    expect(kinds).toContain('$dlatch');
    const gold = `module regs2(input clk, en, rst, input [1:0] d, output reg [1:0] q_adffe, q_sdff, q_sdffe);
      always @(posedge clk or posedge rst) if (rst) q_adffe <= 0; else if (en) q_adffe <= d;
      always @(posedge clk) if (rst) q_sdff <= 0; else q_sdff <= d;
      always @(posedge clk) if (rst) q_sdffe <= 0; else if (en) q_sdffe <= d;
    endmodule`;
    // The latch is left out of the proof (SAT does not model latches); it only has to elaborate.
    const flops = diagramToVerilog({ ...s.diagram('regs2'), nodes: s.nodes.filter((n) => n.cellType !== '$dlatch' && n.label !== 'q_dlatch') }, 'regs2');
    await expectEquivalent({ 'r.v': gold }, { 'r.v': flops.code }, 'regs2');
  }, 60_000);

  it('writes a concatenation that feeds a split', async () => {
    const s = new Sheet();
    const hi = s.add('input', 'hi', { width: 4 });
    const lo = s.add('input', 'lo', { width: 4 });
    const cat = s.add('concat', undefined, { parts: 2, width: 4 });
    const split = s.add('split', undefined, { parts: 2, width: 4 });
    const top = s.add('output', 'top', { width: 4 });
    const bottom = s.add('output', 'bottom', { width: 4 });
    s.wire(hi, 'out', cat, '[7:4]');
    s.wire(lo, 'out', cat, '[3:0]');
    s.wire(cat, 'out', split, 'in', 'bus');
    s.wire(split, '[7:4]', top, 'in');
    s.wire(split, '[3:0]', bottom, 'in');
    const { code, warnings } = diagramToVerilog(s.diagram('swap'), 'swap');
    expect(warnings).toEqual([]);
    expect(code).toContain('wire [7:0] bus;');
    expect(code).toContain('assign bus = {hi, lo};');
    expect(code).toContain('assign top = bus[7:4];');
    expect(code).toContain('assign bottom = bus[3:0];');
    const ir = await design({ 'swap.v': code });
    expect(portNames(ir, 'swap')).toEqual(['hi', 'lo', 'top', 'bottom']);
    const gold = 'module swap(input [3:0] hi, lo, output [3:0] top, bottom); assign top = hi; assign bottom = lo; endmodule';
    await expectEquivalent({ 's.v': gold }, { 's.v': code }, 'swap');
  }, 60_000);

  it('reads slices written on wires', async () => {
    const s = new Sheet();
    const bus = s.add('input', 'bus', { width: 8 });
    const nib = s.add('output', 'nib', { width: 4 });
    const bit = s.add('output', 'bit3');
    s.wire(bus, 'out', nib, 'in', 'bus[7:4]');
    s.wire(bus, 'out', bit, 'in', '[3]');
    const { code, warnings } = diagramToVerilog(s.diagram('slices'), 'slices');
    expect(warnings).toEqual([]);
    expect(code).toContain('assign nib = bus[7:4];');
    expect(code).toContain('assign bit3 = bus[3];');
    await design({ 'slices.v': code });
  }, 60_000);

  it('reads the bits a wire carries even when its label names no slice', async () => {
    const s = new Sheet();
    const bus = s.add('input', 'bus', { width: 8 });
    const nib = s.add('output', 'nib', { width: 4 });
    s.wire(bus, 'out', nib, 'in', 'upper');
    Object.assign(s.edges[0], { width: 4, fullSource: false, bits: { lo: 4, width: 4 } });
    const { code, warnings } = diagramToVerilog(s.diagram('bits'), 'bits');
    expect(warnings).toEqual([]);
    expect(code).toContain('assign nib = bus[7:4];');
    await design({ 'bits.v': code });
  }, 60_000);

  it('writes an adder, a comparator and a constant', async () => {
    const s = new Sheet();
    const a = s.add('input', 'a', { width: 4 });
    const b = s.add('input', 'b', { width: 4 });
    const two = s.add('const', undefined, { value: "4'd2" });
    const add = s.add('add', undefined, { width: 4 });
    const gt = s.add('gt', undefined, { width: 4 });
    const y = s.add('output', 'y');
    s.wire(a, 'out', add, 'A');
    s.wire(two, 'out', add, 'B');
    s.wire(add, 'Y', gt, 'A');
    s.wire(b, 'out', gt, 'B');
    s.wire(gt, 'Y', y, 'in');
    const { code, warnings } = diagramToVerilog(s.diagram('cmp'), 'cmp');
    expect(warnings).toEqual([]);
    expect(code).toContain("assign add1_Y = a + 4'd2;");
    expect(code).toContain('assign y = add1_Y > b;');
    const ir = await design({ 'cmp.v': code });
    expect(cellTypes(ir, 'cmp')).toEqual(['$add', '$gt']);
    const gold = "module cmp(input [3:0] a, b, output y); wire [3:0] t = a + 4'd2; assign y = t > b; endmodule";
    await expectEquivalent({ 'c.v': gold }, { 'c.v': code }, 'cmp');
  }, 60_000);

  it('writes a 2-to-4 decoder', async () => {
    const s = new Sheet();
    const a = s.add('input', 'a', { width: 2 });
    const dec = s.add('decoder', undefined, { width: 2 });
    const y = s.add('output', 'y', { width: 4 });
    s.wire(a, 'out', dec, 'A');
    s.wire(dec, 'Y', y, 'in');
    const { code, warnings } = diagramToVerilog(s.diagram('dec'), 'dec');
    expect(warnings).toEqual([]);
    expect(code).toContain("assign y = 4'b1 << a;");
    await design({ 'dec.v': code });
    const gold = 'module dec(input [1:0] a, output reg [3:0] y); always @* case (a) 0: y = 1; 1: y = 2; 2: y = 4; default: y = 8; endcase endmodule';
    await expectEquivalent({ 'd.v': gold }, { 'd.v': code }, 'dec');
  }, 60_000);

  it('writes a block instance of another drawing', async () => {
    const inc = new Sheet();
    const a = inc.add('input', 'a', { width: 4 });
    const one = inc.add('const', undefined, { value: "4'd1" });
    const add = inc.add('add', undefined, { width: 4 });
    const y = inc.add('output', 'y', { width: 4 });
    inc.wire(a, 'out', add, 'A');
    inc.wire(one, 'out', add, 'B');
    inc.wire(add, 'Y', y, 'in');
    const incOut = diagramToVerilog(inc.diagram('inc'), 'inc');
    expect(incOut.warnings).toEqual([]);

    const iface: InterfaceOf = (m) =>
      m === 'inc'
        ? {
            label: 'inc',
            ports: [
              { name: 'a', dir: 'input', width: 4 },
              { name: 'y', dir: 'output', width: 4 },
            ],
          }
        : undefined;
    const top = new Sheet(iface);
    const x = top.add('input', 'x', { width: 4 });
    const u = top.add('block', 'u_inc', { module: 'inc' });
    const z = top.add('output', 'z', { width: 4 });
    top.wire(x, 'out', u, 'a');
    top.wire(u, 'y', z, 'in');
    const topOut = diagramToVerilog(top.diagram('top'), 'top');
    expect(topOut.warnings).toEqual([]);
    expect(topOut.code).toContain('inc u_inc (\n    .a(x),\n    .y(z)\n  );');

    const ir = await design({ 'inc.v': incOut.code, 'top.v': topOut.code }, 'top');
    expect(ir.top).toBe('top');
    const cell = ir.modules.top.cells.find((c) => c.isInstance);
    expect(cell?.type).toBe('inc');
    expect(cell?.name).toBe('u_inc');
    const gold = "module top(input [3:0] x, output [3:0] z); assign z = x + 4'd1; endmodule";
    await expectEquivalent({ 't.v': gold }, { 'inc.v': incOut.code, 'top.v': topOut.code }, 'top');
  }, 60_000);

  it('warns about open inputs, width mismatches and missing modules, and still elaborates', async () => {
    const s = new Sheet();
    const a = s.add('input', 'a', { width: 4 });
    const g = s.add('and', undefined, { width: 4 });
    const add = s.add('add', undefined, { width: 8 });
    const y = s.add('output', 'y', { width: 4 });
    const w = s.add('output', 'w', { width: 8 });
    s.add('output', 'nothing');
    s.add('block', 'u_none');
    s.add('text', 'just a note');
    s.wire(a, 'out', g, 'A');
    s.wire(g, 'Y', y, 'in');
    s.wire(a, 'out', add, 'A');
    s.wire(a, 'out', add, 'B');
    s.wire(add, 'Y', w, 'in');
    const { code, warnings } = diagramToVerilog(s.diagram('broken'), 'broken');
    expect(warnings).toContainEqual(expect.stringMatching(/^Input B of and1 \(\$and\) is not connected/));
    expect(warnings).toContainEqual(expect.stringMatching(/^Width mismatch: input A of add1 \(\$add\) is 8 bits but its wire from input 'a' carries 4 bits/));
    expect(warnings).toContainEqual(expect.stringMatching(/^Output 'nothing' is not driven/));
    expect(warnings).toContainEqual(expect.stringMatching(/^Instance u_none .* has no module/));
    expect(code).toContain("assign y = a & 4'd0;");
    expect(code).toContain("assign w = {4'd0, a} + {4'd0, a};");
    const ir = await design({ 'broken.v': code });
    expect(portNames(ir, 'broken')).toEqual(['a', 'y', 'w', 'nothing']);
  }, 60_000);

  it('keeps going on open clocks, constant resets, bad constants and reversed wires', async () => {
    const s = new Sheet();
    const clk = s.add('input', 'clk');
    const d = s.add('input', 'd', { width: 4 });
    const open = s.add('dff', undefined, { width: 4 });
    s.wire(d, 'out', open, 'D');
    s.wire(open, 'Q', s.add('output', 'q_open', { width: 4 }), 'in');
    const stuck = s.add('adff', undefined, { width: 4 });
    s.wire(d, 'out', stuck, 'D');
    s.wire(clk, 'out', stuck, 'CLK');
    s.wire(s.add('const', undefined, { value: "1'b1" }), 'out', stuck, 'ARST');
    s.wire(stuck, 'Q', s.add('output', 'q_stuck', { width: 4 }), 'in');
    const bad = s.add('output', 'bad', { width: 4 });
    s.wire(s.add('const', undefined, { value: 'WIDTH' }), 'out', bad, 'in');
    // Drawn from the output pin back to the gate: the exporter turns it around.
    const n = s.add('not', undefined, { width: 4 });
    s.wire(d, 'out', n, 'A');
    const back = s.add('output', 'back', { width: 4 });
    s.wire(back, 'in', n, 'Y');
    // Slice ports that are not bit ranges fall back to their position (MSB first).
    const split = s.cell('$x', []);
    Object.assign(split, {
      kind: 'split',
      ports: [
        { id: `${split.id}.in`, name: 'in', dir: 'in', side: 'WEST', width: 4 },
        { id: `${split.id}.hi`, name: 'hi', dir: 'out', side: 'EAST', width: 1 },
        { id: `${split.id}.rest`, name: 'rest', dir: 'out', side: 'EAST', width: 3 },
      ],
    });
    s.wire(d, 'out', split, 'in');
    s.wire(split, 'hi', s.add('output', 'msb'), 'in');
    s.wire(split, 'rest', s.add('output', 'low3', { width: 3 }), 'in');

    const { code, warnings } = diagramToVerilog(s.diagram('odd'), 'odd');
    expect(warnings).toContainEqual(expect.stringMatching(/^Input CLK of dff1 .* not connected/));
    expect(warnings).toContainEqual(expect.stringMatching(/^The clock of dff1 .* is a constant; the register is left out/));
    expect(warnings).toContainEqual(expect.stringMatching(/^Constant 'WIDTH' is not a Verilog number/));
    expect(warnings).toContainEqual(expect.stringMatching(/^Output hi of split split1 is not a bit range/));
    expect(code).toContain('if (adff1_ARST) adff1_Q <= 4\'d0;');
    expect(code).toContain('assign back = ~d;');
    expect(code).toContain('assign msb = d[3];');
    expect(code).toContain('assign low3 = d[2:0];');
    const ir = await design({ 'odd.v': code });
    expect(portNames(ir, 'odd')).toEqual(['clk', 'd', 'q_open', 'q_stuck', 'bad', 'back', 'msb', 'low3']);
  }, 60_000);

  it('comments out cells without a Verilog form', async () => {
    const s = new Sheet();
    const a = s.add('input', 'a', { width: 4 });
    const m = s.cell('$mem_v2', [
      ['RD_ADDR', 'in', 4],
      ['RD_DATA', 'out', 8],
    ]);
    const y = s.add('output', 'y', { width: 8 });
    s.wire(a, 'out', m, 'RD_ADDR');
    s.wire(m, 'RD_DATA', y, 'in');
    const { code, warnings } = diagramToVerilog(s.diagram('mem'), 'mem');
    expect(warnings).toContainEqual(expect.stringMatching(/mem_v2.*no Verilog form/));
    expect(code).toMatch(/\/\/ mem_v2_1 \(\$mem_v2\): no Verilog form/);
    await design({ 'mem.v': code });
  }, 60_000);

  it('makes names legal and unique', async () => {
    const s = new Sheet();
    const pins = ['module', '2x', 'a b', 'a', 'a'].map((n) => s.add('input', n));
    const g = s.add('or', undefined, { inputs: 5 });
    pins.forEach((p, k) => s.wire(p, 'out', g, 'ABCDE'[k]));
    const y = s.add('output', 'y');
    s.wire(g, 'Y', y, 'in', 'or1_Y');
    // A user label that is a keyword or already taken is not used as a net name.
    const n = s.add('not');
    s.wire(pins[3], 'out', n, 'A');
    s.wire(n, 'Y', s.add('output', 'reg'), 'in', 'wire');
    const { code, warnings } = diagramToVerilog(s.diagram('my module'), 'my module');
    expect(code).toContain('module my_module (');
    expect(code).toContain('input wire module_,');
    expect(code).toContain('input wire _2x,');
    expect(code).toContain('input wire a_b,');
    expect(code).toContain('input wire a,');
    expect(code).toContain('input wire a_2,');
    expect(code).toContain('output wire reg_');
    expect(code).toContain('assign or1_Y = module_ | _2x | a_b | a | a_2;');
    expect(warnings).toContainEqual("Pin name 'a' is used more than once; this one is written as a_2");
    expect(warnings).toContainEqual("Pin 'module' is not a legal Verilog name; it is written as module_");
    const ir = await design({ 'names.v': code });
    expect(portNames(ir, 'my_module')).toEqual(['module_', '_2x', 'a_b', 'a', 'a_2', 'y', 'reg_']);
  }, 60_000);
});

describe('imported cell parameters', () => {
  const ruleSets: [string, ReadonlySet<RuleId>][] = [
    ['no rules', new Set()],
    ['default rules', DEFAULT_RULES],
  ];

  it.each(ruleSets)('keep clock edges and reset values of registers (%s)', async (_name, rules) => {
    const files = {
      'regs.v': `module regs(input clk, rst, input [3:0] d, output reg [3:0] a, n, m);
        always @(posedge clk or posedge rst) if (rst) a <= 4'hA; else a <= d;
        always @(negedge clk) n <= d;
        always @(negedge clk or posedge rst) if (rst) m <= 4'h5; else m <= d;
      endmodule`,
    };
    const before = await design(files);
    const { code, warnings } = diagramToVerilog(buildDiagram(before, 'regs', rules), 'regs');
    expect(warnings).toEqual([]);
    expect(code).toMatch(/always @\(negedge clk\) \w+ <= d;/);
    // (Yosys reads the reset through a |rst cell.)
    expect(code).toMatch(/always @\(negedge clk or posedge (\w+)\)\n {4}if \(\1\) \w+ <= 4'd5;/);
    expect(code).toMatch(/always @\(posedge clk or posedge (\w+)\)\n {4}if \(\1\) \w+ <= 4'd10;/);
    // The SAT proof below models every flip-flop as clocked by the same step, so compare the edges here.
    const after = await design({ 'regs.v': code });
    expect(flops(after, 'regs')).toEqual(flops(before, 'regs'));
    expect(flops(after, 'regs')).toContain('$dff CLK=0 ARST=- VALUE=-');
    await expectEquivalent(files, { 'regs.v': code }, 'regs');
  }, 60_000);

  it('writes active-low resets and enables, and reset values, of register cells', async () => {
    const s = new Sheet();
    const clk = s.add('input', 'clk');
    const en = s.add('input', 'en');
    const rst = s.add('input', 'rst');
    const d = s.add('input', 'd', { width: 2 });
    const reg = (type: string, extra: string[], params: Record<string, string>, out: string) => {
      const ports: [string, 'in' | 'out', number][] = [['D', 'in', 2], ['Q', 'out', 2]];
      if (type !== '$dlatch') ports.push(['CLK', 'in', 1]);
      for (const p of extra) ports.push([p, 'in', 1]);
      const r = s.cell(type, ports);
      r.params = params;
      s.wire(d, 'out', r, 'D');
      if (type !== '$dlatch') s.wire(clk, 'out', r, 'CLK');
      for (const p of extra) s.wire(p === 'EN' ? en : rst, 'out', r, p);
      s.wire(r, 'Q', s.add('output', out, { width: 2 }), 'in');
      return r;
    };
    reg('$adffe', ['ARST', 'EN'], { ARST_POLARITY: '0', EN_POLARITY: '0', ARST_VALUE: '10' }, 'q_adffe');
    reg('$sdffe', ['SRST', 'EN'], { CLK_POLARITY: '0', SRST_POLARITY: '0', SRST_VALUE: '01' }, 'q_sdffe');
    reg('$dlatch', ['EN'], { EN_POLARITY: '0' }, 'q_dlatch');
    // A reset tied to its inactive level (1 for an active-low reset) never fires.
    const idle = s.cell('$adff', [['D', 'in', 2], ['CLK', 'in', 1], ['ARST', 'in', 1], ['Q', 'out', 2]]);
    idle.params = { ARST_POLARITY: '0', ARST_VALUE: '11' };
    s.wire(d, 'out', idle, 'D');
    s.wire(clk, 'out', idle, 'CLK');
    s.wire(s.add('const', undefined, { value: "1'b1" }), 'out', idle, 'ARST');
    s.wire(idle, 'Q', s.add('output', 'q_idle', { width: 2 }), 'in');

    const { code, warnings } = diagramToVerilog(s.diagram('regs3'), 'regs3');
    expect(warnings).toEqual([]);
    expect(code).toContain("always @(posedge clk or negedge rst)\n    if (!rst) adffe1_Q <= 2'd2;\n    else if (!en) adffe1_Q <= d;");
    expect(code).toContain("always @(negedge clk)\n    if (!rst) sdffe1_Q <= 2'd1;\n    else if (en) sdffe1_Q <= d;");
    expect(code).toContain('always @* if (!en) dlatch1_Q = d;');
    expect(code).toContain('always @(posedge clk) adff1_Q <= d;');
    await design({ 'regs3.v': code });
    const gold = `module regs3(input clk, en, rst, input [1:0] d, output reg [1:0] q_adffe, q_sdffe, q_idle);
      always @(posedge clk or negedge rst) if (!rst) q_adffe <= 2'b10; else if (!en) q_adffe <= d;
      always @(negedge clk) if (!rst) q_sdffe <= 2'b01; else if (en) q_sdffe <= d;
      always @(posedge clk) q_idle <= d;
    endmodule`;
    // The latch is left out of the proof (SAT does not model latches); it only has to elaborate.
    const flopsOnly = diagramToVerilog({ ...s.diagram('regs3'), nodes: s.nodes.filter((n) => n.cellType !== '$dlatch' && n.label !== 'q_dlatch') }, 'regs3');
    await expectEquivalent({ 'r.v': gold }, { 'r.v': flopsOnly.code }, 'regs3');
  }, 60_000);

  it.each(ruleSets)('keep signed operands (%s)', async (_name, rules) => {
    const files = {
      'sg.v': `module sg(input signed [3:0] a, input signed [5:0] b, input [2:0] s, input signed [2:0] i, input [15:0] bus,
        output lt, eq, output signed [7:0] sum, prod, sr, neg, inv, pos, output [3:0] part);
        assign lt = a < b;
        assign eq = a == b;
        assign sum = a + b;
        assign prod = a * b;
        assign sr = a >>> s;
        assign neg = -a;
        assign inv = ~a;
        assign pos = +a;
        assign part = bus[i +: 4];
      endmodule`,
    };
    const before = await design(files);
    const { code, warnings } = diagramToVerilog(buildDiagram(before, 'sg', rules), 'sg');
    expect(warnings).toEqual([]);
    expect(code).toContain('assign lt = $signed(a) < $signed(b);');
    expect(code).toContain('assign eq = $signed(a) == $signed(b);');
    expect(code).toContain('assign sum = $signed(a) + $signed(b);');
    expect(code).toContain('assign sr = $signed(a) >>> s;');
    // Yosys widens the operand of a unary operator itself (with copies of the sign bit).
    expect(code).toMatch(/assign neg = -\$signed\(\w+\);/);
    expect(code).toMatch(/\(\$signed\(\w+\) < 0\) \? bus << -\w+ : bus >> \w+;/);
    await expectEquivalent(files, { 'sg.v': code }, 'sg');
  }, 60_000);
});

describe('edits of imported sheets', () => {
  it('keeps the ×4 scale of an imported wire when its label is renamed or cleared', async () => {
    const files = { 'sc.v': "module sc(input [3:0] a, b, output [5:0] y); assign y = a + {b, 2'b00}; endmodule" };
    const base = buildDiagram(await design(files), 'sc', DEFAULT_RULES);
    const scaled = base.edges.find((e) => e.label === '×4');
    expect(scaled?.shift).toBe(2);
    for (const text of ['b_shifted', '']) {
      const d = effectiveDiagram('sc', base, rename(emptyEdits(), scaled!.id, text), () => undefined);
      expect(d.edges.find((e) => e.id === scaled!.id)?.label).toBe(text || undefined);
      const { code } = diagramToVerilog(d, 'sc');
      expect(code).toContain("{b, 2'd0}");
      await expectEquivalent(files, { 'sc.v': code }, 'sc');
    }
    // A hand-drawn (or copied) wire has no recorded shift: its ×4 label still counts.
    const s = new Sheet();
    const b = s.add('input', 'b', { width: 4 });
    const y = s.add('output', 'y', { width: 6 });
    s.wire(b, 'out', y, 'in', '×4');
    expect(diagramToVerilog(s.diagram('drawn'), 'drawn').code).toContain("assign y = {b, 2'd0};");
  }, 60_000);

  it('names a renamed imported instance by its new name', async () => {
    const files = {
      'h.v': 'module leaf(input a, output y); assign y = ~a; endmodule\nmodule top(input a, output y); leaf u_leaf(.a(a), .y(y)); endmodule',
    };
    const base = buildDiagram(await design(files, 'top'), 'top', DEFAULT_RULES);
    const inst = base.nodes.find((n) => n.instanceName === 'u_leaf')!;
    const renamed = effectiveDiagram('top', base, rename(emptyEdits(), inst.id, 'first'), () => undefined);
    const { code, warnings } = diagramToVerilog(renamed, 'top');
    expect(warnings).toEqual([]);
    expect(code).toContain('leaf first (');
    expect(code).not.toContain('u_leaf');
    // Clearing the rename goes back to the name in the Verilog.
    const cleared = effectiveDiagram('top', base, rename(emptyEdits(), inst.id, ''), () => undefined);
    expect(diagramToVerilog(cleared, 'top').code).toContain('leaf u_leaf (');
  }, 60_000);

  it('writes unsized constants sized, so they are legal inside a concatenation', async () => {
    const s = new Sheet();
    const a = s.add('input', 'a', { width: 32 });
    const hi = s.add('const', undefined, { value: "'hFF" });
    const cat = s.add('concat', undefined, { parts: 2, width: 32 });
    const y = s.add('output', 'y', { width: 64 });
    s.wire(hi, 'out', cat, '[63:32]');
    s.wire(a, 'out', cat, '[31:0]');
    s.wire(cat, 'out', y, 'in');
    const { code, warnings } = diagramToVerilog(s.diagram('cat'), 'cat');
    expect(warnings).toEqual([]);
    expect(code).toContain("assign y = {32'd255, a};");
    const gold = "module cat(input [31:0] a, output [63:0] y); assign y = {32'hFF, a}; endmodule";
    await expectEquivalent({ 'c.v': gold }, { 'c.v': code }, 'cat');
  }, 60_000);
});

describe('inout ports of blocks', () => {
  /** A drawing with an inout pin `io` that `a` drives and `y` reads. */
  const leafSheet = () => {
    const leaf = new Sheet();
    const io = leaf.add('inout', 'io', { width: 4 });
    const a = leaf.add('input', 'a', { width: 4 });
    const y = leaf.add('output', 'y', { width: 4 });
    leaf.wire(a, 'out', io, 'in');
    leaf.wire(io, 'out', y, 'in');
    return leaf;
  };
  /** A drawing that only reads its inout pin `io` (into `y`). */
  const readerSheet = () => {
    const reader = new Sheet();
    const io = reader.add('inout', 'io', { width: 4 });
    reader.wire(io, 'out', reader.add('output', 'y', { width: 4 }), 'in');
    return reader;
  };
  const iface: InterfaceOf = (m) =>
    m === 'leaf' || m === 'reader'
      ? {
          label: m,
          ports: [
            { name: 'io', dir: 'inout', width: 4 },
            ...(m === 'leaf' ? [{ name: 'a', dir: 'input' as const, width: 4 }] : []),
            { name: 'y', dir: 'output', width: 4 },
          ],
        }
      : undefined;

  it('leaves an open inout port open instead of tying it to 0', async () => {
    const leafOut = diagramToVerilog(leafSheet().diagram('leaf'), 'leaf');
    expect(leafOut.warnings).toEqual([]);
    const top = new Sheet(iface);
    const p = top.add('input', 'p', { width: 4 });
    const u = top.add('block', 'u1', { module: 'leaf' });
    expect(u.ports.find((q) => q.name === 'io')?.inout).toBe(true);
    top.wire(p, 'out', u, 'a');
    top.wire(u, 'y', top.add('output', 's', { width: 4 }), 'in');
    const { code, warnings } = diagramToVerilog(top.diagram('top'), 'top');
    expect(warnings).toEqual([]);
    expect(code).toContain('leaf u1 (\n    .io(),\n    .a(p),\n    .y(s)\n  );');
    const gate = { 'leaf.v': leafOut.code, 'top.v': code };
    await expectFlattens(gate, 'top');
    await expectEquivalent({ 't.v': 'module top(input [3:0] p, output [3:0] s); assign s = p; endmodule' }, gate, 'top');
  }, 60_000);

  it('gives inout ports joined by wires one shared net', async () => {
    const top = new Sheet(iface);
    const p = top.add('input', 'p', { width: 4 });
    const u1 = top.add('block', 'u1', { module: 'leaf' });
    const u2 = top.add('block', 'u2', { module: 'reader' });
    top.wire(p, 'out', u1, 'a');
    // The editor draws a wire between two inout ports from one to the other (both are wired as inputs).
    top.wire(u1, 'io', u2, 'io', 'shared');
    top.wire(u1, 'io', top.add('output', 'seen', { width: 4 }), 'in');
    top.wire(u2, 'y', top.add('output', 't', { width: 4 }), 'in');
    const { code, warnings } = diagramToVerilog(top.diagram('top'), 'top');
    expect(warnings).toEqual([]);
    expect(code).toContain('wire [3:0] shared;');
    expect(code).toContain('leaf u1 (\n    .io(shared),');
    expect(code).toContain('reader u2 (\n    .io(shared),');
    expect(code).toContain('assign seen = shared;');
    const gate = {
      'leaf.v': diagramToVerilog(leafSheet().diagram('leaf'), 'leaf').code,
      'reader.v': diagramToVerilog(readerSheet().diagram('reader'), 'reader').code,
      'top.v': code,
    };
    await expectFlattens(gate, 'top');
    // What u1 drives onto the bus reaches u2 and the output.
    const gold = 'module top(input [3:0] p, output [3:0] seen, t); assign seen = p; assign t = p; endmodule';
    await expectEquivalent({ 't.v': gold }, gate, 'top');
  }, 60_000);

  it('keeps an imported tristate bus shared between instances and pins', async () => {
    const child = `module child(inout [3:0] bus, input en, input [3:0] d, output [3:0] q);
      assign bus = en ? d : 4'bz;
      assign q = bus;
    endmodule`;
    const shared = `module top(input e1, e2, input [3:0] d1, d2, output [3:0] q1, q2, seen);
      wire [3:0] bus;
      child c1(.bus(bus), .en(e1), .d(d1), .q(q1));
      child c2(.bus(bus), .en(e2), .d(d2), .q(q2));
      assign seen = bus;
    endmodule`;
    const files = { 'child.v': child, 'top.v': shared };
    const ir = await design(files, 'top');
    for (const rules of [new Set<RuleId>(), DEFAULT_RULES]) {
      const top = diagramToVerilog(buildDiagram(ir, 'top', rules), 'top');
      expect(top.warnings).toEqual([]);
      expect(top.code).toContain('wire [3:0] bus;');
      expect(top.code.match(/\.bus\(bus\)/g)).toHaveLength(2);
      expect(top.code).toContain('assign seen = bus;');
      // The child reads the bus itself (what the other instance drives too), not only its own driver.
      const leaf = diagramToVerilog(buildDiagram(ir, 'child', rules), 'child');
      expect(leaf.warnings).toEqual([]);
      expect(leaf.code).toContain('assign q = bus;');
      await expectFlattens({ 'child.v': leaf.code, 'top.v': top.code }, 'top');
    }

    // An inout pin of the parent passed down: the import draws the pin feeding itself, which must not become `assign bus = bus;`.
    const pinned = await design({ 'child.v': child, 'top.v': 'module top(inout [3:0] bus, input en, input [3:0] d, output [3:0] q); child c1(.bus(bus), .en(en), .d(d), .q(q)); endmodule' }, 'top');
    const { code, warnings } = diagramToVerilog(buildDiagram(pinned, 'top', new Set()), 'top');
    expect(warnings).toEqual([]);
    expect(code).toContain('.bus(bus),');
    expect(code).not.toContain('assign bus');
    await expectFlattens({ 'child.v': child, 'top.v': code }, 'top');
  }, 60_000);
});

describe('round trip through the drawing', () => {
  const ruleSets: [string, ReadonlySet<RuleId>][] = [
    ['no rules', new Set()],
    ['default rules', DEFAULT_RULES],
  ];

  it.each(ruleSets)('Fruit Battle (%s)', async (_name, rules) => {
    const files = { [FRUIT_FILE]: FRUIT_SOURCE };
    const before = await design(files);
    const { code } = diagramToVerilog(buildDiagram(before, 'top', rules), 'top');
    const after = await design({ 'top.v': code });
    expect(portNames(after, 'top')).toEqual(portNames(before, 'top'));
    if (rules.size === 0) expect(cellTypes(after, 'top')).toEqual(cellTypes(before, 'top'));
    await expectEquivalent(files, { 'top.v': code }, 'top');
  }, 120_000);

  it.each(ruleSets)('auction, every module (%s)', async (_name, rules) => {
    const files = { [AUCTION_FILE]: AUCTION_SOURCE };
    const before = await design(files);
    const out: Record<string, string> = {};
    for (const m of Object.keys(before.modules)) {
      const r = diagramToVerilog(buildDiagram(before, m, rules), m);
      out[`${m}.v`] = r.code;
      // Hidden zero padding (default rules) shows up as width warnings; nothing else should.
      expect(r.warnings.filter((w) => !w.startsWith('Width mismatch'))).toEqual([]);
    }
    const after = await design(out, 'auction_top');
    expect(Object.keys(after.modules).sort()).toEqual(Object.keys(before.modules).sort());
    for (const m of Object.keys(before.modules)) {
      expect(portNames(after, m)).toEqual(portNames(before, m));
      if (rules.size === 0) expect(cellTypes(after, m)).toEqual(cellTypes(before, m));
    }
    await expectEquivalent(files, out, 'auction_top');
  }, 120_000);
});
