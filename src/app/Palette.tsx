/**
 * The symbol library: click a symbol, then click the canvas to place it
 * (Shift-click places more), or drag it onto the canvas.
 */
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { type LayoutResult, approxMeasure, sizeNode } from '../layout/elk-layout';
import { DiagramGraphic } from '../render/DiagramGraphic';
import { THEMES } from '../render/theme';
import { SYMBOLS, type SymKey, type SymParams, type SymbolGroup, newUserNode, symbolNode } from '../editor/symbols';
import { useStore } from './store';
import { ui } from './ui-events';

const Icon = memo(function Icon({ sym, params }: { sym: SymKey; params?: SymParams }) {
  const iface = useStore((s) => s.interfaceOf);
  const layout = useMemo<LayoutResult>(() => {
    const u = newUserNode('icon', sym, params ? { params: { ...newUserNode('i', sym).params, ...params } } : {});
    if (sym === 'input') u.name = 'a';
    if (sym === 'output') u.name = 'y';
    if (sym === 'inout') u.name = 'io';
    if (sym === 'text') u.name = 'Aa';
    const d = symbolNode(u, iface);
    const s = sizeNode(d, approxMeasure);
    return {
      module: 'icon',
      width: s.width,
      height: s.height,
      nodes: [
        { ...d, x: 0, y: 0, width: s.width, height: s.height, ports: d.ports.map((p) => ({ ...p, x: s.ports[p.id]?.x ?? 0, y: s.ports[p.id]?.y ?? 0 })) },
      ],
      edges: [],
    };
  }, [sym, params, iface]);
  const n = layout.nodes[0];
  const pad = 6;
  const extra = n.kind === 'split' ? 30 : n.kind === 'join' ? 30 : 0;
  const vb = `${-pad - (n.kind === 'join' ? extra : 0)} ${-pad} ${n.width + 2 * pad + extra} ${n.height + 2 * pad}`;
  return (
    <svg viewBox={vb} className="palette-icon" aria-hidden="true">
      <DiagramGraphic layout={layout} theme={THEMES.report} />
    </svg>
  );
});

const GROUPS: SymbolGroup[] = ['Ports & labels', 'Logic gates', 'Arithmetic', 'Compare', 'Select & shift', 'Registers', 'Buses', 'Hierarchy'];

export function Palette() {
  const placing = useStore((s) => s.placing);
  const startPlacing = useStore((s) => s.startPlacing);
  const sheet = useStore((s) => s.sheet);
  const blockModules = useStore((s) => s.blockModules);
  // Re-list modules when drawings or the design change.
  useStore((s) => s.doc.drawn);
  useStore((s) => s.design);
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const focus = () => search.current?.focus();
    ui.addEventListener('focus-library', focus);
    return () => ui.removeEventListener('focus-library', focus);
  }, []);

  if (!sheet) return null;
  const q = query.trim().toLowerCase();
  const match = (t: string) => !q || t.toLowerCase().includes(q);
  const modules = blockModules();

  const item = (key: string, sym: SymKey, title: string, hint: string, params?: SymParams) => {
    const active = placing?.sym === sym && (sym !== 'block' || placing.params?.module === params?.module);
    return (
      <button
        key={key}
        className={`palette-item ${active ? 'on' : ''}`}
        title={`${hint}. Click, then click the canvas (Shift-click to place several), or drag it there.`}
        draggable
        onDragStart={(ev) => {
          ev.dataTransfer.setData('application/x-dc-symbol', sym);
          ev.dataTransfer.effectAllowed = 'copy';
          startPlacing({ sym, params });
        }}
        onClick={() => startPlacing(active ? undefined : { sym, params })}
      >
        <Icon sym={sym} params={params} />
        <span>{title}</span>
      </button>
    );
  };

  return (
    <div className="palette">
      <input
        ref={search}
        className="palette-search"
        placeholder="Search symbols (I)"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setQuery('');
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      {GROUPS.map((g) => {
        const list =
          g === 'Hierarchy'
            ? modules.filter(match).map((m) => item(`block:${m}`, 'block', m, `Block: an instance of ${m}`, { module: m }))
            : SYMBOLS.filter((s) => s.group === g && s.key !== 'block' && (match(s.title) || match(s.hint) || match(g))).map((s) =>
                item(s.key, s.key, s.title, s.hint),
              );
        if (list.length === 0) return null;
        return (
          <section key={g}>
            <h4>{g === 'Hierarchy' ? 'Module blocks' : g}</h4>
            <div className="palette-grid">{list}</div>
          </section>
        );
      })}
      {placing && (
        <p className="small muted palette-tip">
          Click the canvas to place. Shift-click places more. Esc stops.
        </p>
      )}
    </div>
  );
}
