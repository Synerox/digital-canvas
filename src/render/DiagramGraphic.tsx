/**
 * Pure SVG drawing of a laid-out diagram in textbook style.
 * Uses presentation attributes only, so the markup can be exported as-is.
 */
import type { JSX } from 'react';
import type { LEdge, LNode, LayoutResult, Point } from '../layout/elk-layout';
import { FONT, approxMeasure, isMuxType } from '../layout/elk-layout';
import type { Theme } from './theme';

export interface GraphicProps {
  layout: LayoutResult;
  /** Ports whose incoming wire already carries a label (filled in by DiagramGraphic). */
  labeledPorts?: ReadonlySet<string>;
  theme: Theme;
  /** Selected node and edge IDs. */
  selection?: ReadonlySet<string>;
  highlighted?: ReadonlySet<string>;
  /** Attach data-node-id / data-edge-id attributes for hit testing (off for export). */
  interactive?: boolean;
  /** Edges drawn in the warning colour in the editor (for example a width mismatch). */
  flagged?: ReadonlySet<string>;
}

const STROKE = 1.4;

/** Register pins on the bottom edge that are written next to their pin (the clock has its triangle). */
const REGISTER_PINS = new Set(['EN', 'ARST', 'SRST']);

function pathOf(points: Point[]): string {
  return points.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ');
}

/** Point `dist` along a polyline (already reversed when measured from its end), and the segment it is on. */
function pointAt(pts: Point[], dist: number): { at: Point; horizontal: boolean; nearBend: boolean } {
  let left = dist;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len >= left || i === pts.length - 1) {
      const t = len === 0 ? 0 : Math.min(1, left / len);
      const pos = t * len;
      return {
        at: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t },
        horizontal: Math.abs(b.x - a.x) >= Math.abs(b.y - a.y),
        nearBend: (i > 1 && pos < 6) || (i < pts.length - 1 && len - pos < 6),
      };
    }
    left -= len;
  }
  return { at: pts[0], horizontal: true, nearBend: false };
}

