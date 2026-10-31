/**
 * Pure SVG drawing of a laid-out diagram in textbook style.
 * Uses presentation attributes only, so the markup can be exported as-is.
 */
import type { JSX } from 'react';
import type { LEdge, LNode, LayoutResult, Point } from '../layout/elk-layout';
import { FONT } from '../layout/elk-layout';
import type { Theme } from './theme';

export interface GraphicProps {
  layout: LayoutResult;
  theme: Theme;
  selected?: string;
  highlighted?: ReadonlySet<string>;
  /** Attach data-node-id attributes for hit testing (off for export). */
  interactive?: boolean;
}

const STROKE = 1.4;

function pathOf(points: Point[]): string {
  return points.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ');
}

/** Point `dist` along a polyline from its start (or end when reversed). */
function along(points: Point[], dist: number, fromEnd: boolean): Point {
  const pts = fromEnd ? [...points].reverse() : points;
  let left = dist;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len >= left || i === pts.length - 1) {
      const t = len === 0 ? 0 : Math.min(1, left / len);
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    left -= len;
  }
  return pts[0];
}

function firstSegmentLength(points: Point[], fromEnd: boolean): number {
  const pts = fromEnd ? [...points].reverse() : points;
  if (pts.length < 2) return 0;
  return Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
}

function BusMark({ at, width, theme }: { at: Point; width: number; theme: Theme }) {
  return (
    <g>
      <line x1={at.x - 4} y1={at.y + 5} x2={at.x + 4} y2={at.y - 5} stroke={theme.wire} strokeWidth={STROKE} />
      <text x={at.x + 2} y={at.y - 7} fontSize={10} fill={theme.ink} fontFamily={theme.font}>
        {width}
      </text>
    </g>
  );
}

