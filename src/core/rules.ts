/**
 * Semantic transforms: rewrite the structure Yosys produces into the shapes
 * designers draw by hand. Each rule matches cells in one module and replaces
 * them with a `dc:*` cell that keeps the original stable ID and source location,
 * so code highlighting and saved positions still work.
 *
 * Rules run on a copy of the module; the IR itself is never modified.
 */
import type { Bit, IRCell, IRModule } from './ir';

export type RuleId = 'decoder' | 'mux-to-and' | 'zero-extend' | 'scale';

export interface RuleInfo {
  id: RuleId;
  title: string;
  description: string;
}

export const RULES: RuleInfo[] = [
  { id: 'decoder', title: '1 << x → Decoder', description: 'A left shift of the constant 1 is drawn as a decoder.' },
  {
    id: 'mux-to-and',
    title: 'MUX with 0 → AND',
    description: 'A MUX that selects a constant 0 on one input is drawn as an AND gate (with a bubble when inverted).',
  },
  {
    id: 'zero-extend',
    title: 'Hide zero extension',
    description: 'High-order zero padding such as {2\'b00, x} is drawn as a plain wire.',
  },
  { id: 'scale', title: '{x, 2\'b00} → ×4', description: 'Low-order zero padding into arithmetic is labelled ×2ⁿ.' },
];

export const DEFAULT_RULES: ReadonlySet<RuleId> = new Set(RULES.map((r) => r.id));

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

/** Apply cell-level rules. Wiring rules (zero-extend, scale) are applied while building edges. */
export function applyRules(m: IRModule, enabled: ReadonlySet<RuleId>): IRModule {
  if (!enabled.has('decoder') && !enabled.has('mux-to-and')) return m;
  const used = usedBits(m);
  const cells = m.cells.map((c) => {
    if (c.isInstance) return c;
    if (enabled.has('decoder')) {
      const r = rewriteDecoder(c, used);
      if (r) return r;
    }
    if (enabled.has('mux-to-and')) {
      const r = rewriteMuxToAnd(c);
      if (r) return r;
    }
    return c;
  });
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
