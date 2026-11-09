import { useEffect, useRef, useState } from 'react';
import { EditorCanvas } from './app/EditorCanvas';
import { ExportDialog } from './app/ExportDialog';
import { Hints, ImportDialog, MOD } from './app/Dialogs';
import { Inspector } from './app/Inspector';
import { Menu, type MenuItem } from './app/Menu';
import { Palette } from './app/Palette';
import { SettingsPopup } from './app/SettingsPopup';
import { Breadcrumb, Drawings, FileList, HierarchyTree, LogPanel, TopSelector, ViewToggle } from './app/Panels';
import { AUTOSAVE_KEY, EXAMPLES, type ExampleName, type ImportPlan, planDrop, planOpen, useStore } from './app/store';
import { ui } from './app/ui-events';
import { FILE_EXTENSION, FileFormatError, isDrawnKey } from './editor/doc';
import { GRID } from './layout/elk-layout';
import { downloadBlob } from './render/export';
import { type YosysErrorKind, describeStatus, preloadYosys } from './yosys/client';

let started = false;

/** How an error reads in the status bar, over an older diagram, and in place of a diagram. */
const ERROR_TITLES: Record<YosysErrorKind, { status: string; banner: string; box: string }> = {
  design: { status: 'Yosys reported an error', banner: 'Yosys could not elaborate the current files.', box: 'Could not elaborate the design.' },
  timeout: { status: 'Yosys did not finish', banner: 'Yosys did not finish the current files.', box: 'Yosys did not finish the design.' },
  load: { status: 'Yosys could not load', banner: 'Yosys could not be loaded.', box: 'Could not load Yosys.' },
};


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
  const yosys = useStore((s) => s.yosys);
  const errorKind = useStore((s) => s.errorKind);
  const elapsed = useStore((s) => s.elapsedMs);
  switch (status) {
    case 'loading':
      return <span className="status">{yosys ? describeStatus(yosys) : 'Loading Yosys…'}</span>;
    case 'elaborating':
      return <span className="status">Elaborating with Yosys…</span>;
    case 'layout':
      return <span className="status">Laying out…</span>;
    case 'error':
      return <span className="status error-text">{ERROR_TITLES[errorKind ?? 'design'].status}</span>;
    case 'ready':
    case 'too-large':
      return <span className="status muted">Ready{elapsed ? ` in ${(elapsed / 1000).toFixed(1)} s` : ''}</span>;
    default:
      return null;
  }
}

/** True when the key press belongs to a text field or an open menu. */
function ownsKeys(t: EventTarget | null): boolean {
  const el = (t as Element | null)?.closest?.('input, textarea, select, [role=menu], [contenteditable]:not([contenteditable="false"])');
  if (!el) return false;
  return !(el.tagName === 'INPUT' && ['checkbox', 'radio', 'button', 'range', 'file'].includes((el as HTMLInputElement).type));
}

/** The panes that show text to read and copy (the Yosys log). */
const TEXT_PANES = '.log pre';

/**
 * The text pane the user works in, when not the drawing: the pane that has
 * the focus, or the one where text is selected. Copy, select all and the
 * editing keys then act on that text, not on the selected symbols.
 */
