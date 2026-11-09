/**
 * Automatic functional partitioning of a module into blocks.
 *
 * A flat module (no sub-module instances, or lots of glue logic next to them)
 * still gets a block diagram: its primitive cells are grouped into functional
 * blocks, and each block becomes a synthetic IR module that can be opened like
 * a real sub-module. Nothing here knows about any particular design; the
 * grouping uses only generic signals of intent:
 *
 *  1. Signal cones: every cell is attached to the named signal it computes
 *     (anonymous intermediate cells belong to the named signal they feed).
 *  2. Parallel siblings: `x_a`/`x_b`, `x1`/`x2`, `a_valid_0`/`a_valid_1`
 *     are the same function for different channels and share a block.
 *  3. Source paragraphs: statements the designer wrote together (no blank
 *     line between them, or inside one begin…end) and that are connected.
 *  4. Private producers: a group whose results are used by exactly one other
 *     group (and by no module output) is an internal step of that group.
 *  5. A cap on the number of blocks: the smallest blocks are merged into the
 *     neighbour they exchange the most bits with.
 *
 * Block names come from a `//` comment written just above the block's first
 * statement when there is one, otherwise from its main output signal.
 * Cells keep their stable IDs inside the block, so saved positions keep
 * working; the block's own ID comes from its name.
 */
import type { Bit, IRCell, IRDesign, IRModule, IRNet, IRPort, SrcRange } from './ir';
import { inputPortBits, sliceLabel } from './ir';

export interface PartitionOptions {
  /** Modules with fewer primitive cells are left as they are. */
  minCells?: number;
  /** Upper limit for the number of auto blocks in one module. */
  maxBlocks?: number;
  /** A merge may not create a block holding more than this share of the cells. */
  maxShare?: number;
}

const DEFAULTS: Required<PartitionOptions> = { minCells: 8, maxBlocks: 9, maxShare: 0.6 };

export interface AutoBlock {
  /** Block name shown on the diagram. */
  label: string;
  /** Stable IDs of the cells inside the block. */
  cellIds: string[];
}

// ---------------------------------------------------------------------------
// Source paragraphs

const BLOCK_OPEN = /\b(begin|case|casex|casez|fork|function|task|generate)\b/g;
const BLOCK_CLOSE = /\b(end|endcase|join|join_any|join_none|endfunction|endtask|endgenerate)\b/g;

/**
 * Paragraph number for every line (index 0 = line 1). A blank line starts a
 * new paragraph, except inside begin…end and similar blocks. always/initial
 * blocks are paragraphs of their own (an `else` on the next line still
 * belongs to them). Each branch of `ifdef/`else starts from the state before
 * the `ifdef, and the state after `endif is the first branch's, so alternative
 * headers such as two `always … begin` lines do not unbalance the count.
 * Which branch is active is unknown here, so every branch gets paragraphs.
 */
