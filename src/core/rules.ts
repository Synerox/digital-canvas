/**
 * Semantic transforms: rewrite the structure Yosys produces into the shapes
 * designers draw by hand. They always apply (there is no switch to draw the
 * structure as Yosys gives it): a left shift of the constant 1 is a decoder, a
 * MUX that selects a constant 0 is an AND gate, a reduction and a NOT of its
 * bit (`~|a`) is one NOR gate of all the bits (combineReductions), and (while building edges, see
 * buildDiagram) high-order zero padding into arithmetic is a plain wire and
 * low-order zero padding is labelled ×2ⁿ. A rewritten cell becomes a `dc:*`
 * cell that keeps the original stable ID, so saved positions still apply.
 *
 * Rules run on a copy of the module; the IR itself is never modified.
 */
import type { Bit, IRCell, IRModule } from './ir';

const isConst = (b: Bit) => typeof b !== 'number';
const allConst = (bits: Bit[]) => bits.every(isConst);
const allZero = (bits: Bit[]) => bits.every((b) => b === '0');

/** Numeric value of constant bits (LSB first), or undefined for x/z. */
export function constValue(bits: Bit[]): bigint | undefined {
  let v = 0n;
  for (let i = bits.length - 1; i >= 0; i--) {
    const b = bits[i];
    if (b !== '0' && b !== '1') return undefined;
    v = (v << 1n) | (b === '1' ? 1n : 0n);
  }
  return v;
}

/** Bits read by any cell input or module output. */
function usedBits(m: IRModule): Set<number> {
  const used = new Set<number>();
  for (const p of m.ports) if (p.direction !== 'input') for (const b of p.bits) if (typeof b === 'number') used.add(b);
  for (const c of m.cells) {
    for (const [port, bits] of Object.entries(c.connections)) {
      if (c.directions[port] === 'output') continue;
      for (const b of bits) if (typeof b === 'number') used.add(b);
    }
  }
  return used;
}

function rewriteDecoder(c: IRCell, used: Set<number>): IRCell | undefined {
  if (c.type !== '$shl' && c.type !== '$sshl') return undefined;
  const a = c.connections.A;
  const b = c.connections.B;
  const y = c.connections.Y;
  if (!a || !b || !y || !allConst(a) || constValue(a) !== 1n || allConst(b)) return undefined;
  // A signed constant whose MSB is 1 sign-extends to all ones: that is a mask, not a decoder.
  if (/1/.test(c.parameters.A_SIGNED ?? '') && a[a.length - 1] === '1') return undefined;
  // Only the outputs somebody reads (or the natural 2^n width) are drawn.
  let last = -1;
  y.forEach((bit, i) => {
    if (typeof bit === 'number' && used.has(bit)) last = i;
  });
  const natural = b.length < 16 ? 2 ** b.length : y.length;
  const width = Math.max(1, Math.min(y.length, Math.max(last + 1, Math.min(natural, y.length))));
  return {
    ...c,
    type: 'dc:decoder',
    rule: 'decoder',
    directions: { A: 'input', Y: 'output' },
    connections: { A: b, Y: y.slice(0, width) },
    attrs: { inputs: b.length, outputs: width },
  };
}

function rewriteMuxToAnd(c: IRCell): IRCell | undefined {
  if (c.type !== '$mux') return undefined;
  const a = c.connections.A; // selected when S = 0
  const b = c.connections.B; // selected when S = 1
  const s = c.connections.S;
  if (!a || !b || !s || s.length !== 1) return undefined;
  let data: Bit[];
  let invert: boolean;
  if (allZero(a) && !allConst(b)) {
    data = b; // y = s ? b : 0  ->  b & s
    invert = false;
  } else if (allZero(b) && !allConst(a)) {
    data = a; // y = s ? 0 : a  ->  a & ~s
    invert = true;
  } else {
    return undefined;
  }
  return {
    ...c,
    type: 'dc:and',
    rule: 'mux-to-and',
    directions: { A: 'input', B: 'input', Y: 'output' },
    connections: { A: data, B: s, Y: c.connections.Y },
    attrs: { invertB: invert },
  };
}

