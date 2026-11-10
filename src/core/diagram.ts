/**
 * Diagram model: what to draw for one module, before layout.
 *
 * Phase 1 builds a structural view: sub-module instances become blocks,
 * Yosys primitive cells become small operator boxes, module ports become
 * I/O pins, and bit-level connections are regrouped into bus edges.
 */
import {
  type Bit,
  type IRCell,
  type IRDesign,
  type IRModule,
  type IRNet,
  bitDrivers,
  caseNames,
  displayModuleName,
  formatConst,
  sliceLabel,
} from './ir';
import { ARITHMETIC, applyRules, combineReductions } from './rules';

/** text: a free note (no ports); split: a bus split into slices (drawn by hand). */
export type NodeKind = 'instance' | 'cell' | 'input' | 'output' | 'inout' | 'const' | 'join' | 'split' | 'text';
export type Side = 'WEST' | 'EAST' | 'NORTH' | 'SOUTH';

/**
 * How a module pin is drawn: its name in a label outline (`label`, the default), or the name alone, written at the
 * end of its wire (`text`). Only the look: the pin's size, connection points and wires are the same either way.
 */
export type PinStyle = 'label' | 'text';

/** Whether a node of this kind is a module pin (input, output or inout). */
export function isPinKind(kind: NodeKind): kind is 'input' | 'output' | 'inout' {
  return kind === 'input' || kind === 'output' || kind === 'inout';
}

/** How the pin `n` is drawn (its `attrs.style`); `label` for a node that is no pin. */
export function pinStyleOf(n: Pick<DNode, 'kind' | 'attrs'>): PinStyle {
  return isPinKind(n.kind) && n.attrs?.style === 'text' ? 'text' : 'label';
}

/** The pin `n` drawn in `style` (a label has no `attrs.style`); a node that is no pin as it is. */
export function withPinStyle<T extends Pick<DNode, 'kind' | 'attrs'>>(n: T, style: PinStyle | undefined): T {
  if (!isPinKind(n.kind) || pinStyleOf(n) === (style ?? 'label')) return n;
  const attrs: Record<string, string | number | boolean> = { ...n.attrs };
  delete attrs.style;
  if (style === 'text') attrs.style = 'text';
  if (Object.keys(attrs).length) return { ...n, attrs };
  const out = { ...n };
  delete out.attrs;
  return out;
}

export interface DPort {
  /** Globally unique within the diagram: `${nodeId}.${name}`. */
  id: string;
  name: string;
  dir: 'in' | 'out';
  side: Side;
  width: number;
  /**
   * An inout port of a block or instance. It is drawn and wired as an input (dir 'in'),
   * but it may also drive its net, so it is never tied to a constant when left open.
   */
  inout?: boolean;
}

export interface DNode {
  /** Stable ID (used as the key for saved positions). */
  id: string;
  kind: NodeKind;
  /** Main text: module name for instances, operator for cells, signal name for pins. */
  label: string;
  /** Secondary text: instance name for instances. */
  subLabel?: string;
  /** Yosys cell type for cells/instances. */
  cellType?: string;
  /** Module to open on double-click. */
  moduleName?: string;
  /** Yosys instance name, used in the breadcrumb. */
  instanceName?: string;
  ports: DPort[];
  /** Semantic transform that produced this node, if any. */
  rule?: string;
  /** Drawing hints from semantic transforms (e.g. inverted inputs). */
  attrs?: Record<string, string | number | boolean>;
  /**
   * Yosys parameters that change what a primitive cell computes (clock, enable and reset
   * polarity, reset values, signed operands), as Yosys writes them (binary, MSB first).
   * Only values that differ from what a drawn symbol assumes (rising clock, active-high
   * enable and reset, reset to 0, unsigned operands) are kept, so a cell without `params`
   * behaves like the library symbol of the same type. A memory ($mem_v2) keeps all of its
   * parameters (size, initial values, port clocks).
   */
  params?: Record<string, string>;
}

export interface DEndpoint {
  node: string;
  port: string;
}

