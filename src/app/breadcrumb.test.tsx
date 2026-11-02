import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { IRCell, IRDesign, IRModule } from '../core/ir';
import { emptyEdits } from '../editor/doc';
import { Breadcrumb, HierarchyTree } from './Panels';
import { useStore } from './store';

const mod = (name: string, cells: IRCell[] = [], extra: Partial<IRModule> = {}): IRModule => ({
  name,
  displayName: name,
  isTop: false,
  ports: [],
  cells,
  nets: [],
  src: [],
  ...extra,
});
const instance = (id: string, name: string, type: string): IRCell => ({
  id,
  name,
  hidden: false,
  type,
  isInstance: true,
  moduleName: type,
  parameters: {},
  directions: {},
  connections: {},
  src: [],
});

describe('Breadcrumb', () => {
  it('names a renamed automatic block and a renamed instance as the Hierarchy does (H10)', () => {
    const view: IRDesign = {
      top: 'uart_top',
      modules: {
        uart_top: mod('uart_top', [instance('cell_1', 'u_fsm', 'uart_tx_fsm')], { isTop: true }),
        uart_tx_fsm: mod('uart_tx_fsm', [instance('auto:state', 'state', 'uart_tx_fsm/state'), instance('auto:busy', 'busy', 'uart_tx_fsm/busy')]),
        'uart_tx_fsm/state': mod('uart_tx_fsm/state', [], { displayName: 'state', auto: { parent: 'uart_tx_fsm' } }),
        'uart_tx_fsm/busy': mod('uart_tx_fsm/busy', [], { displayName: 'busy', auto: { parent: 'uart_tx_fsm' } }),
      },
    };
    // The block `state` renamed on its parent's sheet, and so is the instance u_fsm on the top's.
    const doc = {
      drawn: [],
      sheets: {
        'v:blocks:uart_top': { ...emptyEdits(), labels: { 'cell:cell_1': 'u_tx' } },
        'v:blocks:uart_tx_fsm': { ...emptyEdits(), labels: { 'cell:auto:state': 'fsm_state' } },
      },
    };
    const top = { instance: 'uart_top', module: 'uart_top' };
    const fsm = { instance: 'u_fsm', module: 'uart_tx_fsm' };
    const hierarchy = {
      instance: 'uart_top',
      module: 'uart_top',
      children: [
        {
          ...fsm,
          children: [
            { instance: 'state', module: 'uart_tx_fsm/state', children: [] },
            { instance: 'busy', module: 'uart_tx_fsm/busy', children: [] },
          ],
        },
      ],
    };
    // On the server the panels read the store's initial state (the server snapshot of useSyncExternalStore).
    const state = useStore.getInitialState();
    Object.assign(state, { viewMode: 'blocks', design: view, blockDesign: view, doc, hierarchy });
    const crumbs = (path: { instance: string; module: string }[]) => {
      state.path = path;
      return [...renderToStaticMarkup(<Breadcrumb />).matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);
    };
    expect(crumbs([top, fsm, { instance: 'state', module: 'uart_tx_fsm/state' }])).toEqual(['uart_top', 'u_tx (uart_tx_fsm)', 'fsm_state']);
    // Not renamed: as the Verilog names it.
    expect(crumbs([top, fsm, { instance: 'busy', module: 'uart_tx_fsm/busy' }])).toEqual(['uart_top', 'u_tx (uart_tx_fsm)', 'busy']);
    // The Hierarchy shows the same names.
    const tree = renderToStaticMarkup(<HierarchyTree />);
    expect(tree).toContain('>fsm_state</span>');
    expect(tree).toContain('>u_tx</span>');
  });
});
