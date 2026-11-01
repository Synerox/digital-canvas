import { describe, expect, it } from 'vitest';
import { emptyEdits } from './doc';
import { makeRoom } from './sheet';

const size = (width: number, height: number) => ({ width, height });

describe('makeRoom', () => {
  it('puts in a column for a wider symbol: what is right of it moves, routes stretch', () => {
    const e = {
      ...emptyEdits(),
      pos: { a: { x: 0, y: 0 }, b: { x: 0, y: 100 }, c: { x: 150, y: 0 }, d: { x: 50, y: 200 } },
      routes: { w: { points: [{ x: 100, y: 25 }, { x: 125, y: 25 }, { x: 125, y: 10 }, { x: 150, y: 10 }], label: { x: 110, y: 20, width: 10, height: 10 } } },
    };
    const was = new Map([
      ['a', size(100, 50)],
      ['b', size(100, 50)],
      ['c', size(40, 20)],
      ['d', size(40, 20)],
    ]);
    const out = makeRoom(e, was, new Map([['a', size(140, 50)]]));
    // c is right of a's old right edge; b is below a in its column and d starts inside it: they stay.
    expect(out.pos).toEqual({ a: { x: 0, y: 0 }, b: { x: 0, y: 100 }, c: { x: 190, y: 0 }, d: { x: 50, y: 200 } });
    // The wire leaves a's right edge (now 40 further) and keeps its shape.
    expect(out.routes.w.points).toEqual([
      { x: 140, y: 25 },
      { x: 165, y: 25 },
      { x: 165, y: 10 },
      { x: 190, y: 10 },
    ]);
    expect(out.routes.w.label).toEqual({ x: 150, y: 20, width: 10, height: 10 });
    // Nothing grew: the same edits.
    expect(makeRoom(e, was, new Map([['a', size(100, 50)]]))).toBe(e);
  });

  it('grows a taller symbol upwards when there is room, else downwards, moving what is below it in its column', () => {
    const e = {
      ...emptyEdits(),
      pos: { top: { x: 0, y: -40 }, a: { x: 0, y: 0 }, b: { x: 0, y: 60 }, side: { x: 300, y: 60 }, free: { x: 300, y: -200 } },
      routes: {
        // Between a and b: under a once it is taller.
        under: { points: [{ x: -50, y: 55 }, { x: 50, y: 55 }] },
        // Beside the column: stays.
        beside: { points: [{ x: 200, y: 55 }, { x: 250, y: 55 }] },
      },
    };
    const was = new Map([
      ['top', size(100, 30)],
      ['a', size(100, 50)],
      ['b', size(100, 50)],
      ['side', size(100, 50)],
      ['free', size(100, 50)],
    ]);
    const out = makeRoom(e, was, new Map([['a', size(100, 70)], ['free', size(100, 70)]]));
    // free has room above it: its pins stay where they were.
    expect(out.pos.free).toEqual({ x: 300, y: -220 });
    // top is right above a: a grows down, and b below it moves down as far; side is in another column.
    expect(out.pos.a).toEqual({ x: 0, y: 0 });
    expect(out.pos.b).toEqual({ x: 0, y: 80 });
    expect(out.pos.side).toEqual({ x: 300, y: 60 });
    // The wire that a covers now is routed again; the other is kept.
    expect(Object.keys(out.routes)).toEqual(['beside']);
  });
});