export interface DEdge {
  /** Stable ID: `<source port>><target port>` (with `#n` when the same pair repeats). */
  id: string;
  source: DEndpoint;
  target: DEndpoint;
  /** Number of bits carried. */
  width: number;
  /** True when the edge carries the whole driver port (bus mark goes near the source). */
  fullSource: boolean;
  /**
   * Slice text such as `z[1:0]` when only part of a signal is used. Display only: the user may
   * rename it to anything, so what the edge carries is in `fullSource`, `bits` and `shift`.
   */
  label?: string;
  /** Which bits of the source port the edge carries, when not all of them. */
  bits?: { lo: number; width: number };
  /**
   * Low-order zero bits appended to what the edge carries (`{x, 2'b00}` is `x` with shift 2),
   * set where low-order zeros pad an operand of arithmetic (see rules.ts). The `×4` label only shows it, and the user may rename the label.
   */
  shift?: number;
}

export interface Diagram {
  module: string;
  nodes: DNode[];
  edges: DEdge[];
}

/** Operator text shown for Yosys primitive cells. */
const CELL_SYMBOL: Record<string, string> = {
  $add: '+',
  $sub: '−',
  $mul: '×',
  $div: '÷',
  $mod: '%',
  $pow: '**',
  $neg: '−',
  $pos: '+',
  $eq: '=',
  $eqx: '===',
  $ne: '≠',
  $nex: '!==',
  $lt: '<',
  $le: '≤',
  $gt: '>',
  $ge: '≥',
  $and: '&',
  $or: '|',
  $xor: '^',
  $xnor: '~^',
  $not: '~',
  $logic_and: '&&',
  $logic_or: '||',
  $logic_not: '!',
  $reduce_and: '&',
  $reduce_or: '|',
  $reduce_xor: '^',
  $reduce_xnor: '~^',
  $reduce_bool: '|',
  $shl: '<<',
  $shr: '>>',
  $sshl: '<<<',
  $sshr: '>>>',
  $shift: '>>',
  $shiftx: '>>',
  $mux: 'MUX',
  $pmux: 'MUX',
  $bmux: 'MUX',
  $demux: 'DEMUX',
  $dff: 'DFF',
  $adff: 'DFF',
  $sdff: 'DFF',
  $dffe: 'DFF',
  $adffe: 'DFF',
  $sdffe: 'DFF',
  $dffsr: 'DFF',
  $dffsre: 'DFF',
  $aldff: 'DFF',
  $aldffe: 'DFF',
  $dlatch: 'LATCH',
  $adlatch: 'LATCH',
  $dlatchsr: 'LATCH',
  $mem: 'MEM',
  $mem_v2: 'MEM',
  'dc:decoder': 'DEC',
  'dc:and': '&',
  'dc:nand': '&',
  'dc:nor': '|',
  'dc:reduce_nand': '~&',
  'dc:reduce_nor': '~|',
  'dc:logic_nand': '!&&',
  'dc:logic_nor': '!||',
  'dc:buf': '',
  'dc:mux': 'MUX',
};

export function cellSymbol(type: string): string {
  return CELL_SYMBOL[type] ?? type.replace(/^\$/, '');
}

/** Port ordering for primitive cells so the drawing reads naturally. */
const PORT_ORDER = ['A', 'B', 'C', 'D', 'AD', 'S', 'EN', 'CLK', 'ARST', 'SRST', 'ALOAD', 'SET', 'CLR', 'Y', 'Q'];

