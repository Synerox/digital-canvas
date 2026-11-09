import { describe, expect, it } from 'vitest';
import { buildDiagram } from './diagram';
import { flattenModule, withFlattened } from './flatten';
import { buildHierarchy, type IRDesign } from './ir';
import { paragraphs, partitionModule, siblingKeys, withAutoBlocks } from './partition';
import { design } from './test-utils';
import { layoutDiagram } from '../layout/elk-layout';
import { AUCTION_FILE, AUCTION_SOURCE } from '../examples/auction';
import { FRUIT_FILE, FRUIT_SOURCE } from '../examples/fruit-battle';

const T = 60_000;
const fruitFiles = { [FRUIT_FILE]: FRUIT_SOURCE };

/** Every bit an auto block reads must be driven by another block or a module input. */
function checkWiring(d: IRDesign, parentName: string) {
  const parent = d.modules[parentName];
  const driven = new Set<number>();
  for (const p of parent.ports) if (p.direction === 'input') for (const b of p.bits) if (typeof b === 'number') driven.add(b);
  for (const c of parent.cells)
    for (const [p, bits] of Object.entries(c.connections))
      if (c.directions[p] === 'output') for (const b of bits) if (typeof b === 'number') driven.add(b);
  for (const c of parent.cells) {
    if (!c.attrs?.auto) continue;
    for (const [p, bits] of Object.entries(c.connections))
      if (c.directions[p] === 'input') for (const b of bits) if (typeof b === 'number') expect(driven.has(b), `${c.name}.${p}`).toBe(true);
  }
  for (const p of parent.ports)
    if (p.direction === 'output') for (const b of p.bits) if (typeof b === 'number') expect(driven.has(b), p.name).toBe(true);
}

describe('helpers', () => {
  it('finds parallel sibling names', () => {
    const share = (a: string, b: string) => siblingKeys(a).some((k) => siblingKeys(b).includes(k));
    expect(share('score_a', 'score_b')).toBe(true);
    expect(share('allocation_a_valid', 'allocation_b_valid')).toBe(true);
    expect(share('seed_x1', 'seed_x3')).toBe(true);
    expect(share('sum0', 'sum1')).toBe(true);
    expect(share('data_in', 'data_out')).toBe(false);
    expect(share('a', 'b')).toBe(false);
  });

  it('splits source into paragraphs at blank lines and around always blocks', () => {
    const src = ['assign a = 1;', 'assign b = a;', '', 'assign c = b;', 'always @(*) begin', '  x = c;', '', '  y = x;', 'end', 'assign d = y;'].join('\n');
    const p = paragraphs(src);
    expect(p[0]).toBe(p[1]);
    expect(p[3]).not.toBe(p[1]);
    // The always block is one paragraph, even with a blank line inside, and it ends one.
    expect(p[4]).not.toBe(p[3]);
    expect(new Set([p[4], p[5], p[6], p[7], p[8]]).size).toBe(1);
    expect(p[9]).not.toBe(p[8]);
  });
});

