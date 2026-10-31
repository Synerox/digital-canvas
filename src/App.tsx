import { useEffect, useRef, useState } from 'react';
import { Canvas } from './app/Canvas';
import { ExportDialog } from './app/ExportDialog';
import { Breadcrumb, CodePanel, FileList, HierarchyTree, LogPanel, RulePanel, TopSelector } from './app/Panels';
import { useStore } from './app/store';
import { THEMES, type ThemeName } from './render/theme';

let exampleLoaded = false;

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
      return <span className="status muted">Ready{elapsed ? ` in ${(elapsed / 1000).toFixed(1)} s` : ''}</span>;
    default:
      return null;
  }
}

export default function App() {
  const s = useStore();
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  // undefined = automatic: open when Yosys reports an error.
  const [showLog, setShowLog] = useState<boolean>();
  const [showExport, setShowExport] = useState(false);
  const theme = THEMES[s.theme];

  useEffect(() => {
    if (exampleLoaded) return;
    exampleLoaded = true;
    void useStore.getState().loadExample();
  }, []);


  const openNode = (id: string) => {
    const n = s.layout?.nodes.find((x) => x.id === id);
    if (n?.kind === 'instance' && n.moduleName && n.instanceName && s.design?.modules[n.moduleName]) {
      void s.enterInstance(n.instanceName, n.moduleName);
    }
  };

  const logVisible = showLog ?? s.status === 'error';
  const selectedNode = s.layout?.nodes.find((n) => n.id === s.selected);
  const currentModule = s.path[s.path.length - 1]?.module ?? 'diagram';

  return (
    <div
      className="app"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={async (e) => {
        e.preventDefault();
        setDragging(false);
        const files = await readFiles(e.dataTransfer.files);
        if (Object.keys(files).length) await s.setFiles(files, false);
      }}
    >
      <header className="toolbar">
        <span className="brand">Digital Canvas</span>
        <button onClick={() => fileInput.current?.click()}>Open Verilog…</button>
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
        <button onClick={() => s.loadExample()}>Load example</button>
        <TopSelector />
        <span className="spacer" />
        <StatusText />
        <label className="theme-select">
          Theme:
          <select value={s.theme} onChange={(e) => s.setTheme(e.target.value as ThemeName)}>
            {(Object.keys(THEMES) as ThemeName[]).map((t) => (
              <option key={t} value={t}>
                {THEMES[t].label}
              </option>
            ))}
          </select>
        </label>
        <button disabled={!s.layout} onClick={() => setShowExport(true)}>
          Export…
        </button>
        <button onClick={() => setShowLog(!logVisible)}>Log</button>
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
            <h3>Drawing rules</h3>
            <RulePanel />
          </section>
          <section className="help small muted">
            <p>Double-click a block to open the sub-module. Click a symbol to find its Verilog line; click a code line to find its symbols.</p>
            <p>Everything runs in your browser. Your Verilog is never uploaded.</p>
          </section>
        </aside>

        <section className="center">
          <div className="center-head">
            <Breadcrumb />
            {selectedNode && (
              <span className="selection muted small">
                {selectedNode.kind === 'instance'
                  ? `${selectedNode.subLabel ?? ''} : ${selectedNode.label} (double-click to open)`
                  : selectedNode.cellType ?? selectedNode.label}
              </span>
            )}
          </div>
          {s.layout ? (
            <Canvas
              layout={s.layout}
              theme={theme}
              selected={s.selected}
              highlighted={s.highlighted}
              onSelect={(id) => s.select(id)}
              onOpen={openNode}
            />
          ) : (
            <div className="canvas empty">
              {s.status === 'error' ? (
                <div className="error-box">
                  <b>Could not elaborate the design.</b>
                  <p>{s.error}</p>
                </div>
              ) : s.status === 'idle' ? (
                <p className="muted">Open Verilog files or load the example.</p>
              ) : (
                <p className="muted">
                  <StatusText />
                </p>
              )}
            </div>
          )}
          {logVisible && <LogPanel onClose={() => setShowLog(false)} />}
        </section>

        <aside className="code-pane">
          <h3>
            Source <span className="muted small">{s.codeFile}</span>
          </h3>
          <CodePanel />
        </aside>
      </div>

      {dragging && <div className="drop-overlay">Drop Verilog files to add them</div>}
      {showExport && s.layout && (
        <ExportDialog layout={s.layout} initialTheme={s.theme} name={currentModule} onClose={() => setShowExport(false)} />
      )}
    </div>
  );
}
