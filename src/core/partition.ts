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
 * Cells keep their stable IDs inside the block, so saved positions and code
 * highlighting keep working; the block's own ID comes from its name.
 */
import type { Bit, IRCell, IRDesign, IRModule, IRNet, IRPort, SrcRange } from './ir';
import { sliceLabel } from './ir';

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
 * new paragraph, except inside begin…end and similar blocks.
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
  let afterProc = false;
  for (const raw of lines) {
    let line = raw;
    // Strip comments (block comments may span lines) and strings.
    let code = '';
    let i = 0;
    while (i < line.length) {
      if (inComment) {
        const e = line.indexOf('*/', i);
        if (e < 0) {
          i = line.length;
        } else {
          inComment = false;
          i = e + 2;
        }
      } else if (line.startsWith('//', i)) {
        break;
      } else if (line.startsWith('/*', i)) {
        inComment = true;
        i += 2;
      } else if (line[i] === '"') {
        const e = line.indexOf('"', i + 1);
        i = e < 0 ? line.length : e + 1;
      } else {
        code += line[i++];
      }
    }
    line = code;
    const blank = raw.trim() === '';
    const trimmed = line.trim();
    if (blank) {
      if (depth <= 0 && !blankRun) para++;
      blankRun = true;
    } else if (trimmed !== '') {
      // always/initial blocks are statements of their own: they start and end a paragraph.
      if (depth <= 0 && (afterProc || /^(always\w*|initial)\b/.test(trimmed)) && !blankRun && out.length > 0) para++;
      afterProc = false;
      blankRun = false;
    }
    out.push(para);
    const before = depth;
    depth += (line.match(BLOCK_OPEN) ?? []).length - (line.match(BLOCK_CLOSE) ?? []).length;
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
 * a number, or a word ending in a number or a capital letter).
 */
