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

export type NodeKind = 'instance' | 'cell' | 'input' | 'output' | 'const' | 'join';
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
};

export function cellSymbol(type: string): string {
  return CELL_SYMBOL[type] ?? type.replace(/^\$/, '');
}

/** Port ordering for primitive cells so the drawing reads naturally. */
const PORT_ORDER = ['A', 'B', 'C', 'D', 'S', 'EN', 'CLK', 'ARST', 'SRST', 'Y', 'Q'];

function sortPorts(type: string, names: string[]): string[] {
  if (!type.startsWith('$')) return names;
  return [...names].sort((a, b) => {
    const ia = PORT_ORDER.indexOf(a);
    const ib = PORT_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
}

function portSide(cell: IRCell, port: string, dir: 'in' | 'out'): Side {
  if (dir === 'out') return 'EAST';
  if ((cell.type === '$mux' || cell.type === '$pmux' || cell.type === '$bmux') && port === 'S') return 'SOUTH';
  if (cell.type.startsWith('$') && (port === 'CLK' || port === 'EN' || port === 'ARST' || port === 'SRST')) return 'SOUTH';
  return 'WEST';
}

interface Driver {
  node: string;
  port: string;
  index: number;
  width: number;
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
  const m: IRModule | undefined = design.modules[moduleName];
  if (!m) return { module: moduleName, nodes: [], edges: [] };

  const nodes: DNode[] = [];
  const edges: DEdge[] = [];
  const drivers = new Map<number, Driver>();
  const sinks: { node: string; port: string; bits: Bit[] }[] = [];

  // Module ports become I/O pins. Inputs drive, outputs sink.
  for (const p of m.ports) {
    const isIn = p.direction !== 'output';
    const id = `${isIn ? 'in' : 'out'}:${p.name}`;
    const portName = isIn ? 'out' : 'in';
    const port: DPort = {
      id: `${id}.${portName}`,
      name: portName,
      dir: isIn ? 'out' : 'in',
      side: isIn ? 'EAST' : 'WEST',
      width: p.bits.length,
    };
    nodes.push({ id, kind: isIn ? 'input' : 'output', label: p.name, ports: [port], src: [] });
    if (isIn) {
      p.bits.forEach((b, i) => {
        if (typeof b === 'number') drivers.set(b, { node: id, port: port.id, index: i, width: p.bits.length });
      });
    } else {
      sinks.push({ node: id, port: port.id, bits: p.bits });
    }
  }
  // Port src comes from the matching net.
  for (const n of nodes) {
    const net = m.nets.find((x) => x.name === n.label && !x.hidden);
    if (net) n.src = net.src;
  }

  for (const c of m.cells) {
    const id = `cell:${c.id}`;
    const ports: DPort[] = [];
    for (const pname of sortPorts(c.type, Object.keys(c.connections))) {
      const dir = c.directions[pname] === 'output' ? 'out' : 'in';
      const port: DPort = {
        id: `${id}.${pname}`,
        name: pname,
        dir,
        side: portSide(c, pname, dir),
        width: c.connections[pname].length,
      };
      ports.push(port);
      const bits = c.connections[pname];
      if (dir === 'out') {
        bits.forEach((b, i) => {
          if (typeof b === 'number' && !drivers.has(b)) drivers.set(b, { node: id, port: port.id, index: i, width: bits.length });
        });
      } else {
        sinks.push({ node: id, port: port.id, bits });
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
          },
    );
  }

  // Regroup each sink's bits into runs: same driver port with consecutive indices, or constants.
  type Run =
    | { kind: 'const'; lo: number; bits: Bit[] }
    | { kind: 'net'; lo: number; bits: Bit[]; driver: Driver };
  const runsOf = (bits: Bit[]): Run[] => {
    const runs: Run[] = [];
    let i = 0;
    while (i < bits.length) {
      const b = bits[i];
      const d = typeof b === 'number' ? drivers.get(b) : undefined;
      let j = i + 1;
      if (!d) {
        while (j < bits.length && (typeof bits[j] !== 'number' || !drivers.has(bits[j] as number))) j++;
        runs.push({ kind: 'const', lo: i, bits: bits.slice(i, j).map((x) => (typeof x === 'number' ? 'x' : x)) as Bit[] });
      } else {
        while (j < bits.length) {
          const nb = bits[j];
          const nd = typeof nb === 'number' ? drivers.get(nb) : undefined;
          if (!nd || nd.port !== d.port || nd.index !== d.index + (j - i)) break;
          j++;
        }
        runs.push({ kind: 'net', lo: i, bits: bits.slice(i, j), driver: d });
      }
      i = j;
    }
    return runs;
  };

  const connectRun = (r: Run, target: DEndpoint, fullSink: boolean) => {
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
    const named = nameBits(m.nets, r.bits);
    edges.push({
      id: `e${edges.length}`,
      source: { node: d.node, port: d.port },
      target,
      width: len,
      fullSource,
      label: fullSource && fullSink ? undefined : named?.name,
      netName: named?.name,
    });
  };

  for (const s of sinks) {
    const runs = runsOf(s.bits);
    if (runs.length <= 1) {
      for (const r of runs) connectRun(r, { node: s.node, port: s.port }, r.lo === 0 && r.bits.length === s.bits.length);
      continue;
    }
    // Several pieces feed one port: draw a concatenation bar, MSB on top.
    const jid = `join:${s.port}`;
    const ordered = [...runs].reverse();
    const ports: DPort[] = ordered.map((r) => {
      const hi = r.lo + r.bits.length - 1;
      const name = hi === r.lo ? `[${hi}]` : `[${hi}:${r.lo}]`;
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
  return { module: moduleName, nodes, edges };
}
