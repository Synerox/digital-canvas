/**
 * Flatten a module: inline every sub-module instance (recursively) so the
 * whole circuit can be drawn on one sheet. Cells inside instance `u` get the
 * stable ID `u/<id>` and the name `u.<name>`; nets are renamed the same way.
 */
import type { Bit, IRCell, IRDesign, IRModule, IRNet } from './ir';

const MAX_DEPTH = 32;

function maxBit(m: IRModule): number {
  let max = 0;
  const see = (bits: Bit[]) => {
    for (const b of bits) if (typeof b === 'number' && b > max) max = b;
  };
  for (const p of m.ports) see(p.bits);
  for (const n of m.nets) see(n.bits);
  for (const c of m.cells) for (const bits of Object.values(c.connections)) see(bits);
  return max;
}

export function flattenModule(design: IRDesign, name: string): IRModule {
  const top = design.modules[name];
  if (!top || !top.cells.some((c) => c.isInstance && design.modules[c.type])) return top;
  let next = maxBit(top) + 1;
  const cells: IRCell[] = [];
  const nets: IRNet[] = [...top.nets];

  const inline = (m: IRModule, map: (b: Bit) => Bit, prefix: string, depth: number) => {
    for (const c of m.cells) {
      const conn: Record<string, Bit[]> = {};
      for (const [p, bits] of Object.entries(c.connections)) conn[p] = bits.map(map);
      const child = c.isInstance ? design.modules[c.type] : undefined;
      if (!child || depth >= MAX_DEPTH) {
        cells.push(
          prefix
            ? { ...c, id: `${prefix}/${c.id}`, name: `${prefix.replace(/\//g, '.')}.${c.name}`, connections: conn }
            : { ...c, connections: conn },
        );
        continue;
      }
      // Child bits: ports map to the parent's connection, everything else gets a fresh number.
      const local = new Map<number, Bit>();
      for (const p of child.ports) {
        const outer = conn[p.name] ?? [];
        p.bits.forEach((b, i) => {
          if (typeof b !== 'number' || local.has(b)) return;
          const o = outer[i];
          // A constant tied to an output port cannot carry the signal; keep it internal.
          if (o !== undefined && (typeof o === 'number' || p.direction === 'input')) local.set(b, o);
        });
      }
      const childMap = (b: Bit): Bit => {
        if (typeof b !== 'number') return b;
        let v = local.get(b);
        if (v === undefined) local.set(b, (v = next++));
        return v;
      };
      const childPrefix = prefix ? `${prefix}/${c.name}` : c.name;
      const dotted = childPrefix.replace(/\//g, '.');
      for (const n of child.nets) {
        nets.push({ ...n, name: `${dotted}.${n.name}`, hidden: true, bits: n.bits.map(childMap) });
      }
      inline(child, childMap, childPrefix, depth + 1);
    }
  };
  inline(top, (b) => b, '', 0);
  return { ...top, cells, nets };
}

/** The design with `name` flattened (other modules unchanged). */
export function withFlattened(design: IRDesign, name: string): IRDesign {
  const flat = flattenModule(design, name);
  if (!flat || flat === design.modules[name]) return design;
  return { ...design, modules: { ...design.modules, [name]: flat } };
}
