import { describe, expect, it } from 'vitest';
import { parseComponents, sameSettings } from './components';
import { FILE_FORMAT, emptyEdits, parseEdits, parseSavedFile, type SheetEdits } from './doc';
import { followComponents, keepLinks, toUserNode, unlinkChanged } from './sheet';
import { newUserNode, symbolNode } from './symbols';
import type { DNode } from '../core/diagram';

const lib = (json: string) => parseComponents(json).defs!;

function sheet(): SheetEdits {
  return {
    ...emptyEdits(),
    nodes: [
      newUserNode('u:1', 'mux', { params: { inputs: 4, width: 8 }, component: 'm' }),
      newUserNode('u:2', 'mux', { params: { inputs: 4, width: 8 } }),
      newUserNode('u:3', 'and', { params: { inputs: 5, width: 1 }, component: 'g' }),
    ],
    edges: [{ id: 'w:1', source: { node: 'u:3', port: 'u:3.Y' }, target: { node: 'u:1', port: 'u:1.S' } }],
    next: 4,
  };
}

describe('symbols placed from a preset', () => {
  const before = lib('[{ "name": "m", "base": "mux", "inputs": 4, "width": 8 }, { "name": "g", "base": "and", "inputs": 5 }]');

  it('take its new settings, all of them, and keep their wires', () => {
    const after = lib('[{ "name": "m", "base": "mux", "inputs": 4, "width": 16 }, { "name": "g", "base": "and", "inputs": 5 }]');
    const out = followComponents({ 'd:x': sheet() }, before, after)['d:x'];
    expect(out.nodes.map((n) => n.params.width)).toEqual([16, 8, 1]);
    expect(out.nodes[0].component).toBe('m');
    expect(out.edges).toEqual(sheet().edges);
    // A setting the preset no longer gives is the library's default, not what the symbol had.
    const fewer = followComponents({ 'd:x': sheet() }, before, lib('[{ "name": "m", "base": "mux", "width": 8 }, { "name": "g", "base": "and", "inputs": 5 }]'))['d:x'];
    expect(fewer.nodes[0].params).toMatchObject({ inputs: 2, width: 8 });
  });

  it('leave the sheets as they are when nothing they follow changed', () => {
    const sheets = { 'd:x': sheet() };
    expect(followComponents(sheets, before, before)).toBe(sheets);
    expect(followComponents(sheets, before, [...before, ...lib('{ "name": "z", "base": "or" }')])).toBe(sheets);
  });

  it('follow a renamed preset, and keep their settings when it is gone or is another symbol now', () => {
    const renamed = followComponents({ 'd:x': sheet() }, before, lib('[{ "name": "m2", "base": "mux", "inputs": 4, "width": 8 }, { "name": "g", "base": "and", "inputs": 5 }]'), { m: 'm2' })['d:x'];
    expect(renamed.nodes.map((n) => n.component)).toEqual(['m2', undefined, 'g']);
    const gone = followComponents({ 'd:x': sheet() }, before, lib('{ "name": "g", "base": "or", "inputs": 3 }'))['d:x'];
    expect(gone.nodes.map((n) => [n.sym, n.params, n.component])).toEqual([
      ['mux', { inputs: 4, width: 8 }, undefined],
      ['mux', { inputs: 4, width: 8 }, undefined],
      ['and', { inputs: 5, width: 1 }, undefined],
    ]);
    // Without "component" at all once it follows nothing (the saved file stays as it was).
    expect('component' in gone.nodes[0]).toBe(false);
  });

  it('leave a symbol whose link no longer held: it is a symbol of its own, with its settings', () => {
    // Placed again after Undo took the preset back to 4 inputs, pasted from another file…: 2 inputs, linked to m.
    const e = sheet();
    const stale: SheetEdits = { ...e, nodes: e.nodes.map((n) => (n.id === 'u:1' ? { ...n, params: { inputs: 2, width: 8 } } : n)) };
    const after = lib('[{ "name": "m", "base": "mux", "inputs": 4, "width": 16 }, { "name": "g", "base": "and", "inputs": 5 }, { "name": "z", "base": "or" }]');
    const out = followComponents({ 'd:x': stale }, before, after)['d:x'];
    expect(out.nodes[0]).toEqual({ id: 'u:1', sym: 'mux', params: { inputs: 2, width: 8 } });
    expect(out.nodes[2].component).toBe('g');
    // keepLinks takes such links off at once (a paste, a sheet that comes back).
    expect(keepLinks(stale, before).nodes.map((n) => n.component)).toEqual([undefined, undefined, 'g']);
    expect(keepLinks(e, before)).toBe(e);
  });

  it('drop the links of a saved file that do not hold', () => {
    const file = {
      format: FILE_FORMAT,
      version: 1,
      files: {},
      doc: {
        drawn: ['x'],
        sheets: { 'd:x': { nodes: [{ id: 'u:1', sym: 'and', params: { inputs: 5 }, component: 'g' }, { id: 'u:2', sym: 'and', params: { inputs: 3 }, component: 'g' }] } },
        components: [{ name: 'g', base: 'and', params: { inputs: 5 } }],
      },
    };
    expect(parseSavedFile(JSON.stringify(file)).doc.sheets['d:x'].nodes.map((n) => n.component)).toEqual(['g', undefined]);
  });

  it('stop following it once changed on their own', () => {
    const e = sheet();
    const changed: SheetEdits = { ...e, nodes: e.nodes.map((n) => (n.id === 'u:1' ? { ...n, params: { inputs: 4, width: 4 } } : n)) };
    expect(unlinkChanged(changed, 'u:1', before).nodes[0].component).toBeUndefined();
    // Changed back to the preset's settings (or not changed): still following.
    expect(unlinkChanged(e, 'u:1', before)).toBe(e);
    expect(unlinkChanged(e, 'u:2', before)).toBe(e);
    // Its preset gone: nothing to follow.
    expect(unlinkChanged(e, 'u:3', lib('{ "name": "m", "base": "mux", "inputs": 4, "width": 8 }')).nodes[2].component).toBeUndefined();
  });

  it('compares settings with the defaults filled in', () => {
    expect(sameSettings('and', { inputs: 2 }, { inputs: 2, width: 1 })).toBe(true);
    expect(sameSettings('and', { inputs: 2 }, { inputs: 2, width: 8 })).toBe(false);
  });

  it('keep the link in a saved file (not on a block or a frozen copy)', () => {
    const e = parseEdits({
      nodes: [
        { id: 'u:1', sym: 'mux', params: { inputs: 4 }, component: 'm' },
        { id: 'u:2', sym: 'block', params: { module: 'alu' }, component: 'alu' },
        { id: 'u:3', sym: 'and', params: {}, component: 7 },
      ],
    });
    expect(e.nodes.map((n) => n.component)).toEqual(['m', undefined, undefined]);
  });
});

