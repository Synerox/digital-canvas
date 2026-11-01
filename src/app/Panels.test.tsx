import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CodePanel } from './Panels';
import { useStore } from './store';

describe('CodePanel', () => {
  it('marks only lines the file has, whatever range a damaged drawing file gives', () => {
    const text = Array.from({ length: 30 }, (_, i) => `// line ${i + 1}`).join('\n');
    const range = (startLine: number, endLine: number) => ({ file: 'a.v', startLine, startCol: 1, endLine, endCol: 1 });
    // On the server the panel reads the store's initial state (the server snapshot of useSyncExternalStore).
    Object.assign(useStore.getInitialState(), { files: { 'a.v': text }, codeFile: 'a.v', codeRanges: [range(25, 2e9), range(-3, 2)] });
    const html = renderToStaticMarkup(<CodePanel />);
    const marked = [...html.matchAll(/data-line="(\d+)" class="code-line marked"/g)].map((m) => Number(m[1]));
    expect(marked).toEqual([1, 2, 25, 26, 27, 28, 29, 30]);
  });
});
