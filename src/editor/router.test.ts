import { describe, expect, it } from 'vitest';
import type { Point } from '../layout/elk-layout';
import {
  type Rect,
  type RouteEnd,
  adjustRoute,
  netJunctions,
  orthogonalize,
  polylineHitsRect,
  routeWire,
  simpleRoute,
  simplify,
} from './router';

const R = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height });
const P = (x: number, y: number): Point => ({ x, y });
const east = (rect: Rect, y: number): RouteEnd => ({ point: P(rect.x + rect.width, y), side: 'EAST', rect });
const west = (rect: Rect, y: number): RouteEnd => ({ point: P(rect.x, y), side: 'WEST', rect });

/** Consecutive points share x or y exactly; no zero-length segments; no redundant middle points. */
function expectClean(pts: Point[], from: RouteEnd, to: RouteEnd): void {
  expect(pts.length).toBeGreaterThanOrEqual(2);
  expect(pts[0]).toEqual(from.point);
  expect(pts[pts.length - 1]).toEqual(to.point);
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    expect(a.x === b.x || a.y === b.y, `segment ${i} is slanted: ${JSON.stringify([a, b])}`).toBe(true);
    expect(a.x === b.x && a.y === b.y, `segment ${i} has no length`).toBe(false);
  }
  expect(simplify(pts)).toHaveLength(pts.length);
}

const bends = (pts: Point[]) => pts.length - 2;
const length = (a: Point, b: Point) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

/** The direction of travel from a to b (an axis-parallel segment). */
function direction(a: Point, b: Point): 'E' | 'W' | 'S' | 'N' {
  if (a.y === b.y) return b.x > a.x ? 'E' : 'W';
  return b.y > a.y ? 'S' : 'N';
}
const OUT = { EAST: 'E', WEST: 'W', SOUTH: 'S', NORTH: 'N' } as const;
const IN = { EAST: 'W', WEST: 'E', SOUTH: 'N', NORTH: 'S' } as const;

/** The direction the wire travels on its last segment. */
const lastMove = (pts: Point[]) => direction(pts[pts.length - 2], pts[pts.length - 1]);

/** Pairs of collinear segments of the two polylines that overlap by a positive length. */
function overlaps(a: Point[], b: Point[]): number {
  let n = 0;
  for (let i = 1; i < a.length; i++)
    for (let j = 1; j < b.length; j++) {
      const [p, q, r, s] = [a[i - 1], a[i], b[j - 1], b[j]];
      if (p.y === q.y && r.y === s.y && p.y === r.y) {
        if (Math.min(Math.max(p.x, q.x), Math.max(r.x, s.x)) - Math.max(Math.min(p.x, q.x), Math.min(r.x, s.x)) > 1e-9) n++;
      } else if (p.x === q.x && r.x === s.x && p.x === r.x) {
        if (Math.min(Math.max(p.y, q.y), Math.max(r.y, s.y)) - Math.max(Math.min(p.y, q.y), Math.min(r.y, s.y)) > 1e-9) n++;
      }
    }
  return n;
}

/** Whether point c lies on segment a-b (axis-parallel). */
const onSegment = (c: Point, a: Point, b: Point) =>
  (a.x === b.x && c.x === a.x && c.y >= Math.min(a.y, b.y) && c.y <= Math.max(a.y, b.y)) ||
  (a.y === b.y && c.y === a.y && c.x >= Math.min(a.x, b.x) && c.x <= Math.max(a.x, b.x));

