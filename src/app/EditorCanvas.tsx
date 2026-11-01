/**
 * The drawing canvas: pan and zoom, select (click, Shift/Ctrl-click, box),
 * move symbols, draw wires from pin to pin (with bends), reshape wire
 * segments, and place symbols chosen in the library.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Side } from '../core/diagram';
import { GRID, type LEdge, type LayoutResult, type Point, sizeNode } from '../layout/elk-layout';
import { DiagramGraphic } from '../render/DiagramGraphic';
import { THEMES } from '../render/theme';
import type { WireEnd } from '../editor/sheet';
import { orthogonalize } from '../editor/router';
import { symbolNode, newUserNode } from '../editor/symbols';
import { drawnRoute, measureFor, useStore } from './store';
import { ui } from './ui-events';

interface View {
  x: number;
  y: number;
  k: number;
}

type Mode =
  | { kind: 'none' }
  | { kind: 'pan'; sx: number; sy: number; vx: number; vy: number }
  | { kind: 'press-node'; start: Point; cx: number; cy: number; ids: Set<string>; moved: boolean; clicked: string; additive: boolean; dx: number; dy: number }
  | { kind: 'press-empty'; start: Point; cx: number; cy: number; additive: boolean; moved: boolean }
  | { kind: 'press-port'; end: WireEnd; at: Point; side: Side; cx: number; cy: number }
  | { kind: 'press-edge'; id: string; start: Point; cx: number; cy: number; seg: number; points: Point[]; moved: boolean; draft?: Point[]; shared: boolean }
  | { kind: 'wire'; from: WireEnd; at: Point; side?: Side; bends: Point[]; dragging: boolean };

const Graphic = memo(DiagramGraphic);

const snap = (v: number) => Math.round(v / GRID) * GRID;

interface Hit {
  port?: { node: string; port: string };
  node?: string;
  edge?: string;
}

function hitFrom(target: EventTarget | null): Hit {
  let el = target as Element | null;
  while (el && el instanceof Element) {
    const port = el.getAttribute('data-port-id');
    if (port) return { port: { node: el.getAttribute('data-port-node')!, port } };
    const node = el.getAttribute('data-node-id');
    if (node) return { node };
    const edge = el.getAttribute('data-edge-id');
    if (edge) return { edge };
    if (el.classList.contains('canvas')) break;
    el = el.parentElement;
  }
  return {};
}

/** The point on a polyline nearest to p (the attach point of a new wire). */
function nearestOnPolyline(points: Point[], p: Point): Point {
  let best = points[0];
  let bd = Infinity;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    const q = { x: a.x + dx * t, y: a.y + dy * t };
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < bd) {
      bd = d;
      best = q;
    }
  }
  return best;
}

/**
 * Whether segment `seg` of a wire runs along another wire of the same net. The
 * router lets branches share their trunk, and every wire keeps its own copy of
 * it: moving the stretch in one wire alone would leave the other copy behind,
 * a loop of doubled wire.
 */
// Exported for the tests.
// oxlint-disable-next-line react/only-export-components
export function sharedSegment(edges: readonly LEdge[], id: string, seg: number): boolean {
  const e = edges.find((x) => x.id === id);
  const a = e?.points[seg];
  const b = e?.points[seg + 1];
  if (!e || !a || !b) return false;
  const flat = Math.abs(a.y - b.y) < 0.5;
  const along = (p: Point) => (flat ? p.x : p.y);
  const across = (p: Point) => (flat ? p.y : p.x);
  const lo = Math.min(along(a), along(b));
  const hi = Math.max(along(a), along(b));
  for (const o of edges) {
    if (o.id === id || o.source.port !== e.source.port) continue;
    for (let i = 1; i < o.points.length; i++) {
      const p = o.points[i - 1];
      const q = o.points[i];
      if (Math.abs(across(p) - across(a)) >= 0.5 || Math.abs(across(q) - across(a)) >= 0.5) continue;
      if (Math.min(hi, Math.max(along(p), along(q))) - Math.max(lo, Math.min(along(p), along(q))) > 0.5) return true;
    }
  }
  return false;
}

