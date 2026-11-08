/**
 * The symbol library for drawing by hand.
 *
 * A placed symbol is stored as a small record (`UserNode`: which symbol, its
 * parameters, its name). Its drawing node (`DNode`, the same type the Verilog
 * import produces) is derived from that record, so changing a parameter such
 * as the bus width or the number of inputs re-derives the ports.
 *
 * Cell types reuse the Yosys names where one exists ($and, $add, $mux, $dff…)
 * so that drawn and imported symbols look the same and export the same way.
 * Symbols Yosys has no cell for use `dc:` types (dc:nand, dc:mux, dc:decoder…).
 */
import type { DNode, DPort, Side } from '../core/diagram';
import { moduleTitle } from '../core/names';

export type SymKey =
  | 'input'
  | 'output'
  | 'inout'
  | 'const'
  | 'text'
  | 'and'
  | 'or'
  | 'xor'
  | 'nand'
  | 'nor'
  | 'xnor'
  | 'not'
  | 'buf'
  | 'mux'
  | 'add'
  | 'sub'
  | 'mul'
  | 'eq'
  | 'ne'
  | 'lt'
  | 'le'
  | 'gt'
  | 'ge'
  | 'shl'
  | 'shr'
  | 'decoder'
  | 'dff'
  | 'dffe'
  | 'adff'
  | 'concat'
  | 'split'
  | 'block'
  /** A copy of an imported symbol, kept exactly as it was drawn (its ports cannot be changed). */
  | 'raw';

export type ParamName = 'width' | 'inputs' | 'value' | 'module' | 'shift' | 'parts';

export interface SymParams {
  /** Bus width in bits (data width for operators and registers). */
  width?: number;
  /** Number of inputs (gates, MUX). */
  inputs?: number;
  /** Number of slices (concatenation, split). */
  parts?: number;
  /** Constant value as written in Verilog, e.g. 4'd2. */
  value?: string;
  /** Module a block instantiates. */
  module?: string;
  /** Width of a shifter's shift amount. */
  shift?: number;
}

export interface UserNode {
  /** `u:<n>`, unique within the sheet. */
  id: string;
  sym: SymKey;
  params: SymParams;
  /** Pin name, instance name, or the text of a note. */
  name?: string;
  /** For `raw` symbols: the drawing node as it was copied (port IDs are rewritten to this node). */
  raw?: DNode;
  /**
   * The preset of the library (Components) it was placed from: it follows that preset's settings when the
   * preset is changed, until it is changed on its own (see followComponents).
   */
  component?: string;
}

export interface UserEdge {
  /** `w:<n>`, unique within the sheet. */
  id: string;
  source: { node: string; port: string };
  target: { node: string; port: string };
  /** Text written next to the wire, e.g. a slice such as `a[3:0]`. */
  label?: string;
  /** The wire carries only these bits of its source (LSB index and count). */
  slice?: { lo: number; width: number };
  /** Low zero bits appended to what the wire carries (an imported `×4` wire has 2), whatever its label says. */
  shift?: number;
}

export interface ModulePort {
  name: string;
  dir: 'input' | 'output' | 'inout';
  width: number;
}

export interface ModuleInterface {
  /** Name drawn in the block's title. */
  label: string;
  ports: ModulePort[];
}

/** Ports of a module a block can instantiate (a Verilog module or another drawing). */
export type InterfaceOf = (module: string) => ModuleInterface | undefined;

export type SymbolGroup = 'Ports & labels' | 'Logic gates' | 'Arithmetic' | 'Compare' | 'Select & shift' | 'Registers' | 'Buses' | 'Hierarchy';

export interface SymbolDef {
  key: SymKey;
  title: string;
  group: SymbolGroup;
  hint: string;
  defaults: SymParams;
  /** Parameters shown in the Properties panel. */
  params: ParamName[];
  /** Whether the symbol shows its name on the drawing (pins, blocks, notes). */
  named?: boolean;
}