describe('routeWire', () => {
  const A = R(40, 20, 60, 40);
  const B = R(300, 20, 60, 40);

  it('draws a straight line between aligned ports', () => {
    const from = east(A, 40);
    const to = west(B, 40);
    expect(routeWire(from, to, { obstacles: [A, B] })).toEqual([P(100, 40), P(300, 40)]);
  });

  it('draws a straight line between aligned ports off the grid', () => {
    const A2 = R(43, 17, 60, 40);
    const B2 = R(297, 3, 60, 70);
    const O = R(150, 90, 40, 40); // not in the way
    const pts = routeWire(east(A2, 43.5), west(B2, 43.5), { obstacles: [A2, B2, O] });
    expect(pts).toEqual([P(103, 43.5), P(297, 43.5)]);
    // Off-grid ports at different heights: still one clean Z, no jog onto the grid.
    const from = east(A2, 23.25);
    const to = west(B2, 61.75);
    const z = routeWire(from, to, { obstacles: [A2, B2, O] });
    expectClean(z, from, to);
    expect(bends(z)).toBe(2);
  });

  it('uses a Z with two bends between ports at different heights', () => {
    const B2 = R(300, 60, 60, 60);
    const from = east(A, 40);
    const to = west(B2, 100);
    const pts = routeWire(from, to, { obstacles: [A, B2] });
    expectClean(pts, from, to);
    expect(bends(pts)).toBe(2);
    expect(pts[1].y).toBe(40);
    expect(pts[2].y).toBe(100);
    expect(lastMove(pts)).toBe('E');
  });

  it('goes around an obstacle between the ports', () => {
    const O = R(180, 0, 60, 80);
    const from = east(A, 40);
    const to = west(B, 40);
    const pts = routeWire(from, to, { obstacles: [A, B, O] });
    expectClean(pts, from, to);
    for (const r of [A, B, O]) expect(polylineHitsRect(pts, r)).toBe(false);
    expect(lastMove(pts)).toBe('E');
  });

  it('routes back to a target behind the source without crossing either symbol', () => {
    const from = east(B, 40);
    const to = west(A, 50);
    const pts = routeWire(from, to, { obstacles: [A, B] });
    expectClean(pts, from, to);
    expect(polylineHitsRect(pts, A)).toBe(false);
    expect(polylineHitsRect(pts, B)).toBe(false);
    expect(pts[1].x).toBeGreaterThanOrEqual(B.x + B.width + 10); // leaves to the right first
    expect(lastMove(pts)).toBe('E');
  });

  it('routes a feedback wire around its own symbol', () => {
    const from = east(A, 40);
    const to = west(A, 30);
    const pts = routeWire(from, to, { obstacles: [A] });
    expectClean(pts, from, to);
    expect(polylineHitsRect(pts, A)).toBe(false);
  });

  it('enters a SOUTH port from below, even one inside its box', () => {
    // A MUX select pin on the sloped bottom edge, 5px inside the bounding box.
    const M = R(300, 100, 30, 60);
    const to: RouteEnd = { point: P(315, 155), side: 'SOUTH', rect: M };
    for (const y of [40, 130, 250]) {
      const from = east(R(40, y - 20, 60, 40), y);
      const pts = routeWire(from, to, { obstacles: [from.rect, M] });
      expectClean(pts, from, to);
      expect(lastMove(pts)).toBe('N');
      expect(pts[pts.length - 2].y).toBeGreaterThanOrEqual(166);
      expect(polylineHitsRect(pts.slice(0, -1), M)).toBe(false);
      expect(polylineHitsRect(pts, from.rect)).toBe(false);
    }
  });

  it('leaves a SOUTH port downward', () => {
    const S = R(100, 100, 40, 40);
    const T = R(300, 200, 40, 40);
    const from: RouteEnd = { point: P(120, 140), side: 'SOUTH', rect: S };
    const to = west(T, 220);
    const pts = routeWire(from, to, { obstacles: [S, T] });
    expectClean(pts, from, to);
    expect(pts[1].x).toBe(120);
    expect(pts[1].y).toBeGreaterThan(140);
    expect(bends(pts)).toBe(1);
  });

  it('branches off the wires its net already has (T junction)', () => {
    const S = R(40, 80, 60, 40);
    const T1 = R(300, 40, 60, 40);
    const T2 = R(300, 120, 60, 40);
    const obstacles = [S, T1, T2];
    const from = east(S, 100);
    const first = routeWire(from, west(T1, 60), { obstacles });
    const to = west(T2, 140);
    const second = routeWire(from, to, { obstacles, ownNet: [first] });
    expectClean(second, from, to);
    // Shared prefix, then the branch point lies on the first wire.
    let k = 0;
    while (k < first.length && k < second.length && first[k].x === second[k].x && first[k].y === second[k].y) k++;
    expect(k).toBeGreaterThanOrEqual(1);
    const branch = second[k];
    expect(onSegment(branch, first[k - 1], first[k])).toBe(true);
    // The new part does not run along the first wire.
    expect(overlaps(first, second.slice(k))).toBe(0);
    expect(netJunctions([first, second])).toEqual([branch]);
  });

  it('builds a tree for a net with three sinks', () => {
    const S = R(40, 140, 60, 40);
    const sinks = [R(300, 20, 40, 40), R(300, 140, 40, 40), R(420, 260, 40, 40)];
    const obstacles = [S, ...sinks];
    const from = east(S, 160);
    const wires: Point[][] = [];
    for (const t of sinks) {
      const to = west(t, t.y + 20);
      const pts = routeWire(from, to, { obstacles, ownNet: wires });
      expectClean(pts, from, to);
      for (const r of obstacles) expect(polylineHitsRect(pts, r)).toBe(false);
      wires.push(pts);
    }
    const dots = netJunctions(wires);
    expect(dots.length).toBeGreaterThanOrEqual(1);
    expect(dots.length).toBeLessThanOrEqual(2);
  });

  it('never runs along a wire of another net', () => {
    const O = R(180, 0, 60, 80);
    const from = east(A, 40);
    const to = west(B, 40);
    const obstacles = [A, B, O];
    const free = routeWire(from, to, { obstacles });
    // Put another net exactly on the horizontal track the free route took around the obstacle.
    const track = free.find((p, i) => i > 0 && free[i - 1].y === p.y && p.y !== 40)!;
    expect(track).toBeDefined();
    const other = [P(150, track.y), P(400, track.y)];
    const pts = routeWire(from, to, { obstacles, otherNets: [other] });
    expectClean(pts, from, to);
    expect(overlaps(pts, other)).toBe(0);
    for (const r of obstacles) expect(polylineHitsRect(pts, r)).toBe(false);
  });

  it('never runs along a vertical wire of another net', () => {
    const B2 = R(300, 100, 60, 60);
    const from = east(A, 40);
    const to = west(B2, 130);
    const free = routeWire(from, to, { obstacles: [A, B2] });
    const vx = free[1].x;
    const other = [P(vx, -100), P(vx, 300)];
    const pts = routeWire(from, to, { obstacles: [A, B2], otherNets: [other] });
    expectClean(pts, from, to);
    expect(overlaps(pts, other)).toBe(0);
    expect(bends(pts)).toBe(2); // still a Z, just on another track
  });

  it('does not take a straight line that would run along another net', () => {
    const from = east(A, 40);
    const to = west(B, 40);
    const other = [P(150, 40), P(250, 40)];
    const pts = routeWire(from, to, { obstacles: [A, B], otherNets: [other] });
    expectClean(pts, from, to);
    expect(overlaps(pts, other)).toBe(0);
  });

  it('crosses other nets rather than detouring far', () => {
    const B2 = R(300, 200, 60, 60);
    const from = east(A, 40);
    const to = west(B2, 230);
    const bus = [P(0, 120), P(500, 120)];
    const pts = routeWire(from, to, { obstacles: [A, B2], otherNets: [bus] });
    expectClean(pts, from, to);
    expect(bends(pts)).toBe(2);
  });

  it('still routes when a stub ends inside a symbol that sits too close', () => {
    const C = R(105, 0, 20, 100); // 5px in front of the source port
    const from = east(A, 40);
    const to = west(R(300, 60, 60, 60), 100);
    const pts = routeWire(from, to, { obstacles: [A, C, to.rect] });
    expectClean(pts, from, to);
    expect(direction(pts[0], pts[1])).toBe('E');
    expect(lastMove(pts)).toBe('E');
    expect(polylineHitsRect(pts, A)).toBe(false);
    expect(polylineHitsRect(pts, to.rect)).toBe(false);
  });

  it('falls back to simpleRoute when the search budget is exhausted', () => {
    const B2 = R(300, 60, 60, 60);
    const from = east(A, 40);
    const to = west(B2, 100);
    expect(routeWire(from, to, { obstacles: [A, B2], maxExpansions: 1 })).toEqual(simpleRoute(from, to));
  });

  it('works with a coarser grid', () => {
    const B2 = R(300, 60, 60, 60);
    const from = east(A, 40);
    const to = west(B2, 100);
    const pts = routeWire(from, to, { obstacles: [A, B2], grid: 20 });
    expectClean(pts, from, to);
    expect(bends(pts)).toBe(2);
  });
});