describe('widths that can be changed', () => {
  it('copies a bar of equal slices as a Concatenate or Split, whose slices and width can be changed', () => {
    const none = () => undefined;
    const join: DNode = {
      id: 'join:x',
      kind: 'join',
      label: '{ }',
      ports: [
        { id: 'join:x.[5:4]', name: '[5:4]', dir: 'in', side: 'WEST', width: 2 },
        { id: 'join:x.[3:2]', name: '[3:2]', dir: 'in', side: 'WEST', width: 2 },
        { id: 'join:x.[1:0]', name: '[1:0]', dir: 'in', side: 'WEST', width: 2 },
        { id: 'join:x.out', name: 'out', dir: 'out', side: 'EAST', width: 6 },
      ],
    };
    expect(toUserNode(join, 'u:1', none)).toEqual({ id: 'u:1', sym: 'concat', params: { parts: 3, width: 2 } });
    const split = symbolNode(newUserNode('s', 'split', { params: { parts: 2, width: 4 } }), none);
    expect(toUserNode(split, 'u:2', none)).toEqual({ id: 'u:2', sym: 'split', params: { parts: 2, width: 4 } });
    // Slices named from the other end (a bus declared [0:3]): a Concatenate would take each wire to the other end.
    const upto: DNode = {
      ...join,
      ports: [
        ...['[0]', '[1]', '[2]', '[3]'].map((n) => ({ id: `join:x.${n}`, name: n, dir: 'in' as const, side: 'WEST' as const, width: 1 })),
        { ...join.ports[3], width: 4 },
      ],
    };
    expect(toUserNode(upto, 'u:4', none).sym).toBe('raw');
    expect(toUserNode({ ...upto, ports: [...upto.ports.slice(0, 4).reverse(), upto.ports[4]] }, 'u:5', none).sym).toBe('concat');
    // Slices of different widths stay a frozen copy: the library bar has one width.
    const odd: DNode = { ...join, ports: [join.ports[0], { ...join.ports[1], id: 'join:x.[3:0]', name: '[3:0]', width: 4 }, { ...join.ports[3], width: 6 }] };
    expect(toUserNode(odd, 'u:3', none).sym).toBe('raw');
  });

  it('reads saved settings within what the library takes, as the pins are drawn', () => {
    const e = parseEdits({
      nodes: [
        { id: 'u:1', sym: 'and', params: { width: 1000, inputs: 1 } },
        { id: 'u:2', sym: 'decoder', params: { width: 12 } },
        { id: 'u:3', sym: 'shl', params: { width: 8.4, shift: 3 } },
      ],
    });
    expect(e.nodes.map((n) => n.params)).toEqual([{ width: 256, inputs: 2 }, { width: 8 }, { width: 8, shift: 3 }]);
  });

  it('reads a setting a saved file leaves out as the symbol is drawn without it, for Properties and the JSON to show', () => {
    const saved = [
      { id: 'u:1', sym: 'add', params: {} },
      { id: 'u:2', sym: 'mux', params: { width: 4 } },
      { id: 'u:3', sym: 'decoder', params: {} },
      { id: 'u:4', sym: 'shl', params: {} },
      { id: 'u:5', sym: 'concat', params: {} },
      { id: 'u:6', sym: 'const', params: {} },
    ] as const;
    const e = parseEdits({ nodes: saved });
    expect(e.nodes.map((n) => n.params)).toEqual([{ width: 1 }, { width: 4, inputs: 2 }, { width: 2 }, { width: 1, shift: 3 }, { width: 1, parts: 2 }, {}]);
    // Drawn exactly as before.
    const none = () => undefined;
    for (const [k, n] of e.nodes.entries()) {
      const was = symbolNode({ ...saved[k], params: { ...saved[k].params } }, none);
      expect(symbolNode(n, none).ports).toEqual(was.ports);
    }
  });
});
