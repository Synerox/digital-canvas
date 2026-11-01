/**
 * Verilog export: write a drawing (drawn by hand, or imported and then edited)
 * as structural, synthesizable Verilog-2005 that Yosys can read back.
 *
 * - Every driver port that feeds at least one wire becomes a net (a `reg` for
 *   register outputs). Input pins drive the net of their own name.
 * - Every input port reads the net of its incoming wire, cut to the slice
 *   written on the wire (`a[3:0]`) and resized to the port's width, so
 *   concatenations and part-selects always see the widths the drawing shows.
 * - Cells become `assign` statements or `always` blocks, blocks become module
 *   instances, and output pins are assigned from their driver.
 *
 * Problems in the drawing (open inputs, width mismatches, cells that have no
 * Verilog form) become warnings rather than errors, so a half-finished drawing
 * still exports to code that elaborates.
 */
import type { DEdge, DNode, DPort, Diagram } from '../core/diagram';
import { formatConst } from '../core/ir';

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
// Literals and wire labels.

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

/** The bit range written on a wire, e.g. `a[3:0]` or `[7]` (the name part is only decoration). */
function labelRange(label: string | undefined): { hi: number; lo: number } | undefined {
  const m = label ? /^\s*(?:[A-Za-z_][\w$]*\s*)?\[\s*(\d+)\s*(?::\s*(\d+)\s*)?\]/.exec(label) : null;
  if (!m) return undefined;
  const hi = Number(m[1]);
  return { hi, lo: m[2] === undefined ? hi : Number(m[2]) };
}

/** Low zero bits implied by a `×2ⁿ` note on a wire (written by the import's "scale" rule). */
function labelScale(label: string | undefined): number {
  const m = label ? /×\s*(\d+)/.exec(label) : null;
  if (!m) return 0;
  const k = Math.log2(Number(m[1]));
  return Number.isInteger(k) && k > 0 && k < 31 ? k : 0;
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
  // Signed shift amounts (negative = left) are not kept: the drawing has no signedness.
  $shift: '>>',
  $shiftx: '>>',
  $logic_and: '&&',
  $logic_or: '||',
};

const SELECTS = new Set(['$mux', 'dc:mux', '$pmux', '$bmux', '$demux', '$tribuf', 'dc:and', 'dc:decoder']);

/** Registers: positive-edge clock, active-high resets to 0 (the drawing does not carry other polarities or values). */
const REGISTERS = new Set(['$dff', '$dffe', '$adff', '$adffe', '$sdff', '$sdffe', '$dlatch']);

function isPrimitive(type: string): boolean {
  return type.startsWith('$') || type.startsWith('dc:');
}

function isSupported(type: string): boolean {
  return type in GATES || type in UNARY || type in BINARY || SELECTS.has(type) || REGISTERS.has(type);
}