describe('simpleRoute', () => {
  const A = R(40, 20, 60, 40);

  it('makes a Z with its bend in the middle for EAST -> WEST', () => {
    const B = R(300, 80, 60, 40);
    expect(simpleRoute(east(A, 40), west(B, 100))).toEqual([P(100, 40), P(200, 40), P(200, 100), P(300, 100)]);
  });

  it('is straight for aligned ports, also very close ones', () => {
    expect(simpleRoute(east(A, 40), west(R(300, 20, 40, 40), 40))).toEqual([P(100, 40), P(300, 40)]);
    expect(simpleRoute(east(A, 40), west(R(108, 20, 40, 40), 40))).toEqual([P(100, 40), P(108, 40)]);
  });

  it('makes an L into a SOUTH port below-right of the source', () => {
    const S = R(40, 80, 60, 40);
    const M = R(300, 0, 30, 60);
    const to: RouteEnd = { point: P(315, 55), side: 'SOUTH', rect: M };
    expect(simpleRoute(east(S, 100), to)).toEqual([P(100, 100), P(315, 100), P(315, 55)]);
  });

  it('detours around both symbols when the target is behind', () => {
    const B = R(300, 20, 60, 40);
    const from = east(B, 40);
    const to = west(A, 40);
    const pts = simpleRoute(from, to);
    expectClean(pts, from, to);
    expect(polylineHitsRect(pts, A)).toBe(false);
    expect(polylineHitsRect(pts, B)).toBe(false);
    expect(bends(pts)).toBe(4);
  });

  it('uses the gap between symbols for a detour when there is one', () => {
    const B = R(300, 20, 60, 40);
    const C = R(40, 120, 60, 40);
    const pts = simpleRoute(east(B, 40), west(C, 140));
    expect(pts).toEqual([P(360, 40), P(370, 40), P(370, 90), P(30, 90), P(30, 140), P(40, 140)]);
  });

  it('makes a U between two EAST ports', () => {
    const B = R(300, 100, 60, 40);
    const from = east(A, 40);
    const to: RouteEnd = { point: P(360, 120), side: 'EAST', rect: B };
    const pts = simpleRoute(from, to);
    expectClean(pts, from, to);
    expect(bends(pts)).toBe(2);
    expect(pts[1].x).toBe(370);
  });
});