function sortPorts(type: string, names: string[]): string[] {
  if (!type.startsWith('$') && !type.startsWith('dc:')) return names;
  return [...names].sort((a, b) => {
    const ia = PORT_ORDER.indexOf(a);
    const ib = PORT_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
}

/** Yosys parameters that change what a primitive cell computes (see DNode.params). */
const SEMANTIC_PARAMS = [
  'CLK_POLARITY',
  'EN_POLARITY',
  'ARST_POLARITY',
  'SRST_POLARITY',
  'ALOAD_POLARITY',
  'SET_POLARITY',
  'CLR_POLARITY',
  'ARST_VALUE',
  'SRST_VALUE',
  'A_SIGNED',
  'B_SIGNED',
];

/** The semantic parameters of a primitive cell that differ from the defaults, or undefined when none do. */
function semanticParams(c: IRCell): Record<string, string> | undefined {
  // Instances, blackboxes and the rules' dc: cells carry no parameters that change what they compute.
  if (c.isInstance || !c.type.startsWith('$')) return undefined;
  // A memory has no library symbol: its size, initial values and port kinds are all part of what it is.
  if (c.type === '$mem_v2') return Object.fromEntries(Object.entries(c.parameters).map(([k, v]) => [k, v.trim()]));
  const out: Record<string, string> = {};
  for (const k of SEMANTIC_PARAMS) {
    const v = c.parameters[k]?.trim();
    if (v === undefined) continue;
    // Polarities default to 1 (rising edge, active high); reset values and signedness to 0.
    const isDefault = k.endsWith('_POLARITY') ? /1/.test(v) : /^0*$/.test(v);
    if (!isDefault) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Ports of a memory that do nothing, so they are not drawn: ports with no bits (a ROM has no
 * write port), and the clock, enable and resets of asynchronous read ports, which Yosys ignores
 * (they would show up as constant pins).
 */
function idleMemoryPort(c: IRCell, port: string): boolean {
  if (c.type !== '$mem_v2') return false;
  if (c.connections[port].length === 0) return true;
  return ['RD_CLK', 'RD_EN', 'RD_ARST', 'RD_SRST'].includes(port) && !/1/.test(c.parameters.RD_CLK_ENABLE ?? '');
}

function portSide(cell: IRCell, port: string, dir: 'in' | 'out'): Side {
  if (dir === 'out') return 'EAST';
  // Module instances (including $paramod ones, whose type also starts with '$') keep all inputs on the left.
  if (cell.isInstance) return 'WEST';
  if ((cell.type === '$mux' || cell.type === '$pmux' || cell.type === '$bmux') && port === 'S') return 'SOUTH';
  if (/dff|dlatch/.test(cell.type) && ['CLK', 'EN', 'ARST', 'SRST', 'ALOAD', 'SET', 'CLR'].includes(port)) return 'SOUTH';
  return 'WEST';
}

interface Driver {
  node: string;
  port: string;
  index: number;
  width: number;
  /** The driver port's full bit vector, used to name slices of it. */
  bits: Bit[];
}

/** Name of the signal a driver port carries: a public net with exactly the same bits. */
function driverNet(nets: IRNet[], bits: Bit[]): IRNet | undefined {
  return nets.find(
    (n) => !n.hidden && n.bits.length === bits.length && n.bits.every((b, i) => b === bits[i]),
  );
}

/** Find a readable name for a run of bits: prefer a public net that contains them in order. */
function nameBits(nets: IRNet[], bits: Bit[]): { name: string; full: boolean } | undefined {
  const nums = bits.filter((b): b is number => typeof b === 'number');
  if (nums.length !== bits.length || nums.length === 0) return undefined;
  const candidates = [...nets].sort((a, b) => Number(a.hidden) - Number(b.hidden) || a.bits.length - b.bits.length);
  for (const n of candidates) {
    if (n.hidden) continue;
    const start = n.bits.indexOf(nums[0]);
    if (start < 0) continue;
    let ok = true;
    for (let i = 1; i < nums.length; i++) {
      if (n.bits[start + i] !== nums[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { name: sliceLabel(n, start, start + nums.length - 1), full: start === 0 && nums.length === n.bits.length };
  }
  return undefined;
}

export function buildDiagram(design: IRDesign, moduleName: string): Diagram {
  const raw: IRModule | undefined = design.modules[moduleName];
  if (!raw) return { module: moduleName, nodes: [], edges: [] };
  // What selects a case is named by the cells before combineReductions (see there).
  const named = applyRules(raw);
  const m = combineReductions(named);

  const nodes: DNode[] = [];
  const edges: DEdge[] = [];
  /** First driver of each bit (cell outputs win over pins that can also drive, such as inouts). */
  const drivers = new Map<number, Driver>();
  /** Further drivers of an already-driven bit (tristate buses, double assignments). */
  const extraDrivers = new Map<number, Driver[]>();
  /** Inout ports drive only bits nobody else drives. */
  const fallbackDrivers: Driver[] = [];
  interface Sink {
    node: string;
    port: string;
    bits: Bit[];
    cellType?: string;
    /** For module output pins: declared range, so bar labels use the real indices. */
    range?: { offset: number; upto: boolean };
    /**
     * For the B input of a $pmux, which holds the value of every case side by side: the width of
     * one case. Constants are cut there, so a case table shows one value per case, not one long number.
     */
    piece?: number;
    /** For the B input of a $pmux: its select bits, one per case, to name the constants of each case by. */
    select?: Bit[];
  }
  const sinks: Sink[] = [];

  /** The cell that drives each bit, to read what selects a case of a $pmux. */
  const cellOf = bitDrivers(named.cells);

  const addDriver = (d: Driver, bit: number) => {
    const first = drivers.get(bit);
    if (!first) drivers.set(bit, d);
    else if (first.port !== d.port) extraDrivers.set(bit, [...(extraDrivers.get(bit) ?? []), d]);
  };

  // Module ports become I/O pins. Inputs drive, outputs sink, inouts do both.
  const pinNodes: DNode[] = [];
  for (const p of m.ports) {
    const kind: NodeKind = p.direction === 'input' ? 'input' : p.direction === 'output' ? 'output' : 'inout';
    const id = `${kind === 'input' ? 'in' : kind === 'output' ? 'out' : 'io'}:${p.name}`;
    const ports: DPort[] = [];
    if (kind !== 'output') {
      const out: DPort = { id: `${id}.out`, name: 'out', dir: 'out', side: 'EAST', width: p.bits.length };
      ports.push(out);
      p.bits.forEach((b, i) => {
        if (typeof b !== 'number') return;
        const d: Driver = { node: id, port: out.id, index: i, width: p.bits.length, bits: p.bits };
        if (kind === 'input') addDriver(d, b);
        else fallbackDrivers.push(d);
      });
    }
    if (kind !== 'input') {
      const inp: DPort = { id: `${id}.in`, name: 'in', dir: 'in', side: 'WEST', width: p.bits.length };
      ports.push(inp);
      sinks.push({ node: id, port: inp.id, bits: p.bits, range: { offset: p.offset, upto: p.upto } });
    }
    pinNodes.push({ id, kind, label: p.name, ports });
  }
  nodes.push(...pinNodes);

  for (const c of m.cells) {
    const id = `cell:${c.id}`;
    const ports: DPort[] = [];
    for (const pname of sortPorts(c.type, Object.keys(c.connections))) {
      if (idleMemoryPort(c, pname)) continue;
      const direction = c.directions[pname];
      const dir = direction === 'output' ? 'out' : 'in';
      const bits = c.connections[pname];
      const port: DPort = {
        id: `${id}.${pname}`,
        name: pname,
        dir,
        side: portSide(c, pname, dir),
        width: bits.length,
        ...(direction === 'inout' ? { inout: true } : {}),
      };
      ports.push(port);
      if (dir === 'out') {
        bits.forEach((b, i) => {
          if (typeof b !== 'number') return;
          addDriver({ node: id, port: port.id, index: i, width: bits.length, bits }, b);
        });
      } else {
        const piece = c.type === '$pmux' && pname === 'B' ? c.connections.A?.length : undefined;
        sinks.push({ node: id, port: port.id, bits, cellType: c.type, ...(piece ? { piece, select: c.connections.S ?? [] } : {}) });
        if (direction === 'inout') {
          bits.forEach((b, i) => {
            if (typeof b === 'number') fallbackDrivers.push({ node: id, port: port.id, index: i, width: bits.length, bits });
          });
        }
      }
    }
    const params = semanticParams(c);
    nodes.push(
      c.isInstance
        ? {
            id,
            kind: 'instance',
            label: design.modules[c.type]?.displayName ?? displayModuleName(c.type),
            subLabel: c.hidden ? undefined : c.name,
            attrs: c.attrs,
            cellType: c.type,
            moduleName: c.type,
            instanceName: c.name,
            ports,
          }
        : {
            id,
            kind: 'cell',
            label: cellSymbol(c.type),
            cellType: c.type,
            ports,
            rule: c.rule,
            attrs: c.attrs,
            ...(params ? { params } : {}),
          },
    );
  }

  // Inout pins and inout instance ports drive the bits that nothing else drives.
  for (const d of fallbackDrivers) {
    const b = d.bits[d.index];
    if (typeof b === 'number' && !drivers.has(b)) drivers.set(b, d);
  }

  // Regroup each sink's bits into runs: same driver port with consecutive indices, or constants.
  type Run =
    | { kind: 'const'; lo: number; bits: Bit[] }
    | { kind: 'net'; lo: number; bits: Bit[]; driver: Driver };
  const runsOf = (bits: Bit[], selfPort: string, selfNode: string): Run[] => {
    const runs: Run[] = [];
    // An inout pin drives its own net through its other port: that is not a wire into it.
    const isSelf = (d: { node: string; port: string }) => d.port === selfPort || (selfNode.startsWith('io:') && d.node === selfNode);
    const driverOf = (b: Bit) => {
      if (typeof b !== 'number') return undefined;
      const d = drivers.get(b);
      return d && !isSelf(d) ? d : undefined;
    };
    let i = 0;
    while (i < bits.length) {
      const d = driverOf(bits[i]);
      let j = i + 1;
      if (!d) {
        while (j < bits.length && !driverOf(bits[j])) j++;
        const piece = bits.slice(i, j);
        // A pin that only drives itself (an unused inout) is not a constant.
        if (!piece.every((b) => typeof b === 'number' && drivers.has(b) && isSelf(drivers.get(b)!))) {
          runs.push({ kind: 'const', lo: i, bits: piece.map((x) => (typeof x === 'number' ? 'x' : x)) as Bit[] });
        }
      } else {
        while (j < bits.length) {
          const nd = driverOf(bits[j]);
          if (!nd || nd.port !== d.port || nd.index !== d.index + (j - i)) break;
          j++;
        }
        runs.push({ kind: 'net', lo: i, bits: bits.slice(i, j), driver: d });
      }
      i = j;
    }
    return runs;
  };

  const runLabel = (d: Driver, len: number, bits: Bit[]): string | undefined => {
    const net = driverNet(m.nets, d.bits);
    if (net) return sliceLabel(net, d.index, d.index + len - 1);
    return nameBits(m.nets, bits)?.name;
  };

  /** `constId`: the ID of the constant node a constant run becomes (by default, named by the port and bit it feeds). */
  const connectRun = (r: Run, target: DEndpoint, fullSink: boolean, note?: string, shift?: number, constId?: string) => {
    if (r.kind === 'const') {
      const cid = constId ?? `const:${target.port}[${r.lo}]`;
      const cport: DPort = { id: `${cid}.out`, name: 'out', dir: 'out', side: 'EAST', width: r.bits.length };
      nodes.push({ id: cid, kind: 'const', label: formatConst(r.bits), ports: [cport] });
      edges.push({
        id: '',
        source: { node: cid, port: cport.id },
        target,
        width: r.bits.length,
        fullSource: true,
      });
      return;
    }
    const d = r.driver;
    const len = r.bits.length;
    const fullSource = d.index === 0 && len === d.width;
    const name = runLabel(d, len, r.bits);
    edges.push({
      id: '',
      source: { node: d.node, port: d.port },
      target,
      width: len,
      fullSource,
      label: note ? [fullSource ? undefined : name, note].filter(Boolean).join(' ') : fullSource && fullSink ? undefined : name,
      ...(fullSource ? {} : { bits: { lo: d.index, width: len } }),
      ...(shift ? { shift } : {}),
    });
  };

  const rangeName = (s: Sink, lo: number, hi: number): string => {
    let a = hi;
    let b = lo;
    if (s.range) {
      const n = s.bits.length;
      a = s.range.upto ? s.range.offset + (n - 1 - hi) : s.range.offset + hi;
      b = s.range.upto ? s.range.offset + (n - 1 - lo) : s.range.offset + lo;
    }
    return a === b ? `[${a}]` : `[${a}:${b}]`;
  };

  for (const s of sinks) {
    let runs = runsOf(s.bits, s.port, s.node);
    const piece = s.piece;
    const cases = s.select && caseNames(cellOf, s.select, m.nets);
    /**
     * The constants of a case table are named by the case they belong to, and where in it they start, so
     * that they keep their IDs (and the edits saved for them) when other cases are added or changed.
     */
    const constId = (r: Run): string | undefined => {
      if (!piece || !cases || r.kind !== 'const') return undefined;
      const k = Math.floor(r.lo / piece);
      const at = r.lo - k * piece;
      return `const:${s.port}[${cases[k] ?? k}]${at ? `[${at}]` : ''}`;
    };
    if (piece) {
      runs = runs.flatMap((r): Run[] => {
        if (r.kind !== 'const') return [r];
        const out: Run[] = [];
        for (let lo = r.lo; lo < r.lo + r.bits.length; lo = (Math.floor(lo / piece) + 1) * piece) {
          const hi = Math.min(r.lo + r.bits.length, (Math.floor(lo / piece) + 1) * piece);
          out.push({ kind: 'const', lo, bits: r.bits.slice(lo - r.lo, hi - r.lo) });
        }
        return out;
      });
    }
    let zeroExtended = false;
    const arithmetic = s.cellType !== undefined && ARITHMETIC.has(s.cellType);
    if (arithmetic && runs.length > 1) {
      // {2'b00, x}: high-order zero padding is just how Verilog widens operands.
      const last = runs[runs.length - 1];
      if (last.kind === 'const' && last.bits.every((b) => b === '0') && runs.some((r) => r.kind === 'net')) {
        runs = runs.slice(0, -1);
        zeroExtended = true;
      }
    }
    // {x, 2'b00}: low-order zeros multiply by a power of two. Other low-order constants ({x, 2'b01})
    // are a concatenation like any other.
    const low = runs[0];
    if (arithmetic && runs.length === 2 && low.kind === 'const' && runs[1].kind === 'net' && low.bits.every((b) => b === '0') && low.bits.length < 31) {
      const k = low.bits.length;
      connectRun(runs[1], { node: s.node, port: s.port }, true, `×${2 ** k}`, k);
    } else if (runs.length <= 1) {
      for (const r of runs) {
        connectRun(r, { node: s.node, port: s.port }, r.lo === 0 && (zeroExtended || r.bits.length === s.bits.length), undefined, undefined, constId(r));
      }
    } else {
      // Several pieces feed one port: draw a concatenation bar, MSB on top.
      const jid = `join:${s.port}`;
      const ordered = [...runs].reverse();
      const ports: DPort[] = ordered.map((r) => {
        const name = rangeName(s, r.lo, r.lo + r.bits.length - 1);
        return { id: `${jid}.${name}`, name, dir: 'in', side: 'WEST', width: r.bits.length };
      });
      const out: DPort = { id: `${jid}.out`, name: 'out', dir: 'out', side: 'EAST', width: s.bits.length };
      nodes.push({ id: jid, kind: 'join', label: '{ }', ports: [...ports, out] });
      ordered.forEach((r, k) => connectRun(r, { node: jid, port: ports[k].id }, true, undefined, undefined, constId(r)));
      edges.push({
        id: '',
        source: { node: jid, port: out.id },
        target: { node: s.node, port: s.port },
        width: s.bits.length,
        fullSource: true,
      });
    }

    // Extra drivers of the same bits (tristate buses): one more edge per driver piece.
    const extra = new Map<string, { d: Driver; count: number }>();
    for (const b of s.bits) {
      if (typeof b !== 'number') continue;
      for (const d of extraDrivers.get(b) ?? []) {
        if (d.port === s.port) continue;
        const e = extra.get(d.port);
        if (e) e.count++;
        else extra.set(d.port, { d, count: 1 });
      }
    }
    for (const { d, count } of extra.values()) {
      const full = count === d.width;
      edges.push({
        id: '',
        source: { node: d.node, port: d.port },
        target: { node: s.node, port: s.port },
        width: count,
        fullSource: full,
        label: full ? undefined : runLabel(d, count, d.bits),
        // The same bits the label names: the editor reads them here, never from the label.
        ...(full || d.index + count > d.width ? {} : { bits: { lo: d.index, width: count } }),
      });
    }
  }

  return { module: moduleName, nodes, edges: withStableEdgeIds(edges) };
}

/** Give every edge an ID made of its end ports, so saved wire routes can be matched after a re-import. */
export function withStableEdgeIds(edges: DEdge[]): DEdge[] {
  const seen = new Map<string, number>();
  return edges.map((e) => {
    const base = `${e.source.port}>${e.target.port}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return { ...e, id: n === 0 ? base : `${base}#${n}` };
  });
}
