import { useEffect, useRef, useState } from 'react';
import { EditorCanvas } from './app/EditorCanvas';
import { ExportDialog } from './app/ExportDialog';
import { Hints, ImportDialog, MOD, VerilogExportDialog } from './app/Dialogs';
import { Inspector } from './app/Inspector';
import { Menu, type MenuItem } from './app/Menu';
import { Palette } from './app/Palette';
import { Breadcrumb, CodePanel, Drawings, FileList, HierarchyTree, LogPanel, RulePanel, TopSelector, ViewToggle } from './app/Panels';
import { EXAMPLES, type ExampleName, useStore } from './app/store';
import { ui } from './app/ui-events';
import { FILE_EXTENSION, FileFormatError, isDrawnKey } from './editor/doc';
import { GRID } from './layout/elk-layout';
import { downloadBlob } from './render/export';
import { THEMES, type ThemeName } from './render/theme';

let started = false;

async function readFiles(list: FileList | File[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of Array.from(list)) {
    if (!/\.(v|sv|vh|svh|verilog)$/i.test(f.name)) continue;
    out[f.name] = await f.text();
  }
  return out;
}

function StatusText() {
  const status = useStore((s) => s.status);
  const progress = useStore((s) => s.progress);
  const elapsed = useStore((s) => s.elapsedMs);
  switch (status) {
    case 'loading': {
      const pct = progress ? Math.floor((100 * progress.loaded) / Math.max(1, progress.total)) : 0;
      const mb = progress ? (progress.total / 1e6).toFixed(0) : '16';
      return <span className="status">Loading Yosys ({mb} MB, first time only)… {pct}%</span>;
    }
    case 'elaborating':
      return <span className="status">Elaborating with Yosys…</span>;
    case 'layout':
      return <span className="status">Laying out…</span>;
    case 'error':
      return <span className="status error-text">Yosys reported an error</span>;
    case 'ready':
    case 'too-large':
      return <span className="status muted">Ready{elapsed ? ` in ${(elapsed / 1000).toFixed(1)} s` : ''}</span>;
    default:
      return null;
  }
}

/** True when the key press belongs to a text field or an open menu. */
function ownsKeys(t: EventTarget | null): boolean {
  const el = (t as Element | null)?.closest?.('input, textarea, select, [role=menu]');
  if (!el) return false;
  return !(el.tagName === 'INPUT' && ['checkbox', 'radio', 'button', 'range', 'file'].includes((el as HTMLInputElement).type));
}

function saveDrawing() {
  const s = useStore.getState();
  const name = (s.path[0]?.module ?? 'drawing').replace(/[^A-Za-z0-9_.-]/g, '_');
  const text = JSON.stringify(s.savedFile(), null, 1);
  downloadBlob(new Blob([text], { type: 'application/json' }), `${name}${FILE_EXTENSION}`);
  s.markSaved();
}