export const SYMBOLS: SymbolDef[] = [
  { key: 'input', title: 'Input', group: 'Ports & labels', hint: 'Module input pin', defaults: { width: 1 }, params: ['width'], named: true },
  { key: 'output', title: 'Output', group: 'Ports & labels', hint: 'Module output pin', defaults: { width: 1 }, params: ['width'], named: true },
  { key: 'inout', title: 'Inout', group: 'Ports & labels', hint: 'Bidirectional module pin', defaults: { width: 1 }, params: ['width'], named: true },
  { key: 'const', title: 'Constant', group: 'Ports & labels', hint: "Constant value such as 4'd2", defaults: { value: "1'b0" }, params: ['value'] },
  { key: 'text', title: 'Note', group: 'Ports & labels', hint: 'Free text (not connected)', defaults: {}, params: [], named: true },
  { key: 'and', title: 'AND', group: 'Logic gates', hint: 'AND gate', defaults: { inputs: 2, width: 1 }, params: ['inputs', 'width'] },
  { key: 'or', title: 'OR', group: 'Logic gates', hint: 'OR gate', defaults: { inputs: 2, width: 1 }, params: ['inputs', 'width'] },
  { key: 'xor', title: 'XOR', group: 'Logic gates', hint: 'XOR gate', defaults: { inputs: 2, width: 1 }, params: ['inputs', 'width'] },
  { key: 'nand', title: 'NAND', group: 'Logic gates', hint: 'NAND gate', defaults: { inputs: 2, width: 1 }, params: ['inputs', 'width'] },
  { key: 'nor', title: 'NOR', group: 'Logic gates', hint: 'NOR gate', defaults: { inputs: 2, width: 1 }, params: ['inputs', 'width'] },
  { key: 'xnor', title: 'XNOR', group: 'Logic gates', hint: 'XNOR gate', defaults: { inputs: 2, width: 1 }, params: ['inputs', 'width'] },
  { key: 'not', title: 'NOT', group: 'Logic gates', hint: 'Inverter', defaults: { width: 1 }, params: ['width'] },
  { key: 'buf', title: 'Buffer', group: 'Logic gates', hint: 'Buffer', defaults: { width: 1 }, params: ['width'] },
  { key: 'add', title: 'Adder', group: 'Arithmetic', hint: 'A + B', defaults: { width: 4 }, params: ['width'] },
  { key: 'sub', title: 'Subtractor', group: 'Arithmetic', hint: 'A − B', defaults: { width: 4 }, params: ['width'] },
  { key: 'mul', title: 'Multiplier', group: 'Arithmetic', hint: 'A × B', defaults: { width: 4 }, params: ['width'] },
  { key: 'eq', title: 'Equal', group: 'Compare', hint: 'A == B', defaults: { width: 4 }, params: ['width'] },
  { key: 'ne', title: 'Not equal', group: 'Compare', hint: 'A != B', defaults: { width: 4 }, params: ['width'] },
  { key: 'lt', title: 'Less than', group: 'Compare', hint: 'A < B', defaults: { width: 4 }, params: ['width'] },
  { key: 'le', title: 'Less or equal', group: 'Compare', hint: 'A <= B', defaults: { width: 4 }, params: ['width'] },
  { key: 'gt', title: 'Greater than', group: 'Compare', hint: 'A > B', defaults: { width: 4 }, params: ['width'] },
  { key: 'ge', title: 'Greater or equal', group: 'Compare', hint: 'A >= B', defaults: { width: 4 }, params: ['width'] },
  { key: 'mux', title: 'MUX', group: 'Select & shift', hint: 'Multiplexer: S picks input S', defaults: { inputs: 2, width: 1 }, params: ['inputs', 'width'] },
  { key: 'decoder', title: 'Decoder', group: 'Select & shift', hint: 'n-to-2ⁿ decoder (1 << A)', defaults: { width: 2 }, params: ['width'] },
  { key: 'shl', title: 'Shift left', group: 'Select & shift', hint: 'A << B', defaults: { width: 8, shift: 3 }, params: ['width', 'shift'] },
  { key: 'shr', title: 'Shift right', group: 'Select & shift', hint: 'A >> B', defaults: { width: 8, shift: 3 }, params: ['width', 'shift'] },
  { key: 'dff', title: 'Register', group: 'Registers', hint: 'D flip-flop / register (posedge CLK)', defaults: { width: 1 }, params: ['width'] },
  { key: 'dffe', title: 'Register + EN', group: 'Registers', hint: 'Register with enable', defaults: { width: 1 }, params: ['width'] },
  { key: 'adff', title: 'Register + reset', group: 'Registers', hint: 'Register with asynchronous reset to 0', defaults: { width: 1 }, params: ['width'] },
  { key: 'concat', title: 'Concatenate', group: 'Buses', hint: 'Join slices into one bus, MSB on top', defaults: { parts: 2, width: 4 }, params: ['parts', 'width'] },
  { key: 'split', title: 'Split', group: 'Buses', hint: 'Split a bus into slices, MSB on top', defaults: { parts: 2, width: 4 }, params: ['parts', 'width'] },
  { key: 'block', title: 'Module block', group: 'Hierarchy', hint: 'An instance of another module or drawing', defaults: {}, params: ['module'], named: true },
];