describe('netJunctions', () => {
  it('puts one dot where two wires sharing a path split', () => {
    const a = [P(0, 0), P(100, 0), P(100, 50)];
    const b = [P(0, 0), P(200, 0)];
    expect(netJunctions([a, b])).toEqual([P(100, 0)]);
    const c = [P(0, 0), P(100, 0), P(100, -50), P(200, -50)];
    expect(netJunctions([a, c])).toEqual([P(100, 0)]);
  });

  it('puts no dot on identical or overlapping wires, nor on a plain bend', () => {
    const a = [P(0, 0), P(100, 0), P(100, 50)];
    expect(netJunctions([a, [...a]])).toEqual([]);
    expect(netJunctions([a])).toEqual([]);
    expect(netJunctions([[P(0, 0), P(200, 0)], [P(50, 0), P(150, 0)]])).toEqual([]);
  });

  it('puts one dot on a four-way join', () => {
    const plus = [
      [P(0, 0), P(100, 0)],
      [P(100, 0), P(200, 0)],
      [P(100, -50), P(100, 0)],
      [P(100, 0), P(100, 50)],
    ];
    expect(netJunctions(plus)).toEqual([P(100, 0)]);
    // Also when two wires simply cross (the same net).
    expect(netJunctions([[P(0, 0), P(200, 0)], [P(100, -50), P(100, 50)]])).toEqual([P(100, 0)]);
  });

  it('finds a T where a wire ends on the middle of another', () => {
    expect(netJunctions([[P(0, 0), P(200, 0)], [P(80, 60), P(80, 0)]])).toEqual([P(80, 0)]);
  });

  it('treats coordinates within a fraction of a pixel as equal', () => {
    const a = [P(0, 0), P(100, 0), P(100, 50)];
    const b = [P(0, 0.2), P(100.3, 0.1), P(100.3, -50)];
    const dots = netJunctions([a, b]);
    expect(dots).toHaveLength(1);
    expect(dots[0].x).toBeCloseTo(100, 0);
    expect(dots[0].y).toBeCloseTo(0, 0);
    // Identical up to float noise: no dot.
    expect(netJunctions([a, a.map((p) => P(p.x + 0.3, p.y - 0.2))])).toEqual([]);
  });

  it('is deterministic and deduplicated', () => {
    const a = [P(0, 0), P(100, 0), P(100, 50)];
    const b = [P(0, 0), P(100, 0), P(100, -50)];
    const c = [P(0, 0), P(50, 0), P(50, 80)];
    const first = netJunctions([a, b, c]);
    expect(first).toEqual([P(50, 0), P(100, 0)]);
    expect(netJunctions([c, b, a])).toEqual(first);
  });
});

