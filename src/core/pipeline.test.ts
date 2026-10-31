import { describe, expect, it } from 'vitest';
import { runYosys } from '@yowasp/yosys';
import { AUCTION_FILE, AUCTION_SOURCE } from '../examples/auction';
import { JSON_OUT, yosysArgs } from '../yosys/script';
import { buildDesign, buildHierarchy, formatConst, parseSrc } from './ir';
import { buildDiagram } from './diagram';
import { layoutDiagram } from '../layout/elk-layout';
import type { YosysDesign } from './yosys-json';

async function elaborate(files: Record<string, string>): Promise<YosysDesign> {
  const out = (await runYosys(yosysArgs(Object.keys(files)), files, {
    stdout: () => {},
    stderr: () => {},
  })) as Record<string, string | Uint8Array>;
  const raw = out[JSON_OUT];
  return JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
}

describe('helpers', () => {
  it('parses src attributes', () => {
    expect(parseSrc('a.v:7.7-7.52|a.v:9.1-10.3')).toEqual([
      { file: 'a.v', startLine: 7, startCol: 7, endLine: 7, endCol: 52 },
      { file: 'a.v', startLine: 9, startCol: 1, endLine: 10, endCol: 3 },
    ]);
  });
  it('formats constants like a designer', () => {
    expect(formatConst(['0', '1', '0', '0'])).toBe("4'd2");
    expect(formatConst(['1'])).toBe("1'b1");
    expect(formatConst(['x', '1'])).toBe("2'b1x");
  });
});

describe('auction demo pipeline', () => {
  it('elaborates, builds IR, diagram and layout', async () => {
    const json = await elaborate({ [AUCTION_FILE]: AUCTION_SOURCE });
    const design = buildDesign(json, { [AUCTION_FILE]: AUCTION_SOURCE });
    expect(design.top).toBe('auction_top');
    const h = buildHierarchy(design);
    expect(h.children.map((c) => c.instance).sort()).toEqual(
      ['u_board', 'u_check_a', 'u_check_b', 'u_max', 'u_result', 'u_score'].sort(),
    );

    const top = buildDiagram(design, design.top);
    const instances = top.nodes.filter((n) => n.kind === 'instance');
    expect(instances).toHaveLength(6);
    // budget fans out to both bid checkers as a full 4-bit bus.
    const budgetEdges = top.edges.filter((e) => e.source.node === 'in:budget');
    expect(budgetEdges).toHaveLength(2);
    expect(budgetEdges.every((e) => e.width === 4 && e.fullSource && !e.label)).toBe(true);

    // Stable IDs for anonymous cells come from the source expression.
    const sb = buildDiagram(design, 'score_calc', new Set());
    const add = sb.nodes.find((n) => n.cellType === '$add');
    expect(add?.id).toBe('cell:$add{{2\'b00, max_bid} + {bonus, 2\'b00}}');
    // Constant padding shows up as constant nodes.
    expect(sb.nodes.some((n) => n.kind === 'const' && n.label === "2'd0")).toBe(true);

    const layout = await layoutDiagram(top);
    expect(layout.width).toBeGreaterThan(100);
    for (const e of layout.edges) expect(e.points.length).toBeGreaterThanOrEqual(2);
    const inputs = layout.nodes.filter((n) => n.kind === 'input');
    const outputs = layout.nodes.filter((n) => n.kind === 'output');
    expect(Math.max(...inputs.map((n) => n.x))).toBeLessThan(Math.min(...outputs.map((n) => n.x)));
  }, 60_000);
});

describe('semantic transforms', () => {
  it('rewrites decoders, zero MUXes and zero padding', async () => {
    const json = await elaborate({ [AUCTION_FILE]: AUCTION_SOURCE });
    const design = buildDesign(json, { [AUCTION_FILE]: AUCTION_SOURCE });

    // 2'd1 << winner -> decoder; any_valid ? dec : 0 -> AND
    const rd = buildDiagram(design, 'result_decode');
    const dec = rd.nodes.find((n) => n.cellType === 'dc:decoder');
    expect(dec?.attrs).toEqual({ inputs: 1, outputs: 2 });
    expect(rd.nodes.some((n) => n.cellType === '$shl')).toBe(false);
    const and = rd.nodes.find((n) => n.cellType === 'dc:and');
    expect(and?.attrs?.invertB).toBe(false);
    expect(rd.nodes.some((n) => n.cellType === '$mux')).toBe(false);
    // The rewritten cell keeps the stable ID of the cell it replaced.
    const plain = buildDiagram(design, 'result_decode', new Set());
    expect(plain.nodes.map((n) => n.id)).toContain(dec!.id);

    // {2'b00, max_bid} + {bonus, 2'b00}: no concatenation bars, a x4 label instead.
    const sc = buildDiagram(design, 'score_calc');
    expect(sc.nodes.some((n) => n.kind === 'join' || n.kind === 'const')).toBe(false);
    expect(sc.edges.find((e) => e.source.node === 'in:bonus')?.label).toBe('×4');
    expect(sc.edges.find((e) => e.source.node === 'in:max_bid')?.label).toBeUndefined();
    const raw = buildDiagram(design, 'score_calc', new Set());
    expect(raw.nodes.filter((n) => n.kind === 'join')).toHaveLength(2);
  }, 60_000);

  it('draws an inverted enable when the MUX passes data on select = 0', async () => {
    const src = 'module m(input [3:0] a, input s, output [3:0] y); assign y = s ? 4\'d0 : a; endmodule';
    const json = await elaborate({ 'm.v': src });
    const d = buildDiagram(buildDesign(json, { 'm.v': src }), 'm');
    const and = d.nodes.find((n) => n.cellType === 'dc:and');
    expect(and?.attrs?.invertB).toBe(true);
  }, 60_000);
});
