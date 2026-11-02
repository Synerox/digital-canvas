/**
 * Verilog export: write a drawing (drawn by hand, or imported and then edited)
 * as structural, synthesizable Verilog-2005 that Yosys can read back.
 *
 * - Every driver port that feeds at least one wire becomes a net (a `reg` for
 *   register outputs). Input pins drive the net of their own name.
 * - Every input port reads the net of its incoming wire, cut to the bits the
 *   wire carries (DEdge.bits, DEdge.shift; never its label text) and resized
 *   to the port's width, so concatenations and part-selects always see the
 *   widths the drawing shows.
 * - Cells become `assign` statements or `always` blocks, blocks become module
 *   instances, and output pins are assigned from their driver. Clock, enable and
 *   reset polarities, reset values and signed operands of imported cells
 *   (DNode.params) are written out (`negedge`, `if (!rst)`, `$signed(a)`).
 * - Inout ports of blocks are never tied to a constant: an open one is left
 *   open (`.io()`), and inout ports joined by wires share one net.
 *
 * Problems in the drawing (open inputs, width mismatches, cells that have no
 * Verilog form) become warnings rather than errors, so a half-finished drawing
 * still exports to code that elaborates.
 */
import type { DEdge, DNode, DPort, Diagram } from '../core/diagram';
import { formatConst } from '../core/ir';
import { moduleTitle } from '../core/names';
import { AUTO_SEPARATOR } from '../core/partition';
import { ARITHMETIC } from '../core/rules';

