import { describe, expect, it } from 'vitest';
import { type Diagram, buildDiagram, pinStyleOf, withPinStyle } from '../core/diagram';
import { design } from '../core/test-utils';
import { type LayoutResult, approxMeasure, layoutDiagram, sizeNode } from '../layout/elk-layout';
import { DiagramGraphic } from '../render/DiagramGraphic';
import { exportSvg } from '../render/export';
import { THEME } from '../render/theme';
import { renderToStaticMarkup } from 'react-dom/server';
import { componentJson, followsPreset, parseComponents, parseSymbolJson, settingsHint, symbolJson } from './components';
import { type SheetEdits, compactDoc, emptyEdits, isEmptyEdits, parseEdits, parseSavedFile } from './doc';
import { copyNodes, effectiveDiagram, layoutToEdits, pasteClip, stylePins, toDrawing, toUserNode } from './sheet';
import { type InterfaceOf, type UserNode, newUserNode, symbolNode } from './symbols';

const noModules: InterfaceOf = () => undefined;

const V = `module t(input [3:0] a, input b, output [3:0] y, inout io);
  assign y = b ? a : 4'd0;
endmodule
`;

/** A laid-out sheet of the nodes as placed (each at its own row), for drawing. */
function laidOut(d: Diagram): LayoutResult {
  const nodes = d.nodes.map((n, i) => {
    const s = sizeNode(n, approxMeasure);
    const x = 100;
    const y = 40 * i;
    return { ...n, x, y, width: s.width, height: s.height, ports: n.ports.map((p) => ({ ...p, x: x + s.ports[p.id].x, y: y + s.ports[p.id].y })) };
  });
  return { module: d.module, width: 400, height: 40 * nodes.length, nodes, edges: [] };
}

