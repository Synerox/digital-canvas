/**
 * Drawing and reshaping wires by hand: what you draw is what you get.
 *
 * Drawing. A wire starts at a pin (or on a wire) and runs, leg by leg, where
 * the pointer goes: the next leg runs along the draft's axis to a corner and
 * on to the pointer. A click fixes the legs up to the pointer. While the
 * pointer is dragged, the corners are fixed where the pointer turns, so the
 * wire follows the path the pointer traces. Over a pin, the wire goes into
 * the pin from the side it faces. The wire is stored exactly as drawn.
 *
 * Reshaping. Any leg of a wire can be dragged across its direction, the legs
 * at its pins too (the wire then leaves its pin on a short stub first, and
 * turns), and any corner can be dragged anywhere (its two legs follow). A
 * stretch that several wires of a net share moves for all of them.
 */
import type { Side } from '../core/diagram';
import type { Point } from '../layout/elk-layout';
import { simplify } from './router';

export type Axis = 'h' | 'v';

const AXIS_OF: Record<Side, Axis> = { EAST: 'h', WEST: 'h', NORTH: 'v', SOUTH: 'v' };
const OUT: Record<Side, Point> = { EAST: { x: 1, y: 0 }, WEST: { x: -1, y: 0 }, SOUTH: { x: 0, y: 1 }, NORTH: { x: 0, y: -1 } };
/** Length of the straight piece of wire at a pin. */
export const STUB = 10;

const other = (a: Axis): Axis => (a === 'h' ? 'v' : 'h');
const last = <T>(a: readonly T[]): T => a[a.length - 1];
const same = (a: Point, b: Point) => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;
/** Orientation of the leg a-b (undefined for a point or a slanted leg). */
function axisOf(a: Point, b: Point): Axis | undefined {
  const h = Math.abs(a.y - b.y) < 1e-6;
  const v = Math.abs(a.x - b.x) < 1e-6;
  return h && !v ? 'h' : v && !h ? 'v' : undefined;
}

export interface WireDraft {
  /** The start (a pin, or a point on a wire), then the corners fixed so far. */
  points: Point[];
  /** Axis of the next leg out of the last point. */
  axis: Axis;
  /** The side of the start pin: the wire leaves it outward, a stub's length at least. */
  side?: Side;
  /** While a drag is traced: where the leg after the next corner has got to (see trace). */
  turn?: Point;
  /** While a drag is traced: where the pointer last ran along the next leg (see trace). */
  pivot?: Point;
}

/** A new draft at a pin (`side`), or at a point on a wire, leaving it along `axis` (across the wire). */
export function startDraft(at: Point, side?: Side, axis: Axis = 'h'): WireDraft {
  return { points: [{ x: at.x, y: at.y }], axis: side ? AXIS_OF[side] : axis, side };
}

/** The legs from the draft's last point to p: along the draft's axis to a corner, then to p. */
function legsTo(d: WireDraft, p: Point): Point[] {
  const a = last(d.points);
  if (d.points.length === 1 && d.side && AXIS_OF[d.side] === d.axis) {
    // Out of the pin first, never back over its symbol: past the stub's end, or around it.
    const o = OUT[d.side];
    const s = { x: a.x + o.x * STUB, y: a.y + o.y * STUB };
    const ahead = (p.x - s.x) * o.x + (p.y - s.y) * o.y >= 0;
    if (!ahead) return d.axis === 'h' ? [s, { x: s.x, y: p.y }, p] : [s, { x: p.x, y: s.y }, p];
  }
  return d.axis === 'h' ? [{ x: p.x, y: a.y }, p] : [{ x: a.x, y: p.y }, p];
}

/** Whether a wire's last leg runs into a pin on `side` the way the pin faces. */
function entersFrom(points: Point[], side: Side): boolean {
  if (points.length < 2) return false;
  const a = points[points.length - 2];
  const b = last(points);
  const o = OUT[side];
  return Math.sign(Math.round(a.x - b.x)) === o.x && Math.sign(Math.round(a.y - b.y)) === o.y;
}

/** Whether a wire leaves its start pin on `side` the way the pin faces. */
function leavesTo(points: Point[], side: Side): boolean {
  return points.length >= 2 && entersFrom([points[1], points[0]], side);
}

/**
 * The wire as it would be drawn now: through the fixed corners, then to `to`. When `to` is a pin (its
 * `side` given), the wire goes into it the way it faces, on a stub; otherwise it ends at `to`.
 */
