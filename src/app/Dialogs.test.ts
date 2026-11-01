import { describe, expect, it } from 'vitest';
import { buildDiagram } from '../core/diagram';
import { withAutoBlocks } from '../core/partition';
import { design, elaborate } from '../core/test-utils';
import { emptyDoc, emptyEdits, type PathEntry, type SheetEdits, sheetKey } from '../editor/doc';
import { effectiveDiagram } from '../editor/sheet';
import { newUserNode } from '../editor/symbols';
import { AUCTION_FILE, AUCTION_SOURCE } from '../examples/auction';
import { FRUIT_FILE, FRUIT_SOURCE } from '../examples/fruit-battle';
import { exportCurrent, planImport } from './Dialogs';
import { useStore } from './store';

const T = 60_000;
const fruit = { [FRUIT_FILE]: FRUIT_SOURCE };
const auction = { [AUCTION_FILE]: AUCTION_SOURCE };

/**
 * Put a design on screen in block view, the way the store does after elaborating it.
 * `sheets`: edits of Verilog sheets, by module.
 */
async function show(files: Record<string, string>, path: PathEntry[], drawings: Record<string, SheetEdits> = {}, sheets: Record<string, SheetEdits> = {}) {
  const d = await design(files);
  const blockDesign = withAutoBlocks(d, files);
  const last = path[path.length - 1];
  const doc = {
    ...emptyDoc(),
    drawn: Object.keys(drawings),
    sheets: {
      ...Object.fromEntries(Object.entries(drawings).map(([k, e]) => [`d:${k}`, e])),
      ...Object.fromEntries(Object.entries(sheets).map(([m, e]) => [sheetKey({ instance: m, module: m }, 'blocks'), e])),
    },
  };
  useStore.setState({ files, design: d, blockDesign, viewMode: 'blocks', path, doc, sheet: sheetKey(last, 'blocks') });
  const s = useStore.getState();
  const base = last.drawn ? undefined : buildDiagram(blockDesign, last.module, s.rules);
  useStore.setState({ netlist: effectiveDiagram(last.module, base, doc.sheets[s.sheet] ?? emptyEdits(), s.interfaceOf) });
  return blockDesign;
}

