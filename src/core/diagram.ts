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
  type SrcRange,
  displayModuleName,
  formatConst,
  sliceLabel,
} from './ir';
import { ARITHMETIC, DEFAULT_RULES, type RuleId, applyRules } from './rules';

export type NodeKind = 'instance' | 'cell' | 'input' | 'output' | 'inout' | 'const' | 'join';
export type Side = 'WEST' | 'EAST' | 'NORTH' | 'SOUTH';

export interface DPort {
  /** Globally unique within the diagram: `${nodeId}.${name}`. */
  id: string;
  name: string;
  dir: 'in' | 'out';
  side: Side;
  width: number;
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
  src: SrcRange[];
  /** Semantic transform that produced this node, if any. */
  rule?: string;
  /** Drawing hints from semantic transforms (e.g. inverted inputs). */
  attrs?: Record<string, string | number | boolean>;
}

export interface DEndpoint {
  node: string;
  port: string;
}

export interface DEdge {
  id: string;
  source: DEndpoint;
  target: DEndpoint;
  /** Number of bits carried. */
  width: number;
  /** True when the edge carries the whole driver port (bus mark goes near the source). */
  fullSource: boolean;
  /** Slice text such as `z[1:0]` when only part of a signal is used. */
  label?: string;
  /** Name of the driving signal, for highlighting. */
  netName?: string;
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
  $dlatch: 'LATCH',
  $mem: 'MEM',
  $mem_v2: 'MEM',
  'dc:decoder': 'DEC',
  'dc:and': '&',
};

export function cellSymbol(type: string): string {
  return CELL_SYMBOL[type] ?? type.replace(/^\$/, '');
}

/** Port ordering for primitive cells so the drawing reads naturally. */
const PORT_ORDER = ['A', 'B', 'C', 'D', 'S', 'EN', 'CLK', 'ARST', 'SRST', 'Y', 'Q'];

