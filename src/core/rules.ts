/**
 * Semantic transforms: rewrite the structure Yosys produces into the shapes
 * designers draw by hand. They always apply (there is no switch to draw the
 * structure as Yosys gives it): a left shift of the constant 1 is a decoder, a
 * MUX that selects a constant 0 is an AND gate, and (while building edges, see
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
