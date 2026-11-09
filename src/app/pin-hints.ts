/**
 * What the canvas draws at the pins of the symbols, over the drawing (none of it is exported):
 *
 * - The connection points, green, of the symbol under the pointer only (a dot on every pin
 *   would read as an inverter's bubble).
 * - On a bus pin that no wire is connected to yet, a short stub with the bus mark and its
 *   bits (`/8`), so that a symbol's width shows as soon as it is set, not only once it is
 *   wired (a wire then carries the mark).
 */
import type { Side } from '../core/diagram';
import type { LayoutResult, Point } from '../layout/elk-layout';

/** Length of the stub drawn on an open bus pin: two grid steps, so that its end is on the grid. */
export const OPEN_BUS_STUB = 20;

export interface OpenBusHint {
  /** The pin's ID. */
  port: string;
  width: number;
  /** The stub, from the pin outwards. */
  from: Point;
  to: Point;
  /** Middle of the slash (half way along the stub). */
  slash: Point;
  /** Where the number is written, and how it is anchored there. */
  text: { x: number; y: number; anchor: 'middle' | 'start' };
}

const OUT: Record<Side, Point> = { WEST: { x: -1, y: 0 }, EAST: { x: 1, y: 0 }, NORTH: { x: 0, y: -1 }, SOUTH: { x: 0, y: 1 } };

/** The stubs of the bus pins (wider than 1 bit) that no wire of the sheet starts or ends on. */
export function openBusHints(layout: Pick<LayoutResult, 'nodes' | 'edges'>): OpenBusHint[] {
  const wired = new Set<string>();
  for (const e of layout.edges) {
    wired.add(e.source.port);
    wired.add(e.target.port);
  }
  const out: OpenBusHint[] = [];
  for (const n of layout.nodes) {
    for (const p of n.ports) {
      if (p.width <= 1 || wired.has(p.id)) continue;
      // The slices of a split or a concatenation are named next to the bar already ([7:4]), where the number would go.
      if ((n.kind === 'split' && p.side === 'EAST') || (n.kind === 'join' && p.side === 'WEST')) continue;
      const d = OUT[p.side] ?? OUT.EAST;
      const from = { x: p.x, y: p.y };
      const to = { x: p.x + d.x * OPEN_BUS_STUB, y: p.y + d.y * OPEN_BUS_STUB };
      const slash = { x: p.x + (d.x * OPEN_BUS_STUB) / 2, y: p.y + (d.y * OPEN_BUS_STUB) / 2 };
      // Above a stub that runs across, right of one that runs up or down (as wires write their marks).
      const text = d.y === 0 ? { x: slash.x, y: slash.y - 7, anchor: 'middle' as const } : { x: slash.x + 6, y: slash.y + 4, anchor: 'start' as const };
      out.push({ port: p.id, width: p.width, from, to, slash, text });
    }
  }
  return out;
}

/** The symbol whose connection points show: the one the pointer is over, on its body or on one of its pins. */
export function hoveredSymbol(hit: { node?: string; port?: { node: string } }): string | undefined {
  return hit.port?.node ?? hit.node;
}