export interface VerilogExport {
  /** The Verilog text of one module. */
  code: string;
  /** Problems found in the drawing, in the order they were met (the code is written anyway). */
  warnings: string[];
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/** Verilog-2005 and SystemVerilog keywords (the app reads every file with `read_verilog -sv`). */
const KEYWORDS = new Set(
  `always and assign automatic begin buf bufif0 bufif1 case casex casez cell cmos config deassign default
  defparam design disable edge else end endcase endconfig endfunction endgenerate endmodule endprimitive
  endspecify endtable endtask event for force forever fork function generate genvar highz0 highz1 if ifnone
  incdir include initial inout input instance integer join large liblist library localparam macromodule
  medium module nand negedge nmos nor noshowcancelled not notif0 notif1 or output parameter pmos posedge
  primitive pull0 pull1 pulldown pullup pulsestyle_ondetect pulsestyle_onevent rcmos real realtime reg
  release repeat rnmos rpmos rtran rtranif0 rtranif1 scalared showcancelled signed small specify specparam
  strong0 strong1 supply0 supply1 table task time tran tranif0 tranif1 tri tri0 tri1 triand trior trireg
  unsigned use uwire vectored wait wand weak0 weak1 while wire wor xnor xor
  accept_on alias always_comb always_ff always_latch assert assume before bind bins binsof bit break byte
  chandle checker class clocking const constraint context continue cover covergroup coverpoint cross dist
  do endchecker endclass endclocking endgroup endinterface endpackage endprogram endproperty endsequence
  enum eventually expect export extends extern final first_match foreach forkjoin global iff ignore_bins
  illegal_bins implements implies import inside int interconnect interface intersect join_any join_none
  let local logic longint matches modport nettype new nexttime null package packed priority program
  property protected pure rand randc randcase randsequence ref reject_on restrict return s_always
  s_eventually s_nexttime s_until s_until_with sequence shortint shortreal soft solve static string strong
  struct super sync_accept_on sync_reject_on tagged this throughout timeprecision timeunit type typedef
  union unique unique0 until until_with untyped var virtual void wait_order weak wildcard with within`.split(/\s+/),
);

/** A legal Verilog identifier for a name (escape or replace characters, avoid keywords). */
export function verilogIdent(name: string): string {
  const s = name.trim();
  if (IDENT.test(s)) return KEYWORDS.has(s) ? `${s}_` : s;
  // Replace rather than escape (`\a b `): escaped names are legal but awkward to read and to type.
  let out = '';
  for (const c of s) {
    const code = c.codePointAt(0) ?? 0;
    // Non-ASCII letters (e.g. Chinese names) keep their code point so different names stay different.
    out += /[A-Za-z0-9_]/.test(c) ? c : code > 0x7f ? `_u${code.toString(16)}_` : '_';
  }
  out = out.replace(/_+/g, '_').replace(/^_|_$/g, '');
  if (!out) out = 'unnamed';
  if (/^[0-9]/.test(out)) out = `_${out}`;
  return KEYWORDS.has(out) ? `${out}_` : out;
}

/** Letters, digits and underscores of a name, for building a compound identifier such as `split1_7_4`. */
function identPart(name: string): string {
  return name.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
}

function isPlainIdent(s: string | undefined): s is string {
  return s !== undefined && IDENT.test(s) && !KEYWORDS.has(s);
}

// ---------------------------------------------------------------------------
// Values: a value is a list of segments (least significant first), each a bit
// range of a net or constant bits, so it can be sliced, padded and
// concatenated while the code is written.

type ConstBit = '0' | '1' | 'x' | 'z';

type Seg =
  | { kind: 'net'; name: string; lo: number; hi: number; netWidth: number }
  /** `text` keeps the literal as the user wrote it while the segment is unchanged. */
  | { kind: 'const'; bits: ConstBit[]; text?: string };

type Vec = Seg[];

function segWidth(s: Seg): number {
  return s.kind === 'net' ? s.hi - s.lo + 1 : s.bits.length;
}

function vecWidth(v: Vec): number {
  return v.reduce((n, s) => n + segWidth(s), 0);
}

function constVec(bits: ConstBit[], text?: string): Vec {
  return bits.length ? [{ kind: 'const', bits, text }] : [];
}

function zeros(width: number): Vec {
  return constVec(Array<ConstBit>(width).fill('0'));
}

function netVec(name: string, width: number): Vec {
  return [{ kind: 'net', name, lo: 0, hi: width - 1, netWidth: width }];
}

/** Bits lo..lo+width-1 of a value; bits above its top read as 0 (zero extension). */
function slice(v: Vec, lo: number, width: number): Vec {
  const out: Vec = [];
  const end = lo + width;
  let pos = 0;
  for (const s of v) {
    const w = segWidth(s);
    const a = Math.max(lo, pos);
    const b = Math.min(end, pos + w);
    if (a < b) {
      if (s.kind === 'net') out.push({ ...s, lo: s.lo + a - pos, hi: s.lo + b - 1 - pos });
      else out.push({ kind: 'const', bits: s.bits.slice(a - pos, b - pos), text: a === pos && b === pos + w ? s.text : undefined });
    }
    pos += w;
  }
  const have = vecWidth(out);
  return have < width ? [...out, ...zeros(width - have)] : out;
}

/** `{a, b, c}` with `a` the most significant part. */
function concat(msbFirst: Vec[]): Vec {
  return [...msbFirst].reverse().flat();
}

function isConstant(v: Vec): boolean {
  return v.every((s) => s.kind === 'const');
}

/** Join neighbouring constants, and neighbouring bit ranges of the same net. */
function merged(v: Vec): Vec {
  const out: Vec = [];
  for (const s of v) {
    const last = out[out.length - 1];
    if (last?.kind === 'const' && s.kind === 'const') {
      out[out.length - 1] = { kind: 'const', bits: [...last.bits, ...s.bits] };
    } else if (last?.kind === 'net' && s.kind === 'net' && last.name === s.name && last.hi + 1 === s.lo) {
      out[out.length - 1] = { ...last, hi: s.hi };
    } else {
      out.push(s);
    }
  }
  return out;
}

function segText(s: Seg): string {
  if (s.kind === 'const') return s.text ?? formatConst(s.bits);
  if (s.lo === 0 && s.hi === s.netWidth - 1) return s.name;
  return s.lo === s.hi ? `${s.name}[${s.lo}]` : `${s.name}[${s.hi}:${s.lo}]`;
}

/** Verilog text of a value. Always a primary (name, select, literal or concatenation), so it never needs parentheses. */
function render(v: Vec): string {
  const parts = merged(v).map(segText).reverse();
  if (parts.length === 0) return "1'b0";
  return parts.length === 1 ? parts[0] : `{${parts.join(', ')}}`;
}

/** Sized zero such as `1'b0` or `4'd0`. */
function zeroText(width: number): string {
  return render(zeros(Math.max(1, width)));
}

function rangeText(width: number): string {
  return width > 1 ? `[${width - 1}:0] ` : '';
}

function bitsText(n: number): string {
  return n === 1 ? '1 bit' : `${n} bits`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Comments must stay on one line. */
function oneLine(s: string): string {
  return s.replace(/[\r\n]+/g, ' ');
}

// ---------------------------------------------------------------------------
// Literals and what a wire carries.

interface Literal {
  /** LSB first, already at the literal's own width (32 bits or more when unsized). */
  bits: ConstBit[];
  sized: boolean;
  signed: boolean;
}

function toBits(v: bigint): ConstBit[] {
  const bits: ConstBit[] = [];
  do {
    bits.push(v & 1n ? '1' : '0');
    v >>= 1n;
  } while (v > 0n);
  return bits;
}

function padTo(bits: ConstBit[], width: number, fill: ConstBit): ConstBit[] {
  return bits.length >= width ? bits.slice(0, width) : [...bits, ...Array<ConstBit>(width - bits.length).fill(fill)];
}

/** Bits of a Verilog number such as 4'd2, 8'hF0, 3'b1x0, 'b1 or 12; undefined when the text is not a number. */
function parseLiteral(text: string): Literal | undefined {
  const t = text.replace(/[\s_]/g, '');
  if (/^\d+$/.test(t)) {
    const bits = toBits(BigInt(t));
    return { bits: padTo(bits, Math.max(32, bits.length), '0'), sized: false, signed: false };
  }
  const m = /^(\d*)'([sS]?)([bBoOdDhH])([0-9a-fA-FxXzZ?]+)$/.exec(t);
  if (!m) return undefined;
  const size = m[1] ? Number(m[1]) : undefined;
  if (size !== undefined && (size < 1 || size > 65536)) return undefined;
  const base = m[3].toLowerCase();
  const digits = m[4].toLowerCase().replace(/\?/g, 'z');
  let bits: ConstBit[] = [];
  if (base === 'd') {
    if (digits === 'x' || digits === 'z') bits = [digits];
    else if (/^\d+$/.test(digits)) bits = toBits(BigInt(digits));
    else return undefined;
  } else {
    const per = base === 'b' ? 1 : base === 'o' ? 3 : 4;
    for (const c of [...digits].reverse()) {
      if (c === 'x' || c === 'z') {
        for (let i = 0; i < per; i++) bits.push(c);
        continue;
      }
      const v = parseInt(c, 16);
      if (!(v < 2 ** per)) return undefined;
      for (let i = 0; i < per; i++) bits.push((v >> i) & 1 ? '1' : '0');
    }
  }
  // A literal whose top digit is x or z fills its own width with x or z; otherwise with zeros.
  const top = bits[bits.length - 1];
  const fill: ConstBit = top === 'x' || top === 'z' ? top : '0';
  return { bits: padTo(bits, size ?? Math.max(32, bits.length), fill), sized: size !== undefined, signed: m[2] !== '' };
}

/*
 * A wire's label is only text: the user may rename any wire to anything (`b[1:0]`, `a ×4`), and
 * that must never change the logic. What a wire carries comes from the drawing's data alone: the
 * bits of its driver (DEdge.bits, all of them when fullSource) and the low zero bits the import's
 * "scale" rule appends (DEdge.shift).
 */

/** Low zero bits appended to what a wire carries (`{x, 2'b00}` has shift 2). */
function edgeShift(e: DEdge): number {
  return e.shift !== undefined && Number.isInteger(e.shift) && e.shift > 0 && e.shift < 31 ? e.shift : 0;
}

/**
 * The bits of a `width`-bit driver a wire carries, when they are not all of them; undefined
 * for the whole driver, or when the drawing records no usable range.
 */
function edgeBits(e: DEdge, width: number): { lo: number; width: number } | undefined {
  const b = e.bits;
  if (!b || !Number.isInteger(b.lo) || !Number.isInteger(b.width) || b.lo < 0 || b.width < 1 || b.lo + b.width > width) return undefined;
  return b.width < width ? b : undefined;
}

/** A split port name such as `[7:4]` or `[3]`. */
function portRange(name: string): { hi: number; lo: number } | undefined {
  const m = /^\[\s*(\d+)\s*(?::\s*(\d+)\s*)?\]$/.exec(name.trim());
  if (!m) return undefined;
  const hi = Number(m[1]);
  return { hi, lo: m[2] === undefined ? hi : Number(m[2]) };
}

// ---------------------------------------------------------------------------
// Cells.

/** Gates with any number of inputs (A, B, C… in port order). */
const GATES: Record<string, { op: string; invert: boolean }> = {
  $and: { op: '&', invert: false },
  $or: { op: '|', invert: false },
  $xor: { op: '^', invert: false },
  $xnor: { op: '^', invert: true },
  'dc:nand': { op: '&', invert: true },
  'dc:nor': { op: '|', invert: true },
};

const UNARY: Record<string, string> = {
  $not: '~',
  'dc:buf': '',
  $pos: '',
  $neg: '-',
  $logic_not: '!',
  $reduce_and: '&',
  $reduce_or: '|',
  $reduce_xor: '^',
  $reduce_xnor: '~^',
  $reduce_bool: '|',
};

const BINARY: Record<string, string> = {
  $add: '+',
  $sub: '-',
  $mul: '*',
  $div: '/',
  $mod: '%',
  $pow: '**',
  $eq: '==',
  $ne: '!=',
  $lt: '<',
  $le: '<=',
  $gt: '>',
  $ge: '>=',
  $eqx: '===',
  $nex: '!==',
  $shl: '<<',
  $shr: '>>',
  $sshl: '<<<',
  $sshr: '>>>',
  // A signed shift amount (B_SIGNED) shifts left when negative; combExpr writes that case.
  $shift: '>>',
  $shiftx: '>>',
  $logic_and: '&&',
  $logic_or: '||',
};

/**
 * Shifts: only A's sign matters (a signed A is sign-extended). The amount B is unsigned, except
 * that a signed B of $shift and $shiftx may be negative.
 */
const SHIFTS = new Set(['$shl', '$shr', '$sshl', '$sshr', '$shift', '$shiftx']);

/** Operators whose result does not depend on the signedness of their operands. */
const SIGN_BLIND = new Set(['$logic_and', '$logic_or', '$logic_not', '$reduce_and', '$reduce_or', '$reduce_xor', '$reduce_xnor', '$reduce_bool']);

const SELECTS = new Set(['$mux', 'dc:mux', '$pmux', '$bmux', '$demux', '$tribuf', 'dc:and', 'dc:decoder']);

/**
 * Registers. Drawn ones have a rising clock and active-high enable and reset, and reset to 0;
 * imported ones may say otherwise in their params (CLK_POLARITY, ARST_VALUE…). Yosys makes a
 * $dffsr of a block with two asynchronous controls (`posedge set or posedge clr`), and an
 * $aldff of one whose asynchronous branch loads a signal rather than a constant.
 */
const REGISTERS = new Set([
  '$dff',
  '$dffe',
  '$adff',
  '$adffe',
  '$sdff',
  '$sdffe',
  '$dffsr',
  '$dffsre',
  '$aldff',
  '$aldffe',
  '$dlatch',
  '$adlatch',
  '$dlatchsr',
]);

/** Registers with an enable (EN). */
const ENABLED = new Set(['$dffe', '$adffe', '$sdffe', '$dffsre', '$aldffe', '$dlatch', '$adlatch', '$dlatchsr']);

/**
 * Statements that only mean something in simulation (`$display`, `assert`…). Yosys keeps them as
 * cells without outputs: they change nothing the circuit computes, so the export leaves them out.
 */
const SIMULATION_ONLY = new Set(['$print', '$check', '$assert', '$assume', '$cover', '$live', '$fair']);

/** A 1-bit Yosys parameter of a cell, e.g. CLK_POLARITY; `dflt` when the cell does not set it. */
function paramFlag(n: DNode, name: string, dflt: boolean): boolean {
  const v = n.params?.[name];
  return v === undefined ? dflt : /1/.test(v);
}

function isPrimitive(type: string): boolean {
  return type.startsWith('$') || type.startsWith('dc:');
}

function isSupported(type: string): boolean {
  return type in GATES || type in UNARY || type in BINARY || SELECTS.has(type) || REGISTERS.has(type);
}

function isPin(n: DNode): boolean {
  return n.kind === 'input' || n.kind === 'output' || n.kind === 'inout';
}

/**
 * A module name the user never typed: an automatic block (`top/crop_points`) or a module
 * Yosys derived (`$paramod\sub\W=…`). It is written as a legal name without a warning,
 * which would only suggest that something in the user's design is wrong.
 */
function isMadeUpModule(name: string): boolean {
  return name.includes(AUTO_SEPARATOR) || name.startsWith('$');
}

/** Instances, and cells whose type is a module rather than a Yosys primitive (e.g. blackbox cells). */
function isInstanceNode(n: DNode): boolean {
  return n.kind === 'instance' || (n.kind === 'cell' && !!n.cellType && !isPrimitive(n.cellType));
}

function isRegister(n: DNode): boolean {
  return n.kind === 'cell' && REGISTERS.has(n.cellType ?? '');
}

/** A wire resolved to its end ports, driver first. */
interface Wire {
  edge: DEdge;
  from: DNode;
  fromPort: DPort;
  to: DNode;
  toPort: DPort;
}

interface Net {
  name: string;
  width: number;
  reg: boolean;
  /** False for nets the module header already declares (pins). */
  declare: boolean;
}

function findPort(n: DNode, ref: string): DPort | undefined {
  return n.ports.find((p) => p.id === ref) ?? n.ports.find((p) => p.name === ref);
}

/** Write a drawing as one Verilog module named `moduleName`. Same input, same text. */
export function diagramToVerilog(d: Diagram, moduleName: string): VerilogExport {
  const warnings: string[] = [];
  const warn = (msg: string) => {
    if (!warnings.includes(msg)) warnings.push(msg);
  };

  const nodes = d.nodes.filter((n) => n.kind !== 'text');
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const key = (n: DNode, p: DPort) => `${n.id}\n${p.name}`;

  // Short readable names for operators (add1, mux2…), numbered per kind in drawing order.
  const short = new Map<string, string>();
  const counters = new Map<string, number>();
  for (const n of nodes) {
    let base: string | undefined;
    if (n.kind === 'cell') base = identPart((n.cellType ?? '').replace(/^\$|^dc:/, '')) || 'cell';
    else if (n.kind === 'join') base = 'cat';
    else if (n.kind === 'split') base = 'split';
    if (!base) continue;
    const k = (counters.get(base) ?? 0) + 1;
    counters.set(base, k);
    short.set(n.id, /\d$/.test(base) ? `${base}_${k}` : `${base}${k}`);
  }

  // Identifiers. Pins and instance names come first so they keep the names the user gave.
  const used = new Set<string>();
  const take = (base: string): string => {
    let name = base;
    for (let i = 2; used.has(name); i++) name = `${base}_${i}`;
    used.add(name);
    return name;
  };
  const takeNamed = (raw: string, what: string, quiet = false): string => {
    const ident = verilogIdent(raw);
    const name = take(ident);
    if (!quiet && name !== raw) {
      warn(
        ident !== raw
          ? `${what} '${raw}' is not a legal Verilog name; it is written as ${name}`
          : `${what} name '${raw}' is used more than once; this one is written as ${name}`,
      );
    }
    return name;
  };

  const modName = verilogIdent(moduleName);
  if (modName !== moduleName && !isMadeUpModule(moduleName)) warn(`Module name '${moduleName}' is not a legal Verilog name; it is written as ${modName}`);

  const pinName = new Map<string, string>();
  // The pins of an automatic block are named by the import (`mix[1:0]`); only a name the user typed is worth a warning.
  for (const n of nodes) if (isPin(n)) pinName.set(n.id, takeNamed(n.label, 'Pin', n.attrs?.autoName === n.label));
  const instName = new Map<string, string>();
  for (const n of nodes) {
    if (!isInstanceNode(n)) continue;
    // The drawn name first: a rename of an imported instance only changes subLabel (instanceName keeps
    // the Yosys name for the breadcrumb). Drawn blocks have both set to the same name.
    const raw = n.subLabel ?? n.instanceName ?? (n.kind === 'cell' ? short.get(n.id) : undefined) ?? `u_${n.moduleName ?? 'block'}`;
    // Blocks placed without a name get an automatic ID; renaming that is not worth a warning.
    instName.set(n.id, takeNamed(raw, 'Instance', n.kind === 'instance' && n.subLabel === undefined));
  }

  /**
   * An instance's module as the user wrote it (`baud_gen #(DIV=10)`), not as Yosys names it, nor as the code writes
   * it (`paramod_baud_gen_DIV_…`, which the caller may give as `moduleName`; `cellType` keeps Yosys's name).
   */
  const moduleTitleOf = (n: DNode): string => {
    const m = n.cellType?.startsWith('$paramod') ? n.cellType : (n.moduleName ?? n.cellType);
    return m === undefined ? 'no module' : moduleTitle(m);
  };
  const describe = (n: DNode): string => {
    if (isPin(n)) return `${n.kind} '${n.label}'`;
    if (n.kind === 'const') return `constant ${n.label}`;
    if (n.kind === 'join') return `concatenation ${short.get(n.id)}`;
    if (n.kind === 'split') return `split ${short.get(n.id)}`;
    if (isInstanceNode(n)) return `instance ${instName.get(n.id)} (${moduleTitleOf(n)})`;
    // `dc:mux` is the app's own name for a MUX symbol; Yosys types such as `$and` stay as they are.
    return `${short.get(n.id)} (${(n.cellType ?? 'cell').replace(/^dc:/, '')})`;
  };
  /** Where a value is read, for warnings: "output 's'" or "input B of and1 ($and)". */
  const where = (n: DNode, p: DPort): string => (isPin(n) ? describe(n) : `${p.inout ? 'inout' : 'input'} ${p.name} of ${describe(n)}`);
  const source = (n: DNode, p: DPort): string => {
    if (isPin(n)) return describe(n);
    return n.ports.filter((q) => q.dir === 'out').length > 1 ? `output ${p.name} of ${describe(n)}` : describe(n);
  };

  // Resolve wires to ports. Outputs drive, and so do inout ports of blocks (wired as inputs, dir 'in').
  const drives = (p: DPort) => p.dir === 'out' || !!p.inout;
  const wires: Wire[] = [];
  for (const e of d.edges) {
    let from = byId.get(e.source.node);
    let to = byId.get(e.target.node);
    let fromPort = from && findPort(from, e.source.port);
    let toPort = to && findPort(to, e.target.port);
    if (!from || !to || !fromPort || !toPort) {
      warn(`Wire ${e.id} does not connect two ports of the drawing; it is ignored`);
      continue;
    }
    // A wire drawn from an input to an output, or from a plain input to an inout port, is turned around.
    if ((fromPort.dir === 'in' && toPort.dir === 'out') || (fromPort.dir === 'in' && !fromPort.inout && toPort.inout)) {
      [from, fromPort, to, toPort] = [to, toPort, from, fromPort];
    }
    if (!drives(fromPort) || toPort.dir !== 'in') {
      warn(`Wire from ${describe(from)} to ${describe(to)} joins two ${fromPort.dir === 'out' ? 'outputs' : 'inputs'}; it is ignored`);
      continue;
    }
    // The import draws a wire from an inout pin to itself when nothing inside drives the pin; it carries nothing
    // (written out, `assign io = io;` would fight every other driver of the pin).
    if (from === to && from.kind === 'inout') continue;
    wires.push({ edge: e, from, fromPort, to, toPort });
  }
  const outgoing = new Map<string, Wire[]>();
  const incoming = new Map<string, Wire[]>();
  for (const w of wires) {
    const ko = key(w.from, w.fromPort);
    const ki = key(w.to, w.toPort);
    outgoing.set(ko, [...(outgoing.get(ko) ?? []), w]);
    // A wire from an inout port of a block to an inout pin joins the two (see buses below); it does not drive the pin.
    if (!(w.fromPort.inout && w.to.kind === 'inout')) incoming.set(ki, [...(incoming.get(ki) ?? []), w]);
  }

  // Buses: inout ports of blocks that wires join, directly or through each other, share one net. An inout
  // port may drive its net from inside its block, so it is never tied to a constant, and when the bus is
  // also wired to a driver or to an inout pin, every port connects to that net itself (not to a copy).
  interface Bus {
    members: { n: DNode; p: DPort }[];
    /** Wires into the bus from drivers that are not inout ports of blocks (the first one gives its net). */
    anchors: Wire[];
    /** The inout pin of this module the bus is wired to: the bus is the pin's net. */
    pin?: DNode;
    /** Wires out of the bus, including the ones that join its ports (they name its net). */
    out: Wire[];
    net?: Net;
    value?: Vec;
  }
  const busRoot = new Map<string, string>();
  const rootOf = (k: string): string => {
    let r = k;
    while (busRoot.get(r) !== r) r = busRoot.get(r)!;
    return r;
  };
  for (const n of nodes) for (const p of n.ports) if (p.inout) busRoot.set(key(n, p), key(n, p));
  for (const w of wires) {
    if (w.fromPort.inout && w.toPort.inout) busRoot.set(rootOf(key(w.to, w.toPort)), rootOf(key(w.from, w.fromPort)));
  }
  const buses = new Map<string, Bus>();
  const busOf = new Map<string, Bus>();
  for (const n of nodes) {
    for (const p of n.ports) {
      if (!p.inout) continue;
      const root = rootOf(key(n, p));
      const b = buses.get(root) ?? { members: [], anchors: [], out: [] };
      buses.set(root, b);
      b.members.push({ n, p });
      busOf.set(key(n, p), b);
    }
  }
  for (const w of wires) {
    const src = busOf.get(key(w.from, w.fromPort));
    if (src) {
      src.out.push(w);
      if (w.to.kind === 'inout') {
        if (!src.pin) src.pin = w.to;
        else if (src.pin !== w.to) warn(`${capitalize(where(w.from, w.fromPort))} is wired to two inout pins; only ${describe(src.pin)} is connected`);
      }
    } else {
      busOf.get(key(w.to, w.toPort))?.anchors.push(w);
    }
  }

  // Nets: one per driver port that feeds at least one wire. Constants are written in place instead.
  const nets = new Map<string, Net>();
  /** A driver (or a bus that nothing outside drives) that still needs a net name. */
  interface Pending {
    n: DNode;
    p: DPort;
    k: string;
    width: number;
    /** The wires it drives. */
    wires: Wire[];
    bus?: Bus;
  }
  const pending: Pending[] = [];
  for (const n of nodes) {
    for (const p of n.ports) {
      const k = key(n, p);
      const b = busOf.get(k);
      if (b) {
        // Named once, at its first port; a bus with no wires at all is left open.
        if (b.members[0].p === p && !b.pin && b.anchors.length === 0 && b.out.length > 0) {
          pending.push({ n, p, k, width: Math.max(...b.members.map((m) => Math.max(1, m.p.width))), wires: b.out, bus: b });
        }
        continue;
      }
      if (p.dir !== 'out' || n.kind === 'const' || !outgoing.has(k)) continue;
      if (n.kind === 'input' || n.kind === 'inout') nets.set(k, { name: pinName.get(n.id)!, width: Math.max(1, p.width), reg: false, declare: false });
      else pending.push({ n, p, k, width: Math.max(1, p.width), wires: outgoing.get(k)! });
    }
  }
  const setNet = (x: Pending, name: string, declare = true) => {
    const net: Net = { name, width: x.width, reg: isRegister(x.n), declare };
    nets.set(x.k, net);
    if (x.bus) x.bus.net = net;
  };
  /** A wire that carries its whole driver unchanged (no slice or scale). */
  const isPlainWire = (w: Wire) => {
    const width = Math.max(1, w.fromPort.width);
    return !edgeShift(w.edge) && !edgeBits(w.edge, width) && (w.edge.fullSource || w.edge.width >= width);
  };

  // 1. A name the user wrote on one of its wires.
  for (const x of pending) {
    const label = x.wires.map((w) => w.edge.label?.trim()).find((l) => isPlainIdent(l) && !used.has(l));
    if (label) setNet(x, take(label));
  }
  // 2. A driver that feeds an output pin through a plain wire drives that pin directly (`assign s = a ^ b;`).
  //    The same for an inout pin, where it also matters: its other readers then read the pin, which
  //    carries what is driven from outside too, not just this driver. Not a bus: the ports on it may
  //    drive it too, so it keeps a net of its own.
  const drivenPins = new Set<string>();
  for (const x of pending) {
    if (nets.has(x.k) || isRegister(x.n) || x.bus) continue;
    const w = x.wires.find(
      (w) =>
        (w.to.kind === 'output' || w.to.kind === 'inout') &&
        !drivenPins.has(w.to.id) &&
        w.toPort.width === x.p.width &&
        incoming.get(key(w.to, w.toPort))!.length === 1 &&
        isPlainWire(w),
    );
    if (!w) continue;
    drivenPins.add(w.to.id);
    setNet(x, pinName.get(w.to.id)!, false);
  }
  // 3. The signal name an import recorded on its wires.
  for (const x of pending) {
    if (nets.has(x.k)) continue;
    const name = x.wires
      .filter((w) => w.edge.fullSource)
      .map((w) => w.edge.netName?.trim())
      .find((l) => isPlainIdent(l) && !used.has(l));
    if (name) setNet(x, take(name));
  }
  // 4. <node>_<port>, e.g. add1_Y or u_inc_y.
  for (const x of pending) {
    if (nets.has(x.k)) continue;
    const node = instName.get(x.n.id) ?? short.get(x.n.id) ?? 'n';
    setNet(x, take(verilogIdent(`${node}_${identPart(x.p.name) || 'out'}`)));
  }

  /** The constant a wire from a const node delivers to a port of `width` bits. */
  const constAt = (c: DNode, at: string, width: number): Vec => {
    const lit = parseLiteral(c.label);
    if (!lit) {
      warn(`Constant '${c.label}' is not a Verilog number; ${at} reads 0`);
      return zeros(width);
    }
    const have = lit.bits.length;
    // The user's text is kept only for sized literals: an unsized one ('hFF, 12) is illegal inside a
    // concatenation, and the value may end up in one, so it is written sized (32'd255).
    if (have === width) return constVec(lit.bits, lit.sized && !lit.signed ? c.label.replace(/\s+/g, '') : undefined);
    if (lit.sized) {
      warn(`Width mismatch: constant ${c.label} is ${bitsText(have)} but ${at} is ${bitsText(width)}; ${have < width ? 'zero-extended' : 'the high bits are dropped'}`);
    } else if (lit.bits.slice(width).some((b) => b !== '0')) {
      warn(`Constant ${c.label} does not fit in the ${bitsText(width)} of ${at}; the high bits are dropped`);
    }
    return constVec(padTo(lit.bits, width, lit.signed ? lit.bits[have - 1] : '0'));
  };

  /**
   * The net a bus connects its ports to: the inout pin it is wired to, else the value of its first
   * driver, else its own net; undefined when nothing is wired to it (its ports are left open).
   */
  const busValue = (b: Bus): Vec | undefined => {
    if (b.pin) return netVec(pinName.get(b.pin.id)!, Math.max(1, b.pin.ports.find((q) => q.dir === 'out')?.width ?? 1));
    const [w, ...more] = b.anchors;
    if (w) {
      if (!b.value) {
        if (more.length) warn(`The bus on ${where(w.to, w.toPort)} is driven by ${b.anchors.length} wires; only the one from ${source(w.from, w.fromPort)} is used`);
        // Not fitted to the port: padding it would tie the missing bits of an inout port to 0.
        b.value = w.from.kind === 'const' ? constAt(w.from, where(w.to, w.toPort), Math.max(1, w.toPort.width)) : wireVec(w);
      }
      return b.value;
    }
    return b.net && netVec(b.net.name, b.net.width);
  };

  /** The value a driver port puts on its wires: its net, or the bus an inout port is on. */
  const sourceVec = (n: DNode, p: DPort): Vec => {
    const b = busOf.get(key(n, p));
    if (b) return busValue(b) ?? zeros(Math.max(1, p.width));
    const net = nets.get(key(n, p))!;
    return netVec(net.name, net.width);
  };

  /** The value a wire delivers, before it is fitted to the port: the driver net, or the bits of it the wire carries. */
  const wireVec = (w: Wire): Vec => {
    let v = sourceVec(w.from, w.fromPort);
    const width = vecWidth(v);
    const e = w.edge;
    const b = edgeBits(e, width);
    if (b) {
      v = slice(v, b.lo, b.width);
    } else if (!e.fullSource && e.width >= 1 && e.width < width) {
      warn(`The wire from ${source(w.from, w.fromPort)} to ${where(w.to, w.toPort)} carries ${e.width} of ${width} bits but records no bit range; the low bits are used`);
      v = slice(v, 0, e.width);
    }
    const k = edgeShift(e);
    return k ? [...zeros(k), ...v] : v;
  };

  /** The value an input port reads, exactly as wide as the port. */
  const sinkVec = (n: DNode, p: DPort): Vec => {
    const width = Math.max(1, p.width);
    const at = where(n, p);
    const ws = incoming.get(key(n, p)) ?? [];
    if (ws.length === 0) {
      warn(`${capitalize(at)} is not connected; it reads 0`);
      return zeros(width);
    }
    // A wire drawn by hand (`w:` IDs) wins over imported ones: it is what the user wants there, e.g.
    // after a re-import brings back an imported driver the user had replaced by their own logic.
    const w = ws.find((x) => x.edge.id.startsWith('w:')) ?? ws[0];
    if (ws.length > 1) warn(`${capitalize(at)} is driven by ${ws.length} wires; only the one from ${source(w.from, w.fromPort)} is used`);
    if (w.from.kind === 'const') return constAt(w.from, at, width);
    const v = wireVec(w);
    const have = vecWidth(v);
    if (have === width) return v;
    // Verilog zero-extends the operands of unsigned arithmetic and compares, and the import's "Hide zero
    // extension" rule draws `{2'b00, x}` there as a narrower wire: no mistake to warn about (as in checkSheet).
    // A signed operator would sign-extend instead, so there the padding is worth a warning.
    const signed = paramFlag(n, 'A_SIGNED', false) && paramFlag(n, 'B_SIGNED', false);
    const widened = have < width && n.kind === 'cell' && ARITHMETIC.has(n.cellType ?? '') && !signed;
    if (!widened) {
      warn(
        `Width mismatch: ${at} is ${bitsText(width)} but its wire from ${source(w.from, w.fromPort)} carries ${bitsText(have)}; ${have < width ? 'zero-extended' : 'the high bits are dropped'}`,
      );
    }
    return slice(v, 0, width);
  };

  /** What an inout port of a block connects to: its bus (nothing when the bus is open), never a constant fill. */
  const inoutText = (n: DNode, p: DPort): string => {
    const v = busValue(busOf.get(key(n, p))!);
    if (!v) return '';
    const width = Math.max(1, p.width);
    const have = vecWidth(v);
    if (have === width) return render(v);
    warn(
      `Width mismatch: ${where(n, p)} is ${bitsText(width)} but its bus carries ${bitsText(have)}; ${have < width ? 'the high bits of the port are left open' : 'the high bits are dropped'}`,
    );
    return render(have < width ? v : slice(v, 0, width));
  };
  /** The value an input port reads, by port name; a missing port reads 0. */
  const input = (n: DNode, name: string, width = 1): Vec => {
    const p = n.ports.find((q) => q.dir === 'in' && q.name === name);
    if (p) return sinkVec(n, p);
    warn(`${capitalize(describe(n))} has no input ${name}; it reads 0`);
    return zeros(width);
  };
  const portWidth = (n: DNode, name: string, fallback = 1) => Math.max(1, n.ports.find((p) => p.name === name)?.width ?? fallback);
  const netOf = (n: DNode, p: DPort | undefined) => (p ? nets.get(key(n, p)) : undefined);

  const decls: string[] = [];
  const assigns: string[] = [];
  const blocks: string[] = [];
  const insts: string[] = [];
  const pinAssigns: string[] = [];

  /** Join (concatenation bar) of each net a bar drives. */
  const joinOfNet = new Map<string, DNode>();
  for (const n of nodes) {
    if (n.kind !== 'join') continue;
    const net = netOf(n, n.ports.find((p) => p.dir === 'out'));
    if (net) joinOfNet.set(net.name, n);
  }
  /**
   * A value with the nets of concatenation bars replaced by what the bars join. Ports that hold
   * several values side by side (the cases of a MUX, the ports of a memory) are fed by bars:
   * seen through the bar, each value is named by itself (`7'd64`, `clk`), not as a slice of the bar.
   */
  const throughJoins = (v: Vec, depth = 0): Vec =>
    v.flatMap((s) => {
      const j = s.kind === 'net' ? joinOfNet.get(s.name) : undefined;
      if (!j || s.kind !== 'net' || depth > 16) return [s];
      const joined = slice(concat(j.ports.filter((p) => p.dir === 'in').map((p) => sinkVec(j, p))), 0, s.netWidth);
      return throughJoins(slice(joined, s.lo, s.hi - s.lo + 1), depth + 1);
    });

  /** Right-hand side of a combinational cell, or undefined when it has no Verilog form here. */
  const combExpr = (n: DNode, type: string, yWidth: number): string | undefined => {
    // Signed operands (A_SIGNED, B_SIGNED) are written the way Yosys' own cell library defines them:
    // most operators are signed only when both operands are, a shift only looks at A, and ** at each.
    const aSigned = paramFlag(n, 'A_SIGNED', false) && !SIGN_BLIND.has(type);
    const bSigned = paramFlag(n, 'B_SIGNED', false) && !SIGN_BLIND.has(type);
    const signed = (text: string, yes: boolean) => (yes ? `$signed(${text})` : text);
    const gate = GATES[type];
    if (gate) {
      const ins = n.ports.filter((p) => p.dir === 'in').map((p) => signed(render(sinkVec(n, p)), aSigned && bSigned));
      if (ins.length === 0) return undefined;
      const e = ins.join(` ${gate.op} `);
      return gate.invert ? `~(${e})` : e;
    }
    if (type in UNARY) return `${UNARY[type]}${signed(render(input(n, 'A')), aSigned)}`;
    if (type in BINARY) {
      const shift = SHIFTS.has(type);
      // $shiftx is a part-select (A[B +: n]): bits outside A are undefined, so A's sign does not matter.
      const a = signed(render(input(n, 'A')), shift || type === '$pow' ? aSigned && type !== '$shiftx' : aSigned && bSigned);
      const b = render(input(n, 'B'));
      // A signed amount of $shift/$shiftx moves the other way when it is negative.
      if ((type === '$shift' || type === '$shiftx') && bSigned) return `($signed(${b}) < 0) ? ${a} << -${b} : ${a} >> ${b}`;
      return `${a} ${BINARY[type]} ${signed(b, shift ? false : type === '$pow' ? bSigned : aSigned && bSigned)}`;
    }
    switch (type) {
      case '$mux': {
        const a = render(input(n, 'A'));
        const b = render(input(n, 'B'));
        const s = render(input(n, 'S'));
        return `${s} ? ${b} : ${a}`;
      }
      case 'dc:mux': {
        const data = n.ports
          .filter((p) => p.dir === 'in' && /^I\d+$/.test(p.name))
          .sort((p, q) => Number(p.name.slice(1)) - Number(q.name.slice(1)));
        const sw = portWidth(n, 'S');
        if (data.length > 2 ** sw) warn(`${capitalize(describe(n))} has more inputs than its select can pick; the extra inputs are ignored`);
        const vals = data.slice(0, 2 ** sw).map((p) => render(sinkVec(n, p)));
        if (vals.length === 0) return undefined;
        const s = render(input(n, 'S'));
        let e = vals[vals.length - 1];
        for (let k = vals.length - 2; k >= 0; k--) e = `(${s} == ${sw}'d${k}) ? ${vals[k]} : ${e}`;
        return e;
      }
      case '$pmux': {
        // A when no select bit is set, else the slice of B for the lowest set bit of the one-hot S.
        const a = input(n, 'A', yWidth);
        const w = vecWidth(a);
        const b = throughJoins(input(n, 'B', yWidth));
        const s = throughJoins(input(n, 'S'));
        let e = render(a);
        for (let k = vecWidth(s) - 1; k >= 0; k--) e = `${render(slice(s, k, 1))} ? ${render(slice(b, k * w, w))} : ${e}`;
        return e;
      }
      case '$bmux': {
        // Y = A[S*W +: W], written as a chain so A may be any value.
        const sw = portWidth(n, 'S');
        if (sw > 8) return undefined;
        const a = input(n, 'A', yWidth);
        const s = render(input(n, 'S'));
        const count = 2 ** sw;
        let e = render(slice(a, (count - 1) * yWidth, yWidth));
        for (let k = count - 2; k >= 0; k--) e = `(${s} == ${sw}'d${k}) ? ${render(slice(a, k * yWidth, yWidth))} : ${e}`;
        return e;
      }
      case '$demux': {
        // Y slice S is A, the others are 0.
        const sw = portWidth(n, 'S');
        if (sw > 8) return undefined;
        const a = input(n, 'A', yWidth);
        const s = render(input(n, 'S'));
        const parts: string[] = [];
        for (let k = 2 ** sw - 1; k >= 0; k--) parts.push(`((${s} == ${sw}'d${k}) ? ${render(a)} : ${zeroText(vecWidth(a))})`);
        return `{${parts.join(', ')}}`;
      }
      case '$tribuf': {
        const a = render(input(n, 'A', yWidth));
        const en = render(input(n, 'EN'));
        return `${en} ? ${a} : ${yWidth}'bz`;
      }
      case 'dc:and': {
        // A MUX that passes A or 0: A & B, or A & ~B when the drawing shows an inverted select.
        const a = input(n, 'A', yWidth);
        const w = vecWidth(a);
        let b = render(input(n, 'B'));
        if (n.attrs?.invertB === true) b = `~${b}`;
        return w > 1 ? `${render(a)} & {${w}{${b}}}` : `${render(a)} & ${b}`;
      }
      case 'dc:decoder':
        return `${yWidth}'b1 << ${render(input(n, 'A'))}`;
    }
    return undefined;
  };

  /**
   * A clock or reset for an event control: a net bit; 'idle' when it is a constant at its inactive
   * level (a reset that never fires); undefined for any other constant.
   */
  const eventSignal = (n: DNode, name: string, activeHigh: boolean): { text: string } | 'idle' | undefined => {
    const v = input(n, name);
    if (!isConstant(v)) return { text: render(v) };
    const idle = activeHigh ? '0' : '1';
    return v.every((s) => s.kind === 'const' && s.bits.every((b) => b === idle)) ? 'idle' : undefined;
  };
  const edgeOf = (activeHigh: boolean) => (activeHigh ? 'posedge' : 'negedge');
  const active = (text: string, activeHigh: boolean) => (activeHigh ? text : `!${text}`);
  /** What a reset loads: ARST_VALUE or SRST_VALUE (binary, MSB first), 0 when the cell does not set it. */
  const resetValue = (n: DNode, param: string, width: number): string => {
    const v = n.params?.[param];
    const ok = v !== undefined && /^[01xz]+$/.test(v);
    if (v !== undefined && !ok) warn(`The reset value '${v}' of ${describe(n)} is not a constant; it resets to 0`);
    return render(constVec(padTo(ok ? ([...v].reverse() as ConstBit[]) : [], width, '0')));
  };

  /**
   * An asynchronous control (reset, load) for an event control: a net bit, or 'idle' when it is a
   * constant at its inactive level (it never fires). One tied to its active level is given a wire,
   * so that the event control names a signal.
   */
  const eventName = (n: DNode, name: string, activeHigh: boolean): string | 'idle' => {
    const e = eventSignal(n, name, activeHigh);
    if (e) return e === 'idle' ? e : e.text;
    const wire = take(verilogIdent(`${short.get(n.id)}_${name}`));
    decls.push(`  wire ${wire};`);
    assigns.push(`  assign ${wire} = ${render(input(n, name))};`);
    return wire;
  };
  /**
   * The bits of the SET or CLR input of a register, one per bit of Q (each bit has its own): a net
   * bit, or 'idle' for a constant at the inactive level. For a flip-flop, a port with a constant at
   * its active level is given a wire, so that the event control names a signal.
   */
  const controlBits = (n: DNode, name: string, width: number, activeHigh: boolean, clocked: boolean): string[] => {
    const v = input(n, name, width);
    const inactive = activeHigh ? '0' : '1';
    const bits = [...Array(width).keys()];
    const idle = bits.map((i) => slice(v, i, 1).every((s) => s.kind === 'const' && s.bits.every((b) => b === inactive)));
    let named = v;
    if (clocked && bits.some((i) => !idle[i] && isConstant(slice(v, i, 1)))) {
      const wire = take(verilogIdent(`${short.get(n.id)}_${name}`));
      decls.push(`  wire ${rangeText(width)}${wire};`);
      assigns.push(`  assign ${wire} = ${render(v)};`);
      named = netVec(wire, width);
    }
    return bits.map((i) => (idle[i] ? 'idle' : render(slice(named, i, 1))));
  };
  /**
   * A register with a set and a clear input per bit ($dffsr, $dffsre, $dlatchsr), written as Yosys
   * defines it: clear wins over set, set over the clock (or enable). Bits that share their set and
   * clear signals share one block; the others get a block each.
   */
  const emitSetClear = (n: DNode, q: Net, d: Vec, en: string | undefined, onClk: string | undefined) => {
    const setHigh = paramFlag(n, 'SET_POLARITY', true);
    const clrHigh = paramFlag(n, 'CLR_POLARITY', true);
    const sets = controlBits(n, 'SET', q.width, setHigh, !!onClk);
    const clrs = controlBits(n, 'CLR', q.width, clrHigh, !!onClk);
    const op = onClk ? '<=' : '=';
    for (let lo = 0; lo < q.width; ) {
      let hi = lo;
      while (hi + 1 < q.width && sets[hi + 1] === sets[lo] && clrs[hi + 1] === clrs[lo]) hi++;
      const width = hi - lo + 1;
      const target = width === q.width ? q.name : lo === hi ? `${q.name}[${lo}]` : `${q.name}[${hi}:${lo}]`;
      const steps: string[] = [];
      const events = onClk ? [onClk] : [];
      if (clrs[lo] !== 'idle') {
        steps.push(`if (${active(clrs[lo], clrHigh)}) ${target} ${op} ${render(zeros(width))};`);
        events.push(`${edgeOf(clrHigh)} ${clrs[lo]}`);
      }
      if (sets[lo] !== 'idle') {
        steps.push(`if (${active(sets[lo], setHigh)}) ${target} ${op} ${render(constVec(Array<ConstBit>(width).fill('1')))};`);
        events.push(`${edgeOf(setHigh)} ${sets[lo]}`);
      }
      steps.push(`${en ? `if (${en}) ` : ''}${target} ${op} ${render(slice(d, lo, width))};`);
      const head = onClk ? `  always @(${events.join(' or ')})` : '  always @*';
      if (steps.length === 1) blocks.push(`${head} ${steps[0]}`);
      else blocks.push(head, `    ${steps[0]}`, ...steps.slice(1).map((s) => `    else ${s}`));
      lo = hi + 1;
    }
  };

  const emitRegister = (n: DNode, type: string) => {
    const qPort = n.ports.find((p) => p.dir === 'out' && p.name === 'Q') ?? n.ports.find((p) => p.dir === 'out');
    const q = netOf(n, qPort);
    if (!qPort || !q) {
      warn(`${capitalize(describe(n))} has no connected output; it is left out`);
      return;
    }
    const d = input(n, 'D', q.width);
    const dv = render(d);
    const en = ENABLED.has(type) ? active(render(input(n, 'EN')), paramFlag(n, 'EN_POLARITY', true)) : undefined;
    if (type === '$dlatch') {
      blocks.push(`  always @* if (${en}) ${q.name} = ${dv};`);
      return;
    }
    if (type === '$adlatch') {
      // A latch with an asynchronous reset: the reset wins over the enable.
      const high = paramFlag(n, 'ARST_POLARITY', true);
      const arst = render(input(n, 'ARST'));
      if (eventSignal(n, 'ARST', high) === 'idle') blocks.push(`  always @* if (${en}) ${q.name} = ${dv};`);
      else blocks.push('  always @*', `    if (${active(arst, high)}) ${q.name} = ${resetValue(n, 'ARST_VALUE', q.width)};`, `    else if (${en}) ${q.name} = ${dv};`);
      return;
    }
    if (type === '$dlatchsr') {
      emitSetClear(n, q, d, en, undefined);
      return;
    }
    const clkHigh = paramFlag(n, 'CLK_POLARITY', true);
    const clk = eventSignal(n, 'CLK', clkHigh);
    if (!clk || clk === 'idle') {
      warn(`The clock of ${describe(n)} is a constant; the register is left out`);
      return;
    }
    const onClk = `${edgeOf(clkHigh)} ${clk.text}`;
    const load = `${en ? `if (${en}) ` : ''}${q.name} <= ${dv};`;
    if (type === '$dffsr' || type === '$dffsre') {
      emitSetClear(n, q, d, en, onClk);
      return;
    }
    if (type === '$adff' || type === '$adffe' || type === '$aldff' || type === '$aldffe') {
      // An asynchronous reset loads ARST_VALUE; an asynchronous load ($aldff) loads its AD input.
      const loads = type === '$aldff' || type === '$aldffe';
      const high = paramFlag(n, loads ? 'ALOAD_POLARITY' : 'ARST_POLARITY', true);
      const name = eventName(n, loads ? 'ALOAD' : 'ARST', high);
      if (name === 'idle') {
        // A reset (or load) tied to its inactive level never fires: a plain register.
        blocks.push(`  always @(${onClk}) ${load}`);
        return;
      }
      const value = loads ? render(input(n, 'AD', q.width)) : resetValue(n, 'ARST_VALUE', q.width);
      blocks.push(`  always @(${onClk} or ${edgeOf(high)} ${name})`, `    if (${active(name, high)}) ${q.name} <= ${value};`, `    else ${load}`);
      return;
    }
    if (type === '$sdff' || type === '$sdffe') {
      const srst = active(render(input(n, 'SRST')), paramFlag(n, 'SRST_POLARITY', true));
      blocks.push(`  always @(${onClk})`, `    if (${srst}) ${q.name} <= ${resetValue(n, 'SRST_VALUE', q.width)};`, `    else ${load}`);
      return;
    }
    blocks.push(`  always @(${onClk}) ${load}`);
  };

  /** The MUX cell whose output net is `name`, if one drives it. */
  const muxOfNet = new Map<string, DNode>();
  for (const n of nodes) {
    if (n.kind !== 'cell' || n.cellType !== '$mux') continue;
    const net = netOf(n, n.ports.find((p) => p.dir === 'out' && p.name === 'Y'));
    if (net) muxOfNet.set(net.name, n);
  }
  /** The A or B bits of a MUX cell, seen through bars, as wide as its output. */
  const muxInput = (mux: DNode, name: string, width: number) => throughJoins(slice(input(mux, name, width), 0, width));
  /**
   * One bit of a write enable. Yosys makes `if (we) mem[a] <= d;` a MUX of constants
   * (`we ? 8'hFF : 8'h00`); each bit of it is `we` itself, so the bits share one enable and are
   * written by one statement, as in the source.
   */
  const enableBit = (v: Vec): Vec => {
    const s = v[0];
    const mux = v.length === 1 && s.kind === 'net' && s.lo === s.hi ? muxOfNet.get(s.name) : undefined;
    if (!mux || s.kind !== 'net') return v;
    const [a] = slice(muxInput(mux, 'A', s.netWidth), s.lo, 1);
    const [b] = slice(muxInput(mux, 'B', s.netWidth), s.lo, 1);
    if (a.kind !== 'const' || b.kind !== 'const') return v;
    if (a.bits[0] === b.bits[0]) return [a];
    return a.bits[0] === '0' && b.bits[0] === '1' ? throughJoins(input(mux, 'S')) : v;
  };
  /**
   * A value as a write under `if (en)` sees it: a MUX selected by `en` itself passes its B input
   * there (Yosys feeds the address and data of `if (we) mem[a] <= d;` through `we ? a : 2'bxx`).
   */
  const whenSelected = (v: Vec, en: string): Vec =>
    v.flatMap((s) => {
      const mux = s.kind === 'net' ? muxOfNet.get(s.name) : undefined;
      if (!mux || s.kind !== 'net' || render(throughJoins(input(mux, 'S'))) !== en) return [s];
      return slice(muxInput(mux, 'B', s.netWidth), s.lo, s.hi - s.lo + 1);
    });

  /**
   * A memory ($mem_v2, as the import draws a `reg [7:0] mem [0:3]` array) written the way Yosys
   * writes one: the array, its initial values, one clocked block per write clock (bits with their
   * own enable), and an assign per read port. When its parameters ask for something this form
   * cannot say, nothing is written and the reason is returned, for the caller to report.
   */
  const emitMemory = (n: DNode): string | undefined => {
    const param = (k: string) => n.params?.[k]?.trim() ?? '';
    const count = (k: string) => (/^[01]+$/.test(param(k)) ? parseInt(param(k), 2) : NaN);
    /** Bit i of a per-port flag parameter (binary, MSB first). */
    const flag = (k: string, i: number) => param(k).charAt(param(k).length - 1 - i) === '1';
    const [size, width, abits, offset, rdPorts, wrPorts] = ['SIZE', 'WIDTH', 'ABITS', 'OFFSET', 'RD_PORTS', 'WR_PORTS'].map(count);
    if (![size, width, abits, offset, rdPorts, wrPorts].every(Number.isSafeInteger) || size < 1 || width < 1) return 'has no Verilog form here';
    const anyPort = (k: string, total: number, set = true) => [...Array(total).keys()].some((i) => flag(k, i) === set);
    // The import never makes these: it does not run memory_dff or memory_share, and Verilog
    // writes to an array happen on a clock edge.
    if (anyPort('RD_CLK_ENABLE', rdPorts)) return 'has a clocked read port, which has no Verilog form here';
    if (anyPort('RD_WIDE_CONTINUATION', rdPorts) || anyPort('WR_WIDE_CONTINUATION', wrPorts)) return 'has wide ports, which have no Verilog form here';
    if (anyPort('WR_CLK_ENABLE', wrPorts, false)) return 'has a write port without a clock, which has no Verilog form here';

    const memid = param('MEMID').replace(/^\\/, '');
    const mem = take(verilogIdent(memid && !memid.startsWith('$') ? memid : (short.get(n.id) ?? 'mem')));
    decls.push(`  reg ${rangeText(width)}${mem} [${offset}:${offset + size - 1}];`);

    // INIT holds every word (MSB first); x bits are words nobody initialised.
    const init = param('INIT');
    const inits: string[] = [];
    for (let i = 0; i < size; i++) {
      const word = [...init.slice(Math.max(0, init.length - (i + 1) * width), Math.max(0, init.length - i * width))].reverse();
      if (word.length !== width || !word.every((b) => /^[01xz]$/.test(b)) || word.every((b) => b === 'x')) continue;
      inits.push(`    ${mem}[${offset + i}] = ${render(constVec(word as ConstBit[]))};`);
    }
    if (inits.length) blocks.push('  initial begin', ...inits, '  end');

    // Writes: ports of one clock share a block, in port order, so a later port wins as in Yosys.
    if (wrPorts > 0) {
      const clks = throughJoins(input(n, 'WR_CLK', wrPorts));
      const addrs = throughJoins(input(n, 'WR_ADDR', wrPorts * abits));
      const data = throughJoins(input(n, 'WR_DATA', wrPorts * width));
      const ens = throughJoins(input(n, 'WR_EN', wrPorts * width));
      const byClock = new Map<string, string[]>();
      for (let i = 0; i < wrPorts; i++) {
        const clk = slice(clks, i, 1);
        if (isConstant(clk)) {
          warn(`The clock of write port ${i} of ${describe(n)} is a constant; the port is left out`);
          continue;
        }
        const event = `${edgeOf(flag('WR_CLK_POLARITY', i))} ${render(clk)}`;
        const addr = slice(addrs, i * abits, abits);
        const lines = byClock.get(event) ?? [];
        byClock.set(event, lines);
        // Runs of bits with the same enable are written together: `if (we) mem[a] <= d;`.
        const enOf = (j: number) => enableBit(slice(ens, i * width + j, 1));
        for (let lo = 0; lo < width; ) {
          const en = enOf(lo);
          const enText = render(en);
          let hi = lo;
          while (hi + 1 < width && render(enOf(hi + 1)) === enText) hi++;
          // A constant enable writes always (1) or never (0, x).
          const seg = en[0];
          const always = seg.kind === 'const' ? (seg.bits[0] === '1' ? true : undefined) : false;
          if (always !== undefined) {
            const part = lo === 0 && hi === width - 1 ? '' : lo === hi ? `[${lo}]` : `[${hi}:${lo}]`;
            const value = render(whenSelected(slice(data, i * width + lo, hi - lo + 1), enText));
            const store = `${mem}[${render(whenSelected(addr, enText))}]${part} <= ${value};`;
            lines.push(always ? `    ${store}` : `    if (${enText}) ${store}`);
          }
          lo = hi + 1;
        }
      }
      for (const [event, lines] of byClock) if (lines.length) blocks.push(`  always @(${event}) begin`, ...lines, '  end');
    }

    // Reads: asynchronous, each port a slice of the RD_DATA net.
    const rdPort = n.ports.find((p) => p.dir === 'out' && p.name === 'RD_DATA');
    const rd = netOf(n, rdPort);
    if (rd && rdPorts > 0) {
      const addrs = throughJoins(input(n, 'RD_ADDR', rdPorts * abits));
      for (let i = 0; i < rdPorts; i++) {
        const lo = i * width;
        if (lo >= rd.width) break;
        const hi = Math.min(rd.width, lo + width) - 1;
        const target = lo === 0 && hi === rd.width - 1 ? rd.name : lo === hi ? `${rd.name}[${lo}]` : `${rd.name}[${hi}:${lo}]`;
        assigns.push(`  assign ${target} = ${mem}[${render(slice(addrs, i * abits, abits))}];`);
      }
    }
    return undefined;
  };

  const emitCell = (n: DNode) => {
    const type = n.cellType ?? '';
    const outs = n.ports.filter((p) => p.dir === 'out');
    if (SIMULATION_ONLY.has(type)) {
      warn(`${capitalize(describe(n))} is a simulation-only statement ($display, assert…); it is left out`);
      assigns.push(`  // ${oneLine(describe(n))}: simulation-only statement left out`);
      return;
    }
    const unwritable = type === '$mem_v2' ? emitMemory(n) : isSupported(type) ? undefined : 'has no Verilog form here';
    if (type === '$mem_v2' && !unwritable) return;
    if (unwritable) {
      // Only a cell that drives a wire leaves something undriven: one that drives nothing is just left out.
      if (!outs.some((p) => netOf(n, p))) {
        warn(`${capitalize(describe(n))} ${unwritable}; it drives nothing, so it is left out`);
        assigns.push(`  // ${oneLine(describe(n))}: no Verilog form; left out (it drives nothing)`);
        return;
      }
      warn(`${capitalize(describe(n))} ${unwritable}; its outputs are left undriven`);
      assigns.push(`  // ${oneLine(describe(n))}: no Verilog form; outputs left undriven`);
      return;
    }
    if (REGISTERS.has(type)) {
      emitRegister(n, type);
      return;
    }
    const yPort = outs.find((p) => p.name === 'Y') ?? outs[0];
    const y = netOf(n, yPort);
    if (!yPort || !y) {
      warn(`${capitalize(describe(n))} has no connected output; it is left out`);
      return;
    }
    const e = combExpr(n, type, Math.max(1, yPort.width));
    if (e === undefined) {
      warn(`${capitalize(describe(n))} cannot be written as Verilog; its output is left undriven`);
      assigns.push(`  // ${oneLine(describe(n))}: cannot be written; output left undriven`);
      return;
    }
    assigns.push(`  assign ${y.name} = ${e};`);
  };

  const emitJoin = (n: DNode) => {
    const out = n.ports.find((p) => p.dir === 'out');
    const net = netOf(n, out);
    if (!out || !net) return;
    // A bar read only through itself (see throughJoins) needs no net: it would be written and never used.
    const throughOnly = (w: Wire) => (w.to.cellType === '$pmux' && (w.toPort.name === 'B' || w.toPort.name === 'S')) || w.to.cellType === '$mem_v2';
    if (outgoing.get(key(n, out))?.every(throughOnly)) {
      net.declare = false;
      return;
    }
    const ins = n.ports.filter((p) => p.dir === 'in');
    let v = concat(ins.map((p) => sinkVec(n, p)));
    if (vecWidth(v) !== net.width) {
      warn(`${capitalize(describe(n))} joins ${bitsText(vecWidth(v))} into a ${bitsText(net.width)} output; ${vecWidth(v) < net.width ? 'zero-extended' : 'the high bits are dropped'}`);
      v = slice(v, 0, net.width);
    }
    assigns.push(`  assign ${net.name} = ${render(v)};`);
  };

  const emitSplit = (n: DNode) => {
    const outs = n.ports.filter((p) => p.dir === 'out');
    if (!outs.some((p) => netOf(n, p))) return;
    const inPort = n.ports.find((p) => p.dir === 'in');
    const inWidth = Math.max(1, inPort?.width ?? 1);
    const v = inPort ? sinkVec(n, inPort) : zeros(inWidth);
    // Ports are listed MSB first; a name that is not a valid range falls back to that position.
    let top = inWidth - 1;
    for (const p of outs) {
      const width = Math.max(1, p.width);
      const r = portRange(p.name);
      let lo: number;
      if (r && r.lo <= r.hi && r.hi < inWidth) {
        lo = r.lo;
      } else {
        lo = Math.max(0, top - width + 1);
        warn(`Output ${p.name} of ${describe(n)} is not a bit range of its ${inWidth}-bit input; bits ${lo + width - 1}:${lo} are used`);
      }
      top = lo - 1;
      const net = netOf(n, p);
      if (net) assigns.push(`  assign ${net.name} = ${render(slice(v, lo, width))};`);
    }
  };

  const emitInstance = (n: DNode) => {
    const inst = instName.get(n.id)!;
    const mod = (n.moduleName ?? n.cellType ?? '').trim();
    if (!mod) {
      warn(`${capitalize(describe(n))} has no module; it is left out`);
      return;
    }
    if (n.attrs?.missingModule) warn(`Module '${moduleTitle(mod)}' of instance ${inst} does not exist (deleted or renamed); the instance is written without connections`);
    const modIdent = verilogIdent(mod);
    if (modIdent !== mod && !isMadeUpModule(mod)) warn(`Module '${mod}' of instance ${inst} is not a legal Verilog name; it is written as ${modIdent}`);
    const conns = n.ports.map((p) => {
      const pn = verilogIdent(p.name);
      if (p.dir === 'out') return `.${pn}(${netOf(n, p)?.name ?? ''})`;
      if (p.inout) return `.${pn}(${inoutText(n, p)})`;
      return `.${pn}(${render(sinkVec(n, p))})`;
    });
    insts.push(conns.length ? `  ${modIdent} ${inst} (\n${conns.map((c) => `    ${c}`).join(',\n')}\n  );` : `  ${modIdent} ${inst} ();`);
  };

  for (const n of nodes) {
    if (isInstanceNode(n)) emitInstance(n);
    else if (n.kind === 'cell') emitCell(n);
    else if (n.kind === 'join') emitJoin(n);
    else if (n.kind === 'split') emitSplit(n);
    else if (n.kind === 'output' || n.kind === 'inout') {
      const p = n.ports.find((q) => q.dir === 'in');
      if (!p || drivenPins.has(n.id)) continue;
      if (!incoming.has(key(n, p))) {
        // An inout that nothing drives is simply used as an input.
        if (n.kind === 'output') warn(`${capitalize(describe(n))} is not driven`);
        continue;
      }
      pinAssigns.push(`  assign ${pinName.get(n.id)} = ${render(sinkVec(n, p))};`);
    }
  }

  // Declarations in driver order (pins are declared by the header).
  const netDecls = [...nets.values()].filter((x) => x.declare).map((x) => `  ${x.reg ? 'reg' : 'wire'} ${rangeText(x.width)}${x.name};`);

  const header = nodes
    .filter(isPin)
    .map((n) => {
      const p = n.ports.find((q) => q.dir === (n.kind === 'output' ? 'in' : 'out')) ?? n.ports[0];
      return `  ${n.kind} wire ${rangeText(Math.max(1, p?.width ?? 1))}${pinName.get(n.id)}`;
    });
  const lines = [`// Generated by Digital Canvas from the sheet ${oneLine(moduleName)}`];
  if (header.length) lines.push(`module ${modName} (`, header.join(',\n'), ');');
  else lines.push(`module ${modName};`);
  for (const section of [[...netDecls, ...decls], assigns, blocks, insts, pinAssigns]) {
    if (section.length) lines.push('', ...section);
  }
  lines.push('', 'endmodule', '');
  return { code: lines.join('\n'), warnings };
}
