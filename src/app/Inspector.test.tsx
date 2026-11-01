import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SrcRange } from '../core/ir';
import type { LNode, LayoutResult } from '../layout/elk-layout';
import { emptyDoc } from '../editor/doc';
import { Inspector } from './Inspector';
import { useStore } from './store';

const src = (startLine: number, endLine = startLine): SrcRange => ({ file: 'a.v', startLine, startCol: 1, endLine, endCol: 1 });

/** The Inspector's text for one selected imported symbol. */
function inspect(node: Partial<LNode>): string {
  const n: LNode = { id: 'n', kind: 'cell', label: 'x', ports: [], src: [], x: 0, y: 0, width: 40, height: 40, ...node };
  const layout: LayoutResult = { module: 'm', width: 100, height: 100, nodes: [n], edges: [] };
  const state = { layout, netlist: { module: 'm', nodes: [n], edges: [] }, sheet: 'v:blocks:m', path: [{ instance: 'm', module: 'm' }], doc: emptyDoc(), selection: new Set(['n']) };
  // Rendering on the server reads the store's initial state (the server snapshot of useSyncExternalStore).
  Object.assign(useStore.getInitialState(), state);
  return renderToStaticMarkup(<Inspector onExportVerilog={() => {}} />);
}

describe('Inspector', () => {
  it('lists each highlighted Verilog line once, in order, with runs as ranges', () => {
    const html = inspect({ kind: 'instance', label: 'result_valid', src: [src(46), src(31), src(33), src(31), src(35, 38), src(39), src(40, 48), src(46)] });
    expect(html).toContain('Verilog lines 31, 33, 35–48 are highlighted in Source.');
    expect(inspect({ src: [src(7), src(7)] })).toContain('Verilog line 7 is highlighted in Source.');
  });

  it("does not offer to rename an imported constant (its label is its value)", () => {
    const html = inspect({ kind: 'const', label: "4'd0" });
    expect(html).toContain('Constant');
    expect(html).not.toContain('<input');
    expect(html).toContain('You can move or delete it here.');
    expect(inspect({ kind: 'input', label: 'bid' })).toContain('<input');
  });
});