/** Apply the cell-level rules. The wiring rules (zero extension, ×2ⁿ) are applied while building edges. */
export function applyRules(m: IRModule): IRModule {
  const used = usedBits(m);
  const cells = m.cells.map((c) => (c.isInstance ? c : (rewriteDecoder(c, used) ?? rewriteMuxToAnd(c) ?? c)));
  return { ...m, cells };
}

/** A reduction followed by a NOT of its bit: one reduction gate with a bubble on its output. */
const NEGATED_REDUCTION: Record<string, string> = {
  $reduce_and: 'dc:reduce_nand',
  $reduce_or: 'dc:reduce_nor',
  $reduce_bool: 'dc:reduce_nor',
  $reduce_xor: '$reduce_xnor',
  $reduce_xnor: '$reduce_xor',
};

/** How many times each bit is read: by cell inputs, and by module outputs (and inouts). */
function readCounts(m: IRModule): Map<number, number> {
  const out = new Map<number, number>();
  const read = (b: Bit) => typeof b === 'number' && out.set(b, (out.get(b) ?? 0) + 1);
  for (const p of m.ports) if (p.direction !== 'input') p.bits.forEach(read);
  for (const c of m.cells) for (const [port, bits] of Object.entries(c.connections)) if (c.directions[port] !== 'output') bits.forEach(read);
  return out;
}

/**
 * Reductions drawn as they are written (`~&a` is one NAND gate of all the bits of `a`, see GateMode in editor/symbols):
 *
 * - `~&a`, `~|a` (and `~(|a)`, `!(^a)`…): Yosys makes a reduction and a NOT of its one bit. They are one reduction
 *   gate with a bubble, when nothing else reads that bit and no signal of the code is that bit (a named wire is drawn
 *   between the two, as written). The gate keeps the reduction's ID.
 * - `!a` of a bus: the bus is all zeros, a NOR of all its bits (an inverter would read as `~a`, every bit inverted).
 *
 * Applied after applyRules, apart from it: what selects a case of a case table is named by the cells before these
 * (see buildDiagram), so those names, and the IDs of the table's constants, stay what they were.
 */
export function combineReductions(m: IRModule): IRModule {
  const reads = readCounts(m);
  const named = new Set<number>();
  for (const n of m.nets) if (!n.hidden) for (const b of n.bits) if (typeof b === 'number') named.add(b);
  const driver = new Map<number, IRCell>();
  for (const c of m.cells) {
    if (c.isInstance || !NEGATED_REDUCTION[c.type]) continue;
    const y = c.connections.Y;
    if (y?.length === 1 && typeof y[0] === 'number') driver.set(y[0], c);
  }
  const merged = new Map<IRCell, IRCell>();
  const gone = new Set<IRCell>();
  for (const c of m.cells) {
    if (c.isInstance || (c.type !== '$logic_not' && c.type !== '$not')) continue;
    const a = c.connections.A;
    const y = c.connections.Y;
    if (a?.length !== 1 || y?.length !== 1 || typeof a[0] !== 'number') continue;
    const r = driver.get(a[0]);
    if (!r || merged.has(r) || reads.get(a[0]) !== 1 || named.has(a[0])) continue;
    merged.set(r, {
      ...r,
      type: NEGATED_REDUCTION[r.type],
      rule: 'reduce-not',
      directions: { A: 'input', Y: 'output' },
      connections: { A: r.connections.A, Y: y },
      src: [...r.src, ...c.src],
    });
    gone.add(c);
  }
  const cells = m.cells
    .filter((c) => !gone.has(c))
    .map((c) => {
      const r = merged.get(c);
      if (r) return r;
      // `!a` of a bus (a 1-bit `!` stays an inverter).
      if (!c.isInstance && c.type === '$logic_not' && (c.connections.A?.length ?? 0) > 1 && c.connections.Y?.length === 1) {
        return { ...c, type: 'dc:reduce_nor', rule: 'logic-not' };
      }
      return c;
    });
  return merged.size || cells.some((c, k) => c !== m.cells[k]) ? { ...m, cells } : m;
}

/** Cell types whose operands are numbers, where zero padding means extension or scaling. */
export const ARITHMETIC = new Set([
  '$add',
  '$sub',
  '$mul',
  '$lt',
  '$le',
  '$gt',
  '$ge',
  '$eq',
  '$ne',
  '$eqx',
  '$nex',
]);
