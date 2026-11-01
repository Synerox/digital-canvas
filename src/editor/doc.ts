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
import type { Point } from '../layout/elk-layout';
import type { RuleId } from '../core/rules';
import type { ThemeName } from '../render/theme';
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
  if (sym === 'raw') {
    const r = v.raw;
    if (!isObj(r) || !isStr(r.kind) || !isStr(r.label) || !Array.isArray(r.ports)) return undefined;
    const ports = r.ports.filter(
      (q): q is { id: string; name: string; dir: 'in' | 'out'; side: 'WEST' | 'EAST' | 'NORTH' | 'SOUTH'; width: number } =>
        isObj(q) &&
        isStr(q.name) &&
        (q.dir === 'in' || q.dir === 'out') &&
        ['WEST', 'EAST', 'NORTH', 'SOUTH'].includes(q.side as string) &&
        isNum(q.width),
    );
    out.raw = { ...(r as object), ports: ports.map((q) => ({ ...q, id: `${v.id}.${q.name}` })), src: Array.isArray(r.src) ? r.src : [] } as UserNode['raw'];
  }
  return out;
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
  return out;
}

export function parseEdits(v: unknown): SheetEdits {
  const e = emptyEdits();
  if (!isObj(v)) return e;
  if (isObj(v.pos)) for (const [k, p] of Object.entries(v.pos)) {
    const q = point(p);
    if (q) e.pos[k] = q;
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
  for (const n of [...e.nodes, ...e.edges]) {
    const m = /^[uw]:(\d+)$/.exec(n.id);
    if (m) e.next = Math.max(e.next, Number(m[1]) + 1);
  }
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
  return { sheets, drawn: doc.drawn };
}