/** The text of `module name ( … endmodule` in the code. */
function moduleText(code: string, name: string): string {
  const i = code.search(new RegExp(`^module ${name.replace(/\$/g, '\\$')} \\(`, 'm'));
  return i < 0 ? '' : code.slice(i, code.indexOf('endmodule', i));
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
  it(
    "writes an automatic block with the ports its instances connect, whatever was done to the pins on its sheet",
    async () => {
      const bd = await design(fruit).then((d) => withAutoBlocks(d, fruit));
      const auto = Object.keys(bd.modules).find((m) => bd.modules[m].auto && bd.modules[m].ports.length >= 3)!;
      const base = buildDiagram(bd, auto, useStore.getState().rules);
      const pins = base.nodes.filter((n) => n.kind === 'input' || n.kind === 'output');
      const [renamed, deleted] = pins;
      const extra = newUserNode('u:1', 'input', { name: 'extra' });
      const edits: SheetEdits = { ...emptyEdits(), labels: { [renamed.id]: 'rng_seed' }, hidden: [deleted.id], nodes: [extra], next: 2 };
      await show(fruit, [{ instance: 'top', module: 'top' }], {}, { [auto]: edits });
      const { out, mod } = await check();
      expect(Object.keys(mod.ports).sort()).toEqual(bd.modules.top.ports.map((p) => p.name).sort());
      const block = moduleText(out.code, auto.replace('/', '_'));
      for (const p of bd.modules[auto].ports) expect(block).toMatch(new RegExp(`^  (input|output) wire (\\[\\d+:0\\] )?${p.name}\\b`, 'm'));
      expect(block).not.toMatch(/rng_seed|extra/);
      const note = out.warnings.find((w) => w.startsWith(`${auto}: its instances connect`));
      expect(note).toContain(`rng_seed keeps its Verilog name ${renamed.label}`);
      expect(note).toContain(`the deleted ${deleted.label} is written all the same`);
      expect(note).toContain('extra, drawn on its sheet, is left out');

      // A drawing uses the block the same way.
      await show(fruit, [{ instance: 'mine', module: 'mine', drawn: true }], { mine: drawingWithBlock(auto) }, { [auto]: edits });
      await check();
      // And the block's own sheet is written as its parents' exports write it.
      await show(fruit, [{ instance: 'top', module: 'top' }, { instance: auto, module: auto }], {}, { [auto]: edits });
      const own = await check();
      expect(Object.keys(own.mod.ports).sort()).toEqual(bd.modules[auto].ports.map((p) => p.name).sort());
      expect(moduleText(own.out.code, own.out.name)).toBe(block);
    },
    T,
  );

  it(
    'names an automatic block apart from a drawing that has its Verilog name',
    async () => {
      const bd = await design(fruit).then((d) => withAutoBlocks(d, fruit));
      const auto = Object.keys(bd.modules).find((m) => bd.modules[m].auto)!;
      const clash = auto.replace('/', '_');
      await show(fruit, [{ instance: clash, module: clash, drawn: true }], { [clash]: drawingWithBlock(auto) });
      const { out } = await check();
      expect(out.name).toBe(clash);
      // The drawing has no pins: `module name;`.
      expect(out.code.match(new RegExp(`^module ${clash}\\b`, 'gm'))).toHaveLength(1);
      expect(out.code).toMatch(new RegExp(`^module ${clash}_2 \\(`, 'm'));
      expect(out.code).toMatch(new RegExp(`^  ${clash}_2 b \\(`, 'm'));
      expect(out.warnings).toContain(`${auto}: written as module ${clash}_2, as another module is called ${clash}`);
    },
    T,
  );

  it(
    'defines the modules Yosys derives from a parameterized module, so the export elaborates',
    async () => {
      const files = {
        'p.v': [
          'module sub #(parameter W = 4) (input [W-1:0] a, output [W-1:0] y);',
          '  assign y = ~a;',
          'endmodule',
          'module ptop (input [7:0] a, output [7:0] y, output [3:0] z);',
          '  sub #(.W(8)) u8 (.a(a), .y(y));',
          '  sub u4 (.a(a[3:0]), .y(z));',
          'endmodule',
        ].join('\n'),
      };
      await show(files, [{ instance: 'ptop', module: 'ptop' }]);
      const derived = Object.keys(useStore.getState().design!.modules).find((m) => m.startsWith('$paramod'))!;
      const { out, mod } = await check();
      expect(out.warnings.join('\n')).not.toMatch(/not defined/);
      const as = derived.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+/, '');
      expect(out.code).toMatch(new RegExp(`^module ${as} \\(`, 'm'));
      expect(out.code).toMatch(new RegExp(`^  ${as} u8 \\(`, 'm'));
      expect(out.code).toContain(`// sub as Yosys elaborated it with the parameters of ${derived}\n`);
      expect(Object.keys(mod.cells)).toHaveLength(2);

      // A drawing with a block of the derived module, as Copy to new drawing makes it.
      await show(files, [{ instance: 'mine', module: 'mine', drawn: true }], { mine: drawingWithBlock(derived) });
      const copy = await check();
      expect(copy.out.code).toMatch(new RegExp(`^module ${as} \\(`, 'm'));
    },
    T,
  );
});