export function draftPath(d: WireDraft, to: Point, side?: Side): Point[] {
  if (!side) return simplify([...d.points, ...legsTo(d, to)]);
  const o = OUT[side];
  const s = { x: to.x + o.x * STUB, y: to.y + o.y * STUB };
  const ok = (pts: Point[]) => entersFrom(pts, side) && (!d.side || leavesTo(pts, d.side));
  for (const axis of [d.axis, other(d.axis)]) {
    const pts = simplify([...d.points, ...legsTo({ ...d, axis }, s), to]);
    if (ok(pts)) return pts;
  }
  // Straight towards the pin from behind it: around, two grid steps off its line.
  const a = last(d.points);
  const off = AXIS_OF[side] === 'h' ? { x: 0, y: 2 * STUB } : { x: 2 * STUB, y: 0 };
  const via = { x: s.x + off.x, y: s.y + off.y };
  const around = simplify([...d.points, ...legsTo(d, { x: AXIS_OF[side] === 'h' ? a.x : via.x, y: AXIS_OF[side] === 'h' ? via.y : a.y }), via, s, to]);
  return around;
}

/** After the legs up to `p` are fixed: the draft goes on from p, across its last leg. */
function fixTo(d: WireDraft, legs: Point[]): WireDraft {
  const points = simplify([...d.points, ...legs]);
  if (points.length === d.points.length && same(last(points), last(d.points))) return d;
  const n = points.length;
  const axis = n >= 2 ? (axisOf(points[n - 2], points[n - 1]) ?? d.axis) : d.axis;
  return { points, axis: n >= 2 ? other(axis) : d.axis, side: d.side };
}

/** A click at p: the legs up to p are fixed, and the wire goes on from there. */
export function clickAt(d: WireDraft, p: Point): WireDraft {
  if (same(p, last(d.points))) return d;
  return fixTo(d, legsTo(d, p));
}

/**
 * Follow a drag to p (on the grid). The pointer runs along the next leg (the draft's axis); where it turns
 * and runs across that leg for two grid steps or more (more across than along: a diagonal stroke is not a
 * turn), the leg after the corner has started. When the pointer then moves `sideways` off that leg, the
 * corner is fixed, and so is the leg after it, up to where the pointer turned again. So the wire follows
 * the path the pointer draws, corner by corner; a straight or diagonal drag just ends in one corner.
 */
export function trace(d: WireDraft, p: Point, sideways: number): WireDraft {
  const along = (q: Point) => (d.axis === 'h' ? q.x : q.y);
  const across = (q: Point) => (d.axis === 'h' ? q.y : q.x);
  if (!d.turn) {
    const from = d.pivot ?? last(d.points);
    const off = Math.abs(across(p) - across(from));
    const on = Math.abs(along(p) - along(from));
    if (off >= 2 * STUB && 2 * on <= off) return { ...d, turn: p };
    // Still running along the leg (or diagonally): the corner would be here.
    return on >= off ? { ...d, pivot: p } : d;
  }
  // Still on the leg after the corner: it grows (or shrinks) with the pointer, and stays where it started.
  if (Math.abs(along(p) - along(d.turn)) < sideways) return { ...d, turn: d.axis === 'h' ? { x: d.turn.x, y: p.y } : { x: p.x, y: d.turn.y } };
  // Turned off the leg: fix the corner where that leg ran, and the leg up to where the pointer turned.
  const fixed = fixTo({ ...d, turn: undefined, pivot: undefined }, legsTo(d, d.turn));
  // The leg on from the turn runs the way the pointer went: along the draft's axis again.
  return { ...fixed, axis: d.axis, pivot: d.turn };
}

/** Take back the last fixed corner (Backspace). Undefined when only the start is left. */
export function undoCorner(d: WireDraft, startAxis: Axis): WireDraft | undefined {
  if (d.points.length <= 1) return undefined;
  const points = d.points.slice(0, -1);
  const n = points.length;
  const axis = n >= 2 ? other(axisOf(points[n - 2], points[n - 1]) ?? startAxis) : startAxis;
  return { points, axis, side: d.side };
}

// ---------------------------------------------------------------------------
// Reshaping

/** Where a leg is: its orientation, and the coordinate across it (y of a horizontal leg). */
export interface LegAt {
  axis: Axis;
  at: number;
  /** Its extent along its direction. */
  lo: number;
  hi: number;
}

export function legAt(points: readonly Point[], i: number): LegAt | undefined {
  const a = points[i];
  const b = points[i + 1];
  if (!a || !b) return undefined;
  const axis = axisOf(a, b);
  if (!axis) return undefined;
  return axis === 'h' ? { axis, at: a.y, lo: Math.min(a.x, b.x), hi: Math.max(a.x, b.x) } : { axis, at: a.x, lo: Math.min(a.y, b.y), hi: Math.max(a.y, b.y) };
}

/** The point `k` px from p towards q (along an axis-parallel leg). */
function toward(p: Point, q: Point, k: number): Point {
  return { x: p.x + Math.sign(q.x - p.x) * k, y: p.y + Math.sign(q.y - p.y) * k };
}

