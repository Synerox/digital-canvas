import { describe, expect, it } from 'vitest';
import type { LEdge, Point } from '../layout/elk-layout';
import { sharedSegment } from './EditorCanvas';

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
