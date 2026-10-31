import { useEffect, useMemo, useRef } from 'react';
import type { HierarchyNode } from '../core/ir';
import { type PathEntry, useStore } from './store';

export function HierarchyTree() {
  const hierarchy = useStore((s) => s.hierarchy);
  const path = useStore((s) => s.path);
  const openPath = useStore((s) => s.openPath);
  if (!hierarchy) return <p className="muted small">No design loaded.</p>;
  const current = path.map((p) => p.instance).join('/');

  const render = (n: HierarchyNode, prefix: PathEntry[]) => {
    const here = [...prefix, { instance: n.instance, module: n.module }];
    const key = here.map((p) => p.instance).join('/');
    return (
      <li key={key}>
        <button className={`tree-item ${key === current ? 'active' : ''}`} onClick={() => openPath(here)}>
          {prefix.length === 0 ? (
            <b>{n.module}</b>
          ) : (
            <>
              <span>{n.instance}</span> <span className="muted">: {n.module}</span>
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

export function Breadcrumb() {
  const path = useStore((s) => s.path);
  const openPath = useStore((s) => s.openPath);
  if (path.length === 0) return null;
  return (
    <nav className="breadcrumb">
      {path.map((p, i) => (
        <span key={i}>
          {i > 0 && <span className="sep">›</span>}
          <button className={i === path.length - 1 ? 'current' : ''} onClick={() => openPath(path.slice(0, i + 1))}>
            {i === 0 ? p.module : `${p.instance} (${p.module})`}
          </button>
        </span>
      ))}
    </nav>
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
      const same = r.file === codeFile || r.file.endsWith('/' + codeFile);
      if (!same) continue;
      for (let l = r.startLine; l <= r.endLine; l++) set.add(l);
    }
    return set;
  }, [ranges, codeFile]);

  useEffect(() => {
    const first = Math.min(...marked);
    if (!Number.isFinite(first) || !box.current) return;
    const el = box.current.querySelector(`[data-line="${first}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [marked]);

  if (!codeFile || text === undefined) return <div className="code empty muted small">No source file.</div>;
  return (
    <div className="code" ref={box}>
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
      <pre>{log || 'No output yet.'}</pre>
    </div>
  );
}

export function TopSelector() {
  const design = useStore((s) => s.design);
  const setTop = useStore((s) => s.setTop);
  if (!design) return null;
  const names = Object.keys(design.modules).sort();
  return (
    <label className="top-select">
      Top:
      <select
        value={design.top}
        onChange={(e) => setTop(e.target.value)}
      >
        {names.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
    </label>
  );
}