export function paragraphs(text: string): number[] {
  const lines = text.split('\n');
  const out: number[] = [];
  let para = 0;
  let depth = 0;
  let inComment = false;
  let blankRun = false;
  /** Inside a procedural block that has not reached depth > 0 yet or is still open. */
  let inProc = false;
  /** A procedural block just ended: the next code line starts a paragraph, unless it is its `else`. */
  let afterProc = false;
  /** Open preprocessor conditionals: the state at the `ifdef, and at the end of the first branch. */
  interface Cond {
    start: { depth: number; inProc: boolean; afterProc: boolean; para: number };
    first?: { depth: number; inProc: boolean; afterProc: boolean };
    maxPara: number;
  }
  const conds: Cond[] = [];
  for (const raw of lines) {
    // Strip comments (block comments may span lines) and strings (with \" escapes).
    let code = '';
    let i = 0;
    while (i < raw.length) {
      if (inComment) {
        const e = raw.indexOf('*/', i);
        if (e < 0) {
          i = raw.length;
        } else {
          inComment = false;
          i = e + 2;
        }
      } else if (raw.startsWith('//', i)) {
        break;
      } else if (raw.startsWith('/*', i)) {
        inComment = true;
        i += 2;
      } else if (raw[i] === '"') {
        i++;
        while (i < raw.length && raw[i] !== '"') i += raw[i] === '\\' ? 2 : 1;
        i++;
      } else {
        code += raw[i++];
      }
    }
    const trimmed = code.trim();
    const directive = /^`(ifdef|ifndef|elsif|else|endif)\b/.exec(trimmed);
    if (directive) {
      out.push(para);
      const d = directive[1];
      const top = conds[conds.length - 1];
      if (d === 'ifdef' || d === 'ifndef') {
        conds.push({ start: { depth, inProc, afterProc, para }, maxPara: para });
      } else if (top && d === 'endif') {
        conds.pop();
        if (top.first) ({ depth, inProc, afterProc } = top.first);
        // Lines after the conditional must not share a paragraph number with a longer branch.
        para = Math.max(top.maxPara, para);
      } else if (top) {
        top.first ??= { depth, inProc, afterProc };
        top.maxPara = Math.max(top.maxPara, para);
        ({ depth, inProc, afterProc, para } = top.start);
      }
      continue;
    }
    if (/^(module|macromodule|endmodule)\b/.test(trimmed)) {
      depth = 0;
      inProc = false;
    }
    if (raw.trim() === '') {
      if (depth <= 0 && !blankRun) para++;
      blankRun = true;
    } else if (trimmed !== '') {
      const continues = afterProc && depth <= 0 && /^else\b/.test(trimmed);
      if (continues) {
        inProc = true;
      } else if (depth <= 0 && (afterProc || /^(always\w*|initial)\b/.test(trimmed)) && !blankRun && out.length > 0) {
        para++;
      }
      afterProc = false;
      blankRun = false;
    }
    out.push(para);
    if (trimmed === '') continue;
    const before = depth;
    depth += (code.match(BLOCK_OPEN) ?? []).length - (code.match(BLOCK_CLOSE) ?? []).length;
    if (depth < 0) depth = 0;
    const ends = /;\s*$/.test(trimmed);
    if (before === 0 && /^(always\w*|initial)\b/.test(trimmed)) {
      if (depth === 0 && ends) afterProc = true;
      else inProc = true;
    } else if (inProc && depth === 0 && (before > 0 || ends)) {
      inProc = false;
      afterProc = true;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Names

/**
 * Keys under which `name` is a parallel copy of another signal: one token is
 * replaced by a wildcard when it looks like a channel index (a single letter,
 * a number, or a word ending in a number or a capital letter), or one `[n]`
 * index is replaced (array elements, generate-loop copies).
 */
export function siblingKeys(name: string): string[] {
  const keys: string[] = [];
  // Array elements and generate-loop copies: `acc[3]`, `lane[2].sum`.
  for (const m of name.matchAll(/\[\d+\]/g)) {
    keys.push(`${name.slice(0, m.index)}[#]${name.slice(m.index! + m[0].length)}`);
  }
  const tokens = name.split('_');
  tokens.forEach((t, i) => {
    let pattern: string | undefined;
    if (/^[A-Za-z]$/.test(t)) pattern = '#L';
    else if (/^\d+$/.test(t)) pattern = '#D';
    else if (/^[A-Za-z]+\d+$/.test(t)) pattern = `${t.replace(/\d+$/, '')}#D`;
    else if (/^[a-z][a-z0-9]*[A-Z]$/.test(t)) pattern = `${t.slice(0, -1)}#U`;
    if (!pattern) return;
    if (tokens.length === 1 && pattern.startsWith('#')) return; // `a` vs `b` alone means nothing
    keys.push([...tokens.slice(0, i), pattern, ...tokens.slice(i + 1)].join('_'));
  });
  return keys;
}

/** Common name for a set of sibling signals: `score_a`, `score_b` -> `score`. */
function stemName(names: string[]): string {
  if (names.length < 2) return names[0] ?? '';
  // `lane[0].sum`, `lane[1].sum` -> `lane[].sum`; `acc[0]`, `acc[1]` -> `acc`.
  if (names.some((n) => /\[\d+\]/.test(n))) {
    const generic = names.map((n) => n.replace(/\[\d+\]$/, '').replace(/\[\d+\]/g, '[]'));
    if (generic.every((g) => g === generic[0])) return generic[0];
  }
  const split = names.map((n) => n.split('_'));
  const len = split[0].length;
  if (split.every((s) => s.length === len)) {
    const keep: string[] = [];
    for (let i = 0; i < len; i++) {
      const t = split[0][i];
      if (split.every((s) => s[i] === t)) keep.push(t);
      else {
        const base = t.replace(/(\d+|[A-Z])$/, '');
        if (base && split.every((s) => s[i].replace(/(\d+|[A-Z])$/, '') === base)) keep.push(base);
      }
    }
    if (keep.length) return keep.join('_');
  }
  return names[0];
}

/** Strongly connected components of `nodes` (edges from `next`), as a component index per node. */
function components(nodes: number[], next: (x: number) => readonly number[]): Map<number, number> {
  const comp = new Map<number, number>();
  const index = new Map<number, number>();
  const low = new Map<number, number>();
  const stack: number[] = [];
  const onStack = new Set<number>();
  let counter = 0;
  let n = 0;
  const open = (x: number) => {
    index.set(x, counter);
    low.set(x, counter++);
    stack.push(x);
    onStack.add(x);
  };
  for (const root of nodes) {
    if (index.has(root)) continue;
    open(root);
    const work: [number, number][] = [[root, 0]];
    while (work.length) {
      const top = work[work.length - 1];
      const x = top[0];
      const out = next(x);
      if (top[1] < out.length) {
        const y = out[top[1]++];
        if (!index.has(y)) {
          open(y);
          work.push([y, 0]);
        } else if (onStack.has(y)) {
          low.set(x, Math.min(low.get(x)!, index.get(y)!));
        }
        continue;
      }
      work.pop();
      if (work.length) {
        const p = work[work.length - 1][0];
        low.set(p, Math.min(low.get(p)!, low.get(x)!));
      }
      if (low.get(x) === index.get(x)) {
        let y: number;
        do {
          y = stack.pop()!;
          onStack.delete(y);
          comp.set(y, n);
        } while (y !== x);
        n++;
      }
    }
  }
  return comp;
}

/**
 * Size of the upstream cone (inside `units`) of each candidate that is not
 * itself upstream of another candidate. A candidate upstream of another has a
 * strictly smaller cone, so it can never be the largest and is left out; this
 * keeps a long chain of exported stages linear instead of quadratic.
 */
function coneSizes(
  units: number[],
  candidates: number[],
  producersOf: Map<number, number[]>,
  size: (u: number) => number,
): Map<number, number> {
  const prod = (x: number) => producersOf.get(x) ?? [];
  const comp = components(units, prod);
  const candidateComps = new Set(candidates.map((u) => comp.get(u)));
  // Everything strictly upstream of a candidate's component.
  const upstream = new Set<number>();
  const stack: number[] = [];
  for (const x of units) {
    if (!candidateComps.has(comp.get(x))) continue;
    for (const y of prod(x)) {
      if (comp.get(y) === comp.get(x) || upstream.has(y)) continue;
      upstream.add(y);
      stack.push(y);
    }
  }
  while (stack.length) {
    for (const y of prod(stack.pop()!)) {
      if (upstream.has(y)) continue;
      upstream.add(y);
      stack.push(y);
    }
  }
  const byComp = new Map<number, number>();
  const sizes = new Map<number, number>();
  for (const u of candidates) {
    if (upstream.has(u)) continue;
    let n = byComp.get(comp.get(u)!);
    if (n === undefined) {
      const seen = new Set<number>([u]);
      const todo = [u];
      n = 0;
      while (todo.length) {
        const x = todo.pop()!;
        n += size(x);
        for (const y of prod(x)) {
          if (seen.has(y)) continue;
          seen.add(y);
          todo.push(y);
        }
      }
      byComp.set(comp.get(u)!, n);
    }
    sizes.set(u, n);
  }
  return sizes;
}

// ---------------------------------------------------------------------------
// Union-find

class DSU {
  parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]];
      i = this.parent[i];
    }
    return i;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
}