export const SYMBOL_BY_KEY: Record<SymKey, SymbolDef | undefined> = Object.fromEntries(SYMBOLS.map((s) => [s.key, s])) as Record<
  SymKey,
  SymbolDef | undefined
>;

export const PARAM_LIMITS: Record<'width' | 'inputs' | 'shift' | 'parts', [number, number]> = {
  width: [1, 256],
  inputs: [2, 32],
  shift: [1, 16],
  parts: [2, 16],
};

export function clampParam(name: keyof typeof PARAM_LIMITS, v: number | undefined, fallback: number): number {
  const [lo, hi] = PARAM_LIMITS[name];
  if (v === undefined || !Number.isFinite(v)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(v)));
}

const CELL_TYPE: Partial<Record<SymKey, string>> = {
  and: '$and',
  or: '$or',
  xor: '$xor',
  xnor: '$xnor',
  nand: 'dc:nand',
  nor: 'dc:nor',
  not: '$not',
  buf: 'dc:buf',
  add: '$add',
  sub: '$sub',
  mul: '$mul',
  eq: '$eq',
  ne: '$ne',
  lt: '$lt',
  le: '$le',
  gt: '$gt',
  ge: '$ge',
  shl: '$shl',
  shr: '$shr',
  decoder: 'dc:decoder',
  dff: '$dff',
  dffe: '$dffe',
  adff: '$adff',
};

const OP_LABEL: Record<string, string> = {
  $and: '&',
  $or: '|',
  $xor: '^',
  $xnor: '~^',
  'dc:nand': '&',
  'dc:nor': '|',
  $not: '~',
  'dc:buf': '',
  $add: '+',
  $sub: '−',
  $mul: '×',
  $eq: '=',
  $ne: '≠',
  $lt: '<',
  $le: '≤',
  $gt: '>',
  $ge: '≥',
  $shl: '<<',
  $shr: '>>',
  'dc:decoder': 'DEC',
  'dc:mux': 'MUX',
  $mux: 'MUX',
  $dff: 'DFF',
  $dffe: 'DFF',
  $adff: 'DFF',
};

/** Names of a gate's inputs: up to X (Y is its output). */
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWX';

/** The name of a gate's input `k`: A, B… X, then I24, I25… (the export goes by their order). */
export function gateInputName(k: number): string {
  return k < LETTERS.length ? LETTERS[k] : `I${k}`;
}

/** Bits needed to number `n` choices (at least 1). */
export function selectWidth(n: number): number {
  return Math.max(1, Math.ceil(Math.log2(Math.max(2, n))));
}