function textInUse(t: EventTarget | null): Element | undefined {
  const target = t instanceof Element ? t : undefined;
  if (target?.closest('.canvas')) return undefined;
  const pane = target?.closest(TEXT_PANES);
  if (pane) return pane;
  // Selected text counts only while nothing else has the focus. A click on a button (the hierarchy,
  // the library, the toolbar) moves the focus but leaves the text selected: the keys are the drawing's again.
  if (target && target !== document.body && target !== document.documentElement) return undefined;
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed) return undefined;
  const at = sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement;
  return at?.closest(TEXT_PANES) ?? document.body;
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
  const errorKind = useStore((x) => x.errorKind);
  const notice = useStore((x) => x.notice);
  const otherTab = useStore((x) => x.autosavePaused);
  const dirty = useStore((x) => x.dirty);
  const sheet = useStore((x) => x.sheet);
  const path = useStore((x) => x.path);
  const hasLayout = useStore((x) => !!x.layout);
  const bigFlat = useStore((x) => x.bigFlat);
  const canUndo = useStore((x) => x.past.length > 0);
  const canRedo = useStore((x) => x.future.length > 0);
  const fileInput = useRef<HTMLInputElement>(null);
  const drawingInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  // undefined = automatic: open when Yosys reports an error.
  const [showLog, setShowLog] = useState<boolean>();
  const [showExport, setShowExport] = useState(false);
  /** The Import dialog, with the code of a dropped file it opens with (see dropVerilog). */
  const [showImport, setShowImport] = useState<boolean | { name: string; code: string }>(false);
  const [showHints, setShowHints] = useState(false);
  const [showLibrary, setShowLibrary] = useState(true);

  useEffect(() => {
    if (started) return;
    started = true;
    // Yosys takes a while to download the first time: start now, even if the work needs it only later.
    preloadYosys();
    void (async () => {
      if (!(await useStore.getState().restoreAutosave())) await useStore.getState().loadExample();
    })();
  }, []);

  // The browser keeps one copy of the work for all its tabs. When another tab writes other work there,
  // this tab stops writing (it would overwrite that work unseen) and asks which to keep. A copy still
  // waiting to be written goes when the page is closed or reloaded, or the last edit before that would be lost.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === AUTOSAVE_KEY && e.newValue !== null) useStore.getState().otherTabSaved(e.newValue);
    };
    const flush = () => useStore.getState().flushAutosave();
    window.addEventListener('storage', onStorage);
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', flush);
    };
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
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      const take = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      const modal = !!document.querySelector('.modal-backdrop');
      // Save and Open are the app's wherever the focus is: the browser's own (save or open the page) is never wanted.
      if (mod && !e.altKey && (k === 's' || k === 'o')) {
        take();
        // A name being typed in the Inspector is committed first (its fields commit when they lose the focus), so the file has it.
        if (!modal && ownsKeys(e.target) && e.target instanceof HTMLElement) e.target.blur();
        if (k === 's') saveDrawing();
        // Not from a dialog: the drawing would replace what the dialog is about.
        else if (!modal) openDrawing();
        return;
      }
      if (ownsKeys(e.target) || modal) return;
      const st = useStore.getState();
      const text = textInUse(e.target);
      if (mod && !e.altKey) {
        if (k === 'z' && !e.shiftKey) return take(), st.undo();
        if ((k === 'z' && e.shiftKey) || k === 'y') return take(), st.redo();
        if (k === 'i') return take(), setShowImport(true);
        if (text) {
          // Select all selects the pane's text, not the whole page; copy and the rest are the browser's.
          if (k === 'a' && text !== document.body) {
            take();
            document.getSelection()?.selectAllChildren(text);
          }
          return;
        }
        if (k === 'a') return take(), st.selectAll();
        if (k === 'c') return st.copy() ? take() : undefined;
        if (k === 'x') return take(), st.cut();
        // The canvas pastes: on another sheet the copy goes where the user looks, which only the canvas knows.
        if (k === 'v') return take(), ui.dispatchEvent(new Event('paste'));
        if (k === 'd') return take(), st.duplicate();
        return;
      }
      if (e.altKey) return;
      if (e.key === 'Escape') {
        if (st.placing) st.startPlacing(undefined);
        else st.select([]);
        return;
      }
      if (k === 'f') return take(), ui.dispatchEvent(new Event('fit'));
      if (k === 'i') return take(), ui.dispatchEvent(new Event('focus-library'));
      // The keys below change the drawing: not while the user reads or selects text in a pane.
      if (text) return;
      if (e.key === 'Delete' || e.key === 'Backspace') return st.selection.size ? (take(), st.deleteSelection()) : undefined;
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

  /**
   * Open Verilog files as a new version of the open ones (see planImport): a file of the same name keeps the
   * edits, as in Import Verilog, and open files of other names that the files cover or share a module with
   * change too, which the notice says.
   */
  const updateVerilog = async (files: Record<string, string>, plan: ImportPlan) => {
    const st = useStore.getState();
    const before = st.notice;
    await st.setFiles(files, false, { newVersion: true });
    const { replaced, trimmed } = plan;
    if (!replaced.length && !trimmed.length) return;
    const names = Object.keys(files).join(', ');
    const one = Object.keys(files).length === 1;
    const said = [
      replaced.length
        ? `${names} ${one ? 'replaces' : 'replace'} ${replaced.join(', ')}, which ${replaced.length === 1 ? 'declares' : 'declare'} only modules ${one ? 'it declares' : 'they declare'} too.`
        : '',
      trimmed.length ? `The modules ${names} ${one ? 'declares' : 'declare'} again are cut out of ${trimmed.join(', ')}.` : '',
      'Undo brings the old files back.',
    ]
      .filter(Boolean)
      .join(' ');
    // What the import said itself (the module shown, a drawing renamed, edits that follow new parameters) stays.
    const now = useStore.getState().notice;
    st.setNotice([said, now !== before ? now : undefined].filter(Boolean).join(' '));
  };

  /** Dropped Verilog files (see planDrop): never a silent replacement of an open file matched only by its module names. */
  const dropVerilog = async (files: Record<string, string>) => {
    const st = useStore.getState();
    const drop = planDrop(st.files, st.putAside, files);
    if (drop.kind === 'ask') {
      setShowImport({ name: drop.name, code: drop.code });
      return;
    }
    if (drop.kind === 'update') return updateVerilog(files, drop.plan);
    const before = st.notice;
    const names = Object.keys(files).join(', ');
    await st.setFiles(files, false);
    const them = drop.twice.length === 1 ? 'it' : 'them';
    const said = `Added ${names}. ${drop.twice.join(', ')} ${drop.twice.length === 1 ? 'is' : 'are'} declared in an open file too: Yosys reports ${them} declared twice until one of the files no longer declares ${them} (Import Verilog can replace ${them} instead).`;
    // What the import said itself (the module shown, a drawing renamed) stays.
    const now = useStore.getState().notice;
    st.setNotice([said, now !== before ? now : undefined].filter(Boolean).join(' '));
  };

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
  ];
  const editMenu: MenuItem[] = [
    { label: 'Undo', shortcut: `${MOD}+Z`, onSelect: () => s.undo() },
    { label: 'Redo', shortcut: `${MOD}+Shift+Z`, onSelect: () => s.redo() },
    { label: 'Cut', shortcut: `${MOD}+X`, onSelect: () => s.cut() },
    { label: 'Copy', shortcut: `${MOD}+C`, onSelect: () => void s.copy() },
    { label: 'Paste', shortcut: `${MOD}+V`, onSelect: () => ui.dispatchEvent(new Event('paste')) },
    { label: 'Duplicate', shortcut: `${MOD}+D`, onSelect: () => s.duplicate() },
    { label: 'Delete', shortcut: 'Del', onSelect: () => s.deleteSelection() },
    { label: 'Select all', shortcut: `${MOD}+A`, onSelect: () => s.selectAll() },
    { label: 'Auto layout', shortcut: 'L', onSelect: () => void s.autoLayout() },
  ];

  return (
    <div
      className="app"
      // Names are code: some fonts' contextual alternates draw the x of ram4x8 as ×, which reads as another name.
      style={{ fontFeatureSettings: '"calt" 0' }}
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
        if (Object.keys(files).length) await dropVerilog(files);
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
            if (Object.keys(files).length === 0) return;
            // New versions of open files update those, and the other open files stay (see planOpen). Files of other
            // names only are another design, opened in place of the open files.
            const st = useStore.getState();
            const plan = planOpen(st.files, st.putAside, files);
            if (plan) await updateVerilog(files, plan);
            else await s.setFiles(files, true);
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
        <button disabled={!hasLayout} onClick={() => setShowExport(true)}>
          Export…
        </button>
        <button onClick={() => setShowLog(!logVisible)}>Log</button>
        <button onClick={() => setShowHints(!showHints)} title="Keys and mouse actions of the editor">
          Hints
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
        </aside>

        <section className="center">
          <div className="center-head">
            <button className={`library-toggle ${showLibrary ? 'on' : ''}`} onClick={() => setShowLibrary(!showLibrary)} title="Show or hide the symbol library">
              Library
            </button>
            {!drawn && <ViewToggle />}
            <Breadcrumb />
          </div>
          {otherTab && (
            <div className="error-banner" role="alert">
              <b>Another tab saved its work in this browser.</b> This tab no longer keeps a copy here, so that it does not overwrite that work: close or
              reload it and its changes are lost unless you save them (File › Save drawing).{' '}
              <button
                onClick={() => {
                  if (!useStore.getState().dirty || confirm("Open the other tab's work here? The work in this tab is lost unless you saved it to a file.")) {
                    void s.restoreAutosave();
                  }
                }}
              >
                Open the other tab's work
              </button>{' '}
              <button onClick={() => s.keepThisTab()} title="The browser keeps this tab's work instead; the other tab then stops keeping its own">
                Keep this tab's work
              </button>
            </div>
          )}
          {hasLayout && status === 'error' && !drawn && (
            <div className="error-banner">
              <b>{ERROR_TITLES[errorKind ?? 'design'].banner}</b> {error} <span className="muted">The diagram below is from the last successful run.</span>
              {errorKind === 'load' && (
                <>
                  {' '}
                  <button onClick={() => void s.rebuild()}>Try again</button>
                </>
              )}
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
                    <b>{ERROR_TITLES[errorKind ?? 'design'].box}</b>
                    <p>{error}</p>
                    {errorKind === 'load' && <button onClick={() => void s.rebuild()}>Try again</button>}
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

        <aside className="props-pane">
          <Inspector />
        </aside>
      </div>

      {dragging && <div className="drop-overlay">Drop Verilog files to add them, or a .dcanvas.json drawing to open it</div>}
      {showExport && exportLayout && (
        <ExportDialog layout={exportLayout} name={currentModule.replace(/[^A-Za-z0-9_.-]/g, '_')} onClose={() => setShowExport(false)} />
      )}
      {showImport && <ImportDialog initial={showImport === true ? undefined : showImport} onClose={() => setShowImport(false)} />}
      <SettingsPopup />
    </div>
  );
}
