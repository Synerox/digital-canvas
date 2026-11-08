import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LayoutResult } from '../layout/elk-layout';
import { type EditDoc, emptyEdits } from '../editor/doc';
import { effectiveDiagram } from '../editor/sheet';
import { parseComponents, partInterface, partNamed } from '../editor/components';
import { newUserNode } from '../editor/symbols';
import { Inspector } from './Inspector';
import { SettingsWindow } from './SettingsPopup';
import { doubleClickSettings, settingsOf, subjectOf } from './settings';
import { type EditorState, useStore } from './store';

const components = parseComponents('[{ "name": "and5", "base": "and", "inputs": 5 }, { "name": "alu", "inputs": ["a[7:0]", "b[7:0]"], "outputs": ["y[7:0]"] }]').defs!;

/**
 * A drawing `d` with an AND, an input pin, a note, a block of the part alu and a block of the drawing sub; or, with
 * `aluDrawn`, a drawing named alu, which then defines the block of alu.
 */
function state(aluDrawn = false): EditorState {
  const nodes = [
    newUserNode('u:1', 'and'),
    newUserNode('u:2', 'input', { name: 'a' }),
    newUserNode('u:3', 'text', { name: 'hello' }),
    newUserNode('u:4', 'block', { name: 'u_alu', params: { module: 'alu' } }),
    newUserNode('u:5', 'block', { name: 'u_sub', params: { module: 'sub' } }),
  ];
  const edits = { ...emptyEdits(), nodes, next: 6 };
  const drawn = ['d', 'sub', ...(aluDrawn ? ['alu'] : [])];
  const doc: EditDoc = { drawn, sheets: { 'd:d': edits }, components };
  const iface = (m: string) => (m === 'alu' && !aluDrawn ? partInterface(partNamed(components, 'alu')!) : { label: m, ports: [] });
  const netlist = effectiveDiagram('d', undefined, edits, iface);
  const layout: LayoutResult = {
    module: 'd',
    width: 100,
    height: 100,
    nodes: netlist.nodes.map((n) => ({ ...n, x: 0, y: 0, width: 40, height: 40, ports: n.ports.map((p) => ({ ...p, x: 0, y: 0 })) })),
    edges: [],
  };
  const st = useStore.getInitialState();
  Object.assign(st, { files: {}, layout, netlist, sheet: 'd:d', path: [{ instance: 'd', module: 'd', drawn: true }], doc, selection: new Set<string>(), design: undefined, blockDesign: undefined });
  return st;
}

describe('what double-clicking a symbol edits', () => {
  it('opens the settings of a symbol, the part of a part block; renames a pin or a note', () => {
    const s = state();
    expect(settingsOf(s, 'u:1')).toEqual({ node: 'u:1' });
    expect(doubleClickSettings(s, 'u:1')).toEqual({ node: 'u:1' });
    // A pin's settings are in Properties' JSON button; double-clicking it renames it.
    expect(settingsOf(s, 'u:2')).toEqual({ node: 'u:2' });
    expect(doubleClickSettings(s, 'u:2')).toBeUndefined();
    expect(settingsOf(s, 'u:3')).toBeUndefined();
    expect(doubleClickSettings(s, 'u:4')).toEqual({ component: 'alu' });
    // A block of a module is opened, not edited.
    expect(settingsOf(s, 'u:5')).toBeUndefined();
    expect(settingsOf(s, 'gone')).toBeUndefined();
    // A drawing of the part's name defines its blocks now.
    expect(settingsOf(state(true), 'u:4')).toBeUndefined();
  });

  it('shows the JSON it edits', () => {
    const s = state();
    expect(subjectOf(s, { node: 'u:1' })).toEqual({ kind: 'node', id: 'u:1', sym: 'and', text: '{ "sym": "and", "inputs": 2, "width": 1 }' });
    expect(subjectOf(s, { component: 'and5' })?.text).toBe('{ "name": "and5", "base": "and", "inputs": 5 }');
    expect(subjectOf(s, { node: 'u:3' })).toBeUndefined();
    expect(subjectOf(s, { component: 'gone' })).toBeUndefined();
  });
});

describe('the JSON window', () => {
  const show = (target: Parameters<typeof subjectOf>[1]) =>
    renderToStaticMarkup(<SettingsWindow subject={subjectOf(state(), target)!} x={10} y={10} onClose={() => {}} />);

  it("edits a symbol's settings, says what they are, and saves them as a component", () => {
    const html = show({ node: 'u:1' });
    expect(html).toContain('<b>AND</b>');
    expect(html).toContain('{ &quot;sym&quot;: &quot;and&quot;, &quot;inputs&quot;: 2, &quot;width&quot;: 1 }</textarea>');
    expect(html).toContain('Sets &quot;inputs&quot; 2–32, &quot;width&quot; 1–256.');
    expect(html).toContain('Save as a component');
  });

  it('edits a component of the library, and says which blocks follow it', () => {
    const preset = show({ component: 'and5' });
    expect(preset).toContain('and5 (component)');
    expect(preset).toContain('Symbols placed already keep their settings.');
    expect(preset).not.toContain('Save as a component');
    const part = show({ component: 'alu' });
    expect(part).toContain('Changes every block of alu.');
    expect(part).toContain('&quot;inputs&quot;: [&quot;a[7:0]&quot;, &quot;b[7:0]&quot;]');
  });
});

describe('Properties of a drawing', () => {
  const inspect = (id: string, aluDrawn = false) => {
    state(aluDrawn).selection = new Set([id]);
    return renderToStaticMarkup(<Inspector onExportVerilog={() => {}} />);
  };

  it('keeps to what is needed: the JSON is in its own window, the pins folded', () => {
    const html = inspect('u:1');
    expect(html).toContain('Inputs');
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('Save as a component');
    expect(html).toContain('>JSON…</button>');
    expect(html).toMatch(/<details class="ports small"><summary>3 pins<\/summary>/);
    expect(inspect('u:3')).not.toContain('JSON…');
  });

  it("offers a part's pins, not a module to open", () => {
    const html = inspect('u:4');
    expect(html).toContain('<h3>Part alu</h3>');
    expect(html).toContain('>Edit pins…</button>');
    expect(html).not.toContain('Open ');
    // Once a drawing defines it, the block opens that drawing.
    const drawn = inspect('u:4', true);
    expect(drawn).toContain('>Open alu<');
    expect(drawn).not.toContain('Edit pins');
  });
});
