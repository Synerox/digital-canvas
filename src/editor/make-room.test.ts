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

  it('grows a taller symbol upwards when there is room, else downwards, with a row put in at its old bottom', () => {
    const e = {
      ...emptyEdits(),
      pos: { top: { x: 0, y: -40 }, a: { x: 0, y: 0 }, b: { x: 0, y: 60 }, side: { x: 300, y: 60 }, free: { x: 300, y: -200 } },
      routes: {
        // Between a and b.
        under: { points: [{ x: -50, y: 55 }, { x: 50, y: 55 }] },
        // Beside the column.
        beside: { points: [{ x: 200, y: 55 }, { x: 250, y: 55 }] },
        // Right above free: under it once it is taller.
        over: { points: [{ x: 280, y: -210 }, { x: 420, y: -210 }] },
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
    // top is right above a: a grows down, and what is below it moves down as far, in its column or not.
    expect(out.pos.a).toEqual({ x: 0, y: 0 });
    expect(out.pos.b).toEqual({ x: 0, y: 80 });
    expect(out.pos.side).toEqual({ x: 300, y: 80 });
    // The wire that free covers now is routed again. The others move down with the row: the one between a and b still
    // runs between them.
    expect(Object.keys(out.routes)).toEqual(['under', 'beside']);
    expect(out.routes.under.points).toEqual([
      { x: -50, y: 75 },
      { x: 50, y: 75 },
    ]);
    expect(out.routes.beside.points).toEqual([
      { x: 200, y: 75 },
      { x: 250, y: 75 },
    ]);
  });

  it('moves what is below a symbol that grows downwards clear of what is beside it, routes and all', () => {
    // x is just under a, and y under x but left of a's column; the wire runs between them.
    const e = {
      ...emptyEdits(),
      pos: { top: { x: 0, y: -40 }, a: { x: 0, y: 0 }, x: { x: -30, y: 60 }, y: { x: -60, y: 90 } },
      routes: {
        other: { points: [{ x: -100, y: 85 }, { x: 5, y: 85 }], label: { x: -90, y: 75, width: 10, height: 10 } },
        up: { points: [{ x: -80, y: 85 }, { x: -80, y: 20 }] },
      },
    };
    const was = new Map([
      ['top', size(100, 30)],
      ['a', size(100, 50)],
      ['x', size(40, 20)],
      ['y', size(40, 20)],
    ]);
    const out = makeRoom(e, was, new Map([['a', size(100, 70)]]));
    // a cannot grow up (top is there): x and y both move down as far, so x does not land on y.
    expect(out.pos).toEqual({ top: { x: 0, y: -40 }, a: { x: 0, y: 0 }, x: { x: -30, y: 80 }, y: { x: -60, y: 110 } });
    // Wires keep their shapes: what is below a's old bottom moves down as far (one keeps running between x and y), and
    // a leg that crosses it grows.
    expect(out.routes.other.points).toEqual([
      { x: -100, y: 105 },
      { x: 5, y: 105 },
    ]);
    expect(out.routes.other.label).toEqual({ x: -90, y: 95, width: 10, height: 10 });
    expect(out.routes.up.points).toEqual([
      { x: -80, y: 105 },
      { x: -80, y: 20 },
    ]);
  });

  it('moves what starts close beside a symbol that grows downwards down with its pins', () => {
    // logic is right above a, so a grows downwards and its pins move down 20. tens starts 8 right of a, below a's
    // output pin (y 40): moved down that far, the pin would face it and its wire would run through tens.
    const e = (tensX: number) => ({
      ...emptyEdits(),
      pos: { logic: { x: 0, y: -60 }, a: { x: 0, y: 0 }, tens: { x: tensX, y: 50 }, far: { x: 400, y: 40 }, below: { x: 0, y: 120 } },
      routes: { out: { points: [{ x: tensX + 40, y: 80 }, { x: 300, y: 80 }] } },
    });
    const was = new Map([
      ['logic', size(100, 50)],
      ['a', size(100, 90)],
      ['tens', size(40, 60)],
      ['far', size(40, 60)],
      ['below', size(100, 20)],
    ]);
    const grow = new Map([['a', size(100, 110)]]);
    const close = makeRoom(e(108), was, grow);
    // tens moves down with a's pins, and so does everything below its top; what is further away stays.
    expect(close.pos).toEqual({ logic: { x: 0, y: -60 }, a: { x: 0, y: 0 }, tens: { x: 108, y: 70 }, far: { x: 400, y: 40 }, below: { x: 0, y: 140 } });
    expect(close.routes.out.points).toEqual([
      { x: 148, y: 100 },
      { x: 300, y: 100 },
    ]);
    // Two grid steps away there is room for the stubs: only what is below a's old bottom moves.
    const roomy = makeRoom(e(120), was, grow);
    expect(roomy.pos).toEqual({ logic: { x: 0, y: -60 }, a: { x: 0, y: 0 }, tens: { x: 120, y: 50 }, far: { x: 400, y: 40 }, below: { x: 0, y: 140 } });
    expect(roomy.routes.out.points).toEqual([
      { x: 160, y: 80 },
      { x: 300, y: 80 },
    ]);
  });

  it('grows a symbol downwards when a pin beside the band above it has no room for its stub', () => {
    const was = new Map([
      ['a', size(100, 90)],
      ['pin', size(40, 20)],
    ]);
    const grow = new Map([['a', size(100, 110)]]);
    // The pin's right edge is one grid step left of a, its middle 12 above a's top: its wire would start inside a grown upwards.
    const tight = makeRoom({ ...emptyEdits(), pos: { a: { x: 0, y: 0 }, pin: { x: -50, y: -22 } } }, was, grow);
    expect(tight.pos).toEqual({ a: { x: 0, y: 0 }, pin: { x: -50, y: -22 } });
    // Two grid steps away there is room for the stub: a grows upwards, its pins stay where they are.
    const roomy = makeRoom({ ...emptyEdits(), pos: { a: { x: 0, y: 0 }, pin: { x: -60, y: -22 } } }, was, grow);
    expect(roomy.pos).toEqual({ a: { x: 0, y: -20 }, pin: { x: -60, y: -22 } });
    // Beside a, below the band it grows into, a pin is as close to it either way: a grows upwards.
    const below = makeRoom({ ...emptyEdits(), pos: { a: { x: 0, y: 0 }, pin: { x: -50, y: 30 } } }, was, grow);
    expect(below.pos).toEqual({ a: { x: 0, y: -20 }, pin: { x: -50, y: 30 } });
  });
});
