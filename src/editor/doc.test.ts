import { describe, expect, it } from 'vitest';
import { type Diagram, buildDiagram } from '../core/diagram';
import { design } from '../core/test-utils';
import { layoutDiagram } from '../layout/elk-layout';
import { type SavedFile, type SheetEdits, emptyEdits, parseEdits, parseSavedFile } from './doc';
import { effectiveDiagram, toDrawing } from './sheet';
import type { InterfaceOf } from './symbols';

const noModules: InterfaceOf = () => undefined;

/** Save a drawing as a file and open it again, the way Save and Open (and the autosave) do. */
function reopen(name: string, e: SheetEdits): SheetEdits {
  const f: SavedFile = {
    format: 'digital-canvas',
    version: 1,
    files: {},
    viewMode: 'blocks',
    doc: { drawn: [name], sheets: { [`d:${name}`]: e } },
    path: [{ instance: name, module: name, drawn: true }],
  };
  return parseSavedFile(JSON.stringify(f)).doc.sheets[`d:${name}`];
}

const effective = (name: string, e: SheetEdits) => effectiveDiagram(name, undefined, e, noModules);

/**
 * What a diagram computes, in an order the drawing does not change: each symbol's kind, pin name,
 * cell type, Yosys parameters, drawing hints and ports, and the ports each wire joins with the
 * bits it carries. Wire IDs, cell and wire labels and source ranges are left out.
 */
function logicOf(d: Diagram) {
  const nodes = d.nodes
    .map((n) => ({
      id: n.id,
      kind: n.kind,
      pin: n.kind === 'input' || n.kind === 'output' ? n.label : undefined,
      cellType: n.cellType,
      moduleName: n.moduleName,
      params: n.params,
      attrs: n.attrs,
      ports: n.ports.map((p) => ({ id: p.id, dir: p.dir, width: p.width, inout: p.inout })),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const edges = d.edges
    .map((x) => ({ from: x.source.port, to: x.target.port, width: x.width, fullSource: x.fullSource, bits: x.bits, shift: x.shift }))
    .sort((a, b) => `${a.from}>${a.to}`.localeCompare(`${b.from}>${b.to}`));
  return { nodes, edges };
}

describe('frozen copies of imported cells in saved files', () => {
  it('keep the Yosys parameters, so a negedge, reset-value or signed cell computes the same after reopening', async () => {
    const src = `module t(input clk, input rst, input [3:0] d, input signed [3:0] a, input signed [3:0] b, output reg [3:0] q, output lt);
  always @(negedge clk or posedge rst) if (rst) q <= 4'd5; else q <= d;
  assign lt = a < b;
endmodule
`;
    const base = buildDiagram(await design({ 't.v': src }), 't');
    const drawing = toDrawing(base, await layoutDiagram(base), emptyEdits(), noModules);
    expect(drawing.nodes.filter((u) => u.raw?.params).length).toBeGreaterThanOrEqual(2);
    const before = effective('t_drawing', drawing);
    const cell = (type: string) => before.nodes.find((n) => n.cellType === type)?.params;
    // The register clocks on the falling edge and resets to 5; the compare is signed.
    expect(cell('$adff')).toMatchObject({ CLK_POLARITY: '0', ARST_VALUE: '0101' });
    expect(cell('$lt')?.A_SIGNED).toMatch(/^0*1$/);
    expect(cell('$lt')?.B_SIGNED).toMatch(/^0*1$/);

    const opened = reopen('t_drawing', drawing);
    for (const u of drawing.nodes) expect(opened.nodes.find((x) => x.id === u.id)?.raw?.params, u.id).toEqual(u.raw?.params);
    expect(logicOf(effective('t_drawing', opened))).toEqual(logicOf(before));
    // The sheet's edits alone (as parseEdits reads them) keep them too.
    expect(logicOf(effective('t_drawing', parseEdits(JSON.parse(JSON.stringify(drawing)))))).toEqual(logicOf(before));
    // Without them the copies would be the library's rising-edge, reset-to-0, unsigned cells.
    const stripped: SheetEdits = { ...opened, nodes: opened.nodes.map((u) => (u.raw ? { ...u, raw: { ...u.raw, params: undefined } } : u)) };
    expect(logicOf(effective('t_drawing', stripped))).not.toEqual(logicOf(before));
  });

  it('keep only parameters written as Yosys writes them (binary, MSB first)', () => {
    const raw = (params: unknown) => ({
      id: 'u:1',
      sym: 'raw',
      params: {},
      raw: { kind: 'cell', label: 'DFF', cellType: '$adff', ports: [], params },
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

  it('drop the Verilog lines older files kept (nothing maps symbols to lines any more), whatever their ranges', () => {
    const range = (startLine: number, endLine: number) => ({ file: 'a.v', startLine, startCol: 1, endLine, endCol: 5 });
    for (const src of [[range(3, 4)], [range(1, 2e7), range(1e300, 1e300 + 2)], 'a.v:1', null]) {
      const node = { id: 'u:1', sym: 'raw', params: {}, raw: { kind: 'cell', label: '&', cellType: '$and', ports: [], src } };
      const raw = parseEdits({ nodes: [node] }).nodes[0].raw!;
      expect(raw).not.toHaveProperty('src');
      expect(raw).toMatchObject({ id: 'u:1', kind: 'cell', label: '&', cellType: '$and', ports: [] });
    }
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
