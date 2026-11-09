/**
 * The Drawings list in the sidebar: what its keys do, and deleting a drawing from it.
 *
 * A click on a drawing opens it and gives its entry the keyboard focus: the
 * entry is then selected, and Delete, Ctrl+C, Ctrl+X, Ctrl+V and Ctrl+D act on
 * the drawing, not on the symbols of the canvas (whose keys are the same; see
 * App). A click on the canvas takes the focus back.
 */
import { MOD } from './Dialogs';
import { clipboardHolds, sheetsUsing, useStore } from './store';

export type DrawingKey =
  /** Delete the drawing (asking first when other sheets use it as a block). */
  | 'delete'
  | 'copy'
  /** Copy, then delete. */
  | 'cut'
  /** Paste the copied drawing; with copied symbols, the canvas pastes them (see pasteTarget). */
  | 'paste'
  | 'duplicate'
  /** Move the focus to another entry. */
  | 'prev'
  | 'next'
  | 'first'
  | 'last'
  | 'open'
  /** A key of the canvas (select all): the canvas takes the focus, then the key. */
  | 'canvas'
  /** Taken, and nothing happens (the arrows that would nudge symbols). */
  | 'none';

interface Keys {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

/**
 * What a key pressed on a drawing's entry does. Undefined: the key is the app's as anywhere else (undo, save,
 * open, import, the letter keys of the canvas).
 */
export function drawingKey(e: Keys): DrawingKey | undefined {
  if (e.altKey) return undefined;
  if (e.ctrlKey || e.metaKey) {
    const keys: Record<string, DrawingKey> = { c: 'copy', x: 'cut', v: 'paste', d: 'duplicate', a: 'canvas' };
    return keys[e.key.toLowerCase()];
  }
  const keys: Record<string, DrawingKey> = {
    Delete: 'delete',
    Backspace: 'delete',
    ArrowUp: 'prev',
    ArrowDown: 'next',
    Home: 'first',
    End: 'last',
    Enter: 'open',
    ArrowLeft: 'none',
    ArrowRight: 'none',
  };
  return keys[e.key];
}

/**
 * Where Paste puts what Copy took last: a drawing into the Drawings list (as a new drawing), symbols onto the
 * canvas. Nothing when nothing was copied.
 */
export function pasteTarget(): 'drawing' | 'canvas' | undefined {
  const what = clipboardHolds();
  return what === 'drawing' ? 'drawing' : what === 'symbols' ? 'canvas' : undefined;
}

/** The question to ask before deleting a drawing, or nothing: only when blocks on other sheets use it (they lose their pins). */
export function deleteQuestion(name: string): string | undefined {
  const users = sheetsUsing(useStore.getState().doc, name);
  return users.length ? `Delete the drawing ${name}? It is used as a block on ${users.join(', ')}; those blocks will lose their pins. (You can undo this.)` : undefined;
}

/**
 * Delete a drawing, asking first when other sheets use it (Undo brings it back, which the notice says).
 * `cut`: copy it first, so Paste brings it back. Returns whether it was deleted.
 */
export function deleteDrawingAsking(name: string, opts: { cut?: boolean; ask?: (q: string) => boolean } = {}): boolean {
  const ask = opts.ask ?? ((q: string) => confirm(q));
  const q = deleteQuestion(name);
  if (q && !ask(q)) return false;
  const s = useStore.getState();
  if (opts.cut) s.copyDrawing(name);
  s.deleteDrawing(name);
  if (opts.cut) s.setNotice(`Cut ${name}: ${MOD}+V pastes it back.`);
  return true;
}

/** The entry that takes the focus after `name` goes from `list`: the next one, or else the one before. */
export function entryAfterDelete(list: readonly string[], name: string): string | undefined {
  const i = list.indexOf(name);
  if (i < 0) return undefined;
  return list[i + 1] ?? list[i - 1];
}