describe('polyline helpers', () => {
  it('simplify drops repeated points and straight-run middles', () => {
    expect(simplify([P(0, 0), P(0, 0), P(10, 0), P(20, 0), P(20, 10), P(20, 30), P(20, 30)])).toEqual([P(0, 0), P(20, 0), P(20, 30)]);
    expect(simplify([P(5, 5)])).toEqual([P(5, 5)]);
    expect(simplify([])).toEqual([]);
  });

  it('orthogonalize inserts horizontal-first corners', () => {
    expect(orthogonalize([P(0, 0), P(50, 30)])).toEqual([P(0, 0), P(50, 0), P(50, 30)]);
    expect(orthogonalize([P(0, 0), P(50, 0), P(80, 40), P(80, 90)])).toEqual([P(0, 0), P(80, 0), P(80, 90)]);
  });

  it('adjustRoute keeps the inner bends and stays orthogonal', () => {
    // A hand-made route with a detour: E, S, E, N, E.
    const route = [P(0, 0), P(40, 0), P(40, 60), P(120, 60), P(120, 20), P(200, 20)];
    const moved = adjustRoute(route, P(0, 10), P(210, 30));
    expect(moved).toEqual([P(0, 10), P(40, 10), P(40, 60), P(120, 60), P(120, 30), P(210, 30)]);
    // An L whose ends move both ways keeps one corner.
    expect(adjustRoute([P(0, 0), P(100, 0), P(100, 80)], P(10, 20), P(130, 90))).toEqual([P(10, 20), P(130, 20), P(130, 90)]);
    // A vertical first segment moves its bend sideways.
    expect(adjustRoute([P(0, 0), P(0, 50), P(100, 50)], P(20, 0), P(100, 70))).toEqual([P(20, 0), P(20, 70), P(100, 70)]);
  });

  it('adjustRoute turns a straight wire into a Z when its ends no longer line up', () => {
    expect(adjustRoute([P(0, 0), P(100, 0)], P(0, 0), P(100, 40))).toEqual([P(0, 0), P(50, 0), P(50, 40), P(100, 40)]);
    expect(adjustRoute([P(0, 0), P(100, 0)], P(0, 10), P(120, 10))).toEqual([P(0, 10), P(120, 10)]);
  });

  it('adjustRoute results are always orthogonal', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 200 - 100;
    for (let n = 0; n < 50; n++) {
      const route = orthogonalize([P(0, 0), P(rnd(), rnd()), P(rnd(), rnd()), P(rnd(), rnd())]);
      const out = adjustRoute(route, P(rnd(), rnd()), P(rnd(), rnd()));
      for (let i = 1; i < out.length; i++) expect(out[i].x === out[i - 1].x || out[i].y === out[i - 1].y).toBe(true);
      expect(simplify(out)).toEqual(out);
    }
  });

  it('polylineHitsRect sees the inside only', () => {
    const r = R(0, 0, 100, 50);
    expect(polylineHitsRect([P(-10, 20), P(110, 20)], r)).toBe(true);
    expect(polylineHitsRect([P(-10, 0), P(110, 0)], r)).toBe(false); // along an edge
    expect(polylineHitsRect([P(-10, 60), P(110, 60)], r)).toBe(false);
    expect(polylineHitsRect([P(50, -10), P(50, 10)], r)).toBe(true);
    expect(polylineHitsRect([P(-10, -10), P(0, 0)], r)).toBe(false); // touches a corner
    expect(polylineHitsRect([P(-10, 60), P(60, -10)], r)).toBe(true); // slanted, through a corner region
  });
});

