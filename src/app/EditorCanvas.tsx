/**
 * The drawing canvas: pan and zoom, select (click, Shift/Ctrl-click, box),
 * move symbols, draw wires by hand (see editor/draw-wire: drag from a pin and
 * the wire follows the pointer, corner by corner; or click a pin, click the
 * corners, click the end), reshape wires (drag any leg or corner), and place
 * symbols chosen in the library.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Side } from '../core/diagram';
import { GRID, type LEdge, type LayoutResult, type Point, sizeNode } from '../layout/elk-layout';
import { DiagramGraphic } from '../render/DiagramGraphic';
import { THEMES } from '../render/theme';
import type { WireEnd } from '../editor/sheet';
import { type Axis, type WireDraft, clickAt, draftPath, followMoves, legAt, legContaining, legMoves, moveCorner, moveLeg, startDraft, trace, undoCorner } from '../editor/draw-wire';
import { polylineHitsRect, wiresMeet } from '../editor/router';
import { symbolNode, newUserNode } from '../editor/symbols';
import { measureFor, useStore } from './store';
import { ui } from './ui-events';
import { doubleClickSettings, openSettings } from './settings';
import { ClickRun } from './click-run';
import { hoveredSymbol, openBusHints } from './pin-hints';

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
  | { kind: 'press-edge'; id: string; cx: number; cy: number; grab?: Grab; points: Point[]; moved: boolean; drafts?: Record<string, Point[]> }
  | { kind: 'wire'; from: WireEnd; side?: Side; startAxis: Axis; draft: WireDraft; dragging: boolean };

/** What a press on a wire took hold of: one of its legs, or one of its corners. */
export interface Grab {
  kind: 'leg' | 'corner';
  index: number;
}

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

/** A point on a wire moved along its leg to the nearest grid line (within the leg): a branch starts on the grid. */
function onGridAlong(points: readonly Point[], p: Point): Point {
  const i = legContaining(points, p);
  const leg = i === undefined ? undefined : legAt(points, i);
  if (!leg) return p;
  const along = Math.min(leg.hi, Math.max(leg.lo, snap(leg.axis === 'h' ? p.x : p.y)));
  return leg.axis === 'h' ? { x: along, y: leg.at } : { x: leg.at, y: along };
}

/**
 * The corner (an inner point) or leg of a wire nearest to p, within `tol`. Corners win when p is about
 * as near one as a leg (a corner is on two legs).
 */
// Exported for the tests.
// oxlint-disable-next-line react/only-export-components
export function grabAt(points: readonly Point[], p: Point, tol: number): Grab | undefined {
  let best: Grab | undefined;
  let bd = Infinity;
  for (let i = 1; i < points.length - 1; i++) {
    const d = Math.hypot(points[i].x - p.x, points[i].y - p.y);
    if (d <= tol * 1.25 && d < bd) {
      bd = d;
      best = { kind: 'corner', index: i };
    }
  }
  if (best) return best;
  for (let i = 0; i + 1 < points.length; i++) {
    if (!legAt(points, i)) continue;
    const q = nearestOnPolyline([points[i], points[i + 1]], p);
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d <= tol && d < bd) {
      bd = d;
      best = { kind: 'leg', index: i };
    }
  }
  return best;
}

/** The cursor over a grabbed part of a wire: which way it moves. */
function grabCursor(points: readonly Point[], g: Grab | undefined): string {
  if (!g) return 'pointer';
  if (g.kind === 'corner') return 'move';
  return legAt(points, g.index)?.axis === 'h' ? 'ns-resize' : 'ew-resize';
}

/**
 * A wire reshaped by dragging part `g` to p (on the grid), and the other wires of its net that ran along
 * the moved legs, moved with them (a shared stretch stays shared). By wire ID; only wires that changed.
 */