/**
 * Move leg i of a wire across its direction, to `at`. Its neighbours stretch to keep the wire orthogonal.
 * The first and last legs end on pins, which stay where they are: the wire first runs `stub` px out of
 * the pin along the leg (all of it, when the leg is shorter), then turns to the moved leg.
 */
export function moveLeg(points: readonly Point[], i: number, at: number, stub = STUB): Point[] {
  const leg = legAt(points, i);
  if (!leg || Math.abs(leg.at - at) < 1e-6) return [...points];
  const set = (p: Point) => (leg.axis === 'h' ? { x: p.x, y: at } : { x: at, y: p.y });
  const n = points.length;
  const k = Math.min(stub, leg.hi - leg.lo);
  const out: Point[] = [];
  for (let j = 0; j < n; j++) {
    const p = points[j];
    if (j === i && j === 0) {
      const s = toward(p, points[1], k);
      out.push(p, s, set(s));
    } else if (j === i + 1 && j === n - 1) {
      const s = toward(p, points[n - 2], k);
      out.push(set(s), s, p);
    } else out.push(j === i || j === i + 1 ? set(p) : { ...p });
  }
  return simplify(out);
}

/**
 * Move corner i (an inner point) of a wire to q: its two legs move with it, and the legs beyond them
 * stretch. A leg that ends on a pin keeps that end there (see moveLeg).
 */
export function moveCorner(points: readonly Point[], i: number, q: Point, stub = STUB): Point[] {
  const n = points.length;
  if (i <= 0 || i >= n - 1) return [...points];
  const before = legAt(points, i - 1);
  const after = legAt(points, i);
  if (!before || !after) return [...points];
  const along = (axis: Axis, p: Point): Point => (axis === 'h' ? { x: p.x, y: q.y } : { x: q.x, y: p.y });
  const out: Point[] = [];
  for (let j = 0; j < n; j++) {
    const p = points[j];
    if (j === i - 1) {
      if (j === 0) {
        const s = toward(p, points[1], Math.min(stub, before.hi - before.lo));
        out.push(p, s, along(before.axis, s));
      } else out.push(along(before.axis, p));
    } else if (j === i) out.push({ ...q });
    else if (j === i + 1) {
      if (j === n - 1) {
        const s = toward(p, points[n - 2], Math.min(stub, after.hi - after.lo));
        out.push(along(after.axis, s), s, p);
      } else out.push(along(after.axis, p));
    } else out.push({ ...p });
  }
  return simplify(out);
}

/** A leg's move: from where it was (`leg`) to `at`. */
export interface LegMove {
  leg: LegAt;
  at: number;
}

/** The leg moves a reshape made: legs of `before` that are not in `after`, with where they went. */
export function legMoves(before: readonly Point[], after: readonly Point[]): LegMove[] {
  const moves: LegMove[] = [];
  const now = after.map((_, i) => legAt(after, i)).filter((l): l is LegAt => !!l);
  for (let i = 0; i + 1 < before.length; i++) {
    const l = legAt(before, i);
    if (!l) continue;
    if (now.some((m) => m.axis === l.axis && Math.abs(m.at - l.at) < 1e-6 && m.lo <= l.lo + 1e-6 && m.hi >= l.hi - 1e-6)) continue;
    // Where it went: the leg of the same orientation that now covers most of its extent.
    let best: LegAt | undefined;
    let bestCover = 0;
    for (const m of now) {
      if (m.axis !== l.axis) continue;
      const cover = Math.min(m.hi, l.hi) - Math.max(m.lo, l.lo);
      if (cover > bestCover + 1e-6) {
        bestCover = cover;
        best = m;
      }
    }
    if (best && Math.abs(best.at - l.at) > 1e-6) moves.push({ leg: l, at: best.at });
  }
  return moves;
}

/**
 * The same moves applied to another wire of the net: each of its legs that runs along a moved leg (the
 * same line, overlapping it) moves with it. Wires of a net share their stretch from the source, so a
 * shared stretch stays shared. Unchanged (the same array) when no leg of it moved.
 */
export function followMoves(points: Point[], moves: readonly LegMove[], stub = STUB): Point[] {
  let pts = points;
  for (const mv of moves) {
    for (let i = 0; i + 1 < pts.length; i++) {
      const l = legAt(pts, i);
      if (!l || l.axis !== mv.leg.axis || Math.abs(l.at - mv.leg.at) > 1e-6) continue;
      if (Math.min(l.hi, mv.leg.hi) - Math.max(l.lo, mv.leg.lo) <= 1e-6) continue;
      pts = moveLeg(pts, i, mv.at, stub);
      break;
    }
  }
  return pts;
}