function sortPorts(type: string, names: string[]): string[] {
  if (!type.startsWith('$') && !type.startsWith('dc:')) return names;
  return [...names].sort((a, b) => {
    const ia = PORT_ORDER.indexOf(a);
    const ib = PORT_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
}

function portSide(cell: IRCell, port: string, dir: 'in' | 'out'): Side {
  if (dir === 'out') return 'EAST';
  // Module instances (including $paramod ones, whose type also starts with '$') keep all inputs on the left.
  if (cell.isInstance) return 'WEST';
  if ((cell.type === '$mux' || cell.type === '$pmux' || cell.type === '$bmux') && port === 'S') return 'SOUTH';
  if (/dff|dlatch/.test(cell.type) && ['CLK', 'EN', 'ARST', 'SRST'].includes(port)) return 'SOUTH';
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

export function buildDiagram(
  design: IRDesign,
  moduleName: string,
  rules: ReadonlySet<RuleId> = DEFAULT_RULES,
): Diagram {
  const raw: IRModule | undefined = design.modules[moduleName];
  if (!raw) return { module: moduleName, nodes: [], edges: [] };
  const m = applyRules(raw, rules);

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
  }
  const sinks: Sink[] = [];

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
    const net = m.nets.find((x) => x.name === p.name && !x.hidden);
    pinNodes.push({ id, kind, label: p.name, ports, src: net?.src ?? [] });
  }
  nodes.push(...pinNodes);

  for (const c of m.cells) {
    const id = `cell:${c.id}`;
    const ports: DPort[] = [];
    for (const pname of sortPorts(c.type, Object.keys(c.connections))) {
      const direction = c.directions[pname];
      const dir = direction === 'output' ? 'out' : 'in';
      const bits = c.connections[pname];
      const port: DPort = {
        id: `${id}.${pname}`,
        name: pname,
        dir,
        side: portSide(c, pname, dir),
        width: bits.length,
      };
      ports.push(port);
      if (dir === 'out') {
        bits.forEach((b, i) => {
          if (typeof b === 'number') addDriver({ node: id, port: port.id, index: i, width: bits.length, bits }, b);
        });
      } else {
        sinks.push({ node: id, port: port.id, bits, cellType: c.type });
        if (direction === 'inout') {
          bits.forEach((b, i) => {
            if (typeof b === 'number') fallbackDrivers.push({ node: id, port: port.id, index: i, width: bits.length, bits });
          });
        }
      }
    }
    nodes.push(
      c.isInstance
        ? {
            id,
            kind: 'instance',
            label: displayModuleName(c.type),
            subLabel: c.hidden ? undefined : c.name,
            cellType: c.type,
            moduleName: c.type,
            instanceName: c.name,
            ports,
            src: c.src,
          }
        : {
            id,
            kind: 'cell',
            label: cellSymbol(c.type),
            cellType: c.type,
            ports,
            src: c.src,
            rule: c.rule,
            attrs: c.attrs,
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
  const runsOf = (bits: Bit[], selfPort: string): Run[] => {
    const runs: Run[] = [];
    const driverOf = (b: Bit) => {
      if (typeof b !== 'number') return undefined;
      const d = drivers.get(b);
      return d && d.port !== selfPort ? d : undefined;
    };
    let i = 0;
    while (i < bits.length) {
      const d = driverOf(bits[i]);
      let j = i + 1;
      if (!d) {
        while (j < bits.length && !driverOf(bits[j])) j++;
        const piece = bits.slice(i, j);
        // A pin that only drives itself (an unused inout) is not a constant.
        if (!piece.every((b) => typeof b === 'number' && drivers.get(b)?.port === selfPort)) {
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

  const connectRun = (r: Run, target: DEndpoint, fullSink: boolean, note?: string) => {
    if (r.kind === 'const') {
      const cid = `const:${target.port}[${r.lo}]`;
      const cport: DPort = { id: `${cid}.out`, name: 'out', dir: 'out', side: 'EAST', width: r.bits.length };
      nodes.push({ id: cid, kind: 'const', label: formatConst(r.bits), ports: [cport], src: [] });
      edges.push({
        id: `e${edges.length}`,
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
      id: `e${edges.length}`,
      source: { node: d.node, port: d.port },
      target,
      width: len,
      fullSource,
      label: note ? [fullSource ? undefined : name, note].filter(Boolean).join(' ') : fullSource && fullSink ? undefined : name,
      netName: name,
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
    let runs = runsOf(s.bits, s.port);
    let zeroExtended = false;
    const arithmetic = s.cellType !== undefined && ARITHMETIC.has(s.cellType);
    if (arithmetic && runs.length > 1 && rules.has('zero-extend')) {
      // {2'b00, x}: high-order zero padding is just how Verilog widens operands.
      const last = runs[runs.length - 1];
      if (last.kind === 'const' && last.bits.every((b) => b === '0') && runs.some((r) => r.kind === 'net')) {
        runs = runs.slice(0, -1);
        zeroExtended = true;
      }
    }
    if (arithmetic && rules.has('scale') && runs.length === 2 && runs[0].kind === 'const' && runs[1].kind === 'net') {
      // {x, 2'b00}: low-order zeros multiply by a power of two.
      const k = runs[0].bits.length;
      if (runs[0].bits.every((b) => b === '0') && k < 31) {
        connectRun(runs[1], { node: s.node, port: s.port }, true, `×${2 ** k}`);
        runs = [];
      }
    } else if (runs.length <= 1) {
      for (const r of runs) {
        connectRun(r, { node: s.node, port: s.port }, r.lo === 0 && (zeroExtended || r.bits.length === s.bits.length));
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
      nodes.push({ id: jid, kind: 'join', label: '{ }', ports: [...ports, out], src: [] });
      ordered.forEach((r, k) => connectRun(r, { node: jid, port: ports[k].id }, true));
      edges.push({
        id: `e${edges.length}`,
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
      edges.push({
        id: `e${edges.length}`,
        source: { node: d.node, port: d.port },
        target: { node: s.node, port: s.port },
        width: count,
        fullSource: count === d.width,
        label: count === d.width ? undefined : runLabel(d, count, d.bits),
      });
    }
  }

  return { module: moduleName, nodes, edges };
}
