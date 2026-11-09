import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Drawings, FileList } from './Panels';
import { useStore } from './store';

describe('FileList', () => {
  it('lists the open files by name, each with a Remove button (no file is shown as source)', () => {
    // On the server the list reads the store's initial state (the server snapshot of useSyncExternalStore).
    Object.assign(useStore.getInitialState(), { files: { 'a.v': 'module a; endmodule', 'b.v': 'module b; endmodule' } });
    const html = renderToStaticMarkup(<FileList />);
    expect([...html.matchAll(/<span class="file-name" title="([^"]+)">/g)].map((m) => m[1])).toEqual(['a.v', 'b.v']);
    expect([...html.matchAll(/title="Remove ([^"]+)"/g)].map((m) => m[1])).toEqual(['a.v', 'b.v']);
    expect(html).not.toContain('active');
  });
});

describe('Drawings', () => {
  it('lists the drawings, each with a Delete (×) button; the open one is marked', () => {
    Object.assign(useStore.getInitialState(), {
      doc: { drawn: ['alu', 'top'], sheets: {} },
      path: [{ instance: 'top', module: 'top', drawn: true }],
    });
    const html = renderToStaticMarkup(<Drawings />);
    expect([...html.matchAll(/<li data-drawing="([^"]+)"/g)].map((m) => m[1])).toEqual(['alu', 'top']);
    expect([...html.matchAll(/aria-label="Delete ([^"]+)"/g)].map((m) => m[1])).toEqual(['alu', 'top']);
    expect(html).toContain('<li data-drawing="top" class="active">');
    expect(html).toContain('tabindex="-1"');
  });
});