function firstSegmentLength(points: Point[], fromEnd: boolean): number {
  const pts = fromEnd ? [...points].reverse() : points;
  if (pts.length < 2) return 0;
  return Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const hits = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Where a piece of text is written: its baseline point and alignment. */
interface TextSpot {
  x: number;
  y: number;
  anchor: 'start' | 'end';
}

/** The box a line of text covers: approximate width (as the layout measures), cap height and a little descent. */
function textBox(t: TextSpot, text: string, size: number): Box {
  const w = approxMeasure(text, size);
  return { x: t.anchor === 'start' ? t.x : t.x - w, y: t.y - size * 0.78, width: w, height: size * 0.88 };
}

/** A wire segment as a thin box. */
function segmentBox(a: Point, b: Point): Box {
  return { x: Math.min(a.x, b.x) - 0.5, y: Math.min(a.y, b.y) - 0.5, width: Math.abs(a.x - b.x) + 1, height: Math.abs(a.y - b.y) + 1 };
}

const MARK_FONT = 10;

/** Where a bus mark's slash goes, and where its number is written. */
interface MarkSpot {
  at: Point;
  text: TextSpot;
}

/**
 * Where to draw the width mark of a bus wire: near its start (or its end), with its slash off
 * `texts` (wire labels, bus slice names, other marks' numbers) and its number off those and off
 * `solids` (symbols and wires). The usual spot comes first; then the number goes on the other
 * side of the wire, then the mark moves further along it (never onto a bend). When nothing is
 * clear, the usual spot.
 */
function placeBusMark(points: Point[], fromEnd: boolean, text: string, texts: readonly Box[], solids: readonly Box[]): MarkSpot {
  const pts = fromEnd ? [...points].reverse() : points;
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  const usual = Math.min(12, firstSegmentLength(points, fromEnd) / 2);
  const spots = (at: Point, horizontal: boolean): MarkSpot[] => [
    { at, text: { x: at.x + 2, y: at.y - 7, anchor: 'start' } },
    horizontal ? { at, text: { x: at.x + 2, y: at.y + 14, anchor: 'start' } } : { at, text: { x: at.x - 6, y: at.y + 4, anchor: 'end' } },
  ];
  // Only what is near the wire's end can be in the way.
  const reach = Math.min(total, 130) + 30;
  const o = pts[0];
  const close = (b: Box) => b.x < o.x + reach && b.x + b.width > o.x - reach && b.y < o.y + reach && b.y + b.height > o.y - reach;
  const nearTexts = texts.filter(close);
  const nearAll = [...nearTexts, ...solids.filter(close)];
  const dists = [usual];
  for (let d = 20; d <= Math.min(total - 6, 120); d += 8) dists.push(d);
  for (const [k, d] of dists.entries()) {
    const p = pointAt(pts, d);
    if (k > 0 && p.nearBend) continue;
    const slash = { x: p.at.x - 4, y: p.at.y - 5, width: 8, height: 10 };
    if (nearTexts.some((b) => hits(b, slash))) continue;
    for (const s of spots(p.at, p.horizontal)) {
      const box = textBox(s.text, text, MARK_FONT);
      if (!nearAll.some((b) => hits(b, box))) return s;
    }
  }
  return spots(pointAt(pts, usual).at, true)[0];
}

function BusMark({ spot, width, theme }: { spot: MarkSpot; width: number; theme: Theme }) {
  const { at, text } = spot;
  return (
    <g>
      <line x1={at.x - 4} y1={at.y + 5} x2={at.x + 4} y2={at.y - 5} stroke={theme.wire} strokeWidth={STROKE} />
      <text x={text.x} y={text.y} fontSize={MARK_FONT} textAnchor={text.anchor} fill={theme.ink} fontFamily={theme.font}>
        {width}
      </text>
    </g>
  );
}

const SLICE_FONT = 9;

/**
 * Where the slice names of splits (`[7:4]` right of the bar, above its wire) and of concatenations
 * (left of the bar, below its wire) go. When a wire (typically the name's own, turning just next to
 * the bar) or another name runs through it, the name moves past its wire's bend, or else to the
 * other side of its wire.
 */
function placeSliceNames(nodes: readonly LNode[], edges: readonly LEdge[], labeledPorts?: ReadonlySet<string>): Map<string, TextSpot> {
  const out = new Map<string, TextSpot>();
  const wires: Box[] = [];
  for (const e of edges) for (let i = 1; i < e.points.length; i++) wires.push(segmentBox(e.points[i - 1], e.points[i]));
  /** Where the wire of a port first leaves the port's row (points listed from the port). */
  const bendX = (port: string, fromSource: boolean): number | undefined => {
    for (const e of edges) {
      if ((fromSource ? e.source.port : e.target.port) !== port) continue;
      const pts = fromSource ? e.points : [...e.points].reverse();
      if (pts.length >= 3 && Math.abs(pts[1].y - pts[0].y) < 0.5) return pts[1].x;
    }
    return undefined;
  };
  const placed: Box[] = [];
  for (const n of nodes) {
    if (n.kind !== 'split' && n.kind !== 'join') continue;
    for (const q of n.ports) {
      // Above or below the wire, within its 20px row: a name below one wire and the next name above the
      // wire under it just touch, so the other side comes last.
      const above = q.y - 3;
      const below = q.y + 9;
      // Past the bend only when the bend is what is in the way: a name far from its bar would belong to nothing.
      const reach = approxMeasure(q.name, SLICE_FONT) + 6;
      let spots: TextSpot[];
      if (n.kind === 'split' && q.side === 'EAST') {
        const x = n.x + n.width + 3;
        const bend = bendX(q.id, true);
        const past: TextSpot[] = bend !== undefined && bend > x && bend < x + reach ? [{ x: bend + 3, y: above, anchor: 'start' }] : [];
        spots = [{ x, y: above, anchor: 'start' }, ...past, { x, y: below, anchor: 'start' }];
      } else if (n.kind === 'join' && q.side === 'WEST' && !labeledPorts?.has(q.id)) {
        const x = n.x - 3;
        const bend = bendX(q.id, false);
        const past: TextSpot[] = bend !== undefined && bend < x && bend > x - reach ? [{ x: bend - 3, y: below, anchor: 'end' }] : [];
        spots = [{ x, y: below, anchor: 'end' }, ...past, { x, y: above, anchor: 'end' }];
      } else {
        continue;
      }
      const boxes = spots.map((s) => textBox(s, q.name, SLICE_FONT));
      const k = boxes.findIndex((b) => !wires.some((w) => hits(w, b)) && !placed.some((p) => hits(p, b)));
      const pick = k < 0 ? 0 : k;
      out.set(q.id, spots[pick]);
      placed.push(boxes[pick]);
    }
  }
  return out;
}

/** Boxes the slice names cover, by port. */
function sliceNameBoxes(nodes: readonly LNode[], names: ReadonlyMap<string, TextSpot>): Box[] {
  const out: Box[] = [];
  for (const n of nodes) for (const q of n.ports) {
    const s = names.get(q.id);
    if (s) out.push(textBox(s, q.name, SLICE_FONT));
  }
  return out;
}

function nodeStroke(n: LNode, p: GraphicProps): { stroke: string; fill: string; width: number } {
  const sel = !!p.selection?.has(n.id);
  const hi = p.highlighted?.has(n.id);
  return {
    stroke: sel ? p.theme.accent : p.theme.ink,
    fill: hi || sel ? p.theme.accentFill : n.kind === 'input' || n.kind === 'output' ? p.theme.pinFill : p.theme.fill,
    width: sel ? 2.2 : STROKE,
  };
}

/** Short stub lines from a port to the outline of a non-rectangular symbol. */
function stubs(n: LNode, edgeX: (y: number) => number, theme: Theme): JSX.Element[] {
  return n.ports
    .filter((p) => p.side === 'WEST')
    .map((p) => (
      <line key={p.id} x1={p.x} y1={p.y} x2={n.x + edgeX(p.y - n.y)} y2={p.y} stroke={theme.wire} strokeWidth={STROKE} />
    ));
}

function CellShape({ n, p }: { n: LNode; p: GraphicProps }) {
  const { theme } = p;
  const s = nodeStroke(n, p);
  const { x, y, width: w, height: h } = n;
  const t = n.cellType ?? '';
  const text = (label: string, cx: number, cy: number, size = FONT.op) => (
    <text x={cx} y={cy + size / 3} fontSize={size} textAnchor="middle" fill={theme.ink} fontFamily={theme.font}>
      {label}
    </text>
  );

  if (isMuxType(t)) {
    const inset = Math.min(10, h / 4);
    const west = n.ports.filter((q) => q.side === 'WEST');
    return (
      <g>
        <polygon
          points={`${x},${y} ${x + w},${y + inset} ${x + w},${y + h - inset} ${x},${y + h}`}
          fill={s.fill}
          stroke={s.stroke}
          strokeWidth={s.width}
          strokeLinejoin="round"
        />
        {(t === '$mux' || t === 'dc:mux') &&
          west.map((q, k) => (
            <text key={q.id} x={x + 4} y={q.y + 3.5} fontSize={10} fill={theme.muted} fontFamily={theme.font}>
              {k}
            </text>
          ))}
      </g>
    );
  }

  if (t === '$add' || t === '$sub' || t === '$mul') {
    // ALU-style adder: trapezoid with a notch between the two operands.
    const pts = [
      [0, 0],
      [w, h * 0.28],
      [w, h * 0.72],
      [0, h],
      [0, h * 0.6],
      [w * 0.28, h * 0.5],
      [0, h * 0.4],
    ]
      .map(([a, b]) => `${x + a},${y + b}`)
      .join(' ');
    return (
      <g>
        <polygon points={pts} fill={s.fill} stroke={s.stroke} strokeWidth={s.width} strokeLinejoin="round" />
        {text(n.label, x + w * 0.62, y + h / 2, 13)}
      </g>
    );
  }

  if (['$eq', '$ne', '$lt', '$le', '$gt', '$ge', '$eqx', '$nex'].includes(t)) {
    const r = Math.min(w, h) / 2;
    const cx = x + w / 2;
    const cy = y + h / 2;
    const edgeX = (py: number) => w / 2 - Math.sqrt(Math.max(0, r * r - (py - h / 2) ** 2));
    return (
      <g>
        {stubs(n, edgeX, theme)}
        <circle cx={cx} cy={cy} r={r} fill={s.fill} stroke={s.stroke} strokeWidth={s.width} />
        {text(n.label, cx, cy, 14)}
      </g>
    );
  }

  if (t === 'dc:decoder') {
    return (
      <g>
        <rect x={x} y={y} width={w} height={h} fill={s.fill} stroke={s.stroke} strokeWidth={s.width} />
        {text('DEC', x + w / 2, y + h / 2 - 5, 11)}
        <text x={x + w / 2} y={y + h / 2 + 10} fontSize={9} textAnchor="middle" fill={theme.muted} fontFamily={theme.font}>
          {`${n.attrs?.inputs ?? '?'}→${n.attrs?.outputs ?? '?'}`}
        </text>
      </g>
    );
  }

  const isAnd = t === '$and' || t === '$logic_and' || t === '$reduce_and' || t === 'dc:and' || t === 'dc:nand';
  const isOr = t === '$or' || t === '$logic_or' || t === '$reduce_or' || t === '$reduce_bool' || t === 'dc:nor';
  const isXor = t === '$xor' || t === '$xnor' || t === '$reduce_xor' || t === '$reduce_xnor';
  if (isAnd) {
    // NAND: the same body, shortened to make room for the output bubble.
    const bubble = t === 'dc:nand';
    const bw = bubble ? w - 8 : w;
    const d = `M${x},${y} H${x + bw / 2} A${bw / 2},${h / 2} 0 0 1 ${x + bw / 2},${y + h} H${x} Z`;
    const inverted = n.attrs?.invertB ? n.ports.find((q) => q.name === 'B') : undefined;
    return (
      <g>
        <path d={d} fill={s.fill} stroke={s.stroke} strokeWidth={s.width} strokeLinejoin="round" />
        {inverted && <circle cx={x - 3.5} cy={inverted.y} r={3.5} fill={s.fill} stroke={s.stroke} strokeWidth={STROKE} />}
        {bubble && <circle cx={x + w - 4} cy={y + h / 2} r={4} fill={s.fill} stroke={s.stroke} strokeWidth={s.width} />}
      </g>
    );
  }
  if (isOr || isXor) {
    const curve = (dx: number) => `M${x + dx},${y} Q${x + dx + w * 0.25},${y + h / 2} ${x + dx},${y + h}`;
    const inverted = t === '$xnor' || t === '$reduce_xnor' || t === 'dc:nor';
    const bw = inverted ? w - 8 : w;
    const body = `M${x},${y} Q${x + bw * 0.6},${y} ${x + bw},${y + h / 2} Q${x + bw * 0.6},${y + h} ${x},${y + h} Q${x + w * 0.25},${y + h / 2} ${x},${y} Z`;
    const edgeX = (py: number) => {
      const tt = py / h;
      return 2 * (1 - tt) * tt * (w * 0.25);
    };
    return (
      <g>
        {stubs(n, edgeX, theme)}
        <path d={body} fill={s.fill} stroke={s.stroke} strokeWidth={s.width} strokeLinejoin="round" />
        {isXor && <path d={curve(-6)} fill="none" stroke={s.stroke} strokeWidth={s.width} />}
        {inverted && <circle cx={x + w - 4} cy={y + h / 2} r={4} fill={s.fill} stroke={s.stroke} strokeWidth={s.width} />}
      </g>
    );
  }
  if (t === '$not' || t === '$logic_not' || t === 'dc:buf') {
    const br = t === 'dc:buf' ? 0 : 4;
    return (
      <g>
        <polygon
          points={`${x},${y + 4} ${x + w - 2 * br},${y + h / 2} ${x},${y + h - 4}`}
          fill={s.fill}
          stroke={s.stroke}
          strokeWidth={s.width}
          strokeLinejoin="round"
        />
        {br > 0 && <circle cx={x + w - br} cy={y + h / 2} r={br} fill={s.fill} stroke={s.stroke} strokeWidth={s.width} />}
      </g>
    );
  }
  if (/dff|dlatch/.test(t)) {
    const clk = n.ports.find((q) => q.name === 'CLK');
    // Enable and reset pins sit on the bottom edge like the clock: name them, or a register with an
    // enable and one with a reset look the same. Written above the clock triangle's height.
    const named = n.ports.filter((q) => q.side === 'SOUTH' && REGISTER_PINS.has(q.name));
    return (
      <g>
        <rect x={x} y={y} width={w} height={h} fill={s.fill} stroke={s.stroke} strokeWidth={s.width} />
        {text(t.includes('dlatch') ? 'L' : 'D  Q', x + w / 2, y + h / 2 - 3, 10)}
        {clk && (
          <polyline
            points={`${clk.x - 5},${y + h} ${clk.x},${y + h - 7} ${clk.x + 5},${y + h}`}
            fill="none"
            stroke={s.stroke}
            strokeWidth={STROKE}
          />
        )}
        {named.map((q) => (
          <text key={q.id} x={q.x} y={y + h - 9} fontSize={7} textAnchor="middle" fill={theme.muted} fontFamily={theme.font}>
            {q.name}
          </text>
        ))}
      </g>
    );
  }

  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={3} fill={s.fill} stroke={s.stroke} strokeWidth={s.width} />
      {text(n.label, x + w / 2, y + h / 2, n.label.length > 2 ? 11 : FONT.op)}
    </g>
  );
}

