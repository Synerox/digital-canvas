import { describe, expect, it } from 'vitest';
import { deleteDrawingAsking, deleteQuestion, drawingKey, entryAfterDelete, pasteTarget } from './drawing-list';
import { emptyEdits } from '../editor/doc';
import { newUserNode } from '../editor/symbols';
import { useStore } from './store';

const key = (k: string, mods: { ctrl?: boolean; meta?: boolean; alt?: boolean } = {}) =>
  drawingKey({ key: k, ctrlKey: !!mods.ctrl, metaKey: !!mods.meta, altKey: !!mods.alt });

describe('keys of the Drawings list', () => {
  it('takes Delete, Backspace and Ctrl/⌘ + C, X, V, D for the drawing; leaves the app its other keys', () => {
    expect([key('Delete'), key('Backspace')]).toEqual(['delete', 'delete']);
    expect(['c', 'x', 'v', 'd'].map((k) => key(k, { ctrl: true }))).toEqual(['copy', 'cut', 'paste', 'duplicate']);
    expect(['C', 'v'].map((k) => key(k, { meta: true }))).toEqual(['copy', 'paste']);
    // Select all is the canvas's: the canvas takes the focus first.
    expect(key('a', { ctrl: true })).toBe('canvas');
    expect([key('ArrowUp'), key('ArrowDown'), key('Home'), key('End'), key('Enter')]).toEqual(['prev', 'next', 'first', 'last', 'open']);
    // The arrows that nudge symbols do nothing here.
    expect([key('ArrowLeft'), key('ArrowRight')]).toEqual(['none', 'none']);
    // Undo, save, open, import, and the canvas's letter keys stay the app's.
    for (const k of ['z', 'y', 's', 'o', 'i']) expect(key(k, { ctrl: true })).toBeUndefined();
    for (const k of ['f', 'l', 'i', 'Escape', 'F2', ' ']) expect(key(k)).toBeUndefined();
    expect(key('c', { ctrl: true, alt: true })).toBeUndefined();
    expect(key('Delete', { alt: true })).toBeUndefined();
  });

  it('moves the focus to the next entry after a delete, or to the one before the last', () => {
    expect(entryAfterDelete(['a', 'b', 'c'], 'a')).toBe('b');
    expect(entryAfterDelete(['a', 'b', 'c'], 'c')).toBe('b');
    expect(entryAfterDelete(['a'], 'a')).toBeUndefined();
    expect(entryAfterDelete(['a'], 'x')).toBeUndefined();
  });
});

describe('deleting a drawing from the list', () => {
  const setDoc = () => {
    const block = { ...newUserNode('u:1', 'block'), params: { module: 'leaf' } };
    useStore.setState({
      doc: { drawn: ['leaf', 'top', 'lone'], sheets: { 'd:leaf': emptyEdits(), 'd:top': { ...emptyEdits(), nodes: [block] }, 'd:lone': emptyEdits() } },
      path: [],
      sheet: '',
    });
  };

  it('asks only when other sheets use the drawing as a block, and keeps it when the answer is no', () => {
    setDoc();
    expect(deleteQuestion('lone')).toBeUndefined();
    expect(deleteQuestion('leaf')).toMatch(/used as a block on top; those blocks will lose their pins/);
    const asked: string[] = [];
    expect(deleteDrawingAsking('leaf', { ask: (q) => (asked.push(q), false) })).toBe(false);
    expect(useStore.getState().doc.drawn).toEqual(['leaf', 'top', 'lone']);
    expect(deleteDrawingAsking('lone', { ask: (q) => (asked.push(q), false) })).toBe(true);
    expect(asked.length).toBe(1);
    expect(useStore.getState().doc.drawn).toEqual(['leaf', 'top']);
    expect(deleteDrawingAsking('leaf', { ask: () => true })).toBe(true);
    expect(useStore.getState().doc.drawn).toEqual(['top']);
  });

  it('Cut copies the drawing first: Paste brings it back under its name', () => {
    setDoc();
    expect(deleteDrawingAsking('lone', { cut: true })).toBe(true);
    expect(useStore.getState().notice).toMatch(/^Cut lone: .+V pastes it back\.$/);
    expect(pasteTarget()).toBe('drawing');
    expect(useStore.getState().pasteDrawing()).toBe('lone');
    expect(useStore.getState().doc.drawn).toEqual(['leaf', 'top', 'lone']);
  });
});