// ---------------------------------------------------------------------------
// Partitioning

const isOutput = (c: IRCell, port: string) => c.directions[port] === 'output';

function inputBits(c: IRCell): number[] {
  const out: number[] = [];
  for (const [p, bits] of Object.entries(c.connections)) {
    if (isOutput(c, p)) continue;
    for (const b of bits) if (typeof b === 'number') out.push(b);
  }
  return out;
}

function outputBits(c: IRCell): number[] {
  const out: number[] = [];
  for (const [p, bits] of Object.entries(c.connections)) {
    if (!isOutput(c, p)) continue;
    for (const b of bits) if (typeof b === 'number') out.push(b);
  }
  return out;
}

/** Group the primitive cells of a module into functional blocks, or undefined when it is not worth it. */
export function partitionModule(
  m: IRModule,
  sources: Record<string, string> = {},
  options: PartitionOptions = {},
): AutoBlock[] | undefined {
  const opt = { ...DEFAULTS, ...options };
  const prims = m.cells.filter((c) => !c.isInstance);
  if (prims.length < opt.minCells) return undefined;

  const index = new Map<IRCell, number>(prims.map((c, i) => [c, i]));
  const driver = new Map<number, number>();
  prims.forEach((c, i) => {
    for (const b of outputBits(c)) if (!driver.has(b)) driver.set(b, i);
  });
  /** Consumers per bit: primitive cell index, or -1 for anything outside (outputs, instances). */
  const consumers = new Map<number, Set<number>>();
  const addUse = (b: number, who: number) => {
    let s = consumers.get(b);
    if (!s) consumers.set(b, (s = new Set()));
    s.add(who);
  };
  for (const c of m.cells) {
    const who = index.get(c) ?? -1;
    for (const b of inputBits(c)) addUse(b, who);
  }
  for (const p of m.ports) if (p.direction !== 'input') for (const b of p.bits) if (typeof b === 'number') addUse(b, -1);

  const publicNets = m.nets.filter((n) => !n.hidden);
  const portNames = new Set(m.ports.map((p) => p.name));
  const netsOfBit = new Map<number, IRNet[]>();
  for (const n of publicNets) {
    for (const b of n.bits) {
      if (typeof b !== 'number') continue;
      const l = netsOfBit.get(b);
      if (l) l.push(n);
      else netsOfBit.set(b, [n]);
    }
  }

  // 1. Signal cones. A cell whose outputs are anonymous and feed exactly one
  //    other primitive cell belongs to that cell's cone.
  const next: number[] = prims.map((c) => {
    const outs = outputBits(c);
    if (outs.some((b) => netsOfBit.has(b))) return -1;
    const users = new Set<number>();
    for (const b of outs) for (const u of consumers.get(b) ?? []) users.add(u);
    if (users.size !== 1) return -1;
    const [u] = users;
    return u;
  });
  const rootOf = (i: number): number => {
    const seen = new Set<number>();
    while (next[i] >= 0 && !seen.has(i)) {
      seen.add(i);
      i = next[i];
    }
    return i;
  };
  /** Name of the signal a root cell computes: the public net covering most of its outputs. */
  const signalName = (c: IRCell): string | undefined => {
    const count = new Map<IRNet, number>();
    for (const b of outputBits(c)) for (const n of netsOfBit.get(b) ?? []) count.set(n, (count.get(n) ?? 0) + 1);
    let best: IRNet | undefined;
    let bestN = 0;
    for (const [n, k] of count) {
      const better =
        k > bestN ||
        (k === bestN && best && portNames.has(best.name) && !portNames.has(n.name)) ||
        (k === bestN && best && portNames.has(best.name) === portNames.has(n.name) && n.bits.length < best.bits.length);
      if (better) {
        best = n;
        bestN = k;
      }
    }
    return best?.name;
  };

  // Units: all cones computing the same named signal (e.g. the bits of one vector).
  const unitOfCell: number[] = new Array(prims.length).fill(-1);
  const unitNames: (string | undefined)[] = [];
  const unitByName = new Map<string, number>();
  prims.forEach((_, i) => {
    const r = rootOf(i);
    if (unitOfCell[r] < 0) {
      const name = signalName(prims[r]);
      let u = name !== undefined ? unitByName.get(name) : undefined;
      if (u === undefined) {
        u = unitNames.length;
        unitNames.push(name);
        if (name !== undefined) unitByName.set(name, u);
      }
      unitOfCell[r] = u;
    }
    unitOfCell[i] = unitOfCell[r];
  });
  const nUnits = unitNames.length;
  if (nUnits < 2) return undefined;

  // Unit graph: which units read bits another unit computes.
  const unitCells: number[][] = Array.from({ length: nUnits }, () => []);
  prims.forEach((_, i) => unitCells[unitOfCell[i]].push(i));

  // Paragraphs of each unit (from the first source range of each cell).
  const paraCache = new Map<string, number[]>();
  const paraOf = (r: SrcRange | undefined): number | undefined => {
    if (!r) return undefined;
    const text = sources[r.file] ?? Object.entries(sources).find(([k]) => r.file.endsWith('/' + k) || k.endsWith('/' + r.file))?.[1];
    if (text === undefined) return undefined;
    let p = paraCache.get(r.file);
    if (!p) paraCache.set(r.file, (p = paragraphs(text)));
    return p[r.startLine - 1];
  };
  const fileIndex = new Map<string, number>();
  const unitParas: Set<number>[] = Array.from({ length: nUnits }, () => new Set());
  const unitLine: number[] = new Array(nUnits).fill(Infinity);
  const allParas = new Set<number>();
  for (let u = 0; u < nUnits; u++) {
    for (const i of unitCells[u]) {
      const r = prims[i].src[0];
      if (r) unitLine[u] = Math.min(unitLine[u], r.startLine);
      const p = paraOf(r);
      if (p === undefined) continue;
      if (!fileIndex.has(r!.file)) fileIndex.set(r!.file, fileIndex.size);
      // Paragraph numbers are only comparable within one file.
      const key = p + 1e6 * fileIndex.get(r!.file)!;
      unitParas[u].add(key);
      allParas.add(key);
    }
  }
  const hasParagraphs = allParas.size >= 3;

  const dsu = new DSU(nUnits);
  const size = (u: number) => groupSize.get(dsu.find(u)) ?? 0;
  const groupSize = new Map<number, number>();
  for (let u = 0; u < nUnits; u++) groupSize.set(u, unitCells[u].length);
  const cap = Math.max(opt.minCells * 2, Math.floor(prims.length * opt.maxShare));
  const join = (a: number, b: number, force = false): boolean => {
    const ra = dsu.find(a);
    const rb = dsu.find(b);
    if (ra === rb) return false;
    const s = size(ra) + size(rb);
    if (!force && s > cap) return false;
    const paras = new Set([...(parasOfGroup.get(ra) ?? []), ...(parasOfGroup.get(rb) ?? [])]);
    dsu.union(ra, rb);
    groupSize.set(dsu.find(ra), s);
    parasOfGroup.set(dsu.find(ra), paras);
    return true;
  };
  /** Paragraphs of each group, kept up to date by join(). */
  const parasOfGroup = new Map<number, Set<number>>(unitParas.map((p, u) => [u, new Set(p)]));
  const groupParas = (root: number): Set<number> => parasOfGroup.get(dsu.find(root)) ?? new Set();
  const paraDistance = (a: Set<number>, b: Set<number>): number => {
    let d = Infinity;
    for (const x of a) for (const y of b) d = Math.min(d, Math.abs(x - y));
    return d;
  };

  // Directed unit edges (producer -> consumer) with bit counts; -1 = outside world.
  const unitEdges = new Map<number, Map<number, number>>();
  for (let u = 0; u < nUnits; u++) unitEdges.set(u, new Map());
  prims.forEach((c, i) => {
    const u = unitOfCell[i];
    for (const b of outputBits(c)) {
      for (const who of consumers.get(b) ?? []) {
        const v = who < 0 ? -1 : unitOfCell[who];
        if (v === u) continue;
        const e = unitEdges.get(u)!;
        e.set(v, (e.get(v) ?? 0) + 1);
      }
    }
  });

  // 2. Parallel siblings (only when written close to each other).
  const byKey = new Map<string, number[]>();
  unitNames.forEach((n, u) => {
    if (n === undefined) return;
    for (const k of siblingKeys(n)) {
      const l = byKey.get(k);
      if (l) l.push(u);
      else byKey.set(k, [u]);
    }
  });
  for (const list of byKey.values()) {
    if (list.length < 2) continue;
    for (let k = 1; k < list.length; k++) {
      // Distance to the group so far, so a long run of copies chains together.
      const near =
        !hasParagraphs || paraDistance(groupParas(list[0]), unitParas[list[k]]) <= 1 || unitParas[list[k]].size === 0;
      if (near) join(list[0], list[k]);
    }
  }

  // Anonymous units (shared intermediate results) go with their consumers when those agree.
  for (let u = 0; u < nUnits; u++) {
    if (unitNames[u] !== undefined) continue;
    const targets = new Set<number>();
    for (const v of unitEdges.get(u)!.keys()) targets.add(v < 0 ? -1 : dsu.find(v));
    if (targets.size === 1 && !targets.has(-1)) join(u, [...targets][0]);
  }

  // 3. Connected statements in the same source paragraph, when one side is
  //    private to the other: the consumer reads nothing but this group (and
  //    module inputs), or the producer feeds nothing but that consumer.
  //    A statement that combines results of several groups is a decision
  //    point and stays a boundary.
  if (hasParagraphs) {
    const producers: Set<number>[] = Array.from({ length: nUnits }, () => new Set());
    for (let u = 0; u < nUnits; u++) for (const v of unitEdges.get(u)!.keys()) if (v >= 0) producers[v].add(u);
    let changed = true;
    while (changed) {
      changed = false;
      for (let u = 0; u < nUnits; u++) {
        for (const v of unitEdges.get(u)!.keys()) {
          if (v < 0 || dsu.find(u) === dsu.find(v)) continue;
          if (![...unitParas[u]].some((p) => unitParas[v].has(p))) continue;
          const gu = dsu.find(u);
          const gv = dsu.find(v);
          const consumerPrivate = [...producers[v]].every((x) => dsu.find(x) === gu);
          const producerPrivate = [...unitEdges.get(u)!.keys()].every((x) => x >= 0 && dsu.find(x) === gv);
          if ((consumerPrivate || producerPrivate) && join(u, v)) changed = true;
        }
      }
    }
  }

  // Group-level graph helpers.
  const groupConsumers = (): Map<number, Map<number, number>> => {
    const g = new Map<number, Map<number, number>>();
    for (let u = 0; u < nUnits; u++) {
      const ru = dsu.find(u);
      if (!g.has(ru)) g.set(ru, new Map());
      for (const [v, k] of unitEdges.get(u)!) {
        const rv = v < 0 ? -1 : dsu.find(v);
        if (rv === ru) continue;
        const e = g.get(ru)!;
        e.set(rv, (e.get(rv) ?? 0) + k);
      }
    }
    return g;
  };

  // 4. Private producers: one simultaneous pass, so a chain of private steps
  //    joins its consumer but a shared result stays a block boundary.
  {
    const g = groupConsumers();
    const pairs: [number, number][] = [];
    for (const [ru, outs] of g) {
      if (outs.size !== 1) continue;
      const [rv] = outs.keys();
      if (rv < 0) continue;
      if (hasParagraphs && paraDistance(groupParas(ru), groupParas(rv)) > 2) continue;
      pairs.push([ru, rv]);
    }
    for (const [a, b] of pairs) join(a, b);
  }

  /** Undirected neighbour weights between current groups. */
  const neighbours = (g: Map<number, Map<number, number>>): Map<number, Map<number, number>> => {
    const nb = new Map<number, Map<number, number>>();
    const add = (x: number, y: number, k: number) => {
      let m2 = nb.get(x);
      if (!m2) nb.set(x, (m2 = new Map()));
      m2.set(y, (m2.get(y) ?? 0) + k);
    };
    for (const [r, outs] of g) {
      for (const [v, k] of outs) {
        if (v < 0) continue;
        add(r, v, k);
        add(v, r, k);
      }
    }
    return nb;
  };

  // 5. Tiny groups (a couple of cells) join a connected neighbour written in the same place.
  //    Several merges per round; a group touched this round waits for the next one.
  if (hasParagraphs) {
    const tiny = (r: number) => size(r) <= 3 || size(r) < 0.04 * prims.length;
    let changed = true;
    while (changed) {
      changed = false;
      const g = groupConsumers();
      const nb = neighbours(g);
      const touched = new Set<number>();
      const rs = [...g.keys()].sort((x, y) => size(x) - size(y) || x - y);
      for (const r of rs) {
        if (touched.has(r) || !tiny(r)) continue;
        const pr = groupParas(r);
        const best = [...(nb.get(r) ?? [])]
          .filter(([v]) => !touched.has(v) && paraDistance(pr, groupParas(v)) === 0)
          .sort((x, y) => y[1] - x[1] || x[0] - y[0])[0];
        if (best && join(r, best[0])) {
          touched.add(r);
          touched.add(best[0]);
          changed = true;
        }
      }
    }
  }

  // 6. Too many blocks: merge the smallest ones into their closest neighbour. Groups that
  //    exchange no signals (independent output cones) go with the group that reads the
  //    most of the same module inputs, or else the one written nearest.
  const inputBitSet = inputPortBits(m);
  const unitInputs: Set<number>[] = Array.from({ length: nUnits }, () => new Set());
  prims.forEach((c, i) => {
    for (const b of inputBits(c)) if (inputBitSet.has(b)) unitInputs[unitOfCell[i]].add(b);
  });
  const roots = () => [...new Set(Array.from({ length: nUnits }, (_, u) => dsu.find(u)))];
  let count = roots().length;
  while (count > opt.maxBlocks) {
    const g = groupConsumers();
    const nb = neighbours(g);
    const rs = [...g.keys()].sort((x, y) => size(x) - size(y) || x - y);
    const reads = new Map<number, Set<number>>();
    const firstLine = new Map<number, number>();
    for (let u = 0; u < nUnits; u++) {
      const r = dsu.find(u);
      let set = reads.get(r);
      if (!set) reads.set(r, (set = new Set()));
      for (const b of unitInputs[u]) set.add(b);
      firstLine.set(r, Math.min(firstLine.get(r) ?? Infinity, unitLine[u]));
    }
    const touched = new Set<number>();
    let merged = false;
    for (const r of rs) {
      if (count <= opt.maxBlocks) break;
      if (touched.has(r)) continue;
      let target = [...(nb.get(r) ?? [])]
        .filter(([v]) => !touched.has(v))
        .sort((x, y) => y[1] - x[1] || size(x[0]) - size(y[0]) || x[0] - y[0])[0]?.[0];
      if (target === undefined) {
        const mine = reads.get(r)!;
        const lr = firstLine.get(r)!;
        let bestShared = -1;
        let bestDist = Infinity;
        for (const o of rs) {
          if (o === r || touched.has(o)) continue;
          let shared = 0;
          for (const b of reads.get(o)!) if (mine.has(b)) shared++;
          const dist = Math.abs((firstLine.get(o) ?? 0) - lr);
          const dd = Number.isFinite(dist) ? dist : 1e9;
          if (shared > bestShared || (shared === bestShared && dd < bestDist)) {
            bestShared = shared;
            bestDist = dd;
            target = o;
          }
        }
      }
      if (target !== undefined && join(r, target, true)) {
        touched.add(r);
        touched.add(target);
        count--;
        merged = true;
      }
    }
    if (!merged) break;
  }

  // Bucket units by group.
  const byRoot = new Map<number, number[]>();
  for (let u = 0; u < nUnits; u++) {
    const r = dsu.find(u);
    const l = byRoot.get(r);
    if (l) l.push(u);
    else byRoot.set(r, [u]);
  }
  // One block, or blocks of one or two cells on average, draw worse than the plain circuit.
  if (byRoot.size < 2 || byRoot.size > prims.length / 2) return undefined;

  // Build blocks in source order.
  const groups = [...byRoot.values()].map((units) => {
    const cells = units.flatMap((u) => unitCells[u]).sort((x, y) => x - y);
    const line = Math.min(...units.map((u) => unitLine[u]));
    return { units, cells, line };
  });
  groups.sort((x, y) => x.line - y.line || x.cells[0] - y.cells[0]);

  // Names.
  const used = new Set<string>(m.cells.filter((c) => c.isInstance).map((c) => c.name));
  const PRAGMA =
    /^(?:verilator|synopsys|synthesis|pragma|spyglass|cadence|ambit)\b|^coverage\s+(?:on|off)\b|\b(?:lint_off|lint_on|translate_off|translate_on|full_case|parallel_case)\b/;
  /** A `//` comment written just above `line` (banners and pragmas skipped), with the line it is on. */
  const commentAbove = (line: number): { text: string; at: number } | undefined => {
    if (!Number.isFinite(line)) return undefined;
    const file = prims.find((c) => c.src[0]?.startLine === line)?.src[0]?.file;
    const text = file ? (sources[file] ?? Object.entries(sources).find(([k]) => file.endsWith('/' + k))?.[1]) : undefined;
    if (!text) return undefined;
    const lines = text.split('\n');
    for (let l = line - 2; l >= 0 && l >= line - 8; l--) {
      const t = lines[l].trim();
      const c = /^\/\/+(.*)$/.exec(t);
      if (!c) return undefined; // blank line or code: no heading
      const words = c[1].replace(/^[-=*#~\s]+|[-=*#~\s]+$/g, '');
      if (words === '') continue; // a banner rule
      if (PRAGMA.test(words) || /[;{}]|<=|\bassign\b/.test(words)) continue; // pragma or commented-out code
      return { text: words.slice(0, 40), at: l };
    }
    return undefined;
  };
  const comments = groups.map((g) => commentAbove(g.line));
  const claims = new Map<number, number>();
  for (const c of comments) if (c) claims.set(c.at, (claims.get(c.at) ?? 0) + 1);
  return groups.map((g, gi) => {
    const inGroup = new Set(g.units);
    // Signals the block hands to the outside.
    const exported = g.units.filter(
      (u) => unitNames[u] !== undefined && [...unitEdges.get(u)!.keys()].some((v) => v < 0 || !inGroup.has(v)),
    );
    const pickFrom = exported.length ? exported : g.units.filter((u) => unitNames[u] !== undefined);
    // Main signal: the exported one with the largest upstream cone inside the block.
    const producersIn = new Map<number, number[]>();
    for (const y of g.units) {
      for (const v of unitEdges.get(y)!.keys()) {
        if (!inGroup.has(v)) continue;
        const l = producersIn.get(v);
        if (l) l.push(y);
        else producersIn.set(v, [y]);
      }
    }
    const cone = coneSizes(g.units, pickFrom, producersIn, (u) => unitCells[u].length);
    const ranked = pickFrom
      .map((u) => ({ u, w: cone.get(u) ?? -1 }))
      .sort((x, y) => y.w - x.w || unitLine[x.u] - unitLine[y.u]);
    const main = ranked[0]?.u;
    const candidates: string[] = [];
    // A comment names a block only when no other block starts under it.
    const comment = comments[gi];
    if (comment && claims.get(comment.at) === 1) candidates.push(comment.text);
    if (main !== undefined) {
      const mainName = unitNames[main]!;
      const keys = new Set(siblingKeys(mainName));
      const sibs = ranked
        .map((r) => unitNames[r.u]!)
        .filter((n) => n === mainName || siblingKeys(n).some((k) => keys.has(k)));
      candidates.push(stemName(sibs), mainName);
    }
    candidates.push('logic');
    let label = candidates.find((c) => c && !used.has(c));
    if (!label) {
      const base = candidates.find(Boolean)!;
      label = base;
      for (let k = 2; used.has(label); k++) label = `${base}_${k}`;
    }
    used.add(label);
    return { label, cellIds: g.cells.map((i) => prims[i].id) };
  });
}

// ---------------------------------------------------------------------------
// Synthetic modules

/**
 * Choose public nets that cover `bits`: the net covering the most of them
 * first, then the narrower net (so a block that reads `lo` is not given the
 * wider output port `z = {hi, lo}`), then a module port name.
 */
function coverBits(
  bits: number[],
  netsOfBit: Map<number, IRNet[]>,
  portNames: Set<string>,
): { net?: IRNet; bits: number[] }[] {
  const remaining = new Set(bits);
  const out: { net?: IRNet; bits: number[] }[] = [];
  while (remaining.size) {
    const score = new Map<IRNet, number>();
    for (const b of remaining) for (const n of netsOfBit.get(b) ?? []) score.set(n, (score.get(n) ?? 0) + 1);
    let best: IRNet | undefined;
    let bestS = 0;
    for (const [n, s] of score) {
      const better =
        s > bestS ||
        (s === bestS && best && n.bits.length < best.bits.length) ||
        (s === bestS && best && n.bits.length === best.bits.length && !portNames.has(best.name) && portNames.has(n.name));
      if (better) {
        best = n;
        bestS = s;
      }
    }
    if (!best) {
      out.push({ bits: [...remaining].sort((a, b) => a - b) });
      break;
    }
    const covered = best.bits.filter((b): b is number => typeof b === 'number' && remaining.has(b));
    for (const b of covered) remaining.delete(b);
    out.push({ net: best, bits: covered });
  }
  return out;
}

function portLabel(net: IRNet | undefined, bits: number[], fallback: string): string {
  if (!net) return fallback;
  if (bits.length === net.bits.length) return net.name;
  const idx = bits.map((b) => net.bits.indexOf(b)).sort((a, b) => a - b);
  const contiguous = idx.every((v, i) => i === 0 || v === idx[i - 1] + 1);
  return contiguous ? sliceLabel(net, idx[0], idx[idx.length - 1]) : `${net.name}_part`;
}

function mergeSrc(cells: IRCell[]): SrcRange[] {
  const seen = new Set<string>();
  const out: SrcRange[] = [];
  for (const c of cells) {
    for (const r of c.src) {
      const k = `${r.file}:${r.startLine}.${r.startCol}-${r.endLine}.${r.endCol}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(r);
    }
  }
  return out;
}

const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

/**
 * Three or more parallel copies of a signal (`acc0`, `acc1`, … of the same
 * width) become one bundled port named `acc0…acc39`, so a block does not get
 * a pin per copy. The bits are concatenated in natural name order, which is
 * the same on both ends of the connection, so one bus edge joins them.
 */
export function bundleSiblingPorts(ports: IRPort[], nets: IRNet[]): void {
  const full = (p: IRPort) => nets.some((n) => !n.hidden && n.name === p.name && n.bits.length === p.bits.length);
  for (const dir of ['input', 'output'] as const) {
    const byKey = new Map<string, IRPort[]>();
    for (const p of ports) {
      if (p.direction !== dir || !full(p)) continue;
      for (const k of siblingKeys(p.name)) {
        const key = `${k}:${p.bits.length}`;
        const l = byKey.get(key);
        if (l) l.push(p);
        else byKey.set(key, [p]);
      }
    }
    const done = new Set<IRPort>();
    const groups = [...byKey.values()].filter((l) => l.length >= 3).sort((a, b) => b.length - a.length);
    for (const g of groups) {
      const members = g.filter((p) => !done.has(p)).sort((a, b) => natural(a.name, b.name));
      if (members.length < 3) continue;
      for (const p of members) done.add(p);
      const at = ports.indexOf(members[0]);
      const bundle: IRPort = {
        name:
          members.length <= 4
            ? `{${members.map((p) => p.name).join(',')}}`
            : `${members[0].name}…${members[members.length - 1].name}`,
        direction: dir,
        bits: members.flatMap((p) => p.bits),
        offset: 0,
        upto: false,
      };
      for (const p of members) ports.splice(ports.indexOf(p), 1);
      ports.splice(Math.min(at, ports.length), 0, bundle);
    }
  }
}

export const AUTO_SEPARATOR = '/';

/** Name of the synthetic module for an auto block. */
export function autoModuleName(parent: string, label: string): string {
  return `${parent}${AUTO_SEPARATOR}${label}`;
}

/**
 * Replace the cells of each block by an instance of a new synthetic module.
 * Returns the rewritten parent and the new modules.
 */
export function buildAutoModules(
  m: IRModule,
  blocks: AutoBlock[],
  taken: ReadonlySet<string> = new Set(),
): { parent: IRModule; children: IRModule[] } {
  const byId = new Map(m.cells.map((c) => [c.id, c]));
  const blockOf = new Map<string, number>();
  blocks.forEach((b, i) => b.cellIds.forEach((id) => blockOf.set(id, i)));

  const publicNets = m.nets.filter((n) => !n.hidden);
  const portNames = new Set(m.ports.map((p) => p.name));
  const netsOfBit = new Map<number, IRNet[]>();
  for (const n of publicNets) {
    for (const b of n.bits) {
      if (typeof b !== 'number') continue;
      const l = netsOfBit.get(b);
      if (l) l.push(n);
      else netsOfBit.set(b, [n]);
    }
  }

  // Which block drives each bit, and who reads it.
  const drivenBy = new Map<number, number>();
  const readers = new Map<number, Set<number>>(); // block index, or -1 for outside
  for (const c of m.cells) {
    const blk = blockOf.get(c.id) ?? -1;
    for (const [p, bits] of Object.entries(c.connections)) {
      for (const b of bits) {
        if (typeof b !== 'number') continue;
        if (c.directions[p] === 'output') {
          if (blk >= 0 && !drivenBy.has(b)) drivenBy.set(b, blk);
        } else {
          let s = readers.get(b);
          if (!s) readers.set(b, (s = new Set()));
          s.add(blk);
        }
      }
    }
  }
  for (const p of m.ports) {
    if (p.direction === 'input') continue;
    for (const b of p.bits) {
      if (typeof b !== 'number') continue;
      let s = readers.get(b);
      if (!s) readers.set(b, (s = new Set()));
      s.add(-1);
    }
  }

  // Bits the parent sees driven by something other than an auto block:
  // module inputs and the outputs of cells left in the parent (real instances).
  const outsideDriven = inputPortBits(m);
  for (const c of m.cells) {
    if (blockOf.has(c.id)) continue;
    for (const [p, bits] of Object.entries(c.connections)) {
      if (c.directions[p] !== 'output') continue;
      for (const b of bits) if (typeof b === 'number') outsideDriven.add(b);
    }
  }

  const children: IRModule[] = [];
  const instances: IRCell[] = [];
  const chosen = new Set<string>();
  blocks.forEach((blk, i) => {
    const cells = blk.cellIds.map((id) => byId.get(id)!).filter(Boolean);
    const inBits: number[] = [];
    const outBits: number[] = [];
    const seenIn = new Set<number>();
    const seenOut = new Set<number>();
    for (const c of cells) {
      for (const [p, bits] of Object.entries(c.connections)) {
        for (const b of bits) {
          if (typeof b !== 'number') continue;
          if (c.directions[p] === 'output') {
            const rs = readers.get(b);
            if (rs && [...rs].some((r) => r !== i) && !seenOut.has(b)) {
              seenOut.add(b);
              outBits.push(b);
            }
          } else if (drivenBy.get(b) !== i && !seenIn.has(b)) {
            seenIn.add(b);
            inBits.push(b);
          }
        }
      }
    }
    const ports: IRPort[] = [];
    const names = new Set<string>();
    const uniq = (n: string) => {
      let u = n;
      for (let k = 2; names.has(u); k++) u = `${n}_${k}`;
      names.add(u);
      return u;
    };
    const assignedIn = new Set<number>();
    coverBits(inBits, netsOfBit, portNames).forEach((piece, k) => {
      let bits: Bit[] = piece.bits;
      // Bring the whole bus in when all of it comes from outside the blocks (a module input
      // or a real instance): the block diagram then shows the full bus. A bus computed by
      // another block is not widened, or the extra bits would look undriven (drawn as x) or
      // add edges that do not exist.
      if (
        piece.net &&
        piece.net.bits.every((b) => typeof b === 'number' && outsideDriven.has(b) && !assignedIn.has(b))
      ) {
        bits = piece.net.bits;
      } else if (piece.net) {
        bits = piece.net.bits.filter((b) => typeof b === 'number' && piece.bits.includes(b));
      }
      for (const b of bits) if (typeof b === 'number') assignedIn.add(b);
      const name = uniq(portLabel(piece.net, bits as number[], `in${k}`));
      const offset = piece.net && bits.length === piece.net.bits.length ? piece.net.offset : 0;
      ports.push({ name, direction: 'input', bits, offset, upto: !!piece.net?.upto && bits.length === piece.net.bits.length });
    });
    coverBits(outBits, netsOfBit, portNames).forEach((piece, k) => {
      const bits: Bit[] = piece.net ? piece.net.bits.filter((b) => typeof b === 'number' && piece.bits.includes(b)) : piece.bits;
      const name = uniq(portLabel(piece.net, bits as number[], `out${k}`));
      const full = !!piece.net && bits.length === piece.net.bits.length;
      ports.push({ name, direction: 'output', bits, offset: full ? piece.net!.offset : 0, upto: full && !!piece.net!.upto });
    });

    bundleSiblingPorts(ports, m.nets);
    let name = autoModuleName(m.name, blk.label);
    for (let k = 2; taken.has(name) || chosen.has(name); k++) name = autoModuleName(m.name, `${blk.label}_${k}`);
    chosen.add(name);
    // Port names need a net of the same name.
    // Bundles get a hidden net, so wires inside still carry the member names.
    const extraNets: IRNet[] = ports
      .filter((p) => !m.nets.some((n) => !n.hidden && n.name === p.name))
      .map((p) => ({ name: p.name, hidden: true, bits: p.bits, offset: p.offset, upto: p.upto, src: [] }));
    const src = mergeSrc(cells);
    children.push({
      name,
      displayName: blk.label,
      isTop: false,
      ports,
      cells,
      nets: [...m.nets, ...extraNets],
      src: src.length ? [src[0]] : m.src,
      auto: { parent: m.name },
    });
    const connections: Record<string, Bit[]> = {};
    const directions: Record<string, 'input' | 'output'> = {};
    for (const p of ports) {
      connections[p.name] = p.bits;
      directions[p.name] = p.direction === 'output' ? 'output' : 'input';
    }
    instances.push({
      id: `auto:${blk.label}`,
      name: blk.label,
      hidden: true,
      type: name,
      isInstance: true,
      moduleName: name,
      parameters: {},
      directions,
      connections,
      src,
      attrs: { auto: true },
    });
  });

  // Keep the parent's cell order: each block appears where its first cell was.
  const firstIndex = new Map<number, number>();
  m.cells.forEach((c, k) => {
    const b = blockOf.get(c.id);
    if (b !== undefined && !firstIndex.has(b)) firstIndex.set(b, k);
  });
  const cells: IRCell[] = [];
  m.cells.forEach((c, k) => {
    const b = blockOf.get(c.id);
    if (b === undefined) cells.push(c);
    else if (firstIndex.get(b) === k) cells.push(instances[b]);
  });
  return { parent: { ...m, cells }, children };
}

/**
 * The design as a block diagram: every module that is worth partitioning gets
 * auto blocks (synthetic modules named `parent/label`). Real instances stay.
 */
export function withAutoBlocks(
  design: IRDesign,
  sources: Record<string, string> = {},
  options: PartitionOptions = {},
): IRDesign {
  const modules: Record<string, IRModule> = { ...design.modules };
  for (const m of Object.values(design.modules)) {
    const blocks = partitionModule(m, sources, options);
    if (!blocks) continue;
    const { parent, children } = buildAutoModules(m, blocks, new Set(Object.keys(modules)));
    modules[m.name] = parent;
    for (const c of children) modules[c.name] = c;
  }
  return { ...design, modules };
}