function nodeStroke(n: LNode, p: GraphicProps): { stroke: string; fill: string; width: number } {
  const sel = p.selected === n.id;
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

  if (t === '$mux' || t === '$pmux' || t === '$bmux') {
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
        {t === '$mux' &&
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

  const isAnd = t === '$and' || t === '$logic_and' || t === '$reduce_and' || t === 'dc:and';
  const isOr = t === '$or' || t === '$logic_or' || t === '$reduce_or' || t === '$reduce_bool';
  const isXor = t === '$xor' || t === '$xnor' || t === '$reduce_xor' || t === '$reduce_xnor';
  if (isAnd) {
    const d = `M${x},${y} H${x + w / 2} A${w / 2},${h / 2} 0 0 1 ${x + w / 2},${y + h} H${x} Z`;
    const inverted = n.attrs?.invertB ? n.ports.find((q) => q.name === 'B') : undefined;
    return (
      <g>
        <path d={d} fill={s.fill} stroke={s.stroke} strokeWidth={s.width} strokeLinejoin="round" />
        {inverted && <circle cx={x - 3.5} cy={inverted.y} r={3.5} fill={s.fill} stroke={s.stroke} strokeWidth={STROKE} />}
      </g>
    );
  }
  if (isOr || isXor) {
    const curve = (dx: number) => `M${x + dx},${y} Q${x + dx + w * 0.25},${y + h / 2} ${x + dx},${y + h}`;
    const body = `M${x},${y} Q${x + w * 0.6},${y} ${x + w},${y + h / 2} Q${x + w * 0.6},${y + h} ${x},${y + h} Q${x + w * 0.25},${y + h / 2} ${x},${y} Z`;
    const edgeX = (py: number) => {
      const tt = py / h;
      return 2 * (1 - tt) * tt * (w * 0.25);
    };
    return (
      <g>
        {stubs(n, edgeX, theme)}
        <path d={body} fill={s.fill} stroke={s.stroke} strokeWidth={s.width} strokeLinejoin="round" />
        {isXor && <path d={curve(-6)} fill="none" stroke={s.stroke} strokeWidth={s.width} />}
      </g>
    );
  }
  if (t === '$not' || t === '$logic_not') {
    const br = 4;
    return (
      <g>
        <polygon
          points={`${x},${y + 4} ${x + w - 2 * br},${y + h / 2} ${x},${y + h - 4}`}
          fill={s.fill}
          stroke={s.stroke}
          strokeWidth={s.width}
          strokeLinejoin="round"
        />
        <circle cx={x + w - br} cy={y + h / 2} r={br} fill={s.fill} stroke={s.stroke} strokeWidth={s.width} />
      </g>
    );
  }
  if (/^\$(a|s)?dffe?$/.test(t) || t === '$dlatch') {
    const clk = n.ports.find((q) => q.name === 'CLK');
    return (
      <g>
        <rect x={x} y={y} width={w} height={h} fill={s.fill} stroke={s.stroke} strokeWidth={s.width} />
        {text(t === '$dlatch' ? 'L' : 'D  Q', x + w / 2, y + h / 2 - 3, 10)}
        {clk && (
          <polyline
            points={`${clk.x - 5},${y + h} ${clk.x},${y + h - 7} ${clk.x + 5},${y + h}`}
            fill="none"
            stroke={s.stroke}
            strokeWidth={STROKE}
          />
        )}
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

function NodeShape({ n, p }: { n: LNode; p: GraphicProps }) {
  const { theme } = p;
  const s = nodeStroke(n, p);
  const { x, y, width: w, height: h } = n;
  const dataAttrs = p.interactive ? { 'data-node-id': n.id, style: { cursor: 'pointer' } } : {};

  let body: JSX.Element;
  switch (n.kind) {
    case 'input':
    case 'output': {
      const tip = 8;
      body = (
        <g>
          <polygon
            points={`${x},${y} ${x + w - tip},${y} ${x + w},${y + h / 2} ${x + w - tip},${y + h} ${x},${y + h}`}
            fill={s.fill}
            stroke={s.stroke}
            strokeWidth={s.width}
            strokeLinejoin="round"
          />
          <text x={x + 6} y={y + h / 2 + 4} fontSize={FONT.pin} fill={theme.ink} fontFamily={theme.font}>
            {n.label}
          </text>
        </g>
      );
      break;
    }
    case 'const':
      body = (
        <g>
          <rect x={x} y={y} width={w} height={h} fill="transparent" stroke={p.selected === n.id ? theme.accent : 'none'} />
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
      body = (
        <g>
          <rect x={x} y={y} width={w} height={h} fill={s.stroke} stroke={s.stroke} strokeWidth={1} />
          {n.ports
            .filter((q) => q.side === 'WEST')
            .map((q) => (
              <text
                key={q.id}
                x={x - 3}
                y={q.y + 11}
                fontSize={9}
                textAnchor="end"
                fill={theme.muted}
                fontFamily={theme.font}
              >
                {q.name}
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
            y={y + 17}
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
              y={y + 31}
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

function Edges({ edges, theme }: { edges: LEdge[]; theme: Theme }) {
  const marks: JSX.Element[] = [];
  const doneSources = new Set<string>();
  const junctionKeys = new Set<string>();
  const junctions: Point[] = [];

  for (const e of edges) {
    if (e.width > 1 && e.points.length >= 2) {
      if (e.fullSource) {
        if (!doneSources.has(e.source.port)) {
          doneSources.add(e.source.port);
          const seg = firstSegmentLength(e.points, false);
          marks.push(<BusMark key={`m${e.id}`} at={along(e.points, Math.min(12, seg / 2), false)} width={e.width} theme={theme} />);
        }
      } else {
        const seg = firstSegmentLength(e.points, true);
        marks.push(<BusMark key={`m${e.id}`} at={along(e.points, Math.min(12, seg / 2), true)} width={e.width} theme={theme} />);
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
      {junctions.map((j, i) => (
        <circle key={i} cx={j.x} cy={j.y} r={3} fill={theme.wire} />
      ))}
      {marks}
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

export function DiagramGraphic(p: GraphicProps) {
  return (
    <g>
      <Edges edges={p.layout.edges} theme={p.theme} />
      {p.layout.nodes.map((n) => (
        <NodeShape key={n.id} n={n} p={p} />
      ))}
    </g>
  );
}
