/**
 * The editable document.
 *
 * The netlist and the layout are kept apart:
 *
 * - A Verilog sheet's netlist is derived from the Verilog every time
 *   (Yosys → IR → diagram), so it is never stored. What the user changed is
 *   stored as edits keyed by stable IDs: positions, wire routes, renamed
 *   labels, deleted (hidden) items, and symbols and wires drawn by hand.
 *   Re-importing changed Verilog keeps every edit whose ID still exists.
 * - A drawing (a module drawn by hand) has no Verilog: its symbols and wires
 *   are all in its edits.
 */
import type { DNode, DPort, NodeKind, Side } from '../core/diagram';
import type { SrcRange } from '../core/ir';
import { GRID, type Point } from '../layout/elk-layout';
import type { RuleId } from '../core/rules';
import type { ThemeName } from '../render/theme';
import { type ComponentDef, loadComponents } from './components';
import { SYMBOL_BY_KEY, type SymKey, type UserEdge, type UserNode } from './symbols';

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RouteRec {
  /** Absolute points from the source port to the target port. */
  points: Point[];
  /** Drawn or reshaped by the user: kept (and stretched) when its symbols move. */
  manual?: boolean;
  /** Where the wire's label goes. */
  label?: Box;
}

export interface SheetEdits {
  /**
   * Top-left corner of every symbol, by stable ID. Empty for a Verilog sheet
   * nobody has edited: such a sheet is laid out by ELK each time. The first
   * edit copies the ELK positions here ("pins" the layout).
   */
  pos: Record<string, Point>;
  /** Wire routes by edge ID. Routes whose ends no longer meet their ports are routed again. */
  routes: Record<string, RouteRec>;
  /** Imported symbols and wires the user deleted. */
  hidden: string[];
  /** Text the user gave imported symbols (pin names, instance names) and wires (labels). */
  labels: Record<string, string>;
  /** Symbols drawn by hand. */
  nodes: UserNode[];
  /** Wires drawn by hand. */
  edges: UserEdge[];
  /** Counter for new IDs (u:<n>, w:<n>). */
  next: number;
}

export interface EditDoc {
  /** Edits by sheet key (see sheetKey). */
  sheets: Record<string, SheetEdits>;
  /** Names of the modules drawn by hand, in the order they were made. */
  drawn: string[];
  /** Components of the library defined in JSON (see editor/components); left out when there are none. */
  components?: ComponentDef[];
}

export type ViewMode = 'blocks' | 'flat';

export interface PathEntry {
  instance: string;
  module: string;
  /** The module is a drawing, not a Verilog module. */
  drawn?: boolean;
}

/** What Save writes: everything needed to reopen the work, including the Verilog sources. */
export interface SavedFile {
  format: 'digital-canvas';
  version: 1;
  files: Record<string, string>;
  top?: string;
  rules: RuleId[];
  viewMode: ViewMode;
  theme: ThemeName;
  doc: EditDoc;
  path: PathEntry[];
}

export const FILE_FORMAT = 'digital-canvas';
export const FILE_EXTENSION = '.dcanvas.json';

export function emptyEdits(): SheetEdits {
  return { pos: {}, routes: {}, hidden: [], labels: {}, nodes: [], edges: [], next: 1 };
}

export function emptyDoc(): EditDoc {
  return { sheets: {}, drawn: [] };
}

/** Key of the sheet a path entry opens. */
export function sheetKey(entry: PathEntry | undefined, viewMode: ViewMode): string {
  if (!entry) return '';
  return entry.drawn ? `d:${entry.module}` : `v:${viewMode}:${entry.module}`;
}

export function isDrawnKey(key: string): boolean {
  return key.startsWith('d:');
}

/** The lowest ID counter that never hands out an ID already used by the sheet's symbols or wires. */
export function freeIdFloor(e: Pick<SheetEdits, 'nodes' | 'edges' | 'next'>): number {
  let next = e.next;
  for (const x of [...e.nodes, ...e.edges]) {
    const m = /^[uw]:(\d+)$/.exec(x.id);
    if (m) next = Math.max(next, Number(m[1]) + 1);
  }
  return next;
}

/** True once the sheet has its own layout (always true for a drawing with symbols). */
export function isPinned(e: SheetEdits | undefined): boolean {
  return !!e && Object.keys(e.pos).length > 0;
}

/** True when a sheet has no edits at all. */
export function isEmptyEdits(e: SheetEdits | undefined): boolean {
  return (
    !e ||
    (Object.keys(e.pos).length === 0 &&
      Object.keys(e.routes).length === 0 &&
      e.hidden.length === 0 &&
      Object.keys(e.labels).length === 0 &&
      e.nodes.length === 0 &&
      e.edges.length === 0)
  );
}

// ---------- validation of loaded files ----------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';

function point(v: unknown): Point | undefined {
  return isObj(v) && isNum(v.x) && isNum(v.y) ? { x: v.x, y: v.y } : undefined;
}

function box(v: unknown): Box | undefined {
  return isObj(v) && isNum(v.x) && isNum(v.y) && isNum(v.width) && isNum(v.height)
    ? { x: v.x, y: v.y, width: v.width, height: v.height }
    : undefined;
}

