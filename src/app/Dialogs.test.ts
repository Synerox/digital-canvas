import { describe, expect, it } from 'vitest';
import { emptyDoc, emptyEdits } from '../editor/doc';
import { planImport } from './Dialogs';

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