/** Deterministic pseudo-random numbers in [0, 1). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

/** Random non-overlapping symbols at least `gap` apart. */
function scatter(rnd: () => number, count: number, w: number, h: number, gap: number, onGrid: boolean): Rect[] {
  const out: Rect[] = [];
  for (let tries = 0; out.length < count && tries < count * 50; tries++) {
    const snap = (v: number) => (onGrid ? Math.round(v / 10) * 10 : Math.round(v * 4) / 4);
    const r = R(snap(rnd() * w), snap(rnd() * h), snap(20 + rnd() * 60), snap(20 + rnd() * 80));
    if (out.every((o) => r.x > o.x + o.width + gap || o.x > r.x + r.width + gap || r.y > o.y + o.height + gap || o.y > r.y + r.height + gap)) out.push(r);
  }
  return out;
}

function portOn(rnd: () => number, r: Rect, side: RouteEnd['side'], onGrid: boolean): RouteEnd {
  const t = (len: number) => {
    const v = 5 + rnd() * (len - 10);
    return onGrid ? Math.min(len - 5, Math.max(5, Math.round(v / 10) * 10)) : Math.round(v * 2) / 2;
  };
  switch (side) {
    case 'EAST':
      return { point: P(r.x + r.width, r.y + t(r.height)), side, rect: r };
    case 'WEST':
      return { point: P(r.x, r.y + t(r.height)), side, rect: r };
    case 'SOUTH':
      return { point: P(r.x + t(r.width), r.y + r.height), side, rect: r };
    case 'NORTH':
      return { point: P(r.x + t(r.width), r.y), side, rect: r };
  }
}