function NodeShape({ n, p, names }: { n: LNode; p: GraphicProps; names: ReadonlyMap<string, TextSpot> }) {
  const { theme } = p;
  const s = nodeStroke(n, p);
  const { x, y, width: w, height: h } = n;
  const dataAttrs = p.interactive ? { 'data-node-id': n.id, style: { cursor: 'pointer' } } : {};

  let body: JSX.Element;
  switch (n.kind) {
    case 'input':
    case 'output':
    case 'inout': {
      const tip = 8;
      const left = n.kind === 'inout' ? tip : 0;
      body = (
        <g>
          <polygon
            points={`${x + left},${y} ${x + w - tip},${y} ${x + w},${y + h / 2} ${x + w - tip},${y + h} ${x + left},${y + h} ${x},${y + h / 2}`}
            fill={s.fill}
            stroke={s.stroke}
            strokeWidth={s.width}
            strokeLinejoin="round"
          />
          <text x={x + 6 + left} y={y + h / 2 + 4} fontSize={FONT.pin} fill={theme.ink} fontFamily={theme.font}>
            {n.label}
          </text>
        </g>
      );
      break;
    }
    case 'const':
      body = (
        <g>
          <rect x={x} y={y} width={w} height={h} fill="transparent" stroke={p.selection?.has(n.id) ? theme.accent : 'none'} />
          <text
            x={x + w - 3}
            y={y + h / 2 + 4}
            fontSize={FONT.label}
            textAnchor="end"
            fill={theme.ink}
            fontFamily={theme.font}
          >
            {n.label}
          </text>
        </g>
      );
      break;
    case 'join':
    case 'split':
      // Slice names: where placeSliceNames put them (a join's are left out when its wire has a label).
      body = (
        <g>
          <rect x={x} y={y} width={w} height={h} fill={s.stroke} stroke={s.stroke} strokeWidth={1} />
          {n.ports.map((q) => {
            const t = names.get(q.id);
            return t ? (
              <text key={q.id} x={t.x} y={t.y} fontSize={SLICE_FONT} textAnchor={t.anchor} fill={theme.muted} fontFamily={theme.font}>
                {q.name}
              </text>
            ) : null;
          })}
        </g>
      );
      break;
    case 'text':
      body = (
        <g>
          <rect x={x} y={y} width={w} height={h} fill="transparent" stroke={p.selection?.has(n.id) ? theme.accent : 'none'} strokeDasharray="3 2" />
          {n.label.split('\n').map((line, i) => (
            <text key={i} x={x + 2} y={y + 14 + i * 16} fontSize={FONT.pin} fill={theme.ink} fontFamily={theme.font}>
              {line}
            </text>
          ))}
        </g>
      );
      break;
    case 'instance': {
      body = (
        <g>
          <rect x={x} y={y} width={w} height={h} fill={s.fill} stroke={s.stroke} strokeWidth={s.width} />
          <text
            x={x + w / 2}
            y={y + 20}
            fontSize={FONT.title}
            fontWeight={700}
            textAnchor="middle"
            fill={theme.ink}
            fontFamily={theme.font}
          >
            {n.label}
          </text>
          {n.subLabel && (
            <text
              x={x + w / 2}
              y={y + 37}
              fontSize={FONT.sub}
              fontStyle="italic"
              textAnchor="middle"
              fill={theme.muted}
              fontFamily={theme.font}
            >
              {n.subLabel}
            </text>
          )}
          {n.ports.map((q) =>
            q.side === 'WEST' || q.side === 'EAST' ? (
              <text
                key={q.id}
                x={q.side === 'WEST' ? q.x + 5 : q.x - 5}
                y={q.y + 4}
                fontSize={FONT.port}
                textAnchor={q.side === 'WEST' ? 'start' : 'end'}
                fill={theme.ink}
                fontFamily={theme.font}
              >
                {q.name}
              </text>
            ) : null,
          )}
        </g>
      );
      break;
    }
    default:
      body = <CellShape n={n} p={p} />;
  }
  return <g {...dataAttrs}>{body}</g>;
}