export default function App() {
  // Subscribe to what the frame shows, not to the drawing (which changes on every drag step).
  const s = useStore.getState();
  const status = useStore((x) => x.status);
  const error = useStore((x) => x.error);
  const notice = useStore((x) => x.notice);
  const dirty = useStore((x) => x.dirty);
  const theme = useStore((x) => x.theme);
  const sheet = useStore((x) => x.sheet);
  const path = useStore((x) => x.path);
  const hasLayout = useStore((x) => !!x.layout);
  const bigFlat = useStore((x) => x.bigFlat);
  const codeFile = useStore((x) => x.codeFile);
  const canUndo = useStore((x) => x.past.length > 0);
  const canRedo = useStore((x) => x.future.length > 0);
  const fileInput = useRef<HTMLInputElement>(null);
  const drawingInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  // undefined = automatic: open when Yosys reports an error.
  const [showLog, setShowLog] = useState<boolean>();
  const [showExport, setShowExport] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showVerilog, setShowVerilog] = useState(false);
  const [showHints, setShowHints] = useState(false);
  const [showLibrary, setShowLibrary] = useState(true);

  useEffect(() => {
    if (started) return;
    started = true;
    void (async () => {
      if (!(await useStore.getState().restoreAutosave())) await useStore.getState().loadExample();
    })();
  }, []);

  // Messages fade after a few seconds.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => useStore.getState().setNotice(undefined), 5000);
    return () => clearTimeout(t);
  }, [notice]);

  const openDrawing = () => {
    if (useStore.getState().dirty && !confirm('Open another drawing? Your current work is kept in this browser until you open the new one, but not saved to a file.')) return;
    drawingInput.current?.click();
  };

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (ownsKeys(e.target) || document.querySelector('.modal-backdrop')) return;
      const st = useStore.getState();
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      const take = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (mod && !e.altKey) {
        if (k === 'z' && !e.shiftKey) return take(), st.undo();
        if ((k === 'z' && e.shiftKey) || k === 'y') return take(), st.redo();
        if (k === 's') return take(), saveDrawing();
        if (k === 'o') return take(), openDrawing();
        if (k === 'i') return take(), setShowImport(true);
        if (k === 'a') return take(), st.selectAll();
        if (k === 'c') return st.copy() ? take() : undefined;
        if (k === 'x') return take(), st.cut();
        if (k === 'v') return take(), st.paste();
        if (k === 'd') return take(), st.duplicate();
        return;
      }
      if (e.altKey) return;
      if (e.key === 'Delete' || e.key === 'Backspace') return st.selection.size ? (take(), st.deleteSelection()) : undefined;
      if (e.key === 'Escape') {
        if (st.placing) st.startPlacing(undefined);
        else st.select([]);
        return;
      }
      if (k === 'f') return take(), ui.dispatchEvent(new Event('fit'));
      if (k === 'i') return take(), ui.dispatchEvent(new Event('focus-library'));
      if (k === 'l') return take(), void st.autoLayout();
      if ((e.key === 'Enter' || e.key === 'F2') && st.selection.size === 1) {
        take();
        ui.dispatchEvent(new CustomEvent('rename', { detail: [...st.selection][0] }));
        return;
      }
      const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      const a = arrows[e.key];
      if (a && st.selection.size) {
        take();
        const step = GRID * (e.shiftKey ? 5 : 1);
        const ids = new Set([...st.selection].filter((id) => st.layout?.nodes.some((n) => n.id === id)));
        st.moveSelection(ids, a[0] * step, a[1] * step);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const logVisible = showLog ?? status === 'error';
  const currentModule = path[path.length - 1]?.module ?? 'diagram';
  const drawn = isDrawnKey(sheet);
  const exportLayout = useStore((x) => (showExport ? x.layout : undefined));

  const fileMenu: MenuItem[] = [
    { label: 'New drawing', onSelect: () => s.newDrawing() },
    { label: 'Import Verilog…', shortcut: `${MOD}+I`, onSelect: () => setShowImport(true) },
    { label: 'Open Verilog files…', onSelect: () => fileInput.current?.click() },
    {
      label: 'Load example',
      submenu: (Object.keys(EXAMPLES) as ExampleName[]).map((k) => ({ label: EXAMPLES[k].label, onSelect: () => void s.loadExample(k) })),
    },
    { label: 'Open drawing…', shortcut: `${MOD}+O`, onSelect: openDrawing },
    { label: 'Save drawing', shortcut: `${MOD}+S`, onSelect: saveDrawing },
    { label: 'Export image (SVG / PNG)…', onSelect: () => useStore.getState().layout && setShowExport(true) },
    { label: 'Export Verilog…', onSelect: () => useStore.getState().netlist && setShowVerilog(true) },
  ];
  const editMenu: MenuItem[] = [
    { label: 'Undo', shortcut: `${MOD}+Z`, onSelect: () => s.undo() },
    { label: 'Redo', shortcut: `${MOD}+Shift+Z`, onSelect: () => s.redo() },
    { label: 'Cut', shortcut: `${MOD}+X`, onSelect: () => s.cut() },
    { label: 'Copy', shortcut: `${MOD}+C`, onSelect: () => void s.copy() },
    { label: 'Paste', shortcut: `${MOD}+V`, onSelect: () => s.paste() },
    { label: 'Duplicate', shortcut: `${MOD}+D`, onSelect: () => s.duplicate() },
    { label: 'Delete', shortcut: 'Del', onSelect: () => s.deleteSelection() },
    { label: 'Select all', shortcut: `${MOD}+A`, onSelect: () => s.selectAll() },
    { label: 'Auto layout', shortcut: 'L', onSelect: () => void s.autoLayout() },
  ];

  return (
    <div
      className="app"
      onDragEnter={(e) => {
        if (!Array.from(e.dataTransfer.types).includes('Files')) return;
        dragDepth.current++;
        setDragging(true);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => {
        // dragenter/dragleave fire for every child element; count them to know when the pointer left the window.
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={async (e) => {
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        const list = Array.from(e.dataTransfer.files);
        const saved = list.find((f) => f.name.endsWith('.json'));
        if (saved) {
          try {
            await s.loadSaved(await saved.text());
          } catch (err) {
            s.setNotice(err instanceof FileFormatError ? err.message : String(err));
          }
          return;
        }
        const files = await readFiles(list);
        if (Object.keys(files).length) await s.setFiles(files, false);
      }}
    >
      <header className="toolbar">
        <span className="brand">Digital Canvas</span>
        <Menu label="File" items={fileMenu} />
        <Menu label="Edit" items={editMenu} />
        <button onClick={() => s.undo()} disabled={!canUndo} title={`Undo (${MOD}+Z)`}>
          ↶
        </button>
        <button onClick={() => s.redo()} disabled={!canRedo} title={`Redo (${MOD}+Shift+Z)`}>
          ↷
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          accept=".v,.sv,.vh,.svh"
          hidden
          onChange={async (e) => {
            const files = await readFiles(e.target.files ?? []);
            e.target.value = '';
            if (Object.keys(files).length) await s.setFiles(files, true);
          }}
        />
        <input
          ref={drawingInput}
          type="file"
          accept=".json"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            try {
              await s.loadSaved(await f.text());
            } catch (err) {
              s.setNotice(err instanceof FileFormatError ? err.message : String(err));
            }
          }}
        />
        <TopSelector />
        <span className="spacer" />
        <StatusText />
        {dirty && <span className="small muted" title="Kept in this browser. Use File › Save drawing to keep a file.">Unsaved</span>}
        <label className="theme-select">
          Theme:
          <select value={theme} onChange={(e) => s.setTheme(e.target.value as ThemeName)}>
            {(Object.keys(THEMES) as ThemeName[]).map((t) => (
              <option key={t} value={t}>
                {THEMES[t].label}
              </option>
            ))}
          </select>
        </label>
        <button disabled={!hasLayout} onClick={() => setShowExport(true)}>
          Export…
        </button>
        <button onClick={() => setShowLog(!logVisible)}>Log</button>
        <button onClick={() => setShowHints(!showHints)} title="Keyboard and mouse shortcuts">
          Shortcuts
        </button>
      </header>

      <div className="main">
        <aside className="sidebar">
          <section>
            <h3>Files</h3>
            <FileList />
          </section>
          <section>
            <h3>Hierarchy</h3>
            <HierarchyTree />
          </section>
          <section>
            <h3>Drawings</h3>
            <Drawings />
          </section>
          <section>
            <h3>Drawing rules</h3>
            <RulePanel />
          </section>
          <section className="help small muted">
            <p>
              Draw with the symbol library, or import Verilog and edit what it draws. Drag from a pin to wire it. Double-click a block to open it.
              Click a symbol to find its Verilog line.
            </p>
            <p>Everything runs in your browser. Your Verilog is never uploaded; your work is kept in this browser and in files you save.</p>
          </section>
        </aside>

        <section className="center">
          <div className="center-head">
            <button className={`library-toggle ${showLibrary ? 'on' : ''}`} onClick={() => setShowLibrary(!showLibrary)} title="Show or hide the symbol library">
              Library
            </button>
            {!drawn && <ViewToggle />}
            <Breadcrumb />
          </div>
          {hasLayout && status === 'error' && !drawn && (
            <div className="error-banner">
              <b>Yosys could not elaborate the current files.</b> {error} <span className="muted">The diagram below is from the last successful run.</span>
            </div>
          )}
          <div className="center-body">
            {showLibrary && hasLayout && <Palette />}
            {hasLayout ? (
              <EditorCanvas />
            ) : (
              <div className="canvas empty">
                {status === 'too-large' && bigFlat ? (
                  <div className="notice-box">
                    <b>The full circuit has {bigFlat.cells.toLocaleString()} cells.</b>
                    <p className="muted">Drawing it can take a while. The block diagram shows the same circuit in smaller pieces.</p>
                    <div className="notice-actions">
                      <button className="primary" onClick={() => s.setViewMode('blocks')}>
                        Back to Block diagram
                      </button>
                      <button onClick={() => s.drawBigFlat()}>Draw anyway</button>
                    </div>
                  </div>
                ) : status === 'error' ? (
                  <div className="error-box">
                    <b>Could not elaborate the design.</b>
                    <p>{error}</p>
                  </div>
                ) : status === 'idle' ? (
                  <div className="notice-box">
                    <b>Start a circuit</b>
                    <p className="muted">Draw one by hand, or import Verilog and edit the diagram it makes.</p>
                    <div className="notice-actions">
                      <button className="primary" onClick={() => s.newDrawing()}>
                        New drawing
                      </button>
                      <button onClick={() => setShowImport(true)}>Import Verilog…</button>
                      <button onClick={() => void s.loadExample()}>Load example</button>
                    </div>
                  </div>
                ) : (
                  <p className="muted">
                    <StatusText />
                  </p>
                )}
              </div>
            )}
          </div>
          {notice && (
            <div className="notice-toast" role="status" onClick={() => s.setNotice(undefined)}>
              {notice}
            </div>
          )}
          {showHints && <Hints onClose={() => setShowHints(false)} />}
          {logVisible && <LogPanel onClose={() => setShowLog(false)} />}
        </section>

        <aside className="code-pane">
          <Inspector onExportVerilog={() => setShowVerilog(true)} />
          <h3>
            Source <span className="muted small">{codeFile}</span>
          </h3>
          <CodePanel />
        </aside>
      </div>

      {dragging && <div className="drop-overlay">Drop Verilog files to add them, or a .dcanvas.json drawing to open it</div>}
      {showExport && exportLayout && (
        <ExportDialog layout={exportLayout} initialTheme={theme} name={currentModule.replace(/[^A-Za-z0-9_.-]/g, '_')} onClose={() => setShowExport(false)} />
      )}
      {showImport && <ImportDialog onClose={() => setShowImport(false)} />}
      {showVerilog && <VerilogExportDialog onClose={() => setShowVerilog(false)} />}
    </div>
  );
}
