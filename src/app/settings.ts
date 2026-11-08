/**
 * What the JSON window (SettingsPopup) edits for a symbol, and the event that opens it: double-clicking a
 * symbol, a part's block or a component of the library, or Properties' button.
 */
import type { LNode } from '../layout/elk-layout';
import { type ComponentDef, PRESET_BASES, componentJson, partNamed, symbolJson } from '../editor/components';
import { SYMBOL_BY_KEY, type SymKey } from '../editor/symbols';
import type { EditorState } from './store';
import { ui } from './ui-events';

/** What the window edits: a symbol of the sheet shown, or a component of the library. */
export type SettingsTarget = { node: string } | { component: string };

/** What asks for the window: `edit-settings` on ui, with the point (in the page) to show it next to. */
export interface SettingsRequest {
  target: SettingsTarget;
  x: number;
  y: number;
}

/**
 * The part of the library a block on the sheet is an instance of: none when a drawing or a Verilog module of
 * that name defines the block now (it is opened, not edited).
 */
export function partOfBlock(s: EditorState, node: Pick<LNode, 'moduleName'>): ComponentDef | undefined {
  const name = node.moduleName;
  if (!name || s.doc.drawn.includes(name) || s.viewDesign()?.modules[name]) return undefined;
  return partNamed(s.doc.components, name);
}

/**
 * What the window edits for a symbol of the sheet shown: its settings, when it is a symbol of the library that has
 * any; the part, for a part's block. None for what has no settings of its own (a note, what Verilog draws, a block
 * of a module).
 */
export function settingsOf(s: EditorState, id: string): SettingsTarget | undefined {
  const user = s.doc.sheets[s.sheet]?.nodes.find((n) => n.id === id);
  if (!user) return undefined;
  if (PRESET_BASES.includes(user.sym)) return { node: id };
  const node = s.layout?.nodes.find((n) => n.id === id);
  const part = node && partOfBlock(s, node);
  return part ? { component: part.name } : undefined;
}

/**
 * What double-clicking a symbol edits: as settingsOf, but a pin (input, output, inout) is renamed instead, as a
 * note or a wire is (its width is in Properties).
 */
export function doubleClickSettings(s: EditorState, id: string): SettingsTarget | undefined {
  const t = settingsOf(s, id);
  const user = s.doc.sheets[s.sheet]?.nodes.find((n) => n.id === id);
  if (t && 'node' in t && user && SYMBOL_BY_KEY[user.sym]?.named) return undefined;
  return t;
}

/** Open the window for `target`, next to the point (in the page) where the user asked for it. */
export function openSettings(target: SettingsTarget, x: number, y: number): void {
  ui.dispatchEvent(new CustomEvent<SettingsRequest>('edit-settings', { detail: { target, x, y } }));
}

/** What the window was opened on, as it was then (the window is modal: nothing else changes while it is open). */
export type Subject = { kind: 'node'; id: string; sym: SymKey; text: string } | { kind: 'component'; def: ComponentDef; text: string };

/** What the window shows for `target`: none when there is no such symbol or component (any more). */
export function subjectOf(s: EditorState, target: SettingsTarget): Subject | undefined {
  if ('node' in target) {
    const user = s.doc.sheets[s.sheet]?.nodes.find((n) => n.id === target.node);
    return user && PRESET_BASES.includes(user.sym) ? { kind: 'node', id: user.id, sym: user.sym, text: symbolJson(user.sym, user.params) } : undefined;
  }
  const def = s.doc.components?.find((c) => c.name === target.component);
  return def && { kind: 'component', def, text: componentJson(def) };
}