describe('automatic blocks for a single module', () => {
  it('partitions the Fruit Battle top module into functional blocks', async () => {
    const d = await design(fruitFiles);
    const top = d.modules.top;
    expect(top.cells.some((c) => c.isInstance)).toBe(false);
    const blocks = partitionModule(top, fruitFiles)!;
    expect(blocks.map((b) => b.label)).toEqual(['crop_points', 'result_valid', 'field_owner', 'score', 'game_result']);
    // Every primitive cell is in exactly one block.
    const all = blocks.flatMap((b) => b.cellIds);
    expect(all.length).toBe(top.cells.length);
    expect(new Set(all).size).toBe(all.length);

    const byLabel = Object.fromEntries(blocks.map((b) => [b.label, b]));
    const inBlock = (label: string, text: string) => byLabel[label].cellIds.some((id) => id.includes(text));
    expect(inBlock('crop_points', 'seed << 13')).toBe(true);
    expect(inBlock('result_valid', '4\'b0001 << shears_field_a')).toBe(true);
    expect(inBlock('result_valid', 'worker_total_b == 5\'d6')).toBe(true);
    expect(inBlock('field_owner', "{1'b0, workers_b[11:9]}")).toBe(true);
    expect(inBlock('score', 'base_score_a + ')).toBe(true);
    expect(inBlock('game_result', 'score_a < score_b')).toBe(true);
  }, T);

  it('draws the block diagram and opens every block like a sub-module', async () => {
    const d = withAutoBlocks(await design(fruitFiles), fruitFiles);
    checkWiring(d, 'top');
    const h = buildHierarchy(d);
    expect(h.children.map((c) => c.instance)).toEqual(['crop_points', 'result_valid', 'field_owner', 'score', 'game_result']);

    const top = buildDiagram(d, 'top');
    const blocks = top.nodes.filter((n) => n.kind === 'instance');
    expect(blocks).toHaveLength(5);
    expect(top.nodes.some((n) => n.kind === 'cell')).toBe(false);
    expect(blocks.map((b) => b.id)).toContain('cell:auto:result_valid');
    // Full buses enter the blocks: workers_a goes whole into the validator and the comparator.
    const workers = top.edges.filter((e) => e.source.node === 'in:workers_a');
    expect(workers.map((e) => e.target.node).sort()).toEqual(['cell:auto:field_owner', 'cell:auto:result_valid']);
    expect(workers.every((e) => e.width === 12)).toBe(true);
    // The validator block keeps the source lines of the cells it took (in the netlist; nothing draws them).
    const rv = d.modules.top.cells.find((c) => c.id === 'auto:result_valid')!;
    const lines = new Set(rv.src.map((r) => r.startLine));
    expect(lines.has(31)).toBe(true); // worker_total_a
    expect(lines.has(47)).toBe(true); // result_valid

    // Signals flow left to right on the block diagram.
    const layout = await layoutDiagram(top);
    const x = (id: string) => layout.nodes.find((n) => n.id === id)!.x;
    expect(x('cell:auto:result_valid')).toBeLessThan(x('cell:auto:field_owner'));
    expect(x('cell:auto:field_owner')).toBeLessThan(x('cell:auto:score'));
    expect(x('cell:auto:score')).toBeLessThan(x('cell:auto:game_result'));

    // Each block opens into its own circuit with pins for its interface.
    for (const b of blocks) {
      const inner = buildDiagram(d, b.moduleName!);
      expect(inner.nodes.some((n) => n.kind === 'cell')).toBe(true);
      const pins = inner.nodes.filter((n) => n.kind === 'input' || n.kind === 'output').map((n) => n.label);
      for (const p of b.ports) expect(pins).toContain(p.name);
      // Cells keep their stable IDs inside the block.
      for (const n of inner.nodes.filter((n) => n.kind === 'cell')) expect(n.id.startsWith('cell:$')).toBe(true);
    }
    const sc = buildDiagram(d, 'top/score');
    expect(sc.nodes.filter((n) => n.kind === 'input').map((n) => n.label).sort()).toEqual(
      ['crop_points', 'field_owner', 'gift_box_mask_a', 'gift_box_mask_b'],
    );
    expect(sc.nodes.filter((n) => n.kind === 'output').map((n) => n.label).sort()).toEqual(['score_a', 'score_b']);
  }, T);

  it('keeps block IDs when an unrelated line changes', async () => {
    const edited = FRUIT_SOURCE.replace('wire [7:0] crop_points;', 'wire [7:0] crop_points; // edited');
    const a = partitionModule((await design(fruitFiles)).modules.top, fruitFiles)!;
    const b = partitionModule((await design({ [FRUIT_FILE]: edited })).modules.top, { [FRUIT_FILE]: edited })!;
    expect(b.map((x) => x.label)).toEqual(a.map((x) => x.label));
    expect(b.map((x) => x.cellIds.length)).toEqual(a.map((x) => x.cellIds.length));
  }, T);

  it('uses a comment above a group as the block name', async () => {
    const src = `module m(input [7:0] a, b, c, output [7:0] y, output z);
  // Adder tree
  wire [7:0] s1 = a + b;
  wire [7:0] s2 = s1 + c;
  wire [7:0] s3 = s2 + 8'd1;

  // Compare
  wire g1 = a > b;
  wire g2 = b > c;
  wire g3 = g1 & g2;
  wire g4 = g3 | (a == c);

  assign y = s3;
  assign z = g4;
endmodule`;
    const blocks = partitionModule((await design({ 'm.v': src })).modules.m, { 'm.v': src }, { minCells: 4 })!;
    expect(blocks.map((b) => b.label)).toEqual(['Adder tree', 'Compare']);
  }, T);

  it('still partitions without source text, and leaves small modules alone', async () => {
    const d = await design(fruitFiles);
    const blocks = partitionModule(d.modules.top)!;
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    expect(blocks.length).toBeLessThanOrEqual(9);
    expect(blocks.flatMap((b) => b.cellIds).length).toBe(d.modules.top.cells.length);
    checkWiring(withAutoBlocks(d), 'top');

    // The auction demo's modules are small: they are drawn as they are.
    const a = await design({ [AUCTION_FILE]: AUCTION_SOURCE });
    const ab = withAutoBlocks(a, { [AUCTION_FILE]: AUCTION_SOURCE });
    expect(Object.keys(ab.modules).sort()).toEqual(Object.keys(a.modules).sort());
  }, T);

  it('partitions sequential logic with feedback', async () => {
    const src = `module cnt(input clk, rst, en, input [7:0] limit, output reg [7:0] count, output reg [3:0] laps, output hit);
  always @(posedge clk) begin
    if (rst) count <= 8'd0;
    else if (en) count <= hit ? 8'd0 : count + 8'd1;
  end
  assign hit = count == limit;

  always @(posedge clk) begin
    if (rst) laps <= 4'd0;
    else if (hit) laps <= laps + 4'd1;
  end
endmodule`;
    const d = withAutoBlocks(await design({ 'c.v': src }), { 'c.v': src }, { minCells: 4 });
    checkWiring(d, 'cnt');
    const top = buildDiagram(d, 'cnt');
    expect(top.nodes.filter((n) => n.kind === 'instance').length).toBeGreaterThanOrEqual(2);
  }, T);
});