function Ghost({ at }: { at: Point }) {
  const placing = useStore((s) => s.placing);
  const themeName = useStore((s) => s.theme);
  const theme = THEMES[themeName];
  const iface = useStore((s) => s.interfaceOf);
  if (!placing) return null;
  const node = newUserNode('ghost', placing.sym, placing.params ? { params: { ...newUserNode('g', placing.sym).params, ...placing.params } } : {});
  if (placing.sym === 'text') node.name = 'Note';
  const d = symbolNode(node, iface);
  const s = sizeNode(d, measureFor(themeName));
  const x = snap(at.x - s.width / 2);
  const y = snap(at.y - s.height / 2);
  const layout: LayoutResult = {
    module: 'ghost',
    width: s.width,
    height: s.height,
    nodes: [
      {
        ...d,
        x,
        y,
        width: s.width,
        height: s.height,
        ports: d.ports.map((p) => ({ ...p, x: x + (s.ports[p.id]?.x ?? 0), y: y + (s.ports[p.id]?.y ?? 0) })),
      },
    ],
    edges: [],
  };
  return (
    <g opacity={0.5} pointerEvents="none">
      <DiagramGraphic layout={layout} theme={theme} />
    </g>
  );
}

export function EditorCanvas() {
  const layout = useStore((s) => s.layout);
  const themeName = useStore((s) => s.theme);
  const selection = useStore((s) => s.selection);
  const highlighted = useStore((s) => s.highlighted);
  const issues = useStore((s) => s.issues);
  const placing = useStore((s) => s.placing);
  const theme = THEMES[themeName];
  const wrap = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 40, y: 40, k: 1 });
  const viewRef = useRef(view);
  useLayoutEffect(() => {
    viewRef.current = view;
  }, [view]);
  const mode = useRef<Mode>({ kind: 'none' });
  const [pointer, setPointer] = useState<Point>();
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number }>();
  const [wireDraft, setWireDraft] = useState<Point[]>();
  const [hoverPort, setHoverPort] = useState<string>();
  const [size, setSize] = useState({ w: 2000, h: 2000 });
  // Shown in the cursor: what a press does now.
  const [gesture, setGesture] = useState<'none' | 'pan' | 'wire'>('none');
  const [spaceDown, setSpaceDown] = useState(false);
  /** Set while a fit waits for the layout of a newly opened sheet (`stale`: the layout of the sheet before). */
  const fitAfter = useRef<{ stale?: LayoutResult } | undefined>({});
  const hasLayout = layout !== undefined;

  const fit = useCallback(() => {
    const el = wrap.current;
    const l = useStore.getState().layout;
    if (!el || !l) return;
    const { clientWidth: W, clientHeight: H } = el;
    if (l.nodes.length === 0) {
      setView({ x: 40, y: 40, k: 1 });
      return;
    }
    const lx = l.x ?? 0;
    const ly = l.y ?? 0;
    const k = Math.min(2, Math.max(0.1, Math.min(W / (l.width + 40), H / (l.height + 40))));
    setView({ k, x: (W - l.width * k) / 2 - lx * k, y: (H - l.height * k) / 2 - ly * k });
  }, []);

  // Fit when another sheet appears, not after every edit. The store switches to the new sheet's key
  // before that sheet's layout is ready (ELK runs in a worker): until then the layout on screen is
  // still the previous sheet's, so the fit waits for a layout that is not that one.
  useEffect(
    () =>
      useStore.subscribe((s, prev) => {
        if (s.sheet === prev.sheet) return;
        // A renamed drawing keeps its edits under the new key: the same sheet, so keep the view.
        const e = s.doc.sheets[s.sheet];
        if (e && e === prev.doc.sheets[prev.sheet]) return;
        fitAfter.current = { stale: prev.layout };
      }),
    [],
  );
  useEffect(() => {
    const pending = fitAfter.current;
    if (!layout || !pending || layout === pending.stale) return;
    fitAfter.current = undefined;
    fit();
  }, [layout, fit]);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasLayout]);

  useEffect(() => {
    const onFit = () => fit();
    ui.addEventListener('fit', onFit);
    return () => ui.removeEventListener('fit', onFit);
  }, [fit]);

  const toWorld = (cx: number, cy: number): Point => {
    const el = wrap.current!;
    const r = el.getBoundingClientRect();
    const v = viewRef.current;
    return { x: (cx - r.left - v.x) / v.k, y: (cy - r.top - v.y) / v.k };
  };

  /** Zoom around the centre of the view, within the same limits as the wheel. */
  const zoomBy = (f: number) => {
    const el = wrap.current;
    if (!el) return;
    const mx = el.clientWidth / 2;
    const my = el.clientHeight / 2;
    setView((v) => {
      const k = Math.min(8, Math.max(0.05, v.k * f));
      return { k, x: mx - ((mx - v.x) * k) / v.k, y: my - ((my - v.y) * k) / v.k };
    });
  };

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const rect = el.getBoundingClientRect();
      const mx = ev.clientX - rect.left;
      const my = ev.clientY - rect.top;
      // Ctrl/Cmd + wheel (and trackpad pinch) zooms; the wheel alone scrolls the sheet.
      if (ev.ctrlKey || ev.metaKey) {
        setView((v) => {
          const factor = Math.exp(-ev.deltaY * (ev.ctrlKey && Math.abs(ev.deltaY) < 50 ? 0.01 : 0.0015));
          const k = Math.min(8, Math.max(0.05, v.k * factor));
          return { k, x: mx - ((mx - v.x) * k) / v.k, y: my - ((my - v.y) * k) / v.k };
        });
      } else {
        const dx = ev.shiftKey && ev.deltaX === 0 ? ev.deltaY : ev.deltaX;
        const dy = ev.shiftKey && ev.deltaX === 0 ? 0 : ev.deltaY;
        setView((v) => ({ ...v, x: v.x - dx, y: v.y - dy }));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const cancelWire = useCallback(() => {
    mode.current = { kind: 'none' };
    setWireDraft(undefined);
    setGesture('none');
  }, []);

  // Keys that belong to the canvas while a wire is being drawn or a symbol placed.
  useEffect(() => {
    const down = (ev: KeyboardEvent) => {
      const t = ev.target as Element | null;
      if (t?.closest?.('input, textarea, select, [role=menu]')) return;
      if (ev.key === ' ' && !ev.repeat) setSpaceDown(true);
      const m = mode.current;
      if (m.kind === 'wire') {
        if (ev.key === 'Escape') {
          cancelWire();
        } else if (ev.key === 'Backspace' || ev.key === 'Delete') {
          if (m.bends.length) m.bends = m.bends.slice(0, -1);
          else cancelWire();
        } else return;
        ev.preventDefault();
        ev.stopImmediatePropagation();
      } else if (useStore.getState().placing && ev.key === 'Escape') {
        useStore.getState().startPlacing(undefined);
        ev.preventDefault();
        ev.stopImmediatePropagation();
      }
    };
    const up = (ev: KeyboardEvent) => {
      if (ev.key === ' ') setSpaceDown(false);
    };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up);
    };
  }, [cancelWire]);

  const store = useStore.getState;

  const portInfo = (portId: string) => {
    for (const n of store().layout?.nodes ?? []) for (const p of n.ports) if (p.id === portId) return { node: n, port: p };
    return undefined;
  };

  /** The end of a wire under the pointer: a pin, or a point on a wire. */
  const endAt = (hit: Hit, w: Point): { end: WireEnd; at: Point } | undefined => {
    if (hit.port) {
      const p = portInfo(hit.port.port);
      if (p) return { end: { kind: 'port', node: hit.port.node, port: hit.port.port }, at: { x: p.port.x, y: p.port.y } };
    }
    if (hit.edge) {
      const e = store().layout?.edges.find((x) => x.id === hit.edge);
      if (e) {
        const at = nearestOnPolyline(e.points, w);
        return { end: { kind: 'wire', edge: e.id, at }, at };
      }
    }
    return undefined;
  };

  const finishWire = (to: WireEnd) => {
    const m = mode.current;
    if (m.kind !== 'wire') return;
    const ok = store().connectEnds(m.from, to, m.bends);
    if (ok || !m.dragging) cancelWire();
  };

  const updateDraft = (w: Point) => {
    const m = mode.current;
    if (m.kind !== 'wire') return;
    const start = m.at;
    const pts = [start, ...m.bends, { x: snap(w.x), y: snap(w.y) }];
    // Same shape as the wire connectEnds will store: out of the pin first, then through the bends.
    const side = m.from.kind === 'port' && m.bends.length ? portInfo(m.from.port)?.port.side : undefined;
    setWireDraft(side ? drawnRoute(pts, side) : orthogonalize(pts));
  };

  if (!layout) return null;
  const lx = layout.x ?? 0;
  const ly = layout.y ?? 0;

  // Visible world rectangle, for the grid.
  const vw = size.w / view.k;
  const vh = size.h / view.k;
  const vx = -view.x / view.k;
  const vy = -view.y / view.k;
  const gridStep = view.k < 0.4 ? GRID * 5 : view.k < 0.8 ? GRID * 2 : GRID;

  const selectedNodes = layout.nodes.filter((n) => selection.has(n.id));
  const cursor = spaceDown || gesture === 'pan' ? 'grab' : placing ? 'copy' : gesture === 'wire' ? 'crosshair' : 'default';

  return (
    <div
      ref={wrap}
      className="canvas"
      tabIndex={-1}
      style={{ background: theme.background, cursor }}
      onContextMenu={(ev) => ev.preventDefault()}
      onDragOver={(ev) => {
        if (Array.from(ev.dataTransfer.types).includes('application/x-dc-symbol')) ev.preventDefault();
      }}
      onDrop={(ev) => {
        const sym = ev.dataTransfer.getData('application/x-dc-symbol');
        if (!sym) return;
        ev.preventDefault();
        ev.stopPropagation();
        const w = toWorld(ev.clientX, ev.clientY);
        const s = store();
        s.startPlacing({ sym: sym as never, ...(s.placing?.sym === sym ? { params: s.placing.params } : {}) });
        s.placeAt(w);
      }}
      onPointerDown={(ev) => {
        const w = toWorld(ev.clientX, ev.clientY);
        (ev.currentTarget as HTMLElement).focus({ preventScroll: true });
        // The canvas cannot be selected, so a press here would leave text selected in Source;
        // drop it, so that Ctrl+C later copies symbols, not old text (see App's shortcuts).
        document.getSelection()?.removeAllRanges();
        if (ev.button === 1 || ev.button === 2 || (ev.button === 0 && spaceDown)) {
          mode.current = { kind: 'pan', sx: ev.clientX, sy: ev.clientY, vx: view.x, vy: view.y };
          setGesture('pan');
          (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
          ev.preventDefault();
          return;
        }
        if (ev.button !== 0) return;
        const s = store();
        const hit = hitFrom(ev.target);
        if (s.placing) {
          s.placeAt(w, ev.shiftKey);
          return;
        }
        const m = mode.current;
        if (m.kind === 'wire') {
          const end = endAt(hit, w);
          if (end) finishWire(end.end);
          else {
            m.bends = [...m.bends, { x: snap(w.x), y: snap(w.y) }];
            updateDraft(w);
          }
          return;
        }
        const additive = ev.shiftKey || ev.ctrlKey || ev.metaKey;
        (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
        if (hit.port) {
          const p = portInfo(hit.port.port);
          if (p) {
            mode.current = {
              kind: 'press-port',
              end: { kind: 'port', node: hit.port.node, port: hit.port.port },
              at: { x: p.port.x, y: p.port.y },
              side: p.port.side,
              cx: ev.clientX,
              cy: ev.clientY,
            };
            return;
          }
        }
        if (hit.node) {
          let sel = s.selection;
          if (additive) {
            s.select([hit.node], 'toggle');
            sel = store().selection;
          } else if (!sel.has(hit.node)) {
            s.select([hit.node]);
            sel = store().selection;
          }
          const ids = new Set([...sel].filter((id) => s.layout?.nodes.some((n) => n.id === id)));
          mode.current = { kind: 'press-node', start: w, cx: ev.clientX, cy: ev.clientY, ids, moved: false, clicked: hit.node, additive, dx: 0, dy: 0 };
          return;
        }
        if (hit.edge) {
          if (additive) s.select([hit.edge], 'toggle');
          else s.select([hit.edge]);
          const e = s.layout?.edges.find((x) => x.id === hit.edge);
          let seg = -1;
          if (e) {
            // Only inner segments can be dragged: the first and last stay on their pins.
            let bd = Infinity;
            for (let i = 1; i < e.points.length - 2; i++) {
              const a = e.points[i];
              const b = e.points[i + 1];
              const q = nearestOnPolyline([a, b], w);
              const d = Math.hypot(q.x - w.x, q.y - w.y);
              if (d < bd && d < 8 / view.k) {
                bd = d;
                seg = i;
              }
            }
          }
          // A trunk that branches share is not dragged: one wire would leave the others' copy behind.
          const shared = !!e && seg >= 0 && sharedSegment(s.layout?.edges ?? [], e.id, seg);
          mode.current = {
            kind: 'press-edge',
            id: hit.edge,
            start: w,
            cx: ev.clientX,
            cy: ev.clientY,
            seg: shared ? -1 : seg,
            points: e?.points ?? [],
            moved: false,
            shared,
          };
          return;
        }
        mode.current = { kind: 'press-empty', start: w, cx: ev.clientX, cy: ev.clientY, additive, moved: false };
      }}
      onPointerMove={(ev) => {
        const w = toWorld(ev.clientX, ev.clientY);
        const m = mode.current;
        const s = store();
        if (s.placing || m.kind === 'wire') setPointer(w);
        if (m.kind === 'none' || m.kind === 'wire') {
          const hit = hitFrom(m.kind === 'wire' ? document.elementFromPoint(ev.clientX, ev.clientY) : ev.target);
          setHoverPort(hit.port?.port);
          if (m.kind === 'wire') updateDraft(w);
          return;
        }
        const far = (cx: number, cy: number, d = 3) => Math.abs(ev.clientX - cx) + Math.abs(ev.clientY - cy) > d;
        switch (m.kind) {
          case 'pan':
            setView((v) => ({ ...v, x: m.vx + ev.clientX - m.sx, y: m.vy + ev.clientY - m.sy }));
            return;
          case 'press-node': {
            if (!m.moved && !far(m.cx, m.cy)) return;
            m.moved = true;
            const free = ev.altKey;
            m.dx = free ? Math.round(w.x - m.start.x) : snap(w.x - m.start.x);
            m.dy = free ? Math.round(w.y - m.start.y) : snap(w.y - m.start.y);
            s.previewMove(m.ids, m.dx, m.dy);
            return;
          }
          case 'press-empty': {
            if (!m.moved && !far(m.cx, m.cy)) return;
            m.moved = true;
            setMarquee({ x: Math.min(m.start.x, w.x), y: Math.min(m.start.y, w.y), w: Math.abs(w.x - m.start.x), h: Math.abs(w.y - m.start.y) });
            return;
          }
          case 'press-port': {
            if (!far(m.cx, m.cy, 4)) return;
            mode.current = { kind: 'wire', from: m.end, at: m.at, side: m.side, bends: [], dragging: true };
            setGesture('wire');
            updateDraft(w);
            return;
          }
          case 'press-edge': {
            if (m.shared && !m.moved && far(m.cx, m.cy)) {
              m.moved = true;
              s.setNotice('Several wires of this net run along this stretch. Drag a stretch that belongs to one wire, or move the symbols.');
            }
            if (m.seg < 0 || (!m.moved && !far(m.cx, m.cy))) return;
            m.moved = true;
            const a = m.points[m.seg];
            const b = m.points[m.seg + 1];
            const pts = m.points.map((p) => ({ ...p }));
            if (Math.abs(a.y - b.y) < 0.5) {
              const y = ev.altKey ? w.y : snap(w.y);
              pts[m.seg] = { x: a.x, y };
              pts[m.seg + 1] = { x: b.x, y };
            } else {
              const x = ev.altKey ? w.x : snap(w.x);
              pts[m.seg] = { x, y: a.y };
              pts[m.seg + 1] = { x, y: b.y };
            }
            m.draft = pts;
            setWireDraft(pts);
            return;
          }
        }
      }}
      onPointerUp={(ev) => {
        const m = mode.current;
        const s = store();
        const w = toWorld(ev.clientX, ev.clientY);
        switch (m.kind) {
          case 'pan':
            mode.current = { kind: 'none' };
            setGesture('none');
            return;
          case 'press-node':
            mode.current = { kind: 'none' };
            if (m.moved) s.moveSelection(m.ids, m.dx, m.dy);
            else if (!m.additive && s.selection.size > 1) s.select([m.clicked]);
            return;
          case 'press-empty': {
            mode.current = { kind: 'none' };
            setMarquee(undefined);
            if (!m.moved) {
              if (!m.additive) s.select([]);
              return;
            }
            const x0 = Math.min(m.start.x, w.x);
            const x1 = Math.max(m.start.x, w.x);
            const y0 = Math.min(m.start.y, w.y);
            const y1 = Math.max(m.start.y, w.y);
            // Dragging right selects what is fully inside; dragging left also what it touches.
            const touching = w.x < m.start.x;
            const inside = (n: { x: number; y: number; width: number; height: number }) =>
              touching
                ? n.x < x1 && n.x + n.width > x0 && n.y < y1 && n.y + n.height > y0
                : n.x >= x0 && n.x + n.width <= x1 && n.y >= y0 && n.y + n.height <= y1;
            const nodes = new Set(s.layout!.nodes.filter(inside).map((n) => n.id));
            const edges = s.layout!.edges.filter((e) => nodes.has(e.source.node) && nodes.has(e.target.node)).map((e) => e.id);
            s.select([...nodes, ...edges], m.additive ? 'add' : 'replace');
            return;
          }
          case 'press-port':
            // A click on a pin starts a wire; click more points for bends, then a pin to finish.
            mode.current = { kind: 'wire', from: m.end, at: m.at, side: m.side, bends: [], dragging: false };
            setGesture('wire');
            updateDraft(w);
            return;
          case 'press-edge':
            mode.current = { kind: 'none' };
            if (m.moved && m.draft) s.setEdgeRoute(m.id, orthogonalize(m.draft));
            setWireDraft(undefined);
            return;
          case 'wire': {
            if (!m.dragging) return;
            const end = endAt(hitFrom(document.elementFromPoint(ev.clientX, ev.clientY)), w);
            if (end && !(end.end.kind === 'port' && m.from.kind === 'port' && end.end.port === m.from.port)) finishWire(end.end);
            else {
              // Released on empty canvas: keep drawing with a bend there.
              m.dragging = false;
              if (!end) m.bends = [...m.bends, { x: snap(w.x), y: snap(w.y) }];
              updateDraft(w);
            }
            return;
          }
        }
      }}
      onDoubleClick={(ev) => {
        const m = mode.current;
        if (m.kind === 'wire') {
          cancelWire();
          return;
        }
        const hit = hitFrom(document.elementFromPoint(ev.clientX, ev.clientY));
        const s = store();
        if (hit.node) {
          const n = s.layout?.nodes.find((x) => x.id === hit.node);
          if (n?.kind === 'instance' && n.moduleName && (s.doc.drawn.includes(n.moduleName) || s.viewDesign()?.modules[n.moduleName])) s.openNode(hit.node);
          else ui.dispatchEvent(new CustomEvent('rename', { detail: hit.node }));
        } else if (hit.edge) {
          ui.dispatchEvent(new CustomEvent('rename', { detail: hit.edge }));
        }
      }}
    >
      <svg width="100%" height="100%">
        <defs>
          <pattern id="dc-grid" width={gridStep} height={gridStep} patternUnits="userSpaceOnUse">
            <circle cx={0} cy={0} r={0.9 / view.k} fill={theme.muted} opacity={0.35} />
          </pattern>
        </defs>
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          <rect x={vx - gridStep} y={vy - gridStep} width={vw + 2 * gridStep} height={vh + 2 * gridStep} fill="url(#dc-grid)" pointerEvents="none" />
          <Graphic layout={layout} theme={theme} selection={selection} highlighted={highlighted} flagged={issues.flagged} interactive />
          {selectedNodes.map((n) => (
            <rect
              key={n.id}
              x={n.x - 4}
              y={n.y - 4}
              width={n.width + 8}
              height={n.height + 8}
              fill="none"
              stroke={theme.accent}
              strokeDasharray="4 3"
              strokeWidth={1 / view.k}
              pointerEvents="none"
            />
          ))}
          <g>
            {layout.nodes.map((n) =>
              n.ports.map((p) => {
                const open = issues.openPorts?.has(p.id);
                const hover = hoverPort === p.id;
                return (
                  <g key={p.id}>
                    {(open || hover) && (
                      <circle
                        cx={p.x}
                        cy={p.y}
                        r={hover ? 4 : 2.5}
                        fill={hover ? theme.accent : theme.background}
                        stroke={hover ? theme.accent : theme.muted}
                        strokeWidth={1}
                        pointerEvents="none"
                      />
                    )}
                    <circle cx={p.x} cy={p.y} r={6} fill="transparent" data-port-id={p.id} data-port-node={n.id} style={{ cursor: 'crosshair' }} />
                  </g>
                );
              }),
            )}
          </g>
          {wireDraft && (
            <polyline
              points={wireDraft.map((p) => `${p.x},${p.y}`).join(' ')}
              fill="none"
              stroke={theme.accent}
              strokeWidth={1.6}
              strokeDasharray="5 3"
              pointerEvents="none"
            />
          )}
          {marquee && (
            <rect
              x={marquee.x}
              y={marquee.y}
              width={marquee.w}
              height={marquee.h}
              fill={theme.accentFill}
              stroke={theme.accent}
              strokeDasharray="4 3"
              strokeWidth={1 / view.k}
              pointerEvents="none"
            />
          )}
          {placing && pointer && <Ghost at={pointer} />}
          {layout.nodes.length === 0 && !placing && (
            <text x={lx + 4} y={ly + 30} fontSize={13} fill={theme.muted} fontFamily={theme.font} pointerEvents="none">
              Empty sheet: pick a symbol in the library on the left, then click here to place it.
            </text>
          )}
        </g>
      </svg>
      <div className="zoom-controls" onPointerDown={(ev) => ev.stopPropagation()} onDoubleClick={(ev) => ev.stopPropagation()}>
        <button onClick={() => zoomBy(1.25)} title="Zoom in (Ctrl + wheel)">
          +
        </button>
        <button onClick={() => zoomBy(1 / 1.25)} title="Zoom out (Ctrl + wheel)">
          −
        </button>
        <button onClick={fit} title="Fit to view (F)">
          ⤢
        </button>
      </div>
    </div>
  );
}
