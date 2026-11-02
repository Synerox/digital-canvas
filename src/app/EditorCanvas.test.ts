import { describe, expect, it } from 'vitest';
import type { LEdge, Point } from '../layout/elk-layout';
import { draftRoute, sharedSegment } from './EditorCanvas';

const pts = (...xy: number[]): Point[] => xy.flatMap((v, i) => (i % 2 ? [] : [{ x: v, y: xy[i + 1] }]));

function wire(id: string, source: string, points: Point[]): LEdge {
  return {
    id,
    source: { node: source.split('.')[0], port: source },
    target: { node: 't', port: `t.${id}` },
    width: 1,
    fullSource: true,
    points,
    junctions: [],
  };
}

describe('sharedSegment', () => {
  // in1 fans out to two gates: the router draws both branches down the same vertical at x=150.
  const toXor = wire('w:5', 'u:1.out', pts(127, 110, 150, 110, 150, 150, 320, 150));
  const toAnd = wire('w:7', 'u:1.out', pts(127, 110, 150, 110, 150, 250, 320, 250));

  it('finds a trunk that branches of the net share', () => {
    expect(sharedSegment([toXor, toAnd], 'w:5', 1)).toBe(true);
    // Overlapping over part of its length is enough.
    expect(sharedSegment([toXor, toAnd], 'w:7', 1)).toBe(true);
  });

  it('lets a stretch that only one wire uses be dragged', () => {
    const elsewhere = wire('w:7', 'u:1.out', pts(127, 110, 140, 110, 140, 250, 320, 250));
    expect(sharedSegment([toXor, elsewhere], 'w:5', 1)).toBe(false);
    // Touching at an end only is not sharing.
    const below = wire('w:7', 'u:1.out', pts(127, 300, 150, 300, 150, 150, 320, 150));
    expect(sharedSegment([toXor, below], 'w:5', 1)).toBe(false);
  });

  it('ignores wires of other nets', () => {
    const other = wire('w:9', 'u:2.out', pts(127, 110, 150, 110, 150, 150, 320, 150));
    expect(sharedSegment([toXor, other], 'w:5', 1)).toBe(false);
  });
});

describe('draftRoute', () => {
  // An AND's output Y at (280,260), a bend above it, and an Output's input pin at (540,260).
  const y = { x: 280, y: 260 };
  const bend = { x: 280, y: 140 };
  const pin = { x: 540, y: 260 };

  it('enters the target pin the way the stored wire does, not sideways', () => {
    const draft = draftRoute([y, bend, pin], 'EAST', 'WEST');
    expect(draft).toEqual(pts(280, 260, 290, 260, 290, 140, 530, 140, 530, 260, 540, 260));
  });

  it('runs to the pointer while no pin is under it, and shows a plain elbow before the first bend', () => {
    expect(draftRoute([y, bend, { x: 400, y: 200 }], 'EAST')).toEqual(pts(280, 260, 290, 260, 290, 140, 400, 140, 400, 200));
    expect(draftRoute([y, pin], 'EAST', 'WEST')).toEqual(pts(280, 260, 540, 260));
  });
});