describe('full circuit view', () => {
  it('flattens sub-module instances into one sheet', async () => {
    const a = await design({ [AUCTION_FILE]: AUCTION_SOURCE });
    const flat = flattenModule(a, a.top);
    expect(flat.cells.some((c) => c.isInstance)).toBe(false);
    const count = (name: string): number =>
      a.modules[name].cells.reduce((n, c) => n + (c.isInstance && a.modules[c.type] ? count(c.type) : 1), 0);
    expect(flat.cells.length).toBe(count(a.top));
    expect(new Set(flat.cells.map((c) => c.id)).size).toBe(flat.cells.length);
    expect(flat.cells.some((c) => c.id.startsWith('u_check_a/'))).toBe(true);

    const d = buildDiagram(withFlattened(a, a.top), a.top);
    expect(d.nodes.some((n) => n.kind === 'instance')).toBe(false);
    // The budget input still reaches both bid checkers' comparators.
    const budget = d.edges.filter((e) => e.source.node === 'in:budget');
    expect(budget.length).toBe(2);
    expect(d.nodes.some((n) => n.kind === 'const' && /x/.test(n.label))).toBe(false);
    const layout = await layoutDiagram(d);
    expect(layout.nodes.length).toBe(d.nodes.length);
  }, T);

  it('shows a flat module unchanged', async () => {
    const d = await design(fruitFiles);
    expect(flattenModule(d, 'top')).toBe(d.modules.top);
  }, T);
});