describe('routeWire properties', () => {
  it('gives valid, deterministic routes on 200 random sheets', () => {
    const rnd = lcg(12345);
    const sides: RouteEnd['side'][] = ['WEST', 'WEST', 'WEST', 'SOUTH', 'NORTH', 'EAST'];
    for (let n = 0; n < 200; n++) {
      const onGrid = rnd() < 0.7;
      const rects = scatter(rnd, 3 + Math.floor(rnd() * 8), 600, 400, 40, onGrid);
      if (rects.length < 2) continue;
      const i = Math.floor(rnd() * rects.length);
      const j = (i + 1 + Math.floor(rnd() * (rects.length - 1))) % rects.length;
      const from = portOn(rnd, rects[i], rnd() < 0.85 ? 'EAST' : 'SOUTH', onGrid);
      const to = portOn(rnd, rects[j], sides[Math.floor(rnd() * sides.length)], onGrid);
      // Sometimes another net is already on the sheet, sometimes this net has a wire already.
      const opts: Parameters<typeof routeWire>[2] = { obstacles: rects };
      if (rnd() < 0.3) {
        const o1 = portOn(rnd, rects[j], 'EAST', onGrid);
        const o2 = portOn(rnd, rects[i], 'WEST', onGrid);
        // Another net drawn first across this net's port stubs forces an overlap: not a router question.
        const apart = (u: RouteEnd, v: RouteEnd) => Math.abs(u.point.x - v.point.x) + Math.abs(u.point.y - v.point.y) >= 30;
        if ([o1, o2].every((o) => apart(o, from) && apart(o, to))) opts.otherNets = [routeWire(o1, o2, { obstacles: rects })];
      }
      if (rnd() < 0.3) {
        const k = (j + 1) % rects.length;
        if (k !== i) opts.ownNet = [routeWire(from, portOn(rnd, rects[k], 'WEST', onGrid), { obstacles: rects, otherNets: opts.otherNets })];
      }
      const pts = routeWire(from, to, opts);
      const ctx = JSON.stringify({ n, from, to, opts, pts });
      expect(pts[0], ctx).toEqual(from.point);
      expect(pts[pts.length - 1], ctx).toEqual(to.point);
      for (let s = 1; s < pts.length; s++) {
        expect(pts[s].x === pts[s - 1].x || pts[s].y === pts[s - 1].y, ctx).toBe(true);
        expect(pts[s].x === pts[s - 1].x && pts[s].y === pts[s - 1].y, ctx).toBe(false);
      }
      expect(simplify(pts), ctx).toHaveLength(pts.length);
      for (const r of rects) expect(polylineHitsRect(pts, r), `${ctx} hits ${JSON.stringify(r)}`).toBe(false);
      // The new part (after what it shares with its own net) never runs along another net.
      let shared = 1;
      const trunk = opts.ownNet?.[0] ?? [];
      while (shared < pts.length && shared < trunk.length && pts[shared].x === trunk[shared].x && pts[shared].y === trunk[shared].y) shared++;
      if (opts.otherNets) for (const o of opts.otherNets) expect(overlaps(pts.slice(shared), o), ctx).toBe(0);
      // Stubs: out of the source side and into the target side, at least 10px each.
      expect(direction(pts[0], pts[1]), ctx).toBe(OUT[from.side]);
      expect(direction(pts[pts.length - 2], pts[pts.length - 1]), ctx).toBe(IN[to.side]);
      if (pts.length > 2) {
        expect(length(pts[0], pts[1]), ctx).toBeGreaterThanOrEqual(10);
        expect(length(pts[pts.length - 2], pts[pts.length - 1]), ctx).toBeGreaterThanOrEqual(10);
      }
      expect(routeWire(from, to, opts)).toEqual(pts);
    }
  });
});

describe('routeWire speed', () => {
  it('routes across a sheet with 200 symbols quickly', () => {
    const rnd = lcg(99);
    // 20 x 10 cells of 100px, one symbol in each with some jitter: a 2000 x 1000 sheet.
    const rects: Rect[] = [];
    for (let cy = 0; cy < 10; cy++)
      for (let cx = 0; cx < 20; cx++)
        rects.push(R(cx * 100 + 10 + Math.round(rnd() * 3) * 10, cy * 100 + 10 + Math.round(rnd() * 3) * 10, 40, 30 + Math.round(rnd() * 2) * 10));
    // From the three left columns to the three right ones: wires across the whole sheet.
    const cases: [RouteEnd, RouteEnd][] = [];
    for (let k = 0; k < 10; k++) {
      const a = rects[Math.floor(rnd() * 10) * 20 + Math.floor(rnd() * 3)];
      const b = rects[Math.floor(rnd() * 10) * 20 + 17 + Math.floor(rnd() * 3)];
      cases.push([east(a, a.y + 10), west(b, b.y + 20)]);
    }
    // Some wires already drawn.
    const otherNets = cases.slice(0, 5).map(([f, t]) => routeWire(f, t, { obstacles: rects }));
    let worst = 0;
    for (const [from, to] of cases.slice(5)) {
      const t0 = performance.now();
      const pts = routeWire(from, to, { obstacles: rects, otherNets });
      worst = Math.max(worst, performance.now() - t0);
      expectClean(pts, from, to);
      for (const r of rects) expect(polylineHitsRect(pts, r)).toBe(false);
    }
    expect(worst).toBeLessThan(250);
  });
});
