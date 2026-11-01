import { describe, expect, it } from 'vitest';
import { buildDiagram } from '../core/diagram';
import { withAutoBlocks } from '../core/partition';
import { design, elaborate } from '../core/test-utils';
import { emptyDoc, emptyEdits, type PathEntry, type SheetEdits, sheetKey } from '../editor/doc';
import { effectiveDiagram } from '../editor/sheet';
import { newUserNode } from '../editor/symbols';
import { AUCTION_FILE, AUCTION_SOURCE } from '../examples/auction';
import { FRUIT_FILE, FRUIT_SOURCE } from '../examples/fruit-battle';
import { exportCurrent } from './Dialogs';
import { useStore } from './store';

const T = 60_000;
const fruit = { [FRUIT_FILE]: FRUIT_SOURCE };
const auction = { [AUCTION_FILE]: AUCTION_SOURCE };

/** Put a design on screen in block view, the way the store does after elaborating it. */
async function show(files: Record<string, string>, path: PathEntry[], drawings: Record<string, SheetEdits> = {}) {
  const d = await design(files);
  const blockDesign = withAutoBlocks(d, files);
  const last = path[path.length - 1];
  const doc = { ...emptyDoc(), drawn: Object.keys(drawings), sheets: Object.fromEntries(Object.entries(drawings).map(([k, e]) => [`d:${k}`, e])) };
  useStore.setState({ files, design: d, blockDesign, viewMode: 'blocks', path, doc, sheet: sheetKey(last, 'blocks') });
  const s = useStore.getState();
  const base = last.drawn ? undefined : buildDiagram(blockDesign, last.module, s.rules);
  useStore.setState({ netlist: effectiveDiagram(last.module, base, doc.sheets[`d:${last.module}`] ?? emptyEdits(), s.interfaceOf) });
  return blockDesign;
}

/** Elaborate the export the way the dialog's check does, and return the checked module. */
async function check() {
  const out = exportCurrent();
  const json = await elaborate(out.check.files, out.check.top);
  return { out, mod: json.modules[out.check.top] };
}

/** A drawing with one block of `module`, its inputs and outputs wired to pins. */
function drawingWithBlock(module: string): SheetEdits {
  const block = newUserNode('u:1', 'block', { name: 'b' });
  block.params = { module };
  return { ...emptyEdits(), nodes: [block], next: 2 };
}

describe('Export Verilog', () => {
  it(
    'defines the automatic blocks a block diagram instantiates, so the export elaborates on its own',
    async () => {
      const bd = await show(fruit, [{ instance: 'top', module: 'top' }]);
      const autos = Object.keys(bd.modules).filter((m) => bd.modules[m].auto);
      expect(autos.length).toBeGreaterThan(2);
      const { out, mod } = await check();
      for (const a of autos) expect(out.code).toMatch(new RegExp(`^module ${a.replace('/', '_')} \\(`, 'm'));
      // Sub-modules first; the sheet's own module last.
      expect(out.code.trimEnd().split('\n').filter((l) => l.startsWith('module ')).pop()).toBe('module top (');
      expect(Object.keys(out.check.files)).toEqual(['top.v']);
      expect(Object.keys(mod.ports).sort()).toEqual(bd.modules.top.ports.map((p) => p.name).sort());
    },
    T,
  );

  it(
    "checks a Verilog sheet with the user's files, under a name that does not clash with its own module",
    async () => {
      await show(auction, [{ instance: 'auction_top', module: 'auction_top' }]);
      const { out, mod } = await check();
      expect(out.name).toBe('auction_top');
      expect(out.code).toMatch(/^module auction_top \(/m);
      expect(out.check.top).not.toBe('auction_top');
      expect(out.check.files[AUCTION_FILE]).toBe(AUCTION_SOURCE);
      expect(Object.keys(mod.cells).length).toBeGreaterThan(3);
    },
    T,
  );

  it(
    'writes an automatic block under the name its parent instantiates',
    async () => {
      const bd = await show(fruit, [{ instance: 'top', module: 'top' }]);
      const cell = bd.modules.top.cells.find((c) => bd.modules[c.type]?.auto)!;
      await show(fruit, [
        { instance: 'top', module: 'top' },
        { instance: cell.name, module: cell.type },
      ]);
      const { out } = await check();
      expect(out.name).toBe(cell.type.replace('/', '_'));
      expect(out.code).toMatch(new RegExp(`^module ${out.name} \\(`, 'm'));
      expect(out.check.top).toBe(out.name);
    },
    T,
  );

  it(
    'defines an automatic block that a drawing uses as a block',
    async () => {
      const bd = await design(fruit).then((d) => withAutoBlocks(d, fruit));
      const auto = Object.keys(bd.modules).find((m) => bd.modules[m].auto)!;
      await show(fruit, [{ instance: 'mine', module: 'mine', drawn: true }], { mine: drawingWithBlock(auto) });
      const { out } = await check();
      expect(out.code).toMatch(new RegExp(`^module ${auto.replace('/', '_')} \\(`, 'm'));
      expect(out.code).toMatch(new RegExp(`^  ${auto.replace('/', '_')} b \\(`, 'm'));
    },
    T,
  );

  it(
    'names the module of a drawing called by a keyword as the code does',
    async () => {
      const a = newUserNode('u:1', 'input', { name: 'a' });
      const y = newUserNode('u:2', 'output', { name: 'y' });
      const e: SheetEdits = { ...emptyEdits(), nodes: [a, y], edges: [{ id: 'w:3', source: { node: 'u:1', port: 'u:1.out' }, target: { node: 'u:2', port: 'u:2.in' } }], next: 4 };
      await show(fruit, [{ instance: 'edge', module: 'edge', drawn: true }], { edge: e });
      const { out, mod } = await check();
      expect(out.name).toBe('edge_');
      expect(out.code).toMatch(/^module edge_ \(/m);
      expect(Object.keys(mod.ports).sort()).toEqual(['a', 'y']);
    },
    T,
  );

  it(
    'warns about a block whose module nothing defines',
    async () => {
      await show(fruit, [{ instance: 'mine', module: 'mine', drawn: true }], { mine: drawingWithBlock('gone') });
      const out = exportCurrent();
      expect(out.warnings.some((w) => w.includes('gone') && w.includes('not defined'))).toBe(true);
    },
    T,
  );
});
