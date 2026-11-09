import type { HierarchyNode, IRDesign } from '../core/ir';
import { type EditDoc, type ViewMode, sheetKey } from '../editor/doc';
import { MOD } from './Dialogs';
import { deleteDrawingAsking, drawingKey, entryAfterDelete, pasteTarget } from './drawing-list';
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

/** Gives a drawing's entry in the Drawings list the focus, once the list shows it (or takes the focus out of the list). */
function focusEntry(name: string | undefined) {
  setTimeout(() => {
    const entry = name === undefined ? undefined : document.querySelector<HTMLElement>(`.drawings li[data-drawing="${name}"] .tree-item`);
    if (entry) entry.focus();
    else if (document.activeElement instanceof HTMLElement && document.activeElement.closest('.drawings')) document.activeElement.blur();
  }, 0);
}

/** Gives the canvas the focus (out of the Drawings list), so that it takes the next keys. */
function focusCanvas() {
  const canvas = document.querySelector<HTMLElement>('.canvas');
  if (canvas) canvas.focus({ preventScroll: true });
  else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
}

/**
 * Modules drawn by hand. A click opens a drawing and selects its entry (the entry has the focus): Delete,
 * Ctrl+C / X / V / D then act on the drawing (see drawing-list). × deletes one too.
 */
export function Drawings() {
  const drawn = useStore((s) => s.doc.drawn);
  const path = useStore((s) => s.path);
  const navigate = useStore((s) => s.navigate);
  const newDrawing = useStore((s) => s.newDrawing);
  const current = path.length === 1 && path[0].drawn ? path[0].module : undefined;
  const open = (d: string) => {
    // The entry is selected now, not the symbols: Delete and the rest act on the drawing.
    useStore.getState().select([]);
    void navigate([{ instance: d, module: d, drawn: true }]);
  };
  const onKeyDown = (e: React.KeyboardEvent, d: string) => {
    const action = drawingKey(e);
    if (!action) return;
    const st = useStore.getState();
    if (action === 'canvas' || (action === 'paste' && pasteTarget() === 'canvas')) {
      // The canvas's key (select all, paste symbols): the canvas takes the focus, and then the key (see App).
      focusCanvas();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const list = st.doc.drawn;
    const i = list.indexOf(d);
    switch (action) {
      case 'delete':
      case 'cut': {
        const after = entryAfterDelete(list, d);
        if (deleteDrawingAsking(d, { cut: action === 'cut' })) focusEntry(after);
        return;
      }
      case 'copy':
        if (st.copyDrawing(d)) st.setNotice(`Copied ${d}: ${MOD}+V pastes a copy of it.`);
        return;
      case 'paste': {
        // Nothing copied: nothing happens.
        const name = st.pasteDrawing();
        if (name !== undefined) focusEntry(name);
        return;
      }
      case 'duplicate': {
        const name = st.copyDrawing(d) ? st.pasteDrawing() : undefined;
        if (name !== undefined) focusEntry(name);
        return;
      }
      case 'prev':
      case 'next':
      case 'first':
      case 'last': {
        const to = { prev: i - 1, next: i + 1, first: 0, last: list.length - 1 }[action];
        if (list[to] !== undefined) focusEntry(list[to]);
        return;
      }
      case 'open':
        return open(d);
      case 'none':
        return;
    }
  };
  return (
    <>
      {drawn.length === 0 ? (
        <p className="muted small">None yet.</p>
      ) : (
        <ul className="tree drawings">
          {drawn.map((d) => (
            <li key={d} data-drawing={d} className={d === current ? 'active' : undefined}>
              <button
                className={`tree-item ${d === current ? 'active' : ''}`}
                title={d}
                onClick={(e) => {
                  // Safari does not give a clicked button the focus: the entry must have it to take the keys.
                  e.currentTarget.focus();
                  open(d);
                }}
                onKeyDown={(e) => onKeyDown(e, d)}
              >
                {d}
              </button>
              <button
                className="icon"
                title={`Delete ${d}`}
                aria-label={`Delete ${d}`}
                // Reached with Delete on the entry, not with Tab.
                tabIndex={-1}
                // The focus stays where it is (on the canvas, its keys stay the canvas's).
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => {
                  // The next entry moves up under the pointer: the second click of a double-click must not delete it too.
                  if (e.detail > 1) return;
                  const had = document.activeElement?.closest('.drawings li')?.getAttribute('data-drawing') === d;
                  const after = entryAfterDelete(useStore.getState().doc.drawn, d);
                  if (deleteDrawingAsking(d) && had) focusEntry(after);
                }}
              >
                ×
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
