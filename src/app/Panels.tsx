import { useEffect, useMemo, useRef } from 'react';
import type { HierarchyNode } from '../core/ir';
import { RULES } from '../core/rules';
import { type PathEntry, moduleTitle, sameFile, useStore } from './store';

export function HierarchyTree() {
  const hierarchy = useStore((s) => s.hierarchy);
  const path = useStore((s) => s.path);
  const openPath = useStore((s) => s.openPath);
  if (!hierarchy) return <p className="muted small">No Verilog loaded.</p>;
  const current = path[0]?.drawn ? '' : path.map((p) => p.instance).join('/');

  const render = (n: HierarchyNode, prefix: PathEntry[]) => {
    const here = [...prefix, { instance: n.instance, module: n.module }];
    const key = here.map((p) => p.instance).join('/');
    return (
      <li key={key}>
        <button className={`tree-item ${key === current ? 'active' : ''}`} onClick={() => openPath(here)}>
          {prefix.length === 0 ? (
            <b>{moduleTitle(n.module)}</b>
          ) : n.module.startsWith(`${prefix[prefix.length - 1].module}/`) ? (
            <span className="auto-block">{n.instance}</span>
          ) : (
            <>
              <span>{n.instance}</span> <span className="muted" title={n.module}>: {moduleTitle(n.module)}</span>
            </>
          )}
        </button>
        {n.children.length > 0 && <ul>{n.children.map((c) => render(c, here))}</ul>}
      </li>
    );
  };
  return <ul className="tree">{render(hierarchy, [])}</ul>;
}

