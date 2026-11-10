import { describe, expect, it } from 'vitest';
import {
  COMPONENTS_EXAMPLE,
  componentJson,
  componentSymbol,
  componentsJson,
  editComponent,
  followsPreset,
  componentStem,
  freeComponentName,
  loadComponents,
  parseComponents,
  parseSymbolJson,
  renamedPresets,
  settingsHint,
  symbolJson,
} from './components';
import { newUserNode, symbolNode } from './symbols';

describe('components in JSON', () => {
  it('reads presets and parts, with numbers or lists of pins', () => {
    const r = parseComponents(COMPONENTS_EXAMPLE);
    expect(r.error).toBeUndefined();
    const [and5, mux, alu, lut] = r.defs!;
    expect(and5).toEqual({ name: 'and5', title: 'AND (5 inputs)', base: 'and', params: { inputs: 5 } });
    expect(mux).toEqual({ name: 'mux4x8', title: 'MUX 4 × 8 bits', base: 'mux', params: { inputs: 4, width: 8 } });
    expect(alu.pins).toEqual([
      { name: 'a', dir: 'input', width: 8 },
      { name: 'b', dir: 'input', width: 8 },
      { name: 'op', dir: 'input', width: 3 },
      { name: 'y', dir: 'output', width: 8 },
      { name: 'zero', dir: 'output', width: 1 },
    ]);
    expect(lut.pins!.map((p) => p.name)).toEqual(['in0', 'in1', 'in2', 'in3', 'in4', 'in5', 'out']);
    // One object is a list of one; nothing is none.
    expect(parseComponents('{ "name": "x", "inputs": 2, "outputs": 2, "width": 4 }').defs![0].pins).toEqual([
      { name: 'in0', dir: 'input', width: 4 },
      { name: 'in1', dir: 'input', width: 4 },
      { name: 'out0', dir: 'output', width: 4 },
      { name: 'out1', dir: 'output', width: 4 },
    ]);
    expect(parseComponents('  ').defs).toEqual([]);
  });

  it('places a preset as its symbol, with as many input pins as it says', () => {
    const and5 = parseComponents('[{ "name": "and5", "base": "and", "inputs": 5 }]').defs![0];
    const { sym, params } = componentSymbol(and5);
    const n = symbolNode({ ...newUserNode('u:1', sym), params: { ...newUserNode('u:1', sym).params, ...params } }, () => undefined);
    expect(n.ports.filter((p) => p.dir === 'in').map((p) => p.name)).toEqual(['A', 'B', 'C', 'D', 'E']);
    // Up to 32 inputs: past X (Y is the output) they are numbered.
    const wide = symbolNode({ ...newUserNode('u:2', 'or'), params: { inputs: 32, width: 1 } }, () => undefined);
    expect(wide.ports.filter((p) => p.dir === 'in').map((p) => p.name).slice(22)).toEqual(['W', 'X', 'I24', 'I25', 'I26', 'I27', 'I28', 'I29', 'I30', 'I31']);
    expect(new Set(wide.ports.map((p) => p.id)).size).toBe(33);
  });

  it('says what is wrong', () => {
    const err = (t: string) => parseComponents(t, (n) => (n === 'taken' ? 'a drawing is named taken.' : undefined)).error;
    expect(err('[{ "name": "a" ')).toMatch(/Not valid JSON/);
    expect(err('[{ "base": "and" }]')).toMatch(/^Component 1: "name"/);
    expect(err('[{ "name": "module", "base": "and" }]')).toMatch(/keyword/);
    expect(err('[{ "name": "g", "base": "nope" }]')).toMatch(/"base" is one of/);
    expect(err('[{ "name": "g", "base": "and", "inptus": 3 }]')).toMatch(/AND has "inputs", "width", "mode", not "inptus"/);
    expect(err('[{ "name": "g", "base": "and", "inputs": 99 }]')).toMatch(/"inputs" is a whole number from 2 to 32/);
    expect(err('[{ "name": "g", "base": "const", "value": "abc" }]')).toMatch(/Verilog number/);
    expect(err('[{ "name": "p", "inputs": ["a b"] }]')).toMatch(/p input 1: "a b" is not a pin/);
    expect(err('[{ "name": "p", "inputs": ["a"], "outputs": ["a"] }]')).toMatch(/two pins are named a/);
    expect(err('[{ "name": "p" }]')).toMatch(/give it "inputs" and "outputs"/);
    expect(err('[{ "name": "p", "inputs": 2, "pins": 3 }]')).toMatch(/not "pins"/);
    expect(err('[{ "name": "taken", "inputs": 2 }]')).toBe('taken: a drawing is named taken.');
    // A preset is not a module: its name may be one a module has.
    expect(err('[{ "name": "taken", "base": "and" }]')).toBeUndefined();
    expect(err('[{ "name": "a", "base": "and" }, { "name": "a", "base": "or" }]')).toMatch(/Two components are named a/);
  });

  it('writes them back as JSON that reads the same, and loads saved ones', () => {
    const defs = parseComponents(COMPONENTS_EXAMPLE).defs!;
    expect(parseComponents(componentsJson(defs)).defs).toEqual(defs);
    expect(componentsJson([])).toBe('[]\n');
    // Text inside values is left as it is.
    const odd = parseComponents('[{ "name": "q", "title": "A\\":B, \\"c", "base": "and" }]').defs!;
    expect(parseComponents(componentsJson(odd)).defs).toEqual(odd);
    expect(odd[0].title).toBe('A":B, "c');
    // Saved as they are kept; what is wrong in a file is dropped.
    const saved = JSON.parse(JSON.stringify(defs));
    expect(loadComponents([...saved, { name: 'bad', base: 'nope' }, 'x', { name: 'and5', base: 'or' }])).toEqual(defs);
    expect(loadComponents(undefined)).toEqual([]);
    expect(loadComponents([{ name: 'and5', base: 'and', params: { name: 'x', base: 'or', inputs: 5 } }])).toEqual([
      { name: 'and5', base: 'and', params: { inputs: 5 } },
    ]);
  });

  it('reads the JSON of a placed symbol', () => {
    // One item to a line.
    expect(symbolJson('and', { inputs: 3 })).toBe('{\n  "sym": "and",\n  "inputs": 3,\n  "width": 1,\n  "mode": "bitwise"\n}');
    expect(parseSymbolJson(symbolJson('mux', { inputs: 4, width: 8 }), 'mux')).toEqual({ params: { inputs: 4, width: 8 } });
    expect(parseSymbolJson('{ "sym": "and", "inputs": 5, "width": 1 }', 'and')).toEqual({ params: { inputs: 5, width: 1 } });
    expect(parseSymbolJson('{ "inputs": 5 }', 'and')).toEqual({ params: { inputs: 5 } });
    expect(parseSymbolJson('{ "sym": "or" }', 'and').error).toMatch(/This is an AND: "sym" stays "and"/);
    expect(parseSymbolJson('{ "inputs": 1 }', 'and').error).toBe('"inputs" is a whole number from 2 to 32.');
    expect(parseSymbolJson('[1]', 'and').error).toMatch(/Write the settings/);
    expect(parseSymbolJson('{ "inputs": 3, "title": "My AND" }', 'and').error).toMatch(/"title" is not a setting/);
  });

  it('edits one component of the library as JSON, in its place', () => {
    const defs = parseComponents(COMPONENTS_EXAMPLE).defs!;
    expect(componentJson(defs[0])).toBe('{ "name": "and5", "title": "AND (5 inputs)", "base": "and", "inputs": 5 }');
    expect(componentJson(defs[2])).toBe('{ "name": "alu", "title": "ALU", "inputs": ["a", "b", "op[2:0]"], "outputs": ["y", "zero[0:0]"], "width": 8 }');
    // One item to a line, as the window shows one; each reads back to itself either way.
    expect(componentJson(defs[0], true)).toBe('{\n  "name": "and5",\n  "title": "AND (5 inputs)",\n  "base": "and",\n  "inputs": 5\n}');
    expect(componentJson(defs[3], true)).toBe('{\n  "name": "lut6",\n  "inputs": [\n    "in0",\n    "in1",\n    "in2",\n    "in3",\n    "in4",\n    "in5"\n  ],\n  "outputs": [\n    "out"\n  ]\n}');
    for (const d of defs) {
      expect(editComponent(defs, d.name, componentJson(d)).defs).toEqual(defs);
      expect(editComponent(defs, d.name, componentJson(d, true)).defs).toEqual(defs);
    }
    const r = editComponent(defs, 'alu', '{ "name": "alu", "inputs": ["a[7:0]"], "outputs": ["y[7:0]"] }');
    expect(r.defs!.map((d) => d.name)).toEqual(['and5', 'mux4x8', 'alu', 'lut6', 'any8']);
    expect(r.defs![2].pins!.map((p) => p.name)).toEqual(['a', 'y']);
    // Renamed in place; not to the name of another component, nor of a module.
    expect(editComponent(defs, 'and5', '{ "name": "and6", "base": "and", "inputs": 6 }').defs!.map((d) => d.name)).toEqual(['and6', 'mux4x8', 'alu', 'lut6', 'any8']);
    expect(editComponent(defs, 'and5', '{ "name": "alu", "base": "and" }').error).toBe('Another component is named alu.');
    expect(editComponent(defs, 'alu', '{ "name": "top", "inputs": 1 }', (n) => (n === 'top' ? 'a module of your Verilog is named top.' : undefined)).error).toBe(
      'top: a module of your Verilog is named top.',
    );
    // One component, as it should be.
    expect(editComponent(defs, 'alu', '').error).toMatch(/^Write one component here/);
    expect(editComponent(defs, 'alu', '[{ "name": "a", "base": "and" }, { "name": "b", "base": "or" }]').error).toMatch(/^Write one component here/);
    expect(editComponent(defs, 'alu', '{ "base": "and" }').error).toBe('"name" is a name of letters, digits and _ (such as "and5").');
    expect(editComponent(defs, 'alu', '{ "name": "alu", "inputs": 2,').error).toMatch(/^Not valid JSON/);
  });

  it('writes the width of a part whose pins all have it once, so that changing it changes every pin', () => {
    const x = parseComponents('{ "name": "x", "inputs": 2, "outputs": 1, "width": 4 }').defs![0];
    expect(componentJson(x)).toBe('{ "name": "x", "inputs": ["in0", "in1"], "outputs": ["out"], "width": 4 }');
    const wider = editComponent([x], 'x', componentJson(x, true).replace('"width": 4', '"width": 16')).defs![0];
    expect(wider.pins!.map((p) => p.width)).toEqual([16, 16, 16]);
    // Buses of other widths, and 1-bit pins, say their bits: "width" is the width of most buses, the data width.
    const alu = parseComponents('{ "name": "alu", "inputs": ["a[7:0]", "b[7:0]", "op[2:0]"], "outputs": ["y[7:0]", "zero"] }').defs![0];
    expect(componentJson(alu)).toBe('{ "name": "alu", "inputs": ["a", "b", "op[2:0]"], "outputs": ["y", "zero[0:0]"], "width": 8 }');
    expect(parseComponents(componentJson(alu)).defs).toEqual([alu]);
    const alu16 = editComponent([alu], 'alu', componentJson(alu, true).replace('"width": 8', '"width": 16')).defs![0];
    expect(alu16.pins!.map((p) => `${p.name}:${p.width}`)).toEqual(['a:16', 'b:16', 'op:3', 'y:16', 'zero:1']);
    // Two widths as common: the wider one.
    expect(componentJson(parseComponents('{ "name": "z", "inputs": ["a[3:0]"], "outputs": ["y[7:0]"] }').defs![0])).toBe(
      '{ "name": "z", "inputs": ["a[3:0]"], "outputs": ["y"], "width": 8 }',
    );
    // Pins written with bits as wide as "width" are the same part.
    const same = parseComponents('{ "name": "y", "inputs": ["a[7:0]", "b[7:0]"], "outputs": ["s[7:0]"] }').defs![0];
    expect(componentJson(same)).toBe('{ "name": "y", "inputs": ["a", "b"], "outputs": ["s"], "width": 8 }');
    expect(parseComponents(componentJson(same)).defs).toEqual([same]);
  });

  it('refuses a part width that no pin takes, rather than leave the pins as they were', () => {
    const r = parseComponents('{ "name": "alu", "inputs": ["a[7:0]", "b[7:0]"], "outputs": ["y[7:0]"], "width": 16 }');
    expect(r.error).toMatch(/^alu: "width" sets the bits of pins written without them, such as "a"/);
    expect(editComponent([], 'alu', '{ "name": "alu", "inputs": [{ "name": "a", "width": 8 }], "outputs": ["y[7:0]"], "width": 4 }').error).toMatch(/^alu: "width"/);
    // Taken by a pin without bits: that pin has it, the others keep theirs.
    expect(parseComponents('{ "name": "m", "inputs": ["a[7:0]", "b"], "outputs": ["y[7:0]"], "width": 16 }').defs![0].pins!.map((p) => p.width)).toEqual([8, 16, 8]);
    // As wide as the pins say: nothing to refuse.
    expect(parseComponents('{ "name": "n", "inputs": ["a[7:0]"], "outputs": ["y[7:0]"], "width": 8 }').defs![0].pins!.map((p) => p.width)).toEqual([8, 8]);
    // As wide as some of them (the data pins of the JSON shown, written with their bits): the same part, nothing to refuse.
    const alu = parseComponents('{ "name": "alu", "inputs": ["a[7:0]", "b[7:0]", "op[2:0]"], "outputs": ["y[7:0]", "zero[0:0]"], "width": 8 }');
    expect(alu.defs![0].pins!.map((p) => p.width)).toEqual([8, 8, 3, 8, 1]);
    // None of them: the message names a pin of another width.
    expect(parseComponents('{ "name": "alu", "inputs": ["a[7:0]", "op[2:0]"], "outputs": ["y[7:0]"], "width": 16 }').error).toMatch(/such as "a\[7:0\]"/);
  });

  it('tells a preset renamed in its place in the list', () => {
    const before = parseComponents('[{ "name": "a", "base": "and" }, { "name": "m", "base": "mux", "width": 8 }, { "name": "p", "inputs": 2, "outputs": 1 }]').defs!;
    const after = parseComponents('[{ "name": "a", "base": "and" }, { "name": "m8", "base": "mux", "width": 16 }, { "name": "q", "inputs": 2, "outputs": 1 }]').defs!;
    // A part is not a preset: its blocks name it as a module.
    expect(renamedPresets(before, after)).toEqual({ m: 'm8' });
    // Another symbol in its place, a name that was there already, or one that stays: no rename.
    expect(renamedPresets(before, parseComponents('[{ "name": "a", "base": "and" }, { "name": "m8", "base": "or" }]').defs!)).toEqual({});
    expect(renamedPresets(before, parseComponents('[{ "name": "m", "base": "mux" }, { "name": "a", "base": "mux" }]').defs!)).toEqual({});
    expect(renamedPresets(before, before.slice(1))).toEqual({});
    expect(renamedPresets(undefined, after)).toEqual({});
    const lib = (json: string) => parseComponents(json).defs!;
    const two = lib('[{ "name": "and3", "base": "and", "inputs": 3 }, { "name": "and4", "base": "and", "inputs": 4 }]');
    // One deleted and the other renamed: the one with the new one's settings was renamed, whatever their places.
    expect(renamedPresets(two, lib('[{ "name": "and_four", "base": "and", "inputs": 4 }]'))).toEqual({ and4: 'and_four' });
    expect(renamedPresets(lib('{ "name": "a", "base": "and", "inputs": 3 }'), lib('[{ "name": "n", "base": "and", "inputs": 5 }, { "name": "a2", "base": "and", "inputs": 3 }]'))).toEqual({
      a: 'a2',
    });
    // A line edited in place, between the same lines that stay: renamed (and changed).
    const three = lib('[{ "name": "or2", "base": "or" }, { "name": "and3", "base": "and", "inputs": 3 }, { "name": "xor2", "base": "xor" }]');
    expect(renamedPresets(three, lib('[{ "name": "or2", "base": "or" }, { "name": "and5", "base": "and", "inputs": 5 }, { "name": "xor2", "base": "xor" }]'))).toEqual({
      and3: 'and5',
    });
    // Two gone and one or two new with no settings to tell them apart: no way to tell which.
    expect(renamedPresets(two, lib('[{ "name": "and5", "base": "and", "inputs": 5 }]'))).toEqual({});
    expect(renamedPresets(two, lib('[{ "name": "x", "base": "and", "inputs": 3 }, { "name": "y", "base": "and", "inputs": 3 }]'))).toEqual({});
    // Deleted here and another added there: no rename, rather than give symbols another preset's settings.
    expect(renamedPresets(three, lib('[{ "name": "and9", "base": "and", "inputs": 9 }, { "name": "or2", "base": "or" }, { "name": "xor2", "base": "xor" }]'))).toEqual({});
    expect(renamedPresets(lib('[{ "name": "m", "base": "mux" }, { "name": "a", "base": "and", "inputs": 3 }]'), lib('[{ "name": "x", "base": "and", "inputs": 5 }, { "name": "y", "base": "and", "inputs": 6 }, { "name": "m", "base": "mux" }]'))).toEqual({});
    const mux = lib('[{ "name": "mux4", "base": "mux", "inputs": 4, "width": 8 }, { "name": "and3", "base": "and", "inputs": 3 }]');
    expect(renamedPresets(mux, lib('[{ "name": "and3", "base": "and", "inputs": 3 }, { "name": "mux2", "base": "mux", "inputs": 2, "width": 8 }]'))).toEqual({});
    expect(renamedPresets(two, lib('[{ "name": "and4", "base": "and", "inputs": 4 }, { "name": "and8", "base": "and", "inputs": 8 }]'))).toEqual({});
  });

  it('links a symbol to its preset only while it has its settings', () => {
    const defs = parseComponents('[{ "name": "add8", "base": "add", "width": 8 }, { "name": "p", "inputs": 2, "outputs": 1 }]').defs!;
    const add = (width: number, component?: string) => ({ id: 'u:1', sym: 'add' as const, params: { width }, ...(component ? { component } : {}) });
    expect(followsPreset(add(8, 'add8'), defs)).toBe(true);
    expect(followsPreset(add(16, 'add8'), defs)).toBe(false);
    expect(followsPreset(add(8), defs)).toBe(false);
    expect(followsPreset(add(8, 'gone'), defs)).toBe(false);
    expect(followsPreset(add(8, 'p'), defs)).toBe(false);
    expect(followsPreset({ ...add(8, 'add8'), sym: 'sub' }, defs)).toBe(false);
  });

  it('says what the JSON of a symbol sets', () => {
    expect(settingsHint('and')).toBe('"inputs" 2–32, "width" 1–256 bits, "mode" "bitwise" (a & b), "logical" (a && b: a 1-bit output) or "reduce" (&a: one input, a 1-bit output)');
    // Each gate as it is written; a XOR has no logical mode, a NOT no reduce mode.
    expect(settingsHint('nor')).toContain('"mode" "bitwise" (~(a | b)), "logical" (!(a || b): a 1-bit output) or "reduce" (~|a: one input, a 1-bit output)');
    expect(settingsHint('xnor')).toContain('"bitwise" (~(a ^ b)) or "reduce" (~^a:');
    expect(settingsHint('not')).toBe('"width" 1–256 bits, "mode" "bitwise" (~a) or "logical" (!a: a 1-bit output)');
    expect(settingsHint('buf')).toBe('"width" 1–256 bits');
    expect(settingsHint('decoder')).toBe('"width" 1–8 select bits');
    expect(settingsHint('const')).toBe('"value" a Verilog number such as "4\'d2"');
    expect(settingsHint('shl')).toBe('"width" 1–256 bits, "shift" 1–16 bits of the shift amount');
  });

  it('finds a free name', () => {
    const defs = parseComponents('[{ "name": "and5", "base": "and" }]').defs!;
    expect(freeComponentName(defs, 'and3')).toBe('and3');
    expect(freeComponentName(defs, 'and5')).toBe('and5_2');
    expect(freeComponentName(defs, 'x', (n) => (n === 'x' ? 'taken' : undefined))).toBe('x_2');
    expect(freeComponentName(defs, 'not')).toBe('not_2');
  });

  it('names a component by its settings, a reduction apart from a gate with as many inputs', () => {
    expect(componentStem('and', { inputs: 3, width: 1, mode: 'bitwise' })).toBe('and3');
    expect(componentStem('mux', { inputs: 4, width: 8 })).toBe('mux4x8');
    expect(componentStem('add', { width: 8 })).toBe('add8');
    expect(componentStem('or', { inputs: 8, width: 1, mode: 'bitwise' })).toBe('or8');
    expect(componentStem('or', { inputs: 2, width: 8, mode: 'reduce' })).toBe('reduce_or8');
    // One bit: no number, and no Verilog keyword (and) to number either.
    expect(componentStem('and', { width: 1, mode: 'reduce' })).toBe('reduce_and');
    // a || b of buses is no a | b: logic_or2x8, not or2x8.
    expect(componentStem('or', { inputs: 2, width: 8, mode: 'logical' })).toBe('logic_or2x8');
    expect(componentStem('not', { width: 8, mode: 'logical' })).toBe('logic_not8');
    expect(componentStem('not', { width: 8 })).toBe('not8');
    // A mode the symbol does not have is not its mode.
    expect(componentStem('xor', { inputs: 2, width: 8, mode: 'logical' })).toBe('xor2x8');
    expect(freeComponentName([], componentStem('and', { width: 1, mode: 'reduce' }))).toBe('reduce_and');
  });
});
