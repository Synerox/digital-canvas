import { describe, expect, it } from 'vitest';
import {
  COMPONENTS_EXAMPLE,
  componentSymbol,
  componentsJson,
  freeComponentName,
  loadComponents,
  parseComponents,
  parseSymbolJson,
  partVerilog,
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
    expect(err('[{ "name": "g", "base": "and", "inptus": 3 }]')).toMatch(/AND has "inputs", "width", not "inptus"/);
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

  it('exports a part as an empty module with its ports', () => {
    const alu = parseComponents('{ "name": "alu", "inputs": ["a[7:0]", "c"], "outputs": ["y[7:0]"] }').defs![0];
    expect(partVerilog(alu as Parameters<typeof partVerilog>[0])).toContain(
      '(* blackbox *)\nmodule alu (\n  input wire [7:0] a,\n  input wire c,\n  output wire [7:0] y\n);\nendmodule',
    );
  });

  it('reads the JSON of a placed symbol', () => {
    expect(symbolJson('and', { inputs: 3 })).toBe('{ "sym": "and", "inputs": 3, "width": 1 }');
    expect(parseSymbolJson('{ "sym": "and", "inputs": 5, "width": 1 }', 'and')).toEqual({ params: { inputs: 5, width: 1 } });
    expect(parseSymbolJson('{ "inputs": 5 }', 'and')).toEqual({ params: { inputs: 5 } });
    expect(parseSymbolJson('{ "sym": "or" }', 'and').error).toMatch(/This is an AND: "sym" stays "and"/);
    expect(parseSymbolJson('{ "inputs": 1 }', 'and').error).toBe('"inputs" is a whole number from 2 to 32.');
    expect(parseSymbolJson('[1]', 'and').error).toMatch(/Write the settings/);
  });

  it('finds a free name', () => {
    const defs = parseComponents('[{ "name": "and5", "base": "and" }]').defs!;
    expect(freeComponentName(defs, 'and3')).toBe('and3');
    expect(freeComponentName(defs, 'and5')).toBe('and5_2');
    expect(freeComponentName(defs, 'x', (n) => (n === 'x' ? 'taken' : undefined))).toBe('x_2');
    expect(freeComponentName(defs, 'not')).toBe('not_2');
  });
});