describe('pins drawn as a label or as text only', () => {
  it('are labels unless set to text, and keep their size and connection points either way', () => {
    for (const sym of ['input', 'output', 'inout'] as const) {
      const label = newUserNode('u:1', sym, { name: 'data_in' });
      const text: UserNode = { ...label, params: { ...label.params, style: 'text' } };
      expect(label.params.style).toBe('label');
      expect(pinStyleOf(symbolNode(label, noModules))).toBe('label');
      expect(symbolNode(label, noModules).attrs).toBeUndefined();
      expect(pinStyleOf(symbolNode(text, noModules))).toBe('text');
      // A pin saved before the setting existed is a label.
      expect(pinStyleOf(symbolNode({ ...label, params: { width: 1 } }, noModules))).toBe('label');
      expect(sizeNode(symbolNode(text, noModules), approxMeasure)).toEqual(sizeNode(symbolNode(label, noModules), approxMeasure));
    }
    // Only pins have the look: other nodes stay as they are.
    const and = symbolNode(newUserNode('u:2', 'and'), noModules);
    expect(withPinStyle(and, 'text')).toBe(and);
    expect(pinStyleOf({ kind: 'const', attrs: { style: 'text' } })).toBe('label');
  });

  it('draw the name only, next to the connection point, with a box only the editor shows', () => {
    const nodes = (['input', 'output', 'inout'] as const).map((sym, i) => {
      const u = newUserNode(`u:${i + 1}`, sym, { name: `p${i}` });
      return { ...u, params: { ...u.params, style: 'text' as const } };
    });
    const e: SheetEdits = { ...emptyEdits(), nodes, next: 9 };
    const layout = laidOut(effectiveDiagram('d', undefined, e, noModules));
    const svg = exportSvg(layout, THEME);
    // No outline, nothing but the names (the export draws no box for clicks).
    expect(svg).not.toContain('<polygon');
    expect(svg.match(/<rect/g)).toHaveLength(1); // the background
    const [inp, out, io] = layout.nodes;
    expect(svg).toContain(`<text x="${inp.x + inp.width - 6}" y="${inp.y + 14}" font-size="12" text-anchor="end"`);
    expect(svg).toContain(`<text x="${out.x + 6}" y="${out.y + 14}" font-size="12" text-anchor="start"`);
    expect(svg).toContain(`<text x="${io.x + io.width / 2}" y="${io.y + 14}" font-size="12" text-anchor="middle"`);
    // In the editor the box takes clicks, and shows the selection.
    const editor = renderToStaticMarkup(DiagramGraphic({ layout, theme: THEME, interactive: true, selection: new Set(['u:2']) }));
    expect(editor.match(/<rect [^>]*fill="transparent" stroke="none"/g)).toHaveLength(2);
    expect(editor).toContain(`<rect x="${out.x}" y="${out.y}" width="${out.width}" height="${out.height}" fill="${THEME.accentFill}" stroke="${THEME.accent}"`);
    // A label still has its outline.
    const labels = laidOut(effectiveDiagram('d', undefined, { ...e, nodes: e.nodes.map((n) => ({ ...n, params: { width: 1 } })) }, noModules));
    expect(exportSvg(labels, THEME).match(/<polygon/g)).toHaveLength(3);
  });

  it('of an imported sheet are restyled as an edit kept by ID, and only pins are', async () => {
    const base = buildDiagram(await design({ 't.v': V }), 't');
    let e = layoutToEdits(emptyEdits(), await layoutDiagram(base), 'existing');
    const before = e;
    e = stylePins(e, effectiveDiagram('t', base, e, noModules), ['in:a', 'out:y', 'io:io', base.nodes.find((n) => n.kind === 'cell')!.id], 'text');
    expect(e.pinStyles).toEqual({ 'in:a': 'text', 'out:y': 'text', 'io:io': 'text' });
    expect(before.pinStyles).toBeUndefined();
    let d = effectiveDiagram('t', base, e, noModules);
    const style = (id: string) => pinStyleOf(d.nodes.find((n) => n.id === id)!);
    expect(['in:a', 'in:b', 'out:y', 'io:io'].map(style)).toEqual(['text', 'label', 'text', 'text']);
    // Nothing to change: the same edits.
    expect(stylePins(e, d, ['in:a'], 'text')).toBe(e);
    expect(stylePins(e, d, ['in:b'], 'label')).toBe(e);
    // Back to a label: the entry goes, and with the last one the field.
    e = stylePins(e, d, ['in:a', 'out:y'], 'label');
    expect(e.pinStyles).toEqual({ 'io:io': 'text' });
    e = stylePins(e, effectiveDiagram('t', base, e, noModules), ['io:io'], 'label');
    expect(e).not.toHaveProperty('pinStyles');
    // Renamed, a pin keeps its look; a re-import keeps it by ID.
    e = stylePins(e, effectiveDiagram('t', base, e, noModules), ['in:b'], 'text');
    e = { ...e, labels: { 'in:b': 'sel' } };
    d = effectiveDiagram('t', base, e, noModules);
    expect(d.nodes.find((n) => n.id === 'in:b')).toMatchObject({ label: 'sel', attrs: { style: 'text' } });
  });

  it('of a drawing are restyled in their settings, a frozen copy of a pin too', () => {
    const raw = toUserNode({ id: 'in:w', kind: 'input', label: 'w', ports: [{ id: 'in:w.out', name: 'out', dir: 'out', side: 'EAST', width: 300 }] }, 'u:3', noModules);
    expect(raw).toMatchObject({ sym: 'raw', params: { style: 'label' } });
    let e: SheetEdits = { ...emptyEdits(), nodes: [newUserNode('u:1', 'input', { name: 'a' }), newUserNode('u:2', 'and'), raw], next: 4 };
    e = stylePins(e, effectiveDiagram('d', undefined, e, noModules), ['u:1', 'u:2', 'u:3'], 'text');
    expect(e.nodes.map((n) => n.params.style)).toEqual(['text', undefined, 'text']);
    expect(e).not.toHaveProperty('pinStyles');
    const d = effectiveDiagram('d', undefined, e, noModules);
    expect(d.nodes.map((n) => pinStyleOf(n))).toEqual(['text', 'label', 'text']);
    // The frozen copy's own node never says how it is drawn: its setting does.
    expect(e.nodes[2].raw?.attrs).toBeUndefined();
  });

  it('keep their look when copied, pasted or turned into a drawing', async () => {
    const base = buildDiagram(await design({ 't.v': V }), 't');
    const elk = await layoutDiagram(base);
    let e = layoutToEdits(emptyEdits(), elk, 'existing');
    e = stylePins(e, effectiveDiagram('t', base, e, noModules), ['in:a', 'out:y'], 'text');
    const d = effectiveDiagram('t', base, e, noModules);
    const layout = { ...elk, nodes: elk.nodes.map((n) => ({ ...n, ...d.nodes.find((x) => x.id === n.id)!, ports: n.ports })) };
    const clip = copyNodes(d, e, layout, new Set(['in:a', 'in:b']), noModules)!;
    expect(clip.nodes.map((it) => it.node.params.style)).toEqual(['text', 'label']);
    const [pasted, ids] = pasteClip(e, clip, { x: 500, y: 500 }, d);
    const after = effectiveDiagram('t', base, pasted, noModules);
    expect(ids.slice(0, 2).map((id) => pinStyleOf(after.nodes.find((n) => n.id === id)!))).toEqual(['text', 'label']);
    const drawing = toDrawing(d, layout, e, noModules);
    const styles = Object.fromEntries(drawing.nodes.filter((n) => n.name).map((n) => [n.name, n.params.style]));
    expect(styles).toEqual({ a: 'text', b: 'label', y: 'text', io: 'label' });
  });

  it('are saved, and files of before open as labels', () => {
    const nodes = [
      { ...newUserNode('u:1', 'input', { name: 'a' }), params: { width: 4, style: 'text' } },
      // Of before the setting: no style, a label.
      { id: 'u:2', sym: 'output', params: { width: 1 }, name: 'y' },
      // Not a style: left out.
      { id: 'u:3', sym: 'inout', params: { style: 'box' }, name: 'io' },
      // Only pins have one.
      { id: 'u:4', sym: 'and', params: { inputs: 2, style: 'text' } },
      { id: 'u:5', sym: 'raw', params: { style: 'text' }, raw: { kind: 'output', label: 'w', ports: [{ name: 'in', dir: 'in', side: 'WEST', width: 300 }] } },
    ];
    const e = parseEdits({ nodes, pinStyles: { 'in:a': 'text', 'in:b': 'label', 'in:c': 7 } });
    expect(e.nodes.map((n) => n.params.style)).toEqual(['text', undefined, undefined, undefined, 'text']);
    expect(e.pinStyles).toEqual({ 'in:a': 'text' });
    expect(parseEdits({ pinStyles: { 'in:b': 'label' } })).not.toHaveProperty('pinStyles');
    // A Verilog sheet whose only edit is a pin's look is kept when saved.
    const only = { ...emptyEdits(), pinStyles: { 'in:a': 'text' as const } };
    expect(isEmptyEdits(only)).toBe(false);
    expect(compactDoc({ drawn: [], sheets: { 'v:blocks:t': only } }).sheets).toHaveProperty('v:blocks:t');
    const f = { format: 'digital-canvas', version: 1, files: {}, viewMode: 'blocks', doc: { drawn: ['d'], sheets: { 'd:d': { nodes }, 'v:blocks:t': only } }, path: [] };
    const back = parseSavedFile(JSON.stringify(f));
    expect(back.doc.sheets['v:blocks:t'].pinStyles).toEqual({ 'in:a': 'text' });
    expect(back.doc.sheets['d:d'].nodes[0].params).toEqual({ width: 4, style: 'text' });
  });

  it('can be set in the JSON of a pin and in a preset', () => {
    expect(JSON.parse(symbolJson('input', { width: 8 }))).toEqual({ sym: 'input', width: 8, style: 'label' });
    expect(JSON.parse(symbolJson('output', { width: 1, style: 'text' }))).toEqual({ sym: 'output', width: 1, style: 'text' });
    expect(settingsHint('input')).toContain('"style" "label" (the name in a label outline) or "text" (the name only)');
    expect(parseSymbolJson('{ "sym": "input", "width": 8, "style": "text" }', 'input')).toEqual({ params: { width: 8, style: 'text' } });
    expect(parseSymbolJson('{ "style": "box" }', 'input').error).toBe('"style" is "label" (the name in a label outline) or "text" (the name only).');
    // Only pins have a style.
    expect(parseSymbolJson('{ "style": "text" }', 'and').error).toMatch(/not "style"/);
    const defs = parseComponents('[{ "name": "in_text", "base": "input", "width": 8, "style": "text" }]').defs!;
    expect(defs[0].params).toEqual({ width: 8, style: 'text' });
    expect(componentJson(defs[0])).toBe('{ "name": "in_text", "base": "input", "width": 8, "style": "text" }');
    // A pin follows its preset while it has the preset's look too; a pin of before (no style) has the default's.
    const placed: UserNode = { ...newUserNode('u:1', 'input'), params: { width: 8, style: 'text' }, component: 'in_text' };
    expect(followsPreset(placed, defs)).toBe(true);
    expect(followsPreset({ ...placed, params: { width: 8, style: 'label' } }, defs)).toBe(false);
    const plain = parseComponents('[{ "name": "in8", "base": "input", "width": 8 }]').defs!;
    expect(followsPreset({ ...placed, params: { width: 8 }, component: 'in8' }, plain)).toBe(true);
    expect(followsPreset({ ...placed, params: { width: 8, style: 'label' }, component: 'in8' }, plain)).toBe(true);
  });
});
