import type { HierarchyNode, IRDesign } from '../core/ir';
import { type EditDoc, type ViewMode, sheetKey } from '../editor/doc';
import { type PathEntry, moduleTitle, useStore } from './store';

/**
 * The name an instance has on its parent's sheet in this view: as it was renamed there (the
 * block shows it), or as the Verilog names it.
 */
function instanceName(view: IRDesign | undefined, doc: EditDoc, mode: ViewMode, parent: PathEntry, instance: string): string {
  const cell = view?.modules[parent.module]?.cells.find((c) => c.isInstance && c.name === instance);
  return (cell && doc.sheets[sheetKey(parent, mode)]?.labels[`cell:${cell.id}`]?.trim()) || instance;
}

export function HierarchyTree() {
  const hierarchy = useStore((s) => s.hierarchy);
  const path = useStore((s) => s.path);
  const navigate = useStore((s) => s.navigate);
  const doc = useStore((s) => s.doc);
  const mode = useStore((s) => s.viewMode);
  const view = useStore((s) => (s.viewMode === 'blocks' ? (s.blockDesign ?? s.design) : s.design));
  if (!hierarchy) return <p className="muted small">No Verilog loaded.</p>;
  const current = path[0]?.drawn ? '' : path.map((p) => p.instance).join('/');

  const render = (n: HierarchyNode, prefix: PathEntry[]) => {
    const here = [...prefix, { instance: n.instance, module: n.module }];
    const key = here.map((p) => p.instance).join('/');
    const name = prefix.length ? instanceName(view, doc, mode, prefix[prefix.length - 1], n.instance) : n.instance;
    const was = name !== n.instance ? `${n.instance} in the Verilog` : undefined;
    return (
      <li key={key}>
        <button className={`tree-item ${key === current ? 'active' : ''}`} onClick={() => navigate(here)}>
          {prefix.length === 0 ? (
            <b>{moduleTitle(n.module)}</b>
          ) : n.module.startsWith(`${prefix[prefix.length - 1].module}/`) ? (
            <span className="auto-block" title={was}>
              {name}
            </span>
          ) : (
            <>
              <span title={was}>{name}</span> <span className="muted" title={n.module}>: {moduleTitle(n.module)}</span>
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
  const removeFile = useStore((s) => s.removeFile);
  const names = Object.keys(files);
  if (names.length === 0) return <p className="muted small">Drop .v / .sv files here or use Open.</p>;
  return (
    <ul className="files">
      {names.map((n) => (
        <li key={n}>
          <span className="file-name" title={n}>
            {n}
          </span>
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
  const navigate = useStore((s) => s.navigate);
  const doc = useStore((s) => s.doc);
  const mode = useStore((s) => s.viewMode);
  const view = useStore((s) => (s.viewMode === 'blocks' ? (s.blockDesign ?? s.design) : s.design));
  if (path.length === 0) return null;
  /** As the Hierarchy names it: an automatic block by its (renamed) name alone, an instance with its module. */
  const title = (p: PathEntry, i: number) => {
    if (i === 0) return moduleTitle(p.module);
    if (p.drawn) return `${p.instance} (${moduleTitle(p.module)})`;
    const name = instanceName(view, doc, mode, path[i - 1], p.instance);
    if (view?.modules[p.module]?.auto) return name !== p.instance ? name : view.modules[p.module].displayName;
    return `${name} (${moduleTitle(p.module)})`;
  };
  return (
    <nav className="breadcrumb">
      {path.map((p, i) => (
        <span key={i}>
          {i > 0 && <span className="sep">›</span>}
          <button className={i === path.length - 1 ? 'current' : ''} onClick={() => navigate(path.slice(0, i + 1))}>
            {title(p, i)}
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
  const navigate = useStore((s) => s.navigate);
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
              <button className={`tree-item ${d === current ? 'active' : ''}`} onClick={() => navigate([{ instance: d, module: d, drawn: true }])}>
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