export function siblingKeys(name: string): string[] {
  const tokens = name.split('_');
  const keys: string[] = [];
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

  // 5. Tiny groups (a couple of cells) join a connected neighbour written in the same place.
  if (hasParagraphs) {
    const tiny = (r: number) => size(r) <= 3 || size(r) < 0.04 * prims.length;
    let changed = true;
    while (changed) {
      changed = false;
      const g = groupConsumers();
      const rs = [...g.keys()].sort((a, b) => size(a) - size(b) || a - b);
      for (const r of rs) {
        if (dsu.find(r) !== r || !tiny(r)) continue;
        const pr = groupParas(r);
        const weight = new Map<number, number>();
        for (const [v, k] of g.get(r) ?? []) if (v >= 0) weight.set(v, (weight.get(v) ?? 0) + k);
        for (const [o, outs] of g) if (o !== r && outs.has(r)) weight.set(o, (weight.get(o) ?? 0) + outs.get(r)!);
        const best = [...weight.entries()]
          .map(([v, k]) => ({ v: dsu.find(v), k, d: paraDistance(pr, groupParas(dsu.find(v))) }))
          .filter((x) => x.d === 0)
          .sort((a, b) => b.k - a.k || a.v - b.v)[0];
        if (best && join(r, best.v)) {
          changed = true;
          break;
        }
      }
    }
  }

  // 6. Too many blocks: merge the smallest one into its closest neighbour.
  const roots = () => [...new Set(Array.from({ length: nUnits }, (_, u) => dsu.find(u)))];
  let guard = nUnits;
  while (roots().length > opt.maxBlocks && guard-- > 0) {
    const g = groupConsumers();
    const rs = roots().sort((a, b) => size(a) - size(b) || a - b);
    let merged = false;
    for (const r of rs) {
      const weight = new Map<number, number>();
      for (const [v, k] of g.get(r) ?? []) if (v >= 0) weight.set(v, (weight.get(v) ?? 0) + k);
      for (const [o, outs] of g) if (o !== r && outs.has(r)) weight.set(o, (weight.get(o) ?? 0) + outs.get(r)!);
      const best = [...weight.entries()].sort((a, b) => b[1] - a[1] || size(a[0]) - size(b[0]))[0];
      if (best && join(r, best[0], true)) {
        merged = true;
        break;
      }
    }
    if (!merged) break;
  }

  const finalRoots = roots();
  if (finalRoots.length < 2) return undefined;

  // Build blocks in source order.
  const groups = finalRoots.map((r) => {
    const units = Array.from({ length: nUnits }, (_, u) => u).filter((u) => dsu.find(u) === r);
    const cells = units.flatMap((u) => unitCells[u]).sort((a, b) => a - b);
    const line = Math.min(...units.map((u) => unitLine[u]));
    return { units, cells, line };
  });
  groups.sort((a, b) => a.line - b.line || a.cells[0] - b.cells[0]);

  // Names.
  const used = new Set<string>(m.cells.filter((c) => c.isInstance).map((c) => c.name));
  const commentAbove = (line: number): string | undefined => {
    if (!Number.isFinite(line)) return undefined;
    const file = prims.find((c) => c.src[0]?.startLine === line)?.src[0]?.file;
    const text = file ? (sources[file] ?? Object.entries(sources).find(([k]) => file.endsWith('/' + k))?.[1]) : undefined;
    if (!text) return undefined;
    const lines = text.split('\n');
    for (let l = line - 2; l >= 0; l--) {
      const t = lines[l].trim();
      if (t === '') return undefined;
      const c = /^\/\/+\s*(.+?)\s*$/.exec(t);
      if (c) return c[1].replace(/[-=*#]+$/, '').trim().slice(0, 40) || undefined;
      return undefined;
    }
    return undefined;
  };
  return groups.map((g) => {
    // Signals the block hands to the outside, with the size of their cone.
    const exported = new Map<number, number>();
    for (const u of g.units) {
      const outsideUse = [...unitEdges.get(u)!.keys()].some((v) => v < 0 || dsu.find(v) !== dsu.find(g.units[0]));
      if (outsideUse && unitNames[u] !== undefined) exported.set(u, unitCells[u].length);
    }
    const pickFrom = exported.size ? [...exported.keys()] : g.units.filter((u) => unitNames[u] !== undefined);
    // Main signal: the exported one with the largest upstream cone inside the block.
    const upstream = (u: number): number => {
      const seen = new Set<number>([u]);
      const stack = [u];
      while (stack.length) {
        const x = stack.pop()!;
        for (const y of g.units) {
          if (seen.has(y)) continue;
          if (unitEdges.get(y)!.has(x)) {
            seen.add(y);
            stack.push(y);
          }
        }
      }
      let n = 0;
      for (const y of seen) n += unitCells[y].length;
      return n;
    };
    const ranked = pickFrom
      .map((u) => ({ u, w: upstream(u) }))
      .sort((a, b) => b.w - a.w || unitLine[a.u] - unitLine[b.u]);
    const main = ranked[0]?.u;
    let label = commentAbove(g.line);
    if (!label && main !== undefined) {
      const mainName = unitNames[main]!;
      const keys = new Set(siblingKeys(mainName));
      const sibs = ranked
        .map((r) => unitNames[r.u]!)
        .filter((n) => n === mainName || siblingKeys(n).some((k) => keys.has(k)));
      label = stemName(sibs);
    }
    label = label || 'logic';
    let unique = label;
    for (let k = 2; used.has(unique); k++) unique = `${label}_${k}`;
    used.add(unique);
    return { label: unique, cellIds: g.cells.map((i) => prims[i].id) };
  });
}

// ---------------------------------------------------------------------------
// Synthetic modules

/** Choose public nets that cover `bits`, preferring ports and nets that cover many of them. */
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
        (s === bestS && best && !portNames.has(best.name) && portNames.has(n.name)) ||
        (s === bestS && best && portNames.has(best.name) === portNames.has(n.name) && n.bits.length < best.bits.length);
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

  const children: IRModule[] = [];
  const instances: IRCell[] = [];
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
      // Bring the whole bus in when none of it is computed here: the block diagram shows full buses.
      if (
        piece.net &&
        piece.net.bits.every((b) => typeof b === 'number' && drivenBy.get(b) !== i && !assignedIn.has(b))
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
    for (let k = 2; taken.has(name); k++) name = autoModuleName(m.name, `${blk.label}_${k}`);
    // Port names need a net of the same name (pins look up their source location there).
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
