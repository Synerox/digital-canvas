import { describe, expect, it } from 'vitest';
import type { Point } from '../layout/elk-layout';
import { clickAt, draftPath, followMoves, legMoves, moveCorner, moveLeg, startDraft, trace, undoCorner } from './draw-wire';

const pts = (...xy: number[]): Point[] => xy.flatMap((v, i) => (i % 2 ? [] : [{ x: v, y: xy[i + 1] }]));
const P = (x: number, y: number): Point => ({ x, y });

describe('drawing a wire', () => {
  // An output pin (EAST) at (100,100).
  const out = startDraft(P(100, 100), 'EAST');

  it('runs out of the pin and turns towards the pointer', () => {
    expect(draftPath(out, P(200, 160))).toEqual(pts(100, 100, 200, 100, 200, 160));
    // Behind the pin: out on the stub first, never back over the symbol.
    expect(draftPath(out, P(60, 160))).toEqual(pts(100, 100, 110, 100, 110, 160, 60, 160));
  });

  it('goes into a target pin the way the pin faces', () => {
    // An input (WEST) at (300,160): from the left.
    expect(draftPath(out, P(300, 160), 'WEST')).toEqual(pts(100, 100, 290, 100, 290, 160, 300, 160));
    // The select pin (SOUTH) of a MUX at (300,160): from below, around past it.
    expect(draftPath(out, P(300, 160), 'SOUTH')).toEqual(pts(100, 100, 320, 100, 320, 170, 300, 170, 300, 160));
    // From below it already: straight up into it.
    expect(draftPath(startDraft(P(100, 300), 'EAST'), P(300, 160), 'SOUTH')).toEqual(pts(100, 300, 300, 300, 300, 160));
    // Level with the pin, straight in.
    expect(draftPath(out, P(300, 100), 'WEST')).toEqual(pts(100, 100, 300, 100));
    // An input behind the output, on a symbol 60 high: around that symbol, not through it.
    expect(draftPath(startDraft(P(300, 0), 'EAST'), P(0, 0), 'WEST', { x: 0, y: -30, width: 40, height: 60 })).toEqual(
      pts(300, 0, 310, 0, 310, 40, -10, 40, -10, 0, 0, 0),
    );
  });

  it('keeps the corners clicked and goes on across the last leg', () => {
    let d = clickAt(out, P(200, 160));
    expect(d.points).toEqual(pts(100, 100, 200, 100, 200, 160));
    // After a vertical leg the next one runs horizontally.
    expect(draftPath(d, P(300, 220))).toEqual(pts(100, 100, 200, 100, 200, 160, 300, 160, 300, 220));
    // Backspace takes back the whole click: the corner on the way too.
    d = undoCorner(d, 'h')!;
    expect(d.points).toEqual(pts(100, 100));
    expect(d.axis).toBe('h');
    expect(undoCorner(startDraft(P(0, 0), 'EAST'), 'h')).toBeUndefined();
  });

  it('follows a drag corner by corner', () => {
    // Right, then down, then right again: a staircase.
    let d = out;
    for (const p of [P(150, 100), P(200, 100), P(200, 130), P(200, 160), P(200, 180)]) d = trace(d, p, 10);
    // Still one leg out and the pointer going down: nothing fixed yet.
    expect(d.points).toEqual(pts(100, 100));
    expect(draftPath(d, P(200, 180))).toEqual(pts(100, 100, 200, 100, 200, 180));
    for (const p of [P(210, 180), P(260, 180), P(300, 180)]) d = trace(d, p, 10);
    // The corners where the pointer turned are fixed.
    expect(d.points).toEqual(pts(100, 100, 200, 100, 200, 180));
    expect(draftPath(d, P(300, 180), 'WEST')).toEqual(pts(100, 100, 200, 100, 200, 180, 300, 180));
  });

  it('draws one corner for a diagonal drag, not a staircase', () => {
    let d = out;
    for (let k = 1; k <= 20; k++) d = trace(d, P(100 + 10 * Math.ceil(k / 2), 100 + 10 * Math.floor(k / 2)), 10);
    expect(d.points).toEqual(pts(100, 100));
    expect(draftPath(d, P(200, 200), 'WEST')).toEqual(pts(100, 100, 190, 100, 190, 200, 200, 200));
  });
});

describe('reshaping a wire', () => {
  const z = pts(100, 100, 150, 100, 150, 200, 300, 200);

  it('moves an inner leg, its neighbours stretch', () => {
    expect(moveLeg(z, 1, 180)).toEqual(pts(100, 100, 180, 100, 180, 200, 300, 200));
  });

  it('moves a leg at a pin, which stays put', () => {
    expect(moveLeg(z, 0, 80)).toEqual(pts(100, 100, 110, 100, 110, 80, 150, 80, 150, 200, 300, 200));
    expect(moveLeg(z, 2, 230)).toEqual(pts(100, 100, 150, 100, 150, 230, 290, 230, 290, 200, 300, 200));
    // A straight wire gets a stub at each end.
    expect(moveLeg(pts(0, 0, 100, 0), 0, 30)).toEqual(pts(0, 0, 10, 0, 10, 30, 90, 30, 90, 0, 100, 0));
    // One too short for a stub at each end and a stretch between them stays.
    expect(moveLeg(pts(0, 0, 20, 0), 0, 20)).toEqual(pts(0, 0, 20, 0));
    expect(moveLeg(pts(0, 0, 10, 0), 0, 20)).toEqual(pts(0, 0, 10, 0));
    expect(moveLeg(pts(0, 0, 30, 0), 0, 20)).toEqual(pts(0, 0, 10, 0, 10, 20, 20, 20, 20, 0, 30, 0));
  });

  it('moves a corner anywhere', () => {
    expect(moveCorner(z, 1, P(130, 150))).toEqual(pts(100, 100, 110, 100, 110, 150, 130, 150, 130, 200, 300, 200));
    // The last leg ends on a pin: it comes back to it on a stub.
    expect(moveCorner(z, 2, P(200, 250))).toEqual(pts(100, 100, 200, 100, 200, 250, 290, 250, 290, 200, 300, 200));
  });

  it('carries a move over to a wire that ran along the moved leg', () => {
    const branch = pts(100, 100, 150, 100, 150, 300, 300, 300);
    const moved = moveLeg(z, 1, 180);
    expect(followMoves(branch, legMoves(z, moved))).toEqual(pts(100, 100, 180, 100, 180, 300, 300, 300));
    // A wire that never ran along it is left as it was (the same array).
    const apart = pts(100, 100, 120, 100, 120, 300, 300, 300);
    expect(followMoves(apart, legMoves(z, moved))).toBe(apart);
  });
});
