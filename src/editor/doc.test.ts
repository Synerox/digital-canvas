import { describe, expect, it } from 'vitest';
import { buildDiagram } from '../core/diagram';
import { design } from '../core/test-utils';
import { layoutDiagram } from '../layout/elk-layout';
import { type SavedFile, type SheetEdits, emptyEdits, parseEdits, parseSavedFile } from './doc';
import { effectiveDiagram, toDrawing } from './sheet';
import type { InterfaceOf } from './symbols';
import { diagramToVerilog } from './verilog-export';

const noModules: InterfaceOf = () => undefined;

/** Save a drawing as a file and open it again, the way Save and Open (and the autosave) do. */
function reopen(name: string, e: SheetEdits): SheetEdits {
  const f: SavedFile = {
    format: 'digital-canvas',
    version: 1,
    files: {},
    rules: [],
    viewMode: 'blocks',
    theme: 'report',
    doc: { drawn: [name], sheets: { [`d:${name}`]: e } },
    path: [{ instance: name, module: name, drawn: true }],
  };
  return parseSavedFile(JSON.stringify(f)).doc.sheets[`d:${name}`];
}

const exportOf = (name: string, e: SheetEdits) => diagramToVerilog(effectiveDiagram(name, undefined, e, noModules), name);

describe('frozen copies of imported cells in saved files', () => {
  it('keep the Yosys parameters, so a negedge, reset-value or signed cell exports the same after reopening', async () => {
    const src = `module t(input clk, input rst, input [3:0] d, input signed [3:0] a, input signed [3:0] b, output reg [3:0] q, output lt);
  always @(negedge clk or posedge rst) if (rst) q <= 4'd5; else q <= d;
  assign lt = a < b;
endmodule
`;
    const base = buildDiagram(await design({ 't.v': src }), 't');
    const drawing = toDrawing(base, await layoutDiagram(base), emptyEdits(), noModules);
    expect(drawing.nodes.filter((u) => u.raw?.params).length).toBeGreaterThanOrEqual(2);
    const before = exportOf('t_drawing', drawing);
    expect(before.code).toContain('negedge clk');
    expect(before.code).toContain("4'd5");
    expect(before.code).toContain('$signed(a)');

    const opened = reopen('t_drawing', drawing);
    for (const u of drawing.nodes) expect(opened.nodes.find((x) => x.id === u.id)?.raw?.params, u.id).toEqual(u.raw?.params);
    expect(exportOf('t_drawing', opened)).toEqual(before);
    // The sheet's edits alone (as parseEdits reads them) keep them too.
    expect(exportOf('t_drawing', parseEdits(JSON.parse(JSON.stringify(drawing))))).toEqual(before);
  });

  it('keep only parameters written as Yosys writes them (binary, MSB first)', () => {
    const raw = (params: unknown) => ({
      id: 'u:1',
      sym: 'raw',
      params: {},
      raw: { kind: 'cell', label: 'DFF', cellType: '$adff', ports: [], src: [], params },
    });
    const parse = (params: unknown) => parseEdits({ nodes: [raw(params)] }).nodes[0].raw?.params;
    expect(parse({ CLK_POLARITY: '0', ARST_VALUE: '0101', A_SIGNED: 1, B_SIGNED: true, SRST_VALUE: 'abc', EN_POLARITY: '', X: null })).toEqual({
      CLK_POLARITY: '0',
      ARST_VALUE: '0101',
    });
    expect(parse({ ARST_VALUE: '1x0z' })).toEqual({ ARST_VALUE: '1x0z' });
    expect(parse({ A_SIGNED: 1 })).toBeUndefined();
    expect(parse('0')).toBeUndefined();
    expect(parse([['CLK_POLARITY', '0']])).toBeUndefined();
  });

  it('bound their source ranges, so the Inspector and code panel never count through huge ones', () => {
    const range = (startLine: number, endLine: number, startCol = 1, endCol = 5) => ({ file: 'a.v', startLine, startCol, endLine, endCol });
    const src = [range(3, 4), range(7, 2), range(-5, 1.5, -3, 2.7), range(1e9, 1e9), range(1e300, 1e300 + 2), range(1e7, 1e9), range(1, 2e7), range(9, 9)];
    const node = { id: 'u:1', sym: 'raw', params: {}, raw: { kind: 'cell', label: '&', cellType: '$and', ports: [], src } };
    const out = parseEdits({ nodes: [node] }).nodes[0].raw!.src;
    // A plain range is kept as it is.
    expect(out[0]).toEqual(range(3, 4));
    let lines = 0;
    for (const r of out) {
      for (const v of [r.startLine, r.endLine, r.startCol, r.endCol]) expect(Number.isInteger(v) && v >= 1).toBe(true);
      expect(r.endLine).toBeGreaterThanOrEqual(r.startLine);
      expect(r.endLine).toBeLessThanOrEqual(10_000_000);
      lines += r.endLine - r.startLine + 1;
    }
    expect(lines).toBeLessThanOrEqual(100_000);
    // A range that ends before it starts marks its first line; a line before 1 is line 1.
    expect(out).toContainEqual(range(7, 7));
    expect(out).toContainEqual(range(1, 1, 1, 2));
    // Nothing points past the last line any file could have.
    expect(out.some((r) => r.startLine >= 1e9)).toBe(false);
  });
});

describe('work saved before the grid', () => {
  it('puts the symbols of an older save on the grid', () => {
    const e = parseEdits({ pos: { 'cell:a': { x: 103.4, y: 47 }, 'u:1': { x: 255, y: -14.9 } } });
    expect(e.pos).toEqual({ 'cell:a': { x: 100, y: 50 }, 'u:1': { x: 260, y: -10 } });
  });

  it('keeps the components of the library, and drops a bad one', () => {
    const f = parseSavedFile(
      JSON.stringify({
        format: 'digital-canvas',
        version: 1,
        files: {},
        doc: { sheets: {}, drawn: [], components: [{ name: 'and5', base: 'and', params: { inputs: 5 } }, { name: 'x', base: 'nope' }] },
      }),
    );
    expect(f.doc.components).toEqual([{ name: 'and5', base: 'and', params: { inputs: 5 } }]);
    expect(parseSavedFile(JSON.stringify({ format: 'digital-canvas', version: 1, doc: { sheets: {}, drawn: [] } })).doc.components).toBeUndefined();
  });
});