/** Parse a Verilog number such as 4'd2, 8'hFF, 1'b0 or 12. Returns its width, or undefined when it is not a number. */
export function literalWidth(value: string): number | undefined {
  const v = value.trim().replace(/_/g, '');
  const sized = /^(\d+)\s*'[sS]?[bBoOdDhH][0-9a-fA-FxXzZ?]+$/.exec(v);
  if (sized) {
    const w = Number(sized[1]);
    return w > 0 && w <= 4096 ? w : undefined;
  }
  if (/^'[sS]?[bBoOdDhH][0-9a-fA-FxXzZ?]+$/.test(v) || /^\d+$/.test(v)) return 32;
  return undefined;
}

function port(nodeId: string, name: string, dir: 'in' | 'out', side: Side, width: number): DPort {
  return { id: `${nodeId}.${name}`, name, dir, side, width };
}

/** `[hi:lo]` names for `parts` slices of `width` bits each, MSB first. */
function sliceNames(parts: number, width: number): string[] {
  const out: string[] = [];
  for (let k = parts - 1; k >= 0; k--) {
    const lo = k * width;
    const hi = lo + width - 1;
    out.push(hi === lo ? `[${lo}]` : `[${hi}:${lo}]`);
  }
  return out;
}

/** The drawing node of a placed symbol. */
export function symbolNode(u: UserNode, iface: InterfaceOf): DNode {
  const id = u.id;
  const p = u.params;
  const w = clampParam('width', p.width, 1);
  const name = u.name ?? '';
  switch (u.sym) {
    case 'input':
      return { id, kind: 'input', label: name || 'in', ports: [port(id, 'out', 'out', 'EAST', w)], src: [] };
    case 'output':
      return { id, kind: 'output', label: name || 'out', ports: [port(id, 'in', 'in', 'WEST', w)], src: [] };
    case 'inout':
      return {
        id,
        kind: 'inout',
        label: name || 'io',
        ports: [port(id, 'out', 'out', 'EAST', w), port(id, 'in', 'in', 'WEST', w)],
        src: [],
      };
    case 'const': {
      const value = (p.value ?? "1'b0").trim() || "1'b0";
      return { id, kind: 'const', label: value, ports: [port(id, 'out', 'out', 'EAST', literalWidth(value) ?? 32)], src: [] };
    }
    case 'text':
      return { id, kind: 'text', label: name || 'Note', ports: [], src: [] };
    case 'concat': {
      const parts = clampParam('parts', p.parts, 2);
      const ports = sliceNames(parts, w).map((n) => port(id, n, 'in', 'WEST', w));
      return { id, kind: 'join', label: '{ }', ports: [...ports, port(id, 'out', 'out', 'EAST', parts * w)], src: [] };
    }
    case 'split': {
      const parts = clampParam('parts', p.parts, 2);
      const ports = sliceNames(parts, w).map((n) => port(id, n, 'out', 'EAST', w));
      return { id, kind: 'split', label: '}{', ports: [port(id, 'in', 'in', 'WEST', parts * w), ...ports], src: [] };
    }
    case 'block': {
      const module = p.module ?? '';
      const info = module ? iface(module) : undefined;
      const ports = (info?.ports ?? []).map((q) =>
        q.dir === 'output'
          ? port(id, q.name, 'out', 'EAST', q.width)
          : { ...port(id, q.name, 'in', 'WEST', q.width), ...(q.dir === 'inout' ? { inout: true } : {}) },
      );
      return {
        id,
        kind: 'instance',
        // A module that is missing is named as the user wrote it (`baud_gen #(DIV=10)`), as the panels name it.
        label: info?.label ?? (module ? moduleTitle(module) : '(no module)'),
        subLabel: name || undefined,
        cellType: module,
        moduleName: module || undefined,
        instanceName: name || id,
        ports,
        src: [],
        // The module was deleted or renamed away: the block keeps its place but has no pins.
        ...(module && !info ? { attrs: { missingModule: true } } : {}),
      };
    }
    case 'raw': {
      const r = u.raw;
      if (!r) return { id, kind: 'text', label: '(missing symbol)', ports: [], src: [] };
      const label = r.kind === 'instance' ? r.label : r.kind === 'cell' || r.kind === 'const' || r.kind === 'join' || r.kind === 'split' ? r.label : name || r.label;
      return {
        ...r,
        id,
        label,
        subLabel: r.kind === 'instance' ? name || r.subLabel : r.subLabel,
        instanceName: r.kind === 'instance' ? name || r.instanceName : r.instanceName,
        ports: r.ports.map((q) => ({ ...q, id: `${id}.${q.name}` })),
      };
    }
    case 'mux': {
      const n = clampParam('inputs', p.inputs, 2);
      const sw = selectWidth(n);
      if (n === 2) {
        return {
          id,
          kind: 'cell',
          label: 'MUX',
          cellType: '$mux',
          ports: [port(id, 'A', 'in', 'WEST', w), port(id, 'B', 'in', 'WEST', w), port(id, 'S', 'in', 'SOUTH', 1), port(id, 'Y', 'out', 'EAST', w)],
          src: [],
        };
      }
      const ins = Array.from({ length: n }, (_, k) => port(id, `I${k}`, 'in', 'WEST', w));
      return {
        id,
        kind: 'cell',
        label: 'MUX',
        cellType: 'dc:mux',
        ports: [...ins, port(id, 'S', 'in', 'SOUTH', sw), port(id, 'Y', 'out', 'EAST', w)],
        src: [],
      };
    }
    default: {
      const type = CELL_TYPE[u.sym];
      if (!type) return { id, kind: 'text', label: `(unknown symbol ${u.sym})`, ports: [], src: [] };
      const cell = (ports: DPort[], attrs?: DNode['attrs']): DNode => ({
        id,
        kind: 'cell',
        label: OP_LABEL[type] ?? type,
        cellType: type,
        ports,
        src: [],
        attrs,
      });
      switch (u.sym) {
        case 'and':
        case 'or':
        case 'xor':
        case 'nand':
        case 'nor':
        case 'xnor': {
          const n = clampParam('inputs', p.inputs, 2);
          const ins = Array.from({ length: n }, (_, k) => port(id, gateInputName(k), 'in', 'WEST', w));
          return cell([...ins, port(id, 'Y', 'out', 'EAST', w)]);
        }
        case 'not':
        case 'buf':
          return cell([port(id, 'A', 'in', 'WEST', w), port(id, 'Y', 'out', 'EAST', w)]);
        case 'eq':
        case 'ne':
        case 'lt':
        case 'le':
        case 'gt':
        case 'ge':
          return cell([port(id, 'A', 'in', 'WEST', w), port(id, 'B', 'in', 'WEST', w), port(id, 'Y', 'out', 'EAST', 1)]);
        case 'shl':
        case 'shr': {
          const s = clampParam('shift', p.shift, 3);
          return cell([port(id, 'A', 'in', 'WEST', w), port(id, 'B', 'in', 'WEST', s), port(id, 'Y', 'out', 'EAST', w)]);
        }
        case 'decoder': {
          const n = Math.min(clampParam('width', p.width, 2), 8);
          return cell([port(id, 'A', 'in', 'WEST', n), port(id, 'Y', 'out', 'EAST', 2 ** n)], { inputs: n, outputs: 2 ** n });
        }
        case 'dff':
          return cell([port(id, 'D', 'in', 'WEST', w), port(id, 'CLK', 'in', 'SOUTH', 1), port(id, 'Q', 'out', 'EAST', w)]);
        case 'dffe':
          return cell([
            port(id, 'D', 'in', 'WEST', w),
            port(id, 'EN', 'in', 'SOUTH', 1),
            port(id, 'CLK', 'in', 'SOUTH', 1),
            port(id, 'Q', 'out', 'EAST', w),
          ]);
        case 'adff':
          return cell([
            port(id, 'D', 'in', 'WEST', w),
            port(id, 'CLK', 'in', 'SOUTH', 1),
            port(id, 'ARST', 'in', 'SOUTH', 1),
            port(id, 'Q', 'out', 'EAST', w),
          ]);
        default:
          // add, sub, mul
          return cell([port(id, 'A', 'in', 'WEST', w), port(id, 'B', 'in', 'WEST', w), port(id, 'Y', 'out', 'EAST', w)]);
      }
    }
  }
}

/** A new placed symbol with the library defaults. */
export function newUserNode(id: string, sym: SymKey, extra: Partial<UserNode> = {}): UserNode {
  const def = SYMBOL_BY_KEY[sym];
  return { id, sym, params: { ...(def?.defaults ?? {}) }, ...extra };
}