function Edges({
  edges,
  theme,
  selection,
  flagged,
  interactive,
  texts,
  solids,
}: {
  edges: LEdge[];
  theme: Theme;
  selection?: ReadonlySet<string>;
  flagged?: ReadonlySet<string>;
  interactive?: boolean;
  /** Text the width marks must not cover; each placed mark's number is added. */
  texts: Box[];
  /** Symbols and wire segments the numbers of width marks must not cover. */
  solids: readonly Box[];
}) {
  const marks: JSX.Element[] = [];
  const doneSources = new Set<string>();
  const junctionKeys = new Set<string>();
  const junctions: Point[] = [];
  const mark = (e: LEdge, fromEnd: boolean) => {
    const text = String(e.width);
    const spot = placeBusMark(e.points, fromEnd, text, texts, solids);
    texts.push(textBox(spot.text, text, MARK_FONT));
    marks.push(<BusMark key={`m${e.id}`} spot={spot} width={e.width} theme={theme} />);
  };

  for (const e of edges) {
    if (e.width > 1 && e.points.length >= 2) {
      if (e.fullSource) {
        if (!doneSources.has(e.source.port)) {
          doneSources.add(e.source.port);
          mark(e, false);
        }
      } else {
        mark(e, true);
      }
    }
    for (const j of e.junctions) {
      const k = `${Math.round(j.x)},${Math.round(j.y)}`;
      if (!junctionKeys.has(k)) {
        junctionKeys.add(k);
        junctions.push(j);
      }
    }
  }

  return (
    <g>
      <g fill="none" stroke={theme.wire} strokeWidth={STROKE} strokeLinejoin="round">
        {edges.map((e) => (
          <path key={e.id} d={pathOf(e.points)} />
        ))}
      </g>
      {(selection || flagged) && (
        <g fill="none" strokeWidth={STROKE + 1} strokeLinejoin="round">
          {edges.map((e) =>
            selection?.has(e.id) || flagged?.has(e.id) ? (
              <path key={e.id} d={pathOf(e.points)} stroke={selection?.has(e.id) ? theme.accent : '#e03131'} strokeDasharray={selection?.has(e.id) ? undefined : '5 3'} />
            ) : null,
          )}
        </g>
      )}
      {junctions.map((j, i) => (
        <circle key={i} cx={j.x} cy={j.y} r={3} fill={theme.wire} />
      ))}
      {marks}
      {interactive && (
        <g fill="none" stroke="transparent" strokeWidth={9} style={{ cursor: 'pointer' }}>
          {edges.map((e) => (
            <path key={e.id} d={pathOf(e.points)} data-edge-id={e.id} />
          ))}
        </g>
      )}
      {edges.map((e) =>
        e.label && e.labelBox ? (
          <text
            key={`l${e.id}`}
            x={e.labelBox.x + 2}
            y={e.labelBox.y + e.labelBox.height - 2}
            fontSize={FONT.label}
            fontStyle="italic"
            fill={theme.ink}
            fontFamily={theme.font}
          >
            {e.label}
          </text>
        ) : null,
      )}
    </g>
  );
}

export function DiagramGraphic(props: GraphicProps) {
  const p = { ...props, labeledPorts: new Set(props.layout.edges.filter((e) => e.label).map((e) => e.target.port)) };
  const { nodes, edges } = p.layout;
  const names = placeSliceNames(nodes, edges, p.labeledPorts);
  // Width marks keep clear of wire labels and slice names, and their numbers of symbols, notes and wires too.
  const texts: Box[] = [...edges.flatMap((e) => (e.label && e.labelBox ? [e.labelBox] : [])), ...sliceNameBoxes(nodes, names)];
  const solids: Box[] = [
    ...nodes.map((n) => ({ x: n.x, y: n.y, width: n.width, height: n.height })),
    ...edges.flatMap((e) => e.points.slice(1).map((q, i) => segmentBox(e.points[i], q))),
  ];
  return (
    <g>
      <Edges edges={edges} theme={p.theme} selection={p.selection} flagged={p.flagged} interactive={p.interactive} texts={texts} solids={solids} />
      {nodes.map((n) => (
        <NodeShape key={n.id} n={n} p={p} names={names} />
      ))}
    </g>
  );
}