describe('Import Verilog', () => {
  const open = { 'auction.v': 'module a(input x, output y); assign y = x; endmodule\nmodule b(input x, output y); assign y = ~x; endmodule\n' };

  it('replaces an open file whose modules the code all declares, whatever the new file is called', () => {
    const code = 'module a(input x, output y); assign y = !x; endmodule\nmodule b(input x, output y); assign y = x; endmodule\n';
    const p = planImport(open, code, 'auction_v2.v', false);
    expect(p.replaced).toEqual(['auction.v']);
    // A new version of the design: the store replaces the file and keeps the edits.
    expect(p.apply).toEqual({ files: { 'auction_v2.v': code }, replace: false, newVersion: true });
    // Unnamed, it takes the name of the file it replaces.
    expect(planImport(open, code, '', false)).toMatchObject({ fname: 'auction.v', changed: ['auction.v'], apply: { files: { 'auction.v': code } } });
  });

  it('cuts a module out of an open file that declares more modules than the code, and says so', () => {
    const code = 'module b(input x, output y); assign y = x; endmodule\n';
    const named = planImport(open, code, 'b.v', false);
    expect(named).toMatchObject({ replaced: [], changed: ['auction.v'], trimmed: [{ file: 'auction.v', modules: ['b'] }], clashes: [] });
    expect(named.apply).toEqual({ files: { 'b.v': code }, replace: false, newVersion: true });
    // Unnamed, it does not take the open file's name either (that would overwrite it), but its module's.
    expect(planImport(open, code, '', false)).toMatchObject({ fname: 'b.v', trimmed: [{ file: 'auction.v' }], apply: { files: { 'b.v': code } } });
  });

  it('says which modules an update of an open file under its own name drops', () => {
    const code = 'module b(input x, output y); assign y = x; endmodule\n';
    expect(planImport(open, code, 'auction.v', false)).toMatchObject({ changed: ['auction.v'], clashes: [], lost: ['a'] });
  });

  it('names unnamed code after its module, never after an open file it does not cover (F1)', () => {
    const counter = 'module counter(input clk, output reg [3:0] q); always @(posedge clk) q <= q + 1; endmodule\n';
    const mux = 'module mux2(input a, input b, input s, output y); assign y = s ? b : a; endmodule\n';
    const pasted = { 'pasted.v': counter };
    // A second paste does not overwrite the first.
    expect(planImport(pasted, mux, '', false)).toMatchObject({ fname: 'mux2.v', changed: [], lost: [], apply: { files: { 'mux2.v': mux } } });
    expect(planImport({ ...pasted, 'mux2.v': mux }, mux.replace('? b : a', '? a : b'), '', false).fname).toBe('mux2.v');
    expect(planImport({ ...pasted, 'mux2.v': counter }, mux, '', false).fname).toBe('mux2_2.v');
    // Named after the module the code is about (the one nothing in it instantiates).
    const top = `${mux}module top(input a, input b, input s, output y); mux2 m(.a(a), .b(b), .s(s), .y(y)); endmodule\n`;
    expect(planImport(pasted, top, '', false).fname).toBe('top.v');
    // Sharing a module with pasted.v: cut out of it, and pasted.v keeps the rest.
    const two = { 'pasted.v': `${counter}${mux}` };
    expect(planImport(two, top, '', false)).toMatchObject({ fname: 'top.v', changed: ['pasted.v'], trimmed: [{ file: 'pasted.v', modules: ['mux2'] }], lost: [] });
    // A new version of all its modules is still named after it.
    expect(planImport(pasted, counter.replace('+ 1', '+ 2'), '', false)).toMatchObject({ fname: 'pasted.v', changed: ['pasted.v'] });
    // No module at all.
    expect(planImport(pasted, '// nothing yet\n', '', false).fname).toBe('pasted_2.v');
  });

  it('says what Replace does: open another design, or new versions of files of the same names (F1, C5)', () => {
    const code = 'module top(input a, output y); assign y = a; endmodule\n';
    // Another design: the edits are put away with the files.
    expect(planImport(open, code, '', true)).toMatchObject({ fname: 'top.v', changed: [], closed: ['auction.v'], lost: [], apply: { files: { 'top.v': code }, replace: true } });
    // The same file name: a new version, which keeps the edits of the modules it declares.
    expect(planImport(open, code, 'auction.v', true)).toMatchObject({ changed: ['auction.v'], removed: [], replaced: [], closed: [], lost: ['a', 'b'] });
    // The open files it leaves out are said apart: their edits are not kept.
    expect(planImport({ ...open, 'more.v': 'module m(input x, output y); assign y = x; endmodule\n' }, code, 'auction.v', true)).toMatchObject({
      changed: ['auction.v'],
      removed: ['more.v'],
      lost: ['a', 'b', 'm'],
    });
  });

  it('says when the code brings back the edits put aside for a removed file of its name (F3)', () => {
    const code = 'module top(input a, output y); assign y = a; endmodule\n';
    const sheets = { 'v:blocks:top': { ...emptyEdits(), hidden: ['in:a'] } };
    const kept = { doc: emptyDoc(), putAside: { 'gone.v': sheets } };
    // The default name does not bring them back, and the dialog says which name does.
    expect(planImport(open, code, '', false, kept)).toMatchObject({ fname: 'top.v', restored: [], couldRestore: { file: 'gone.v', modules: ['top'], dropped: false } });
    // With Replace under another name, another design opens: they go (until Undo).
    expect(planImport({}, code, '', true, kept).couldRestore).toEqual({ file: 'gone.v', modules: ['top'], dropped: true });
    const named = planImport(open, code, 'gone.v', false, kept);
    expect(named).toMatchObject({ fname: 'gone.v', restored: ['top'] });
    expect(named.couldRestore).toBeUndefined();
    // With Replace, the name of a removed file makes it a new version too.
    expect(planImport(open, code, 'gone.v', true, kept)).toMatchObject({ closed: [], changed: [], removed: ['auction.v'], restored: ['top'] });
    // Not when the sheet has edits of its own now.
    expect(planImport(open, code, 'gone.v', false, { ...kept, doc: { drawn: [], sheets } }).restored).toEqual([]);
    // The default name is never that of a removed file.
    expect(planImport({}, code, '', false, { doc: emptyDoc(), putAside: { 'top.v': sheets } }).fname).toBe('top_2.v');
  });
});
