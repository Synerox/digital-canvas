import { describe, expect, it } from 'vitest';
import type { DNode } from '../core/diagram';
import { type LEdge, type LNode, approxMeasure, sizeNode } from '../layout/elk-layout';
import { newUserNode, symbolNode, type SymKey, type SymParams } from '../editor/symbols';
import { OPEN_BUS_STUB, hoveredSymbol, openBusHints } from './pin-hints';

/** A placed symbol laid out at (x, y), as the sheet's geometry places it. */
function placed(id: string, sym: SymKey, params: SymParams, x: number, y: number): LNode {
  const n: DNode = symbolNode({ ...newUserNode(id, sym), params }, () => undefined);
  const s = sizeNode(n, approxMeasure);
  return { ...n, x, y, width: s.width, height: s.height, ports: n.ports.map((p) => ({ ...p, x: x + s.ports[p.id].x, y: y + s.ports[p.id].y })) };
}

function wire(id: string, source: string, target: string): LEdge {
  const node = (p: string) => p.slice(0, p.indexOf('.'));
  return { id, source: { node: node(source), port: source }, target: { node: node(target), port: target }, width: 8, fullSource: true, points: [], junctions: [] };
}

describe('openBusHints', () => {
  it('marks every bus pin of a symbol that is not wired yet with its bits', () => {
    const and = placed('u:1', 'and', { inputs: 2, width: 8 }, 100, 100);
    const hints = openBusHints({ nodes: [and], edges: [] });
    expect(hints.map((h) => [h.port, h.width])).toEqual([
      ['u:1.A', 8],
      ['u:1.B', 8],
      ['u:1.Y', 8],
    ]);
    const a = and.ports.find((p) => p.name === 'A')!;
    const y = and.ports.find((p) => p.name === 'Y')!;
    // Inputs stick out to the left, the output to the right, two grid steps, the slash half way.
    expect(hints[0]).toMatchObject({ from: { x: a.x, y: a.y }, to: { x: a.x - OPEN_BUS_STUB, y: a.y }, slash: { x: a.x - OPEN_BUS_STUB / 2, y: a.y } });
    expect(hints[2]).toMatchObject({ from: { x: y.x, y: y.y }, to: { x: y.x + OPEN_BUS_STUB, y: y.y } });
    // The number is written above the stub.
    expect(hints[0].text).toEqual({ x: a.x - OPEN_BUS_STUB / 2, y: a.y - 7, anchor: 'middle' });
  });

  it('follows the width: a 1-bit symbol has no marks, a wider one says its new bits', () => {
    expect(openBusHints({ nodes: [placed('u:1', 'and', { inputs: 2, width: 1 }, 0, 0)], edges: [] })).toEqual([]);
    expect(openBusHints({ nodes: [placed('u:1', 'and', { inputs: 2, width: 16 }, 0, 0)], edges: [] }).map((h) => h.width)).toEqual([16, 16, 16]);
    // A comparator's output is one bit whatever its width.
    expect(openBusHints({ nodes: [placed('u:1', 'eq', { width: 4 }, 0, 0)], edges: [] }).map((h) => h.port)).toEqual(['u:1.A', 'u:1.B']);
  });

  it('leaves out the pins a wire starts or ends on (the wire carries the mark)', () => {
    const pin = placed('u:1', 'input', { width: 8 }, 0, 100);
    const and = placed('u:2', 'and', { inputs: 2, width: 8 }, 200, 100);
    const out = placed('u:3', 'output', { width: 8 }, 400, 100);
    const hints = openBusHints({ nodes: [pin, and, out], edges: [wire('w:1', 'u:1.out', 'u:2.A'), wire('w:2', 'u:2.Y', 'u:3.in')] });
    expect(hints.map((h) => h.port)).toEqual(['u:2.B']);
  });

  it('draws a pin on the bottom edge downwards, its number beside the stub', () => {
    const mux = placed('u:1', 'mux', { inputs: 4, width: 1 }, 0, 0);
    const [s] = openBusHints({ nodes: [mux], edges: [] });
    const pin = mux.ports.find((p) => p.name === 'S')!;
    expect(s).toMatchObject({ port: 'u:1.S', width: 2, to: { x: pin.x, y: pin.y + OPEN_BUS_STUB } });
    expect(s.text.anchor).toBe('start');
    expect(s.text.x).toBeGreaterThan(pin.x);
  });
});

describe('hoveredSymbol', () => {
  it('is the symbol under the pointer, also when the pointer is on one of its pins', () => {
    expect(hoveredSymbol({ node: 'u:2' })).toBe('u:2');
    expect(hoveredSymbol({ port: { node: 'u:3' } })).toBe('u:3');
    expect(hoveredSymbol({})).toBeUndefined();
  });
});