function isPin(n: DNode): boolean {
  return n.kind === 'input' || n.kind === 'output' || n.kind === 'inout';
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
  if (modName !== moduleName) warn(`Module name '${moduleName}' is not a legal Verilog name; it is written as ${modName}`);

  const pinName = new Map<string, string>();
  for (const n of nodes) if (isPin(n)) pinName.set(n.id, takeNamed(n.label, 'Pin'));
  const instName = new Map<string, string>();
  for (const n of nodes) {
    if (!isInstanceNode(n)) continue;
    const raw = n.instanceName ?? n.subLabel ?? (n.kind === 'cell' ? short.get(n.id) : undefined) ?? `u_${n.moduleName ?? 'block'}`;
    // Blocks placed without a name get an automatic ID; renaming that is not worth a warning.
    instName.set(n.id, takeNamed(raw, 'Instance', n.kind === 'instance' && n.subLabel === undefined));
  }

  const describe = (n: DNode): string => {
    if (isPin(n)) return `${n.kind} '${n.label}'`;
    if (n.kind === 'const') return `constant ${n.label}`;
    if (n.kind === 'join') return `concatenation ${short.get(n.id)}`;
    if (n.kind === 'split') return `split ${short.get(n.id)}`;
    if (isInstanceNode(n)) return `instance ${instName.get(n.id)} (${n.moduleName ?? n.cellType ?? 'no module'})`;
    return `${short.get(n.id)} (${n.cellType ?? 'cell'})`;
  };
  /** Where a value is read, for warnings: "output 's'" or "input B of and1 ($and)". */
  const where = (n: DNode, p: DPort): string => (isPin(n) ? describe(n) : `input ${p.name} of ${describe(n)}`);
  const source = (n: DNode, p: DPort): string => {
    if (isPin(n)) return describe(n);
    return n.ports.filter((q) => q.dir === 'out').length > 1 ? `output ${p.name} of ${describe(n)}` : describe(n);
  };

  // Resolve wires to ports. A wire drawn from an input port to an output port is turned around.
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
    if (fromPort.dir === 'in' && toPort.dir === 'out') [from, fromPort, to, toPort] = [to, toPort, from, fromPort];
    if (fromPort.dir !== 'out' || toPort.dir !== 'in') {
      warn(`Wire from ${describe(from)} to ${describe(to)} joins two ${fromPort.dir === 'out' ? 'outputs' : 'inputs'}; it is ignored`);
      continue;
    }
    wires.push({ edge: e, from, fromPort, to, toPort });
  }
  const outgoing = new Map<string, Wire[]>();
  const incoming = new Map<string, Wire[]>();
  for (const w of wires) {
    const ko = key(w.from, w.fromPort);
    const ki = key(w.to, w.toPort);
    outgoing.set(ko, [...(outgoing.get(ko) ?? []), w]);
    incoming.set(ki, [...(incoming.get(ki) ?? []), w]);
  }

  // Nets: one per driver port that feeds at least one wire. Constants are written in place instead.
  const nets = new Map<string, Net>();
  const pending: { n: DNode; p: DPort; k: string }[] = [];
  for (const n of nodes) {
    for (const p of n.ports) {
      const k = key(n, p);
      if (p.dir !== 'out' || n.kind === 'const' || !outgoing.has(k)) continue;
      if (n.kind === 'input' || n.kind === 'inout') nets.set(k, { name: pinName.get(n.id)!, width: Math.max(1, p.width), reg: false, declare: false });
      else pending.push({ n, p, k });
    }
  }
  const setNet = (x: (typeof pending)[number], name: string, declare = true) =>
    nets.set(x.k, { name, width: Math.max(1, x.p.width), reg: isRegister(x.n), declare });
  /** A wire that carries its whole driver unchanged (no slice or scale written on it). */
  const isPlainWire = (w: Wire) =>
    !labelRange(w.edge.label) && !labelScale(w.edge.label) && (w.edge.fullSource || w.edge.width >= w.fromPort.width);

  // 1. A name the user wrote on one of its wires.
  for (const x of pending) {
    const label = outgoing
      .get(x.k)!
      .map((w) => w.edge.label?.trim())
      .find((l) => isPlainIdent(l) && !used.has(l));
    if (label) setNet(x, take(label));
  }
  // 2. A driver that feeds an output pin through a plain wire drives that pin directly (`assign s = a ^ b;`).
  const drivenPins = new Set<string>();
  for (const x of pending) {
    if (nets.has(x.k) || isRegister(x.n)) continue;
    const w = outgoing
      .get(x.k)!
      .find(
        (w) =>
          w.to.kind === 'output' &&
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
    const name = outgoing
      .get(x.k)!
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
    if (have === width) return constVec(lit.bits, lit.signed ? undefined : c.label.replace(/\s+/g, ''));
    if (lit.sized) {
      warn(`Width mismatch: constant ${c.label} is ${bitsText(have)} but ${at} is ${bitsText(width)}; ${have < width ? 'zero-extended' : 'the high bits are dropped'}`);
    } else if (lit.bits.slice(width).some((b) => b !== '0')) {
      warn(`Constant ${c.label} does not fit in the ${bitsText(width)} of ${at}; the high bits are dropped`);
    }
    return constVec(padTo(lit.bits, width, lit.signed ? lit.bits[have - 1] : '0'));
  };

  /** The value a wire delivers, before it is fitted to the port: the driver net, or the slice written on the wire. */
  const wireVec = (w: Wire): Vec => {
    const net = nets.get(key(w.from, w.fromPort))!;
    let v = netVec(net.name, net.width);
    const e = w.edge;
    const r = labelRange(e.label);
    const partial = !e.fullSource && e.width >= 1 && e.width < net.width;
    // The bits the wire carries, when the drawing records them, win over a slice written in the label
    // (the label may have been renamed to anything).
    const b = e.bits;
    if (b && b.lo >= 0 && b.width >= 1 && b.lo + b.width <= net.width) {
      if (b.width < net.width) v = slice(v, b.lo, b.width);
    } else if (r && r.hi - r.lo + 1 !== net.width) {
      if (r.lo <= r.hi && r.hi < net.width) {
        v = slice(v, r.lo, r.hi - r.lo + 1);
      } else {
        warn(`The slice '${e.label}' on the wire from ${source(w.from, w.fromPort)} is outside its ${bitsText(net.width)}; it is ignored`);
        if (partial) v = slice(v, 0, e.width);
      }
    } else if (partial && !r) {
      warn(`The wire from ${source(w.from, w.fromPort)} to ${where(w.to, w.toPort)} carries ${e.width} of ${net.width} bits but names no slice; the low bits are used`);
      v = slice(v, 0, e.width);
    }
    const k = labelScale(e.label);
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
    if (ws.length > 1) warn(`${capitalize(at)} is driven by ${ws.length} wires; only the first is used`);
    const w = ws[0];
    if (w.from.kind === 'const') return constAt(w.from, at, width);
    const v = wireVec(w);
    const have = vecWidth(v);
    if (have === width) return v;
    warn(
      `Width mismatch: ${at} is ${bitsText(width)} but its wire from ${source(w.from, w.fromPort)} carries ${bitsText(have)}; ${have < width ? 'zero-extended' : 'the high bits are dropped'}`,
    );
    return slice(v, 0, width);
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

  /** Right-hand side of a combinational cell, or undefined when it has no Verilog form here. */
  const combExpr = (n: DNode, type: string, yWidth: number): string | undefined => {
    const gate = GATES[type];
    if (gate) {
      const ins = n.ports.filter((p) => p.dir === 'in').map((p) => render(sinkVec(n, p)));
      if (ins.length === 0) return undefined;
      const e = ins.join(` ${gate.op} `);
      return gate.invert ? `~(${e})` : e;
    }
    if (type in UNARY) return `${UNARY[type]}${render(input(n, 'A'))}`;
    if (type in BINARY) {
      const a = render(input(n, 'A'));
      const b = render(input(n, 'B'));
      return `${a} ${BINARY[type]} ${b}`;
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
        const b = input(n, 'B', yWidth);
        const s = input(n, 'S');
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

  /** A clock or reset for an event control: a net bit, or undefined when it is a constant. */
  const eventSignal = (n: DNode, name: string): { text: string; zero: boolean } | undefined => {
    const v = input(n, name);
    if (!isConstant(v)) return { text: render(v), zero: false };
    return v.every((s) => s.kind === 'const' && s.bits.every((b) => b === '0')) ? { text: '', zero: true } : undefined;
  };

  const emitRegister = (n: DNode, type: string) => {
    const qPort = n.ports.find((p) => p.dir === 'out' && p.name === 'Q') ?? n.ports.find((p) => p.dir === 'out');
    const q = netOf(n, qPort);
    if (!qPort || !q) {
      warn(`${capitalize(describe(n))} has no connected output; it is left out`);
      return;
    }
    const dv = render(input(n, 'D', q.width));
    const en = type === '$dffe' || type === '$adffe' || type === '$sdffe' || type === '$dlatch' ? render(input(n, 'EN')) : undefined;
    if (type === '$dlatch') {
      blocks.push(`  always @* if (${en}) ${q.name} = ${dv};`);
      return;
    }
    const clk = eventSignal(n, 'CLK');
    if (!clk || clk.zero) {
      warn(`The clock of ${describe(n)} is a constant; the register is left out`);
      return;
    }
    const load = `${en ? `if (${en}) ` : ''}${q.name} <= ${dv};`;
    const reset = `${q.name} <= ${zeroText(q.width)};`;
    if (type === '$adff' || type === '$adffe') {
      const arst = eventSignal(n, 'ARST');
      if (arst && !arst.zero) {
        blocks.push(`  always @(posedge ${clk.text} or posedge ${arst.text})`, `    if (${arst.text}) ${reset}`, `    else ${load}`);
        return;
      }
      if (!arst) {
        // A reset tied to 1: give it a wire so the event control names a signal.
        const name = take(verilogIdent(`${short.get(n.id)}_ARST`));
        decls.push(`  wire ${name};`);
        assigns.push(`  assign ${name} = ${render(input(n, 'ARST'))};`);
        blocks.push(`  always @(posedge ${clk.text} or posedge ${name})`, `    if (${name}) ${reset}`, `    else ${load}`);
        return;
      }
      // A reset tied to 0 never fires: a plain register.
      blocks.push(`  always @(posedge ${clk.text}) ${load}`);
      return;
    }
    if (type === '$sdff' || type === '$sdffe') {
      const srst = render(input(n, 'SRST'));
      blocks.push(`  always @(posedge ${clk.text})`, `    if (${srst}) ${reset}`, `    else ${load}`);
      return;
    }
    blocks.push(`  always @(posedge ${clk.text}) ${load}`);
  };

  const emitCell = (n: DNode) => {
    const type = n.cellType ?? '';
    const outs = n.ports.filter((p) => p.dir === 'out');
    if (!isSupported(type)) {
      warn(`${capitalize(describe(n))} has no Verilog form here; its outputs are left undriven`);
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
    const modIdent = verilogIdent(mod);
    if (modIdent !== mod) warn(`Module '${mod}' of instance ${inst} is not a legal Verilog name; it is written as ${modIdent}`);
    const conns = n.ports.map((p) => {
      const pn = verilogIdent(p.name);
      if (p.dir === 'out') return `.${pn}(${netOf(n, p)?.name ?? ''})`;
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
  const lines = [`// Generated by Digital Canvas from the drawing ${oneLine(moduleName)}`];
  if (header.length) lines.push(`module ${modName} (`, header.join(',\n'), ');');
  else lines.push(`module ${modName};`);
  for (const section of [[...netDecls, ...decls], assigns, blocks, insts, pinAssigns]) {
    if (section.length) lines.push('', ...section);
  }
  lines.push('', 'endmodule', '');
  return { code: lines.join('\n'), warnings };
}
