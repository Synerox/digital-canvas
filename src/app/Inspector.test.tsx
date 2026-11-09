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

  it('shows how a pin is drawn, Label or Text, for a pin drawn by hand, an imported one, and the pins of a selection', () => {
    const marked = (html: string) => [...html.matchAll(/<button class="(on|)" aria-pressed="(true|false)" title="[^"]*">(Label|Text)<\/button>/g)].map((m) => `${m[3]}:${m[2]}`);
    // Imported, as Verilog draws it, and after it was set to text.
    expect(marked(inspect({ kind: 'input', label: 'bid' }))).toEqual(['Label:true', 'Text:false']);
    expect(inspect({ kind: 'output', label: 'y', attrs: { style: 'text' } })).toContain('<span>Show as</span>');
    expect(marked(inspect({ kind: 'output', label: 'y', attrs: { style: 'text' } }))).toEqual(['Label:false', 'Text:true']);
    // Not for what is no pin.
    expect(inspect({ kind: 'const', label: "4'd0" })).not.toContain('Show as');
    // Drawn by hand: in place of a "style" field, and for a selection with pins (the style they all have is marked).
    const nodes = [
      newUserNode('u:1', 'input', { name: 'a' }),
      { ...newUserNode('u:2', 'output', { name: 'y' }), params: { width: 1, style: 'text' as const } },
      newUserNode('u:3', 'and'),
    ];
    const edits = { ...emptyEdits(), nodes, next: 4 };
    const netlist = effectiveDiagram('d', undefined, edits, () => undefined);
    const layout: LayoutResult = {
      module: 'd',
      width: 100,
      height: 100,
      nodes: netlist.nodes.map((n) => ({ ...n, x: 0, y: 0, width: 40, height: 20, ports: n.ports.map((p) => ({ ...p, x: 0, y: 0 })) })),
      edges: [],
    };
    const show = (ids: string[]) =>
      render({ files: {}, layout, netlist, sheet: 'd:d', path: [{ instance: 'd', module: 'd', drawn: true }], doc: { drawn: ['d'], sheets: { 'd:d': edits } }, selection: new Set(ids) });
    expect(marked(show(['u:1']))).toEqual(['Label:true', 'Text:false']);
    expect(show(['u:1']).match(/Show as/g)).toHaveLength(2); // the field's name, and its group's
    expect(show(['u:1'])).toContain('Width (bits)');
    expect(marked(show(['u:2']))).toEqual(['Label:false', 'Text:true']);
    expect(show(['u:3'])).not.toContain('Show as');
    expect(show(['u:1', 'u:2', 'u:3'])).toContain('<span>Show 2 pins as</span>');
    expect(marked(show(['u:1', 'u:2', 'u:3']))).toEqual(['Label:false', 'Text:false']);
    expect(marked(show(['u:2', 'u:3']))).toEqual(['Label:false', 'Text:true']);
    expect(show(['u:2', 'u:3'])).toContain('<span>Show 1 pin as</span>');
    expect(show(['u:3', 'u:1'].concat(['w:9']))).toContain('Show 1 pin as');
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
