import { describe, expect, it } from 'vitest';
import type { LEdge, Point } from '../layout/elk-layout';
import { grabAt, reshape } from './EditorCanvas';

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

describe('grabAt', () => {
  const z = pts(100, 100, 150, 100, 150, 200, 300, 200);

  it('takes hold of a corner near the pointer before its legs', () => {
    expect(grabAt(z, { x: 152, y: 103 }, 8)).toEqual({ kind: 'corner', index: 1 });
    expect(grabAt(z, { x: 149, y: 198 }, 8)).toEqual({ kind: 'corner', index: 2 });
  });

  it('takes hold of any leg, the ones at the pins too', () => {
    expect(grabAt(z, { x: 120, y: 104 }, 8)).toEqual({ kind: 'leg', index: 0 });
    expect(grabAt(z, { x: 146, y: 150 }, 8)).toEqual({ kind: 'leg', index: 1 });
    expect(grabAt(z, { x: 250, y: 195 }, 8)).toEqual({ kind: 'leg', index: 2 });
    expect(grabAt(z, { x: 250, y: 150 }, 8)).toBeUndefined();
    // A straight wire has no corner, only its one leg.
    expect(grabAt(pts(0, 0, 100, 0), { x: 50, y: 3 }, 8)).toEqual({ kind: 'leg', index: 0 });
  });
});

describe('reshape', () => {
  // in1 fans out to two gates: both branches run down the same vertical at x=150 (the router shares it).
  const toXor = wire('w:5', 'u:1.out', pts(130, 110, 150, 110, 150, 150, 320, 150));
  const toAnd = wire('w:7', 'u:1.out', pts(130, 110, 150, 110, 150, 250, 320, 250));
  const other = wire('w:9', 'u:2.out', pts(130, 300, 150, 300, 150, 150, 320, 150));

  it('moves a stretch the wires of a net share for all of them, and leaves other nets alone', () => {
    const out = reshape([toXor, toAnd, other], 'w:5', toXor.points, { kind: 'leg', index: 1 }, { x: 200, y: 140 });
    expect(out['w:5']).toEqual(pts(130, 110, 200, 110, 200, 150, 320, 150));
    expect(out['w:7']).toEqual(pts(130, 110, 200, 110, 200, 250, 320, 250));
    expect(out['w:9']).toBeUndefined();
  });

  it('moves a leg at a pin: the pin end stays, on a stub', () => {
    const out = reshape([toXor, toAnd], 'w:5', toXor.points, { kind: 'leg', index: 2 }, { x: 250, y: 170 });
    // The last leg into the target pin at (320,150) moves down to y=170; the wire comes back up 10px before the pin.
    expect(out['w:5']).toEqual(pts(130, 110, 150, 110, 150, 170, 310, 170, 310, 150, 320, 150));
    // The other branch does not run along that leg.
    expect(out['w:7']).toBeUndefined();
  });

  it('drags a corner with both its legs', () => {
    const out = reshape([toAnd], 'w:7', toAnd.points, { kind: 'corner', index: 2 }, { x: 200, y: 230 });
    expect(out['w:7']).toEqual(pts(130, 110, 200, 110, 200, 230, 310, 230, 310, 250, 320, 250));
  });
});