export function FileList() {
  const files = useStore((s) => s.files);
  const codeFile = useStore((s) => s.codeFile);
  const setCodeFile = useStore((s) => s.setCodeFile);
  const removeFile = useStore((s) => s.removeFile);
  const names = Object.keys(files);
  if (names.length === 0) return <p className="muted small">Drop .v / .sv files here or use Open.</p>;
  return (
    <ul className="files">
      {names.map((n) => (
        <li key={n} className={n === codeFile ? 'active' : ''}>
          <button className="file-name" onClick={() => setCodeFile(n)} title={n}>
            {n}
          </button>
          <button className="icon" title={`Remove ${n}`} onClick={() => removeFile(n)}>
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}

export function ViewToggle() {
  const mode = useStore((s) => s.viewMode);
  const setViewMode = useStore((s) => s.setViewMode);
  const design = useStore((s) => s.design);
  if (!design) return null;
  return (
    <div className="view-toggle" role="group" aria-label="View">
      <button
        className={mode === 'blocks' ? 'on' : ''}
        title="Sub-modules and automatically found functional blocks; double-click a block to open it"
        onClick={() => setViewMode('blocks')}
      >
        Block diagram
      </button>
      <button
        className={mode === 'flat' ? 'on' : ''}
        title="Expand every block and sub-module into one circuit"
        onClick={() => setViewMode('flat')}
      >
        Full circuit
      </button>
    </div>
  );
}

export function Breadcrumb() {
  const path = useStore((s) => s.path);
  const openPath = useStore((s) => s.openPath);
  const view = useStore((s) => (s.viewMode === 'blocks' ? (s.blockDesign ?? s.design) : s.design));
  if (path.length === 0) return null;
  return (
    <nav className="breadcrumb">
      {path.map((p, i) => (
        <span key={i}>
          {i > 0 && <span className="sep">›</span>}
          <button className={i === path.length - 1 ? 'current' : ''} onClick={() => openPath(path.slice(0, i + 1))}>
            {i === 0
              ? moduleTitle(p.module)
              : !p.drawn && view?.modules[p.module]?.auto
                ? view.modules[p.module].displayName
                : `${p.instance} (${moduleTitle(p.module)})`}
          </button>
        </span>
      ))}
    </nav>
  );
}

/** Modules drawn by hand. */
export function Drawings() {
  const drawn = useStore((s) => s.doc.drawn);
  const path = useStore((s) => s.path);
  const openPath = useStore((s) => s.openPath);
  const newDrawing = useStore((s) => s.newDrawing);
  const current = path.length === 1 && path[0].drawn ? path[0].module : undefined;
  return (
    <>
      {drawn.length === 0 ? (
        <p className="muted small">None yet.</p>
      ) : (
        <ul className="tree">
          {drawn.map((d) => (
            <li key={d}>
              <button className={`tree-item ${d === current ? 'active' : ''}`} onClick={() => openPath([{ instance: d, module: d, drawn: true }])}>
                {d}
              </button>
            </li>
          ))}
        </ul>
      )}
      <button className="small add-drawing" onClick={() => newDrawing()}>
        + New drawing
      </button>
    </>
  );
}

export function CodePanel() {
  const files = useStore((s) => s.files);
  const codeFile = useStore((s) => s.codeFile);
  const ranges = useStore((s) => s.codeRanges);
  const selectLine = useStore((s) => s.selectLine);
  const box = useRef<HTMLDivElement>(null);
  const text = codeFile ? files[codeFile] : undefined;
  const lines = useMemo(() => (text ?? '').split('\n'), [text]);

  const marked = useMemo(() => {
    const set = new Set<number>();
    for (const r of ranges) {
      if (!codeFile) continue;
      if (!sameFile(r.file, codeFile)) continue;
      // Only the file's own lines: a damaged drawing file can give any range (lines 1 to 10⁹).
      for (let l = Math.max(1, r.startLine); l <= Math.min(r.endLine, lines.length); l++) set.add(l);
    }
    return set;
  }, [ranges, codeFile, lines]);

  useEffect(() => {
    let first = Infinity;
    for (const l of marked) first = Math.min(first, l);
    if (!Number.isFinite(first) || !box.current) return;
    const el = box.current.querySelector(`[data-line="${first}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [marked]);

  if (!codeFile || text === undefined) return <div className="code empty muted small">No source file.</div>;
  return (
    // Focusable, so that copy and select all act on the code while the user works in it (see App).
    <div className="code" ref={box} tabIndex={-1}>
      {lines.map((l, i) => (
        <div
          key={i}
          data-line={i + 1}
          className={`code-line ${marked.has(i + 1) ? 'marked' : ''}`}
          onClick={() => selectLine(codeFile, i + 1)}
        >
          <span className="ln">{i + 1}</span>
          <span className="src">{l || ' '}</span>
        </div>
      ))}
    </div>
  );
}

export function LogPanel({ onClose }: { onClose(): void }) {
  const log = useStore((s) => s.log);
  const error = useStore((s) => s.error);
  return (
    <div className="log">
      <div className="log-head">
        <b>Yosys log</b>
        <button className="icon" onClick={onClose}>
          ×
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      <pre tabIndex={-1}>{log || 'No output yet.'}</pre>
    </div>
  );
}

export function TopSelector() {
  const moduleNames = useStore((s) => s.moduleNames);
  const topOverride = useStore((s) => s.topOverride);
  const design = useStore((s) => s.design);
  const setTop = useStore((s) => s.setTop);
  if (moduleNames.length === 0) return null;
  return (
    <label className="top-select">
      Top:
      <select value={topOverride ?? ''} onChange={(e) => setTop(e.target.value || undefined)}>
        <option value="">{`(automatic${!topOverride && design ? `: ${design.top}` : ''})`}</option>
        {moduleNames.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
    </label>
  );
}

export function RulePanel() {
  const rules = useStore((s) => s.rules);
  const toggleRule = useStore((s) => s.toggleRule);
  return (
    <ul className="rules">
      {RULES.map((r) => (
        <li key={r.id}>
          <label title={r.description}>
            <input type="checkbox" checked={rules.has(r.id)} onChange={() => toggleRule(r.id)} /> {r.title}
          </label>
        </li>
      ))}
    </ul>
  );
}