function endpoint(v: unknown): { node: string; port: string } | undefined {
  return isObj(v) && isStr(v.node) && isStr(v.port) ? { node: v.node, port: v.port } : undefined;
}

function userNode(v: unknown): UserNode | undefined {
  if (!isObj(v) || !isStr(v.id) || !isStr(v.sym)) return undefined;
  const sym = v.sym as SymKey;
  if (sym !== 'raw' && !SYMBOL_BY_KEY[sym]) return undefined;
  const p = isObj(v.params) ? v.params : {};
  const params: UserNode['params'] = {};
  for (const k of ['width', 'inputs', 'parts', 'shift'] as const) if (isNum(p[k])) params[k] = p[k];
  for (const k of ['value', 'module'] as const) if (isStr(p[k])) params[k] = p[k];
  const out: UserNode = { id: v.id, sym, params };
  if (isStr(v.name)) out.name = v.name;
  if (isStr(v.component) && sym !== 'raw' && sym !== 'block') out.component = v.component;
  if (sym === 'raw') {
    const raw = rawNode(v.id, v.raw);
    if (!raw) return undefined;
    out.raw = raw;
  }
  return out;
}

const NODE_KINDS: NodeKind[] = ['instance', 'cell', 'input', 'output', 'inout', 'const', 'join', 'split', 'text'];
const SIDES: Side[] = ['WEST', 'EAST', 'NORTH', 'SOUTH'];
const isKind = (v: unknown): v is NodeKind => NODE_KINDS.includes(v as NodeKind);
const isSide = (v: unknown): v is Side => SIDES.includes(v as Side);

/**
 * Bounds for the source ranges of a frozen symbol. The Inspector and the code
 * panel visit every line of every range, so a hand-edited range such as lines
 * 1 to 2e7 would freeze the page (or overflow a Set and unmount it), and a
 * line number too large to count up from (1e300 + 1 is 1e300) would never end
 * the loop. No line is past MAX_SRC_LINE, so a Set of lines always fits.
 */
const MAX_SRC_LINE = 10_000_000;
/** Lines one symbol may point at in all: far more than any real Verilog cell spans. */
const MAX_SRC_LINES = 100_000;

/** A symbol's source ranges, made sane: whole numbers from 1, each ending at or after its start, within the bounds above. */
function srcRanges(v: unknown): SrcRange[] {
  const out: SrcRange[] = [];
  let budget = MAX_SRC_LINES;
  for (const s of Array.isArray(v) ? v : []) {
    if (!isObj(s) || !isStr(s.file) || !isNum(s.startLine) || !isNum(s.startCol) || !isNum(s.endLine) || !isNum(s.endCol)) continue;
    const startLine = Math.max(1, Math.floor(s.startLine));
    // A range past the end of any real file marks nothing.
    if (startLine > MAX_SRC_LINE) continue;
    const span = Math.min(Math.max(0, Math.floor(s.endLine) - startLine), MAX_SRC_LINE - startLine, budget - 1);
    if (span < 0) break;
    budget -= span + 1;
    const col = (c: number) => Math.max(1, Math.floor(c));
    out.push({ file: s.file, startLine, startCol: col(s.startCol), endLine: startLine + span, endCol: col(s.endCol) });
  }
  return out;
}

/**
 * The frozen drawing node of a `raw` symbol, built only from fields of the
 * right type: the canvas, Inspector and code panel read them while rendering,
 * so one bad value in a hand-edited file would otherwise take the whole page down.
 * Every field the symbol and the Verilog export read must be copied here, or a
 * saved (or autosaved) drawing loses it.
 */
function rawNode(id: string, r: unknown): DNode | undefined {
  if (!isObj(r) || !isKind(r.kind) || !isStr(r.label) || !Array.isArray(r.ports)) return undefined;
  const ports: DPort[] = [];
  for (const q of r.ports) {
    if (!isObj(q) || !isStr(q.name) || (q.dir !== 'in' && q.dir !== 'out') || !isSide(q.side) || !isNum(q.width)) continue;
    ports.push({ id: `${id}.${q.name}`, name: q.name, dir: q.dir, side: q.side, width: q.width, ...(q.inout === true ? { inout: true } : {}) });
  }
  const node: DNode = { id, kind: r.kind, label: r.label, ports, src: srcRanges(r.src) };
  for (const k of ['subLabel', 'cellType', 'moduleName', 'instanceName', 'rule'] as const) if (isStr(r[k])) node[k] = r[k];
  if (isObj(r.attrs)) {
    const attrs: NonNullable<DNode['attrs']> = {};
    for (const [k, a] of Object.entries(r.attrs)) if (isStr(a) || isNum(a) || typeof a === 'boolean') attrs[k] = a;
    node.attrs = attrs;
  }
  // The cell's Yosys parameters (negedge clock, reset value, signed operands): without them the
  // export writes the library default instead. Yosys writes them in binary, MSB first.
  if (isObj(r.params)) {
    const params: Record<string, string> = {};
    for (const [k, p] of Object.entries(r.params)) if (isStr(p) && /^[01xz]+$/.test(p)) params[k] = p;
    if (Object.keys(params).length) node.params = params;
  }
  return node;
}