// Exported for the tests.
// oxlint-disable-next-line react/only-export-components
export function reshape(edges: readonly LEdge[], id: string, points: Point[], g: Grab, p: Point): Record<string, Point[]> {
  let next: Point[];
  if (g.kind === 'corner') next = moveCorner(points, g.index, p);
  else {
    const leg = legAt(points, g.index);
    if (!leg) return {};
    next = moveLeg(points, g.index, leg.axis === 'h' ? p.y : p.x);
  }
  const out: Record<string, Point[]> = { [id]: next };
  const moves = legMoves(points, next);
  const net = edges.find((e) => e.id === id)?.source.port;
  if (moves.length && net !== undefined)
    for (const o of edges) {
      if (o.id === id || o.source.port !== net) continue;
      const f = followMoves(o.points, moves);
      if (f !== o.points) out[o.id] = f;
    }
  return out;
}

/** Axis across the leg of a wire that point p is on: a branch leaves the wire that way. */
function acrossAt(points: readonly Point[], p: Point): Axis {
  const i = legContaining(points, p);
  return i !== undefined && legAt(points, i)?.axis === 'h' ? 'v' : 'h';
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
  /** The canvas's own count of clicks, for the double-clicks the browser sends no dblclick for. */
  const [clicks] = useState(() => new ClickRun());
  const [pointer, setPointer] = useState<Point>();
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number }>();
  /** Wires being drawn or reshaped, drawn dashed over the sheet. */
  const [wireDrafts, setWireDrafts] = useState<Point[][]>();
  /** The cursor over a wire: which way the part under the pointer would move. */
  const [edgeCursor, setEdgeCursor] = useState<string>();
  const [hoverPort, setHoverPort] = useState<string>();
  /** The symbol under the pointer: only its connection points show (see pin-hints). */
  const [hoverNode, setHoverNode] = useState<string>();
  const [size, setSize] = useState({ w: 2000, h: 2000 });
  // Shown in the cursor: what a press does now.
  const [gesture, setGesture] = useState<'none' | 'pan' | 'wire'>('none');
  const [spaceDown, setSpaceDown] = useState(false);
  /** Set while a fit waits for the layout of a newly opened sheet (`stale`: the layout of the sheet before). */
  const fitAfter = useRef<{ stale?: LayoutResult; sheet?: string } | undefined>({});
  /**
   * The view each sheet was left in, since the files were opened: going back to a sheet (Ctrl+Z after
   * opening a block, the breadcrumb) shows it as it was, where a sheet seen for the first time is fitted.
   */
  const views = useRef(new Map<string, View>());
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
        const otherFiles = s.files !== prev.files;
        if (otherFiles) views.current.clear();
        if (s.sheet === prev.sheet) return;
        // A renamed drawing keeps its edits under the new key: the same sheet, so keep the view.
        const e = s.doc.sheets[s.sheet];
        if (e && e === prev.doc.sheets[prev.sheet]) return;
        // Not while the files are reread (the sheet is then none for a moment): the design may be another one.
        if (prev.sheet && s.sheet && !otherFiles) views.current.set(prev.sheet, viewRef.current);
        fitAfter.current = { stale: prev.layout, sheet: s.sheet };
      }),
    [],
  );
  useEffect(() => {
    const pending = fitAfter.current;
    if (!layout || !pending || layout === pending.stale) return;
    fitAfter.current = undefined;
    const back = pending.sheet ? views.current.get(pending.sheet) : undefined;
    if (back) setView(back);
    else fit();
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

  /** The pointer (client coordinates) while it is over the canvas. */
  const hover = useRef<{ x: number; y: number }>(undefined);
  useEffect(() => {
    // Ctrl+V and Edit › Paste: a copy goes where the user looks, the pointer when it is over the canvas,
    // else the middle of the view. The store keeps a paste on its own sheet beside the original while that
    // spot is on screen: it needs the part of the sheet the canvas shows.
    const onPaste = () => {
      const el = wrap.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const v = viewRef.current;
      const at = hover.current ?? { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      const view = { x: -v.x / v.k, y: -v.y / v.k, width: r.width / v.k, height: r.height / v.k };
      useStore.getState().paste({ x: (at.x - r.left - v.x) / v.k, y: (at.y - r.top - v.y) / v.k }, view);
    };
    ui.addEventListener('paste', onPaste);
    return () => ui.removeEventListener('paste', onPaste);
  }, []);

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
    setWireDrafts(undefined);
    setGesture('none');
  }, []);

  // A wire being drawn starts at a pin or a wire of this sheet. When an undo (or anything else) takes
  // that away, or another sheet opens, stop drawing it: finishing it would be refused for a reason that
  // makes no sense ('Connect an output to an input'). When its pin only moved, the draft starts there.
  const sheet = useStore((s) => s.sheet);
  useEffect(() => {
    if (mode.current.kind === 'wire' || mode.current.kind === 'press-port') cancelWire();
  }, [sheet, cancelWire]);
  useEffect(() => {
    const m = mode.current;
    if (m.kind !== 'wire' || !layout) return;
    if (m.from.kind === 'wire') {
      const id = m.from.edge;
      if (!layout.edges.some((x) => x.id === id)) cancelWire();
      return;
    }
    const id = m.from.port;
    const p = layout.nodes.flatMap((n) => n.ports).find((q) => q.id === id);
    if (!p) cancelWire();
    else if (p.x !== m.draft.points[0].x || p.y !== m.draft.points[0].y) {
      // Its pin moved (an undo, say): start again from where it is now.
      m.draft = startDraft({ x: p.x, y: p.y }, p.side);
      setWireDrafts(undefined);
    }
  }, [layout, cancelWire]);

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
          // Take back the last corner; with none left, stop drawing.
          const d = undoCorner(m.draft, m.startAxis);
          if (d) {
            m.draft = d;
            setWireDrafts(undefined);
          } else cancelWire();
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
        const at = onGridAlong(e.points, nearestOnPolyline(e.points, w));
        return { end: { kind: 'wire', edge: e.id, at }, at };
      }
    }
    return undefined;
  };

  /** Where the wire being drawn goes now: to the pin or wire under the pointer (`over`), or to the pointer. */
  const draftTo = (m: Extract<Mode, { kind: 'wire' }>, w: Point, over?: { end: WireEnd; at: Point }): Point[] => {
    const own = !!over && isStart(m, over.end);
    if (over && !own) {
      const pin = over.end.kind === 'port' ? portInfo(over.end.port) : undefined;
      return draftPath(m.draft, over.at, pin?.port.side, pin?.node);
    }
    return draftPath(m.draft, { x: snap(w.x), y: snap(w.y) });
  };

  /** Finish the wire being drawn at the pin or wire `over`, as drawn. */
  const finishWire = (over: { end: WireEnd; at: Point }, w: Point) => {
    const m = mode.current;
    if (m.kind !== 'wire') return;
    const path = draftTo(m, w, over);
    // Dragged straight to the pin, with no corner made, through a symbol in the way: the sheet routes that
    // wire around it (as the corners were left to the app anyway). Corners the user made are kept as drawn.
    const free = m.draft.points.length === 1 && !runsThroughSymbol(path, m.from, over.end) && !meetsOtherNet(path, m.from, over.end);
    const ok = store().connectEnds(m.from, over.end, m.draft.points.length > 1 || free ? path : undefined);
    if (ok || !m.dragging) {
      cancelWire();
      return;
    }
    // Refused (say, two outputs): the wire goes on with clicks from where it was, and moving the pointer
    // without a button held no longer fixes corners as a drag does.
    m.dragging = false;
    m.draft = { ...m.draft, turn: undefined, pivot: undefined };
    updateDraft(w);
  };

  /** Whether a drawn wire from `a` to `b` runs through a symbol (but for its first and last leg at their pins). */
  const runsThroughSymbol = (points: Point[], a: WireEnd, b: WireEnd) => {
    const nodeOf = (e: WireEnd) => (e.kind === 'port' ? e.node : undefined);
    return (store().layout?.nodes ?? []).some((n) => {
      if (n.kind === 'text') return false;
      let line = points;
      if (n.id === nodeOf(a)) line = line.slice(1);
      if (n.id === nodeOf(b)) line = line.slice(0, -1);
      return line.length >= 2 && polylineHitsRect(line, { x: n.x + 1, y: n.y + 1, width: n.width - 2, height: n.height - 2 });
    });
  };

  /** Whether a drawn wire from `a` to `b` runs onto a wire of another net, which would read as a connection. */
  const meetsOtherNet = (points: Point[], a: WireEnd, b: WireEnd) => {
    const edges = store().layout?.edges ?? [];
    const netOf = (end: WireEnd) =>
      end.kind === 'wire' ? edges.find((x) => x.id === end.edge)?.source.port : (edges.find((x) => x.target.port === end.port)?.source.port ?? end.port);
    const nets = new Set([netOf(a), netOf(b)]);
    return edges.some((x) => !nets.has(x.source.port) && wiresMeet(points, x.points));
  };

  /** Whether `end` is where the wire being drawn started: its own pin, or the wire it branches from. */
  const isStart = (m: Extract<Mode, { kind: 'wire' }>, end: WireEnd) =>
    (end.kind === 'port' && m.from.kind === 'port' && end.port === m.from.port) || (end.kind === 'wire' && m.from.kind === 'wire' && end.edge === m.from.edge);

  /** Redraw the wire being drawn, to the pointer at `w`, or onto the pin or wire under it. */
  const updateDraft = (w: Point, hit: Hit = {}) => {
    const m = mode.current;
    if (m.kind !== 'wire') return;
    setWireDrafts([draftTo(m, w, endAt(hit, w))]);
  };

  /** Start drawing a wire at a pin or on a wire. */
  const startWire = (from: WireEnd, at: Point, side: Side | undefined, axis: Axis, dragging: boolean, w: Point) => {
    const draft = startDraft(at, side, axis);
    mode.current = { kind: 'wire', from, side, startAxis: draft.axis, draft, dragging };
    setGesture('wire');
    updateDraft(w);
  };

  // Before the return below: a hook runs on every render.
  const openBus = useMemo(() => (layout ? openBusHints(layout) : []), [layout]);

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
  const cursor = spaceDown || gesture === 'pan' ? 'grab' : placing ? 'copy' : gesture === 'wire' ? 'crosshair' : (edgeCursor ?? 'default');

  /** A double-click: opens a block, the JSON of a symbol with settings or of a part's block, or renames. */
  const doubleClick = (ev: React.MouseEvent) => {
    const m = mode.current;
    if (m.kind === 'wire') {
      cancelWire();
      return;
    }
    const hit = hitFrom(document.elementFromPoint(ev.clientX, ev.clientY));
    const s = store();
    if (hit.node) {
      const n = s.layout?.nodes.find((x) => x.id === hit.node);
      const settings = doubleClickSettings(s, hit.node);
      // A block opens; a symbol with settings, or a part's block, opens its JSON; the rest is renamed.
      if (n?.kind === 'instance' && n.moduleName && (s.doc.drawn.includes(n.moduleName) || s.viewDesign()?.modules[n.moduleName])) s.openNode(hit.node);
      else if (settings) {
        openSettings(settings, ev.clientX, ev.clientY, hit.node);
        // The next two clicks the canvas gets open it again, however the browser counts them (see ClickRun).
        clicks.reset();
      } else ui.dispatchEvent(new CustomEvent('rename', { detail: hit.node }));
    } else if (hit.edge) {
      ui.dispatchEvent(new CustomEvent('rename', { detail: hit.edge }));
    }
  };

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
        s.startPlacing(s.placing?.sym === sym ? s.placing : { sym: sym as never });
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
          if (end && !isStart(m, end.end)) finishWire(end, w);
          else {
            // A click fixes the wire up to here: the corner on the way, and this point.
            m.draft = clickAt(m.draft, { x: snap(w.x), y: snap(w.y) });
            updateDraft(w, hit);
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
          const e = s.layout?.edges.find((x) => x.id === hit.edge);
          if (ev.altKey && e) {
            // Alt: a new wire branches off this one here.
            const end = endAt(hit, w);
            if (end) startWire(end.end, end.at, undefined, acrossAt(e.points, end.at), true, w);
            return;
          }
          if (additive) s.select([hit.edge], 'toggle');
          else s.select([hit.edge]);
          mode.current = {
            kind: 'press-edge',
            id: hit.edge,
            cx: ev.clientX,
            cy: ev.clientY,
            grab: e ? grabAt(e.points, w, 8 / view.k) : undefined,
            points: e?.points ?? [],
            moved: false,
          };
          return;
        }
        mode.current = { kind: 'press-empty', start: w, cx: ev.clientX, cy: ev.clientY, additive, moved: false };
      }}
      onPointerLeave={() => {
        hover.current = undefined;
        setHoverPort(undefined);
        setHoverNode(undefined);
      }}
      onPointerMove={(ev) => {
        hover.current = { x: ev.clientX, y: ev.clientY };
        const w = toWorld(ev.clientX, ev.clientY);
        const m = mode.current;
        const s = store();
        if (s.placing || m.kind === 'wire') setPointer(w);
        if (m.kind === 'none' || m.kind === 'wire') {
          const hit = hitFrom(m.kind === 'wire' ? document.elementFromPoint(ev.clientX, ev.clientY) : ev.target);
          setHoverPort(hit.port?.port);
          setHoverNode(hoveredSymbol(hit));
          if (m.kind === 'wire') {
            // A drag draws the wire where the pointer goes (see trace); a click-drawn wire waits for clicks.
            if (m.dragging) m.draft = trace(m.draft, { x: snap(w.x), y: snap(w.y) }, Math.max(1.5 * GRID, 12 / view.k));
            updateDraft(w, hit);
          } else {
            const e = hit.edge ? s.layout?.edges.find((x) => x.id === hit.edge) : undefined;
            setEdgeCursor(e ? grabCursor(e.points, grabAt(e.points, w, 8 / view.k)) : undefined);
          }
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
            // Always by whole grid steps: symbols stay on the grid, so their pins line up.
            m.dx = snap(w.x - m.start.x);
            m.dy = snap(w.y - m.start.y);
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
            startWire(m.end, m.at, m.side, 'h', true, w);
            return;
          }
          case 'press-edge': {
            if (!m.grab || (!m.moved && !far(m.cx, m.cy))) return;
            m.moved = true;
            // The wire, and the wires of its net that share the moved stretch.
            m.drafts = reshape(s.layout?.edges ?? [], m.id, m.points, m.grab, { x: snap(w.x), y: snap(w.y) });
            setWireDrafts(Object.values(m.drafts));
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
            // A click on a pin starts a wire; click for corners, then click a pin or a wire to finish.
            startWire(m.end, m.at, m.side, 'h', false, w);
            return;
          case 'press-edge':
            mode.current = { kind: 'none' };
            if (m.moved && m.drafts) {
              // A drag that ends where it began (or a wire that cannot move) changes nothing: no undo step, and
              // the wire is not made one drawn by hand.
              const was = new Map((s.layout?.edges ?? []).map((x) => [x.id, x.points]));
              const same = (a: readonly Point[], b: readonly Point[] = []) => a.length === b.length && a.every((p, i) => p.x === b[i].x && p.y === b[i].y);
              const changed = Object.entries(m.drafts).filter(([id, pts]) => !same(pts, was.get(id)));
              if (changed.length) s.setEdgeRoutes(Object.fromEntries(changed));
            }
            setWireDrafts(undefined);
            return;
          case 'wire': {
            if (!m.dragging) return;
            const hit = hitFrom(document.elementFromPoint(ev.clientX, ev.clientY));
            const end = endAt(hit, w);
            if (end && !isStart(m, end.end)) finishWire(end, w);
            else {
              // Released on empty canvas: the wire is fixed up to here, and goes on with clicks.
              m.dragging = false;
              if (!end) m.draft = clickAt({ ...m.draft, turn: undefined, pivot: undefined }, { x: snap(w.x), y: snap(w.y) });
              updateDraft(w, hit);
            }
            return;
          }
        }
      }}
      onDoubleClick={doubleClick}
      onClick={(ev) => {
        if ((ev.target as Element).closest('.zoom-controls')) return;
        if (clicks.click('canvas', ev.detail)) doubleClick(ev);
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
          {/* Bus pins not wired yet: a stub with their bits, so a width shows before the symbol is wired. */}
          <g pointerEvents="none" data-open-bus-hints="">
            {openBus.map((h) => (
              <g key={h.port} data-open-bus={h.port}>
                <line x1={h.from.x} y1={h.from.y} x2={h.to.x} y2={h.to.y} stroke={theme.muted} strokeWidth={1.4} />
                <line x1={h.slash.x - 4} y1={h.slash.y + 5} x2={h.slash.x + 4} y2={h.slash.y - 5} stroke={theme.muted} strokeWidth={1.4} />
                <text x={h.text.x} y={h.text.y} fontSize={10} textAnchor={h.text.anchor} fill={theme.muted} fontFamily={theme.font}>
                  {h.width}
                </text>
              </g>
            ))}
          </g>
          <g>
            {layout.nodes.map((n) =>
              n.ports.map((p) => {
                const hover = hoverPort === p.id;
                // Only the symbol under the pointer shows its connection points, in green.
                const shown = hover || hoverNode === n.id;
                return (
                  <g key={p.id}>
                    {shown && (
                      <circle
                        cx={p.x}
                        cy={p.y}
                        r={hover ? 4 : 3}
                        fill={theme.port}
                        stroke={theme.background}
                        strokeWidth={1}
                        pointerEvents="none"
                        data-pin-dot={p.id}
                      />
                    )}
                    <circle cx={p.x} cy={p.y} r={6} fill="transparent" data-port-id={p.id} data-port-node={n.id} style={{ cursor: 'crosshair' }}>
                      {/* The pin's name on hover: tells EN from ARST, A from B, and so on. */}
                      <title>{p.width > 1 ? `${p.name} [${p.width}]` : p.name}</title>
                    </circle>
                  </g>
                );
              }),
            )}
          </g>
          {/* Corners of the selected wires: each can be dragged, and so can each leg. */}
          {(wireDrafts ? [] : layout.edges.length > selection.size ? [...selection].map((id) => layout.edges.find((x) => x.id === id)) : layout.edges).map((e) =>
            e && selection.has(e.id)
              ? e.points.slice(1, -1).map((p, i) => (
                  <rect
                    key={`${e.id}:${i}`}
                    x={p.x - 3 / view.k}
                    y={p.y - 3 / view.k}
                    width={6 / view.k}
                    height={6 / view.k}
                    fill={theme.background}
                    stroke={theme.accent}
                    strokeWidth={1 / view.k}
                    pointerEvents="none"
                  />
                ))
              : null,
          )}
          {wireDrafts?.map((d, i) => (
            <polyline
              key={i}
              points={d.map((p) => `${p.x},${p.y}`).join(' ')}
              fill="none"
              stroke={theme.accent}
              strokeWidth={1.6}
              strokeDasharray="5 3"
              strokeLinejoin="round"
              pointerEvents="none"
            />
          ))}
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
