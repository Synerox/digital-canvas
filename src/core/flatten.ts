/**
 * Flatten a module: inline every sub-module instance (recursively) so the
 * whole circuit can be drawn on one sheet. Cells inside instance `u` get the
 * stable ID `u/<id>` and the name `u.<name>`; nets are renamed `u.<name>`.
 *
 * Yosys can give two ports of a child the same bits (`assign y = a;`) or
 * constant bits (`assign y = 4'd5;`). The parent nets on such ports are then
 * the same signal, so they are merged (aliased) after inlining.
 */
import { type Bit, type IRCell, type IRDesign, type IRModule, type IRNet, inputPortBits } from './ir';

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

/** Count the cells a flattened module would have, without building it (each module is counted once). */
export function flatCellCount(design: IRDesign, name: string): number {
  const memo = new Map<string, number>();
  const count = (mod: string, depth: number): number => {
    const known = memo.get(mod);
    if (known !== undefined) return known;
    let n = 0;
    for (const c of design.modules[mod]?.cells ?? []) {
      n += c.isInstance && design.modules[c.type] && depth < MAX_DEPTH ? count(c.type, depth + 1) : 1;
    }
    memo.set(mod, n);
    return n;
  };
  return count(name, 0);
}

export function flattenModule(design: IRDesign, name: string): IRModule {
  const top = design.modules[name];
  if (!top || !top.cells.some((c) => c.isInstance && design.modules[c.type])) return top;
  let next = maxBit(top) + 1;
  const cells: IRCell[] = [];
  const nets: IRNet[] = [...top.nets];

  // Union-find over parent bits. Constants win as representatives, then top-level
  // input bits, so a pin stays connected to the name the user sees.
  const topInputs = inputPortBits(top);
  const alias = new Map<number, Bit>();
  const resolve = (b: Bit): Bit => {
    let x = b;
    const seen: number[] = [];
    while (typeof x === 'number' && alias.has(x)) {
      seen.push(x);
      x = alias.get(x)!;
    }
    for (const s of seen) alias.set(s, x);
    return x;
  };
  const rank = (b: Bit) => (typeof b !== 'number' ? 2 : topInputs.has(b) ? 1 : 0);
  const join = (a: Bit, b: Bit) => {
    const ra = resolve(a);
    const rb = resolve(b);
    if (ra === rb) return;
    if (typeof ra !== 'number' && typeof rb !== 'number') return; // two different constants: leave as is
    const [keep, drop] = rank(ra) >= rank(rb) ? [ra, rb] : [rb, ra];
    if (typeof drop === 'number') alias.set(drop, keep);
  };

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
          const o = outer[i];
          if (typeof b !== 'number') {
            // A constant on an output port drives the parent net with that constant.
            if (typeof o === 'number' && p.direction !== 'input') join(o, b);
            return;
          }
          const known = local.get(b);
          if (known !== undefined) {
            // The same child bit on two ports: the parent nets on both are one signal.
            if (o !== undefined && (typeof o === 'number' || p.direction === 'input')) join(o, known);
            return;
          }
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
        nets.push({ ...n, name: `${dotted}.${n.name}`, bits: n.bits.map(childMap) });
      }
      inline(child, childMap, childPrefix, depth + 1);
    }
  };
  inline(top, (b) => b, '', 0);

  if (alias.size === 0) return { ...top, cells, nets };
  const fix = (bits: Bit[]) => bits.map(resolve);
  return {
    ...top,
    // Output pins follow the merge; input pins are representatives already.
    ports: top.ports.map((p) => ({ ...p, bits: fix(p.bits) })),
    cells: cells.map((c) => {
      const connections: Record<string, Bit[]> = {};
      for (const [p, bits] of Object.entries(c.connections)) connections[p] = fix(bits);
      return { ...c, connections };
    }),
    nets: nets.map((n) => ({ ...n, bits: fix(n.bits) })),
  };
}

/** The design with `name` flattened (other modules unchanged). */
export function withFlattened(design: IRDesign, name: string): IRDesign {
  const flat = flattenModule(design, name);
  if (!flat || flat === design.modules[name]) return design;
  return { ...design, modules: { ...design.modules, [name]: flat } };
}