function userEdge(v: unknown): UserEdge | undefined {
  if (!isObj(v) || !isStr(v.id)) return undefined;
  const source = endpoint(v.source);
  const target = endpoint(v.target);
  if (!source || !target) return undefined;
  const out: UserEdge = { id: v.id, source, target };
  if (isStr(v.label)) out.label = v.label;
  if (isObj(v.slice) && isNum(v.slice.lo) && isNum(v.slice.width) && v.slice.lo >= 0 && v.slice.width >= 1) {
    out.slice = { lo: Math.floor(v.slice.lo), width: Math.floor(v.slice.width) };
  }
  if (isNum(v.shift) && Number.isInteger(v.shift) && v.shift > 0 && v.shift < 31) out.shift = v.shift;
  return out;
}

export function parseEdits(v: unknown): SheetEdits {
  const e = emptyEdits();
  if (!isObj(v)) return e;
  // Symbols sit on the grid, so that their pins line up (work saved before that was kept had ELK's
  // positions, anywhere): the wires stored with them are moved along when the sheet is drawn (see buildGeometry).
  const snap = (v: number) => Math.round(v / GRID) * GRID;
  if (isObj(v.pos)) for (const [k, p] of Object.entries(v.pos)) {
    const q = point(p);
    if (q) e.pos[k] = { x: snap(q.x), y: snap(q.y) };
  }
  if (isObj(v.routes)) for (const [k, r] of Object.entries(v.routes)) {
    if (!isObj(r) || !Array.isArray(r.points)) continue;
    const points = r.points.map(point);
    if (points.length < 2 || points.some((q) => !q)) continue;
    const rec: RouteRec = { points: points as Point[] };
    if (r.manual === true) rec.manual = true;
    const lb = box(r.label);
    if (lb) rec.label = lb;
    e.routes[k] = rec;
  }
  if (Array.isArray(v.hidden)) e.hidden = v.hidden.filter(isStr);
  if (isObj(v.labels)) for (const [k, t] of Object.entries(v.labels)) if (isStr(t)) e.labels[k] = t;
  if (Array.isArray(v.nodes)) e.nodes = v.nodes.map(userNode).filter((n): n is UserNode => !!n);
  if (Array.isArray(v.edges)) e.edges = v.edges.map(userEdge).filter((x): x is UserEdge => !!x);
  e.next = isNum(v.next) && v.next >= 1 ? Math.floor(v.next) : 1;
  // Never hand out an ID that is already used.
  e.next = freeIdFloor(e);
  return e;
}

export class FileFormatError extends Error {}

/** Read a saved file. Throws FileFormatError with a readable message when it is not one. */
export function parseSavedFile(text: string): SavedFile {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new FileFormatError('The file is not valid JSON.');
  }
  if (!isObj(v) || v.format !== FILE_FORMAT) throw new FileFormatError('This is not a Digital Canvas drawing (.dcanvas.json).');
  if (v.version !== 1) throw new FileFormatError(`This drawing was saved by a newer version of Digital Canvas (format ${String(v.version)}).`);
  const files: Record<string, string> = {};
  if (isObj(v.files)) for (const [k, t] of Object.entries(v.files)) if (isStr(t)) files[k] = t;
  const doc = emptyDoc();
  const d = isObj(v.doc) ? v.doc : {};
  if (isObj(d.sheets)) for (const [k, s] of Object.entries(d.sheets)) doc.sheets[k] = parseEdits(s);
  if (Array.isArray(d.drawn)) doc.drawn = [...new Set(d.drawn.filter(isStr))];
  for (const name of doc.drawn) doc.sheets[`d:${name}`] ??= emptyEdits();
  const components = loadComponents(d.components);
  if (components.length) doc.components = components;
  const rules = Array.isArray(v.rules) ? (v.rules.filter(isStr) as RuleId[]) : [];
  const path: PathEntry[] = Array.isArray(v.path)
    ? v.path
        .filter((p): p is Record<string, unknown> => isObj(p) && isStr(p.instance) && isStr(p.module))
        .map((p) => ({ instance: p.instance as string, module: p.module as string, ...(p.drawn === true ? { drawn: true } : {}) }))
    : [];
  return {
    format: FILE_FORMAT,
    version: 1,
    files,
    top: isStr(v.top) ? v.top : undefined,
    rules,
    viewMode: v.viewMode === 'flat' ? 'flat' : 'blocks',
    theme: v.theme === 'slides' ? 'slides' : 'report',
    doc,
    path,
  };
}

/** Drop sheets with no edits, so saved files stay small. */
export function compactDoc(doc: EditDoc): EditDoc {
  const sheets: Record<string, SheetEdits> = {};
  for (const [k, e] of Object.entries(doc.sheets)) {
    if (k.startsWith('d:') ? doc.drawn.includes(k.slice(2)) : !isEmptyEdits(e)) sheets[k] = e;
  }
  return { sheets, drawn: doc.drawn, ...(doc.components?.length ? { components: doc.components } : {}) };
}
