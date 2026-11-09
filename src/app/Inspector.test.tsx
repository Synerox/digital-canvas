import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Diagram } from '../core/diagram';
import type { LNode, LayoutResult } from '../layout/elk-layout';
import { checkSheet } from '../editor/check';
import { emptyDoc, emptyEdits } from '../editor/doc';
import { effectiveDiagram } from '../editor/sheet';
import { newUserNode } from '../editor/symbols';
import { Inspector } from './Inspector';
import { useStore } from './store';

/** An open Verilog file the sheet comes from. */
const files = { 'a.v': Array.from({ length: 60 }, (_, i) => `// line ${i + 1}`).join('\n') };

/** Render the Inspector for a state (on the server it reads the store's initial state, the server snapshot of useSyncExternalStore). */
function render(state: object): string {
  Object.assign(useStore.getInitialState(), state);
  return renderToStaticMarkup(<Inspector />);
}

/** The Inspector's text for one selected imported symbol. */
function inspect(node: Partial<LNode>): string {
  const n: LNode = { id: 'n', kind: 'cell', label: 'x', ports: [], x: 0, y: 0, width: 40, height: 40, ...node };
  const layout: LayoutResult = { module: 'm', width: 100, height: 100, nodes: [n], edges: [] };
  return render({ files, layout, netlist: { module: 'm', nodes: [n], edges: [] }, sheet: 'v:blocks:m', path: [{ instance: 'm', module: 'm' }], doc: emptyDoc(), selection: new Set(['n']) });
}

describe('Inspector', () => {
  it('says an imported symbol comes from Verilog, and nothing about Verilog lines (nothing maps symbols to them)', () => {
    for (const html of [inspect({ kind: 'instance', label: 'result_valid' }), inspect({})]) {
      expect(html).toContain('From Verilog.</p>');
      expect(html).not.toMatch(/\bline|Source/);
    }
  });

  it("does not offer to rename an imported constant (its label is its value)", () => {
    const html = inspect({ kind: 'const', label: "4'd0" });
    expect(html).toContain('Constant');
    expect(html).not.toContain('<input');
    expect(html).toContain('You can move or delete it here."');
    expect(inspect({ kind: 'input', label: 'bid' })).toContain('<input');
  });

  it('says why a wire is flagged: its width, or a second wire into the same input', () => {
    const nodes = [newUserNode('u:1', 'input', { name: 'a' }), newUserNode('u:2', 'input', { name: 'b', params: { width: 4 } }), newUserNode('u:3', 'and')];
    const wire = (id: string, from: string, to: string) => ({ id, source: { node: from, port: `${from}.out` }, target: { node: 'u:3', port: `u:3.${to}` } });
    const edits = { ...emptyEdits(), nodes, edges: [wire('w:4', 'u:1', 'A'), wire('w:5', 'u:1', 'B'), wire('w:6', 'u:2', 'B')], next: 7 };
    const netlist: Diagram = effectiveDiagram('d', undefined, edits, () => undefined);
    const layout: LayoutResult = {
      module: 'd',
      width: 100,
      height: 100,
      nodes: netlist.nodes.map((n) => ({ ...n, x: 0, y: 0, width: 40, height: 40, ports: n.ports.map((p) => ({ ...p, x: 0, y: 0 })) })),
      edges: netlist.edges.map((e) => ({ ...e, points: [], junctions: [] })),
    };
    const show = (id: string) =>
      render({
        files: {},
        layout,
        netlist,
        issues: checkSheet(netlist),
        sheet: 'd:d',
        path: [{ instance: 'd', module: 'd', drawn: true }],
        doc: { drawn: ['d'], sheets: { 'd:d': edits } },
        selection: new Set([id]),
      });
    expect(show('w:4')).toContain('1 bit</p>');
    expect(show('w:5')).toContain('1 bit · its input has another driver</p>');
    expect(show('w:6')).toContain('4 bits · does not match the input it feeds · its input has another driver</p>');
  });
});
