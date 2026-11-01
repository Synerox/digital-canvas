import { create } from 'zustand';
import { type Diagram, type Side, buildDiagram } from '../core/diagram';
import { DEFAULT_RULES, RULES, type RuleId } from '../core/rules';
import { type HierarchyNode, type IRDesign, type SrcRange, buildDesign, buildHierarchy } from '../core/ir';
import { parseYosysJson } from '../core/yosys-json';
import { flatCellCount, withFlattened } from '../core/flatten';
import { withAutoBlocks } from '../core/partition';
import { AUCTION_FILE, AUCTION_SOURCE } from '../examples/auction';
import { FRUIT_FILE, FRUIT_SOURCE } from '../examples/fruit-battle';
import { GRID, LayoutCancelled, type LayoutResult, type MeasureText, type Point, cancelLayouts, layoutDiagram, sizeNode } from '../layout/elk-layout';
import { canvasMeasure } from '../render/export';
import { THEMES, type ThemeName } from '../render/theme';
import { YosysError, elaborate } from '../yosys/client';
import { declaredModules } from '../yosys/script';
import {
  type Box,
  type EditDoc,
  FILE_FORMAT,
  type PathEntry,
  type SavedFile,
  type SheetEdits,
  type ViewMode,
  compactDoc,
  emptyDoc,
  emptyEdits,
  isDrawnKey,
  isEmptyEdits,
  isPinned,
  parseSavedFile,
  sheetKey,
} from '../editor/doc';
import { buildGeometry, stubPoint } from '../editor/geometry';
import {
  type Clip,
  type WireEnd,
  addNodes,
  clearRoute,
  connect,
  copyNodes,
  deleteItems,
  effectiveDiagram,
  layoutToEdits,
  moveNodes,
  newId,
  pasteClip,
  placeMissing,
  rename,
  resetLabel,
  resolveConnection,
  restoreHidden,
  setParams,
  setRoute,
  setSlice,
  toDrawing,
  userIds,
} from '../editor/sheet';
import { type InterfaceOf, type ModulePort, type SymKey, type SymParams, type UserNode, clampParam, newUserNode, symbolNode } from '../editor/symbols';
import { orthogonalize } from '../editor/router';
import { type SheetIssues, checkSheet } from '../editor/check';
import { verilogIdent } from '../editor/verilog-export';

export type { PathEntry, ViewMode } from '../editor/doc';

export type ExampleName = 'auction' | 'fruit';

export const EXAMPLES: Record<ExampleName, { label: string; files: Record<string, string> }> = {
  auction: { label: 'Auction (hierarchical)', files: { [AUCTION_FILE]: AUCTION_SOURCE } },
  fruit: { label: 'Fruit Battle (single module)', files: { [FRUIT_FILE]: FRUIT_SOURCE } },
};

/** too-large: the full circuit was held back by the size guard (see `bigFlat`). */
export type Status = 'idle' | 'loading' | 'elaborating' | 'layout' | 'ready' | 'too-large' | 'error';

/** Above this many cells the full circuit is only drawn after the user asks again. */
export const FLAT_CELL_LIMIT = 250;

/** How many edits Undo can go back. */
const HISTORY = 200;

export const AUTOSAVE_KEY = 'digital-canvas:work:v1';

/**
 * Edits of Verilog sheets put aside by the name of the file whose module they
 * belong to, while no open file declares that module (see changeFiles).
 */
export type PutAside = Record<string, EditDoc['sheets']>;

export interface HistoryEntry {
  doc: EditDoc;
  path: PathEntry[];
  sheet: string;
  /**
   * For a step that changed the Verilog files (an import, another design opened, open files
   * removed): the files, Top choice and edits put aside to go back to. Undo and redo of such a
   * step swap the whole state, so `path` and `sheet` are where to return in those files.
   */
  files?: Record<string, string>;
  top?: string;
  putAside?: PutAside;
}

export interface Placing {
  sym: SymKey;
  params?: SymParams;
}

interface State {
  files: Record<string, string>;
  /** Modules declared in the sources, for the Top selector. */
  moduleNames: string[];
  topOverride?: string;
  /** The elaborated design, as Yosys produced it. */
  design?: IRDesign;
  /** The design with automatic blocks added (used in block view). */
  blockDesign?: IRDesign;
  viewMode: ViewMode;
  hierarchy?: HierarchyNode;
  path: PathEntry[];
  /** The sheet on screen (see sheetKey). */
  sheet: string;
  /**
   * The sheet that `base`, `baseLayout`, `netlist` and `layout` belong to. While a Verilog
   * sheet is being opened (or opened again with other rules) they are still the previous
   * ones and this differs from `sheet`: edits wait, or they would land on the new sheet's
   * key computed from the old netlist and positions.
   */
  loadedSheet?: string;
  /** The sheet's netlist from Verilog, before edits (undefined for drawings). */
  base?: Diagram;
  /** ELK layout of `base`. */
  baseLayout?: LayoutResult;
  /** The sheet's netlist with the edits applied. */
  netlist?: Diagram;
  /** What is drawn: positions, wires, labels. */
  layout?: LayoutResult;
  /** Wires drawn in the warning colour, and what is wrong. */
  issues: SheetIssues;
  doc: EditDoc;
  /** Edits of modules no open file declares, kept for a file of the same name (see changeFiles). */
  putAside: PutAside;
  /** Undo history: each entry is the document before an edit, and where the edit was made. */
  past: HistoryEntry[];
  future: HistoryEntry[];
  /** Changed since the last Save to a file. */
  dirty: boolean;
  status: Status;
  progress?: { loaded: number; total: number };
  error?: string;
  log: string;
  /** Selected symbols and wires. */
  selection: ReadonlySet<string>;
  /** Node ids highlighted from the code panel. */
  highlighted: Set<string>;
  /** Source ranges highlighted in the code panel. */
  codeRanges: SrcRange[];
  codeFile?: string;
  theme: ThemeName;
  rules: ReadonlySet<RuleId>;
  elapsedMs?: number;
  /** The full circuit held back while status is 'too-large'. */
  bigFlat?: { module: string; cells: number };
  /** A symbol chosen in the library, waiting to be placed. */
  placing?: Placing;
  /** A short message about the last action (e.g. why a wire was refused). */
  notice?: string;

  /**
   * Import Verilog files. `replace`: they are all the files now (another design,
   * unless they reuse the name of an open file, or of one whose edits are put
   * aside). Otherwise they are added, and replace open files of the same names.
   * `newVersion`: the code is a new version of the open files that declare the
   * same modules, whatever their names (see planImport); the edits are kept.
   * Any change of the files is one undo step that brings back the old ones.
   */
  setFiles(files: Record<string, string>, replace: boolean, opts?: { newVersion?: boolean }): Promise<void>;
  removeFile(name: string): Promise<void>;
  loadExample(name?: ExampleName): Promise<void>;
  setViewMode(mode: ViewMode): Promise<void>;
  /** The design the current view is drawn from. */
  viewDesign(): IRDesign | undefined;
  rebuild(): Promise<void>;
  openPath(path: PathEntry[]): Promise<void>;
  /** Draw the full circuit that `bigFlat` held back. */
  drawBigFlat(): Promise<void>;
  enterInstance(instance: string, module: string, drawn?: boolean): Promise<void>;
  /** Open the sub-module of a block, if it has one. */
  openNode(id: string): void;
  select(ids: Iterable<string>, mode?: 'replace' | 'toggle' | 'add'): void;
  selectAll(): void;
  selectLine(file: string, line: number): void;
  setCodeFile(file: string): void;
  setTheme(t: ThemeName): void;
  toggleRule(id: RuleId): Promise<void>;
  setTop(top: string | undefined): Promise<void>;
  setNotice(text: string | undefined): void;

  // ----- editing -----
  interfaceOf: InterfaceOf;
  /** Modules a block can instantiate here (not the sheet itself). */
  blockModules(): string[];
  startPlacing(p: Placing | undefined): void;
  placeAt(at: Point, keepPlacing?: boolean): void;
  previewMove(ids: ReadonlySet<string>, dx: number, dy: number): void;
  moveSelection(ids: ReadonlySet<string>, dx: number, dy: number): void;
  connectEnds(a: WireEnd, b: WireEnd, bends: Point[]): boolean;
  deleteSelection(): void;
  renameItem(id: string, text: string): void;
  resetItemLabel(id: string): void;
  setNodeParams(id: string, params: SymParams): void;
  setEdgeSlice(id: string, slice: { lo: number; width: number } | undefined): void;
  setEdgeRoute(id: string, points: Point[] | undefined): void;
  restoreHidden(): void;
  autoLayout(): Promise<void>;
  copy(): boolean;
  cut(): void;
  /**
   * Paste what Copy took: on the sheet it was copied from, beside the original;
   * on another sheet, centred on `near` (where the user looks) when given.
   */
  paste(near?: Point): void;
  duplicate(): void;
  undo(): void;
  redo(): void;
  newDrawing(name?: string): void;
  renameDrawing(from: string, to: string): string | undefined;
  deleteDrawing(name: string): void;
  /** Copy the sheet on screen into a new drawing (with drawings of the automatic blocks it uses). */
  convertToDrawing(): Promise<void>;

  // ----- files -----
  savedFile(): SavedFile;
  loadSaved(text: string): Promise<void>;
  /** Start from the browser's autosaved work, if any; returns false when there is none. */
  restoreAutosave(): Promise<boolean>;
  markSaved(): void;
}

const layoutCache = new Map<string, LayoutResult>();
const baseCache = new Map<string, Diagram>();
/** Modules whose large full circuit the user chose to draw (cleared on rebuild). */
const flatAllowed = new Set<string>();
/** Incremented by every rebuild/navigation, so a slow older call cannot overwrite a newer result. */
let rebuildGen = 0;
let navSeq = 0;
/** What Copy took, the box of the copied symbols, and the sheet they were copied from (see paste). */
let clipboard: { clip: Clip; box: Box; sheet: string } | undefined;
let autosaveTimer: ReturnType<typeof setTimeout> | undefined;

const measures = new Map<string, MeasureText>();
/** Text measurement for a theme's font (one canvas per font). */
export function measureFor(theme: ThemeName): MeasureText {
  const font = THEMES[theme].font;
  let m = measures.get(font);
  if (!m) {
    m = canvasMeasure(font);
    measures.set(font, m);
  }
  return m;
}

/** Resolve after pending events (clicks, rendering) have been handled. */
const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const snap = (v: number) => Math.round(v / GRID) * GRID;

/**
 * Where a copy of the symbols in `box` goes: at the same place if nothing is
 * there, otherwise straight below, past every symbol it would overlap.
 */
export function pasteSpot(box: Box, nodes: readonly Box[]): Point {
  const gap = 2 * GRID;
  let y = box.y;
  // Each round moves below at least one more symbol.
  for (let i = 0; i <= nodes.length; i++) {
    const hits = nodes.filter((n) => box.x < n.x + n.width + gap && n.x < box.x + box.width + gap && y < n.y + n.height + gap && n.y < y + box.height + gap);
    if (hits.length === 0) break;
    y = Math.max(...hits.map((n) => n.y + n.height)) + gap;
  }
  return { x: box.x, y };
}

/** True when a Yosys src file name refers to the uploaded file (Yosys may add directories). */
export function sameFile(srcFile: string, file: string): boolean {
  return srcFile === file || srcFile.endsWith('/' + file) || file.endsWith('/' + srcFile);
}

function rangeHasLine(r: SrcRange, file: string, line: number): boolean {
  return sameFile(r.file, file) && line >= r.startLine && line <= r.endLine;
}

function findFile(files: Record<string, string>, srcFile: string | undefined): string | undefined {
  if (!srcFile) return undefined;
  return Object.keys(files).find((f) => sameFile(srcFile, f));
}

const rulesKey = (rules: ReadonlySet<RuleId>) => RULES.map((r) => (rules.has(r.id) ? '1' : '0')).join('');

/** A legal, unused module name for a new drawing. */
function uniqueModuleName(want: string, taken: Set<string>): string {
  let base = want.replace(/[^A-Za-z0-9_$]/g, '_');
  if (!/^[A-Za-z_]/.test(base)) base = `m_${base}`;
  // Never a Verilog keyword: the export would have to write the module under another name.
  base = verilogIdent(base);
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`;
}

/** The view a Verilog sheet key belongs to (undefined for a drawing or no sheet). */
export function viewModeOf(key: string): ViewMode | undefined {
  const m = /^v:(blocks|flat):/.exec(key);
  return m ? (m[1] as ViewMode) : undefined;
}

export interface DrawingPort extends ModulePort {
  /** The pin symbol (u:<n>) the port comes from. */
  pin: string;
}

/**
 * The ports of a block that instantiates a drawing: one per pin, in drawing
 * order. diagramToVerilog writes each pin as verilogIdent(label), made unique
 * with _2, _3… in the same order. A port is named like its pin when the
 * export writes verilogIdent of that name (the instance's .name() then matches
 * the module's port), and takes the written name when the pin had to be made
 * unique (`a b` and `a_b` are both a_b; input x and output x): otherwise the
 * instance connects the wrong port and a pin is lost. Pins keep their names in
 * the common case, so block port IDs (`<block>.<name>`) in saved work stay valid.
 */
export function drawingPorts(e: SheetEdits | undefined): DrawingPort[] {
  const ports: DrawingPort[] = [];
  const used = new Set<string>();
  const seen = new Set<string>();
  for (const n of e?.nodes ?? []) {
    // A pin wider than a library pin is a frozen copy (`raw`, see toUserNode); the export writes it as a port all the same.
    const raw = n.sym === 'raw' ? n.raw : undefined;
    const dir = raw ? raw.kind : n.sym;
    if (dir !== 'input' && dir !== 'output' && dir !== 'inout') continue;
    // effectiveDiagram draws a repeated ID once.
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    // The label symbolNode gives the pin, and the take() rule of diagramToVerilog.
    const label = raw ? n.name || raw.label : n.name || (dir === 'input' ? 'in' : dir === 'output' ? 'out' : 'io');
    const ident = verilogIdent(label);
    let written = ident;
    for (let i = 2; used.has(written); i++) written = `${ident}_${i}`;
    used.add(written);
    const own = label.trim();
    // The width the module header gets (see diagramToVerilog).
    const width = raw ? Math.max(1, (raw.ports.find((q) => q.dir === (dir === 'output' ? 'in' : 'out')) ?? raw.ports[0])?.width ?? 1) : clampParam('width', n.params.width, 1);
    ports.push({ pin: n.id, name: own && verilogIdent(own) === written ? own : written, dir, width });
  }
  return ports;
}

/**
 * Wires to a block of a drawing name the block's ports by pin name
 * (`<block>.<name>`). When an edit of the drawing changes the name of a pin's
 * port (a rename, or a repeated name that now resolves differently), move those
 * wires to the new name on every sheet, so they stay connected. Wires to the
 * port of a deleted pin are removed: another pin can inherit its name (x and
 * x_2 become x), and they must not land on that one.
 */
export function followPinRenames(doc: EditDoc, drawing: string, before: SheetEdits | undefined, after: SheetEdits | undefined): EditDoc {
  const was = new Map(drawingPorts(before).map((p) => [p.pin, p.name]));
  const now = drawingPorts(after);
  const renamed = new Map<string, string>();
  for (const p of now) {
    const old = was.get(p.pin);
    if (old !== undefined && old !== p.name) renamed.set(old, p.name);
  }
  const kept = new Set(now.map((p) => p.pin));
  const deleted = new Set([...was].filter(([pin]) => !kept.has(pin)).map(([, name]) => name));
  if (renamed.size === 0 && deleted.size === 0) return doc;
  let changed = false;
  const sheets: EditDoc['sheets'] = {};
  for (const [k, e] of Object.entries(doc.sheets)) {
    const blocks = new Set(e.nodes.filter((n) => n.sym === 'block' && n.params.module === drawing).map((n) => n.id));
    if (blocks.size === 0) {
      sheets[k] = e;
      continue;
    }
    /** The block port an end names (by its name before the edit), if it is a block of this drawing. */
    const portOf = (end: { node: string; port: string }) =>
      blocks.has(end.node) && end.port.startsWith(`${end.node}.`) ? end.port.slice(end.node.length + 1) : undefined;
    // One lookup per end, so pins that swap names do not collide.
    const follow = (end: { node: string; port: string }) => {
      const port = portOf(end);
      const to = port === undefined ? undefined : renamed.get(port);
      return to === undefined ? end : { ...end, port: `${end.node}.${to}` };
    };
    const gone = (end: { node: string; port: string }) => {
      const port = portOf(end);
      return port !== undefined && deleted.has(port);
    };
    let edited = false;
    const routes = { ...e.routes };
    const edges = e.edges.flatMap((w) => {
      if (gone(w.source) || gone(w.target)) {
        edited = true;
        delete routes[w.id];
        return [];
      }
      const source = follow(w.source);
      const target = follow(w.target);
      if (source === w.source && target === w.target) return [w];
      edited = true;
      return [{ ...w, source, target }];
    });
    sheets[k] = edited ? { ...e, edges, routes } : e;
    changed ||= edited;
  }
  return changed ? { ...doc, sheets } : doc;
}

/** A drawing under a new name, with the blocks that instantiate it. */
export function renameDrawingIn(doc: EditDoc, from: string, to: string): EditDoc {
  const sheets: EditDoc['sheets'] = {};
  for (const [k, e] of Object.entries(doc.sheets)) {
    const nk = k === `d:${from}` ? `d:${to}` : k;
    const nodes = e.nodes.some((n) => n.sym === 'block' && n.params.module === from)
      ? e.nodes.map((n) => (n.sym === 'block' && n.params.module === from ? { ...n, params: { ...n.params, module: to } } : n))
      : e.nodes;
    sheets[nk] = nodes === e.nodes ? e : { ...e, nodes };
  }
  return { drawn: doc.drawn.map((d) => (d === from ? to : d)), sheets };
}

function renamePathDrawing(path: PathEntry[], from: string, to: string): PathEntry[] {
  return path.map((p) => (p.drawn && p.module === from ? { ...p, module: to, instance: p.instance === from ? to : p.instance } : p));
}

/** The sheets (drawings and Verilog modules) that hold a block of `module`. */
export function sheetsUsing(doc: EditDoc, module: string): string[] {
  const out = new Set<string>();
  for (const [k, e] of Object.entries(doc.sheets)) {
    if (e.nodes.some((n) => n.sym === 'block' && n.params.module === module)) out.add(k.replace(/^d:|^v:[a-z]+:/, ''));
  }
  out.delete(module);
  return [...out];
}

/**
 * The document without the edits of Verilog sheets (drawings stay). Those
 * edits are keyed by module name only, so another design must not inherit them.
 * Returns `doc` itself when there is nothing to drop.
 */
export function withoutVerilogEdits(doc: EditDoc): EditDoc {
  const verilog = Object.keys(doc.sheets).filter((k) => !isDrawnKey(k));
  if (!verilog.some((k) => !isEmptyEdits(doc.sheets[k]))) return doc;
  return { drawn: doc.drawn, sheets: Object.fromEntries(Object.entries(doc.sheets).filter(([k]) => isDrawnKey(k))) };
}

/** Whether a sheet key is a Verilog sheet of one of these modules (in either view, or of its automatic blocks `<module>/<block>`). */
function ofModules(key: string, modules: readonly string[]): boolean {
  const m = /^v:[a-z]+:(.*)$/.exec(key)?.[1];
  return m !== undefined && modules.some((x) => m === x || m.startsWith(`${x}/`));
}

export interface FilesChange {
  doc: EditDoc;
  putAside: PutAside;
  /** Modules whose edits were put aside before and come back. */
  restored: string[];
}

/**
 * The document when the open files change from `before` to `after`. Edits are
 * keyed by module name only, so the edits of a module that no file declares
 * any more must not show on a module of that name added later (another
 * design's top, say: C5). They are put aside under the name of the file that
 * declared it, and come back when a file of that name declares the module
 * again (a new version of a removed file), on sheets that have no edits of
 * their own. Returns `doc` and `putAside` themselves when nothing changes.
 */
export function changeFiles(doc: EditDoc, putAside: PutAside, before: Record<string, string>, after: Record<string, string>): FilesChange {
  const declared = new Set(declaredModules(after));
  let sheets = doc.sheets;
  let aside = putAside;
  for (const [f, text] of Object.entries(before)) {
    if (after[f] === text) continue;
    const gone = declaredModules({ [f]: text }).filter((m) => !declared.has(m));
    const keys = Object.keys(doc.sheets).filter((k) => ofModules(k, gone) && !isEmptyEdits(doc.sheets[k]));
    if (keys.length === 0) continue;
    aside = { ...aside, [f]: { ...aside[f], ...Object.fromEntries(keys.map((k) => [k, doc.sheets[k]])) } };
    sheets = Object.fromEntries(Object.entries(sheets).filter(([k]) => !keys.includes(k)));
  }
  const restored = new Set<string>();
  for (const [f, text] of Object.entries(after)) {
    const kept = aside[f];
    if (before[f] === text || !kept) continue;
    const own = declaredModules({ [f]: text });
    const back = Object.keys(kept).filter((k) => ofModules(k, own) && isEmptyEdits(sheets[k]));
    if (back.length === 0) continue;
    sheets = { ...sheets, ...Object.fromEntries(back.map((k) => [k, kept[k]])) };
    for (const k of back) restored.add(own.find((m) => ofModules(k, [m]))!);
    // What came back is in the document now (and in the undo history): it is not put aside twice.
    const rest = Object.fromEntries(Object.entries(kept).filter(([k]) => !back.includes(k)));
    aside = { ...aside };
    if (Object.keys(rest).length) aside[f] = rest;
    else delete aside[f];
  }
  return { doc: sheets === doc.sheets ? doc : { drawn: doc.drawn, sheets }, putAside: aside, restored: [...restored] };
}

/** Whether two sets of files are the same names with the same text. */
export function sameFiles(a: Record<string, string>, b: Record<string, string>): boolean {
  return Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([f, text]) => b[f] === text);
}

const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

/**
 * The module an import is about: of the modules it adds, the first one (in
 * source order) that none of the imported code instantiates, so a file with
 * submodules opens at its top. A textual guess (Yosys keeps only one top).
 */
export function importedTop(files: Record<string, string>, added: readonly string[]): string | undefined {
  const texts = Object.values(files).map(stripComments);
  const order: string[] = [];
  for (const t of texts) {
    for (const m of t.matchAll(/^\s*(?:macro)?module\s+(?:automatic\s+|static\s+)?([A-Za-z_][\w$]*)/gm)) if (added.includes(m[1]) && !order.includes(m[1])) order.push(m[1]);
  }
  for (const m of added) if (!order.includes(m)) order.push(m);
  const used = (m: string) => {
    // `m [#(…)] name [range] (`, but not the module's own header.
    const re = new RegExp(`(?<!module\\s+)(?<![\\w$])${m.replace(/\$/g, '\\$')}\\s*(?:#|[A-Za-z_\\\\][\\w$]*\\s*(?:\\[[^\\]]*\\]\\s*)?\\()`);
    return texts.some((t) => re.test(t));
  };
  return order.find((m) => !used(m)) ?? order[0];
}

/**
 * Verilog text without the definitions (`module … endmodule`) of these
 * modules, or undefined when they cannot be cut out exactly. Comments and
 * strings are blanked out first, so neither hides nor fakes a keyword.
 */
export function withoutModuleDefinitions(text: string, modules: ReadonlySet<string>): string | undefined {
  const code = text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:[^"\\\n]|\\.)*"/g, (m) => m.replace(/[^\n]/g, ' '));
  const cuts: [number, number][] = [];
  let open: { at: number; cut: boolean } | undefined;
  for (const m of code.matchAll(/\bendmodule\b|\b(?:macro)?module\s+(?:automatic\s+|static\s+)?([A-Za-z_][\w$]*)/g)) {
    if (m[1] === undefined) {
      if (!open) return undefined;
      if (open.cut) {
        let end = m.index + 'endmodule'.length;
        end += /^[ \t]*(?::[ \t]*[A-Za-z_][\w$]*)?[ \t]*(?:\r?\n)?/.exec(code.slice(end))![0].length;
        cuts.push([open.at, end]);
      }
      open = undefined;
      continue;
    }
    // A module header inside a module: not something to cut by text.
    if (open) return undefined;
    // Attributes before the header (`(* keep_hierarchy *)`) belong to the module: left behind, they
    // would stand before nothing, which Yosys rejects.
    let start = m.index;
    for (;;) {
      let i = start;
      while (i > 0 && /\s/.test(code[i - 1])) i--;
      const attr = code.endsWith('*)', i) ? code.lastIndexOf('(*', i - 3) : -1;
      if (attr < 0) break;
      start = attr;
    }
    const line = code.lastIndexOf('\n', start - 1) + 1;
    open = { at: /^[ \t]*$/.test(code.slice(line, start)) ? line : start, cut: modules.has(m[1]) };
  }
  if (open) return undefined;
  let out = text;
  for (const [a, b] of cuts.reverse()) out = out.slice(0, a) + out.slice(b);
  // Only what was asked for is gone (a macro or an odd layout could fool the search above).
  const before = declaredModules({ 'f.v': text }).filter((m) => !modules.has(m));
  const after = declaredModules({ 'f.v': out });
  return after.length === before.length && before.every((m) => after.includes(m)) ? out : undefined;
}

export interface ImportPlan {
  /** All files after the import. */
  files: Record<string, string>;
  /** Open files the import takes the place of: it declares every module they declare. */
  replaced: string[];
  /** Open files that keep their other modules: the definitions the import declares again are cut out. */
  trimmed: string[];
  /** Open files with a module the import declares again that could not be cut out (Yosys reports it defined twice). */
  clashes: string[];
}

/**
 * Importing code as a new version of open files of other names (see
 * setFiles): a file whose modules it all declares is replaced; one that
 * shares only some of them keeps the others, so importing one module of a
 * file never removes the rest of the design.
 */
export function planImport(open: Record<string, string>, incoming: Record<string, string>): ImportPlan {
  const mods = new Set(declaredModules(incoming));
  const plan: ImportPlan = { files: { ...open }, replaced: [], trimmed: [], clashes: [] };
  for (const [f, text] of Object.entries(open)) {
    if (f in incoming) continue;
    const own = declaredModules({ [f]: text });
    const again = own.filter((m) => mods.has(m));
    if (again.length === 0) continue;
    if (again.length === own.length) {
      delete plan.files[f];
      plan.replaced.push(f);
      continue;
    }
    const cut = withoutModuleDefinitions(text, new Set(again));
    if (cut === undefined) plan.clashes.push(f);
    else {
      plan.files[f] = cut;
      plan.trimmed.push(f);
    }
  }
  Object.assign(plan.files, incoming);
  return plan;
}

/**
 * The route of a wire drawn through bends, from points[0] to the last point.
 * At a pin (when its side is given) the wire first leaves the symbol on a short
 * stub, and the leg next to the stub turns across it, so the wire never runs
 * back through its own symbol or into a pin sideways. Other corners go
 * horizontal first, like orthogonalize.
 */
export function drawnRoute(points: readonly Point[], startSide?: Side, endSide?: Side): Point[] {
  if (points.length < 2) return [...points];
  const across = (side: Side) => side === 'EAST' || side === 'WEST';
  const out: Point[] = [points[0]];
  const goTo = (q: Point, verticalFirst: boolean) => {
    const a = out[out.length - 1];
    if (a.x !== q.x && a.y !== q.y) out.push(verticalFirst ? { x: a.x, y: q.y } : { x: q.x, y: a.y });
    out.push(q);
  };
  if (startSide) out.push(stubPoint(points[0], startSide));
  const inner = endSide ? points.slice(1, -1) : points.slice(1);
  // After a horizontal stub, go vertical first (and the other way round).
  inner.forEach((q, i) => goTo(q, i === 0 && !!startSide && across(startSide)));
  if (endSide) {
    const last = points[points.length - 1];
    // Reach the stub across its direction, then go straight into the pin.
    goTo(stubPoint(last, endSide), inner.length === 0 && startSide ? across(startSide) : !across(endSide));
    out.push(last);
  }
  // Only simplifies: every leg is horizontal or vertical already.
  return orthogonalize(out);
}

export const useStore = create<State>((set, get) => {
  // ---------- helpers that need the store ----------

  const interfaceOf: InterfaceOf = (name) => {
    const { doc, design, blockDesign } = get();
    if (doc.drawn.includes(name)) return { label: name, ports: drawingPorts(doc.sheets[`d:${name}`]) };
    // Not viewDesign(): a block copied from an automatic block names a module only the block
    // view has, and it must keep its ports (and wires) when the full circuit is shown.
    const m = blockDesign?.modules[name] ?? design?.modules[name];
    if (!m) return undefined;
    return { label: m.displayName, ports: m.ports.map((p) => ({ name: p.name, dir: p.direction, width: p.bits.length })) };
  };

  const edits = (): SheetEdits => get().doc.sheets[get().sheet] ?? emptyEdits();

  /** False while a Verilog sheet is being opened: what is on screen still belongs to the previous one. */
  const settled = (s: State) => isDrawnKey(s.sheet) || s.loadedSheet === s.sheet;

  /** A history entry for the document as it is now. */
  const here = (): HistoryEntry => ({ doc: get().doc, path: get().path, sheet: get().sheet });

  /** Push the current document on the undo stack and replace it. */
  const pushDoc = (doc: EditDoc, extra: Partial<State> = {}) => {
    set({ past: [...get().past.slice(-(HISTORY - 1)), here()], future: [], doc, dirty: true, ...extra });
    scheduleAutosave();
  };

  const currentModule = () => get().path[get().path.length - 1]?.module ?? '';

  /**
   * Recompute the netlist and geometry of the sheet on screen from the
   * document. Routes found on the way are stored in the document (not as an
   * undo step: they follow from the edits).
   */
  const refresh = (opts: { moved?: ReadonlySet<string>; fast?: SheetEdits } = {}) => {
    const s = get();
    const key = s.sheet;
    if (!key) return;
    const drawn = isDrawnKey(key);
    // The base of another sheet would be stored under this sheet's key (see loadedSheet).
    if (!drawn && (!s.base || !settled(s))) return;
    const e = opts.fast ?? edits();
    const netlist = effectiveDiagram(currentModule(), drawn ? undefined : s.base, e, interfaceOf);
    const measure = measureFor(s.theme);
    let pos = e.pos;
    let routes = e.routes;
    let placed: string[] = [];
    if (!drawn && !isPinned(e)) {
      if (!s.baseLayout) return;
      const pinned = layoutToEdits(e, s.baseLayout, 'none');
      pos = pinned.pos;
      routes = pinned.routes;
    } else if (netlist.nodes.some((n) => !pos[n.id])) {
      placed = netlist.nodes.filter((n) => !pos[n.id]).map((n) => n.id);
      pos = placeMissing(netlist, pos, s.baseLayout, (n) => sizeNode(n, measure));
    }
    // placeMissing keeps symbols apart but not off wires: stored wires that run through a
    // symbol placed now are routed again, as after a move.
    const moved = placed.length ? new Set([...(opts.moved ?? []), ...placed]) : opts.moved;
    const g = buildGeometry({ netlist, pos, routes, measure, fast: !!opts.fast, moved, previous: s.layout });
    const issues = checkSheet(netlist);
    const selection = new Set([...s.selection].filter((id) => netlist.nodes.some((n) => n.id === id) || netlist.edges.some((x) => x.id === id)));
    const patch: Partial<State> = { netlist, layout: g.layout, issues, selection: selection.size === s.selection.size ? s.selection : selection };
    if (!opts.fast && (placed.length || Object.keys(g.routed).length) && (drawn || isPinned(e))) {
      const stored: SheetEdits = { ...e, pos, routes: { ...e.routes, ...g.routed } };
      patch.doc = { ...s.doc, sheets: { ...s.doc.sheets, [key]: stored } };
    }
    set(patch);
  };

  const scheduleAutosave = () => {
    if (typeof localStorage === 'undefined') return;
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
      try {
        // Whether the work is saved to a file goes along (only here, not in saved files): see restoreAutosave.
        localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({ ...get().savedFile(), ...(get().dirty ? {} : { saved: true }) }));
      } catch {
        set({ notice: 'Could not keep a copy in this browser (storage is full or blocked). Use File › Save drawing.' });
      }
    }, 400);
  };

  /** Replace the document (one undo step) and redraw. */
  const commitDoc = (doc: EditDoc, opts: { moved?: ReadonlySet<string>; selection?: ReadonlySet<string> } = {}) => {
    const s = get();
    set({
      past: [...s.past.slice(-(HISTORY - 1)), here()],
      future: [],
      doc,
      dirty: true,
      ...(opts.selection ? { selection: opts.selection } : {}),
    });
    refresh({ moved: opts.moved });
    scheduleAutosave();
  };

  /** Apply an edit to the sheet on screen. A Verilog sheet's ELK layout is pinned first. */
  const editSheet = (
    fn: (e: SheetEdits, netlist: Diagram, layout: LayoutResult) => SheetEdits | undefined,
    opts: { moved?: ReadonlySet<string>; selection?: ReadonlySet<string> } = {},
  ) => {
    const s = get();
    if (!s.sheet || !s.netlist || !s.layout || s.status === 'too-large' || !settled(s)) return;
    const before = s.doc.sheets[s.sheet];
    let e = before ?? emptyEdits();
    if (!isDrawnKey(s.sheet) && !isPinned(e)) {
      if (!s.baseLayout) return;
      e = layoutToEdits(e, s.baseLayout, 'existing');
    }
    const next = fn(e, s.netlist, s.layout);
    if (!next || next === e) return;
    let doc: EditDoc = { ...s.doc, sheets: { ...s.doc.sheets, [s.sheet]: next } };
    // Blocks of this drawing (on other sheets) follow its pins' new names, in the same undo step.
    if (isDrawnKey(s.sheet)) doc = followPinRenames(doc, s.sheet.slice(2), before, next);
    commitDoc(doc, opts);
  };

  /** The ELK layout of a sheet's Verilog netlist (cached). */
  const elkOf = async (key: string, diagram: Diagram): Promise<LayoutResult | undefined> => {
    let l = layoutCache.get(key);
    if (l) return l;
    try {
      l = await layoutDiagram(diagram, measureFor(get().theme));
    } catch (e) {
      if (e instanceof LayoutCancelled) return undefined;
      throw e;
    }
    layoutCache.set(key, l);
    return l;
  };

  /**
   * An automatic block's sheet as it shows in the block diagram (with its
   * edits), laid out as refresh() lays it out, for Copy to new drawing.
   * Undefined when the layout was cancelled.
   */
  const autoBlockSheet = async (module: string): Promise<{ netlist: Diagram; layout: LayoutResult; edits: SheetEdits } | undefined> => {
    const { blockDesign, rules, theme, doc } = get();
    if (!blockDesign?.modules[module]) return undefined;
    const cacheKey = `blocks:${module}:${rulesKey(rules)}`;
    let base = baseCache.get(cacheKey);
    if (!base) {
      base = buildDiagram(blockDesign, module, rules);
      baseCache.set(cacheKey, base);
    }
    const e = doc.sheets[sheetKey({ instance: module, module }, 'blocks')] ?? emptyEdits();
    const netlist = effectiveDiagram(module, base, e, interfaceOf);
    const measure = measureFor(theme);
    let { pos, routes } = e;
    if (!isPinned(e) || netlist.nodes.some((n) => !pos[n.id])) {
      const elk = await elkOf(cacheKey, base);
      if (!elk) return undefined;
      if (!isPinned(e)) ({ pos, routes } = layoutToEdits(e, elk, 'none'));
      else pos = placeMissing(netlist, pos, elk, (n) => sizeNode(n, measure));
    }
    return { netlist, edits: e, layout: buildGeometry({ netlist, pos, routes, measure }).layout };
  };

  /** Show the first drawing, or nothing. */
  const openFallback = async () => {
    const { design, doc } = get();
    if (design) return get().openPath([{ instance: design.top, module: design.top }]);
    if (doc.drawn.length) return get().openPath([{ instance: doc.drawn[0], module: doc.drawn[0], drawn: true }]);
    set({ path: [], sheet: '', base: undefined, baseLayout: undefined, netlist: undefined, layout: undefined });
  };

  /** Switch between Block diagram and Full circuit without opening a sheet. */
  const applyViewMode = (mode: ViewMode) => {
    const { design, blockDesign } = get();
    set({ viewMode: mode, ...(design ? { hierarchy: buildHierarchy(mode === 'blocks' ? (blockDesign ?? design) : design) } : {}) });
    scheduleAutosave();
  };

  /** After undo/redo: show the sheet the change was made on, or redraw this one. */
  const showAfterHistory = async (entry: HistoryEntry) => {
    const { doc, sheet } = get();
    const drawnGone = (p: PathEntry[]) => p.some((x) => x.drawn && !doc.drawn.includes(x.module));
    if (entry.sheet && entry.sheet !== sheet && !drawnGone(entry.path)) {
      // The change may have been made in the other view: show that view again, or the change
      // happens out of sight (openPath alone would open this path in the current view).
      const mode = viewModeOf(entry.sheet);
      if (mode && mode !== get().viewMode) applyViewMode(mode);
      return get().openPath(entry.path);
    }
    if (drawnGone(get().path)) return openFallback();
    // A Verilog sheet that is no longer pinned is drawn from its ELK layout, which openPath
    // skips while every symbol has a stored position (and a rule change or re-import drops
    // the cached one): open the sheet again, which lays it out.
    const s = get();
    if (!isDrawnKey(sheet) && settled(s) && s.base && !s.baseLayout && !isPinned(doc.sheets[sheet])) return get().openPath(s.path);
    refresh();
  };

  /**
   * Drawings and Verilog modules share one namespace: blocks, drill-down and the
   * Verilog export find a module by name. New and renamed drawings avoid the
   * names of Verilog modules, but Verilog imported later can declare one. Such a
   * drawing is renamed, with the blocks that use it, also in the undo history,
   * so that no undo brings the clash back.
   */
  const renameClashingDrawings = (moduleNames: readonly string[]) => {
    const s = get();
    const clash = s.doc.drawn.filter((d) => moduleNames.includes(d));
    if (clash.length === 0) return;
    const history = [...s.past, ...s.future];
    const taken = new Set([...moduleNames, ...s.doc.drawn, ...history.flatMap((h) => h.doc.drawn)]);
    const names = new Map<string, string>();
    for (const from of clash) {
      const to = uniqueModuleName(from, taken);
      taken.add(to);
      names.set(from, to);
    }
    const fix = (h: HistoryEntry): HistoryEntry => {
      let { doc, path, sheet } = h;
      for (const [from, to] of names) {
        if (!doc.drawn.includes(from)) continue;
        doc = renameDrawingIn(doc, from, to);
        path = renamePathDrawing(path, from, to);
        if (sheet === `d:${from}`) sheet = `d:${to}`;
      }
      return doc === h.doc ? h : { ...h, doc, path, sheet };
    };
    const now = fix({ doc: s.doc, path: s.path, sheet: s.sheet });
    const list = [...names].map(([from, to]) => `${from} → ${to}`).join(', ');
    set({
      ...now,
      past: s.past.map(fix),
      future: s.future.map(fix),
      dirty: true,
      notice: `Renamed drawing ${list}: the Verilog now declares a module with that name.`,
    });
    scheduleAutosave();
  };

  /** Start over from a saved file. `dirty`: the work is not saved to a file (it comes from the browser's copy). */
  const applySaved = async (f: SavedFile, dirty = false) => {
    navSeq++;
    cancelLayouts();
    layoutCache.clear();
    baseCache.clear();
    set({
      files: f.files,
      topOverride: f.top,
      rules: new Set(f.rules.filter((r) => RULES.some((x) => x.id === r))),
      viewMode: f.viewMode,
      theme: f.theme,
      doc: f.doc,
      putAside: {},
      past: [],
      future: [],
      dirty,
      selection: new Set(),
      path: f.path,
      sheet: '',
      loadedSheet: undefined,
      layout: undefined,
      netlist: undefined,
      base: undefined,
      baseLayout: undefined,
      design: undefined,
      blockDesign: undefined,
      hierarchy: undefined,
    });
    // The browser's copy is this file now, or a reload brings back the work from before it.
    scheduleAutosave();
    await get().rebuild();
  };

  /** A history entry that brings back the files as they are now, with the document. */
  const hereWithFiles = (): HistoryEntry => {
    const s = get();
    return { ...here(), files: s.files, top: s.topOverride, putAside: s.putAside };
  };

  /**
   * Record a change of the Verilog files as one undo step that puts them back
   * too (see HistoryEntry.files), with `doc` and `putAside` as they are after
   * it. Nothing is recorded when there is nothing to go back to: no files, no
   * history, no change of the document and nothing put aside (the example
   * opened at start).
   */
  const pushFilesStep = (doc: EditDoc, putAside = get().putAside) => {
    const s = get();
    if (Object.keys(s.files).length === 0 && s.past.length === 0 && doc === s.doc && Object.keys(putAside).length === 0) return;
    set({ past: [...s.past.slice(-(HISTORY - 1)), hereWithFiles()], future: [], doc, putAside, dirty: true });
  };

  /** After undo/redo of a step that changed the files: open those files again, where the step left them. */
  const reopenFiles = async (entry: HistoryEntry) => {
    const mode = viewModeOf(entry.sheet);
    set({ files: entry.files ?? {}, topOverride: entry.top, putAside: entry.putAside ?? {}, path: entry.path, ...(mode ? { viewMode: mode } : {}) });
    scheduleAutosave();
    await get().rebuild();
  };

  /**
   * Make `files` the open files as one undo step, with the edits of modules
   * they no longer declare put aside (see changeFiles). No step when nothing
   * changes.
   */
  const pushFiles = (files: Record<string, string>) => {
    const s = get();
    if (sameFiles(s.files, files)) return;
    const c = changeFiles(s.doc, s.putAside, s.files, files);
    pushFilesStep(c.doc, c.putAside);
  };

  /**
   * Open a new set of Verilog files (`all`). `imported`: the files the user
   * added, whose modules are shown when the design does not use them.
   */
  const openFiles = async (all: Record<string, string>, opts: { imported?: Record<string, string>; clearTop?: boolean } = {}) => {
    const s = get();
    const imported = opts.imported ? declaredModules(opts.imported) : [];
    // Opening Verilog while a drawing is on screen shows the Verilog.
    const path = s.path[0]?.drawn ? [] : s.path;
    set({ files: all, path, ...(opts.clearTop ? { topOverride: undefined } : {}) });
    scheduleAutosave();
    const noticeBefore = get().notice;
    await get().rebuild();
    // Added files whose modules the top does not use are not in the design at all (Yosys keeps
    // only the top's hierarchy), so nothing would show them: make the import the top. A new
    // version of an open file, or a submodule the top uses, has modules in the design.
    const { design, error } = get();
    if (!imported.length || get().files !== all || !design || error || imported.some((m) => design.modules[m])) return;
    const top = importedTop(opts.imported!, imported);
    if (!top) return;
    // What the rebuild said (a drawing renamed away from an imported module's name) is kept: there is one notice line.
    const said = get().notice !== noticeBefore ? get().notice : undefined;
    await get().setTop(top);
    if (get().design?.top === top) set({ notice: [said, `Showing ${top}, which ${design.top} does not use. Pick another module under Top.`].filter(Boolean).join(' ') });
  };

  /**
   * Open files that are not a new version of the open ones. The edits of
   * Verilog sheets are dropped: they are keyed by module name only, and a module
   * of another design with the same name (top, say) would show them. The edits
   * put aside go too: they are not for a file of the other design that has the
   * same name. One undo step brings back the files and the edits, and nothing
   * older refers to the other design while it is not open.
   */
  const openOtherDesign = async (files: Record<string, string>) => {
    pushFilesStep(withoutVerilogEdits(get().doc), {});
    await openFiles(files, { clearTop: true });
  };

  return {
    files: {},
    moduleNames: [],
    path: [],
    sheet: '',
    status: 'idle',
    log: '',
    selection: new Set(),
    highlighted: new Set(),
    codeRanges: [],
    theme: 'report',
    rules: DEFAULT_RULES,
    viewMode: 'blocks',
    issues: { flagged: new Set(), messages: [] },
    doc: emptyDoc(),
    putAside: {},
    past: [],
    future: [],
    dirty: false,
    interfaceOf,

    async setFiles(files, replace, opts = {}) {
      const { files: current, putAside } = get();
      if (replace) {
        // Replacing all files keeps the edits only when it is a new version of the open design:
        // it reuses a file name (File › Open Verilog of the same files), or the name of a removed
        // file whose edits are put aside.
        if (!Object.keys(files).some((f) => f in current || f in putAside)) return openOtherDesign(files);
        // Open files it leaves out come back with Undo; so do the old versions of the others.
        pushFiles(files);
        await openFiles(files, { clearTop: true });
        return;
      }
      // With `newVersion`, the same design under other file names: the edits stay. Open files it
      // replaces, cuts a module out of or updates come back with Undo, and so does the file set
      // without the files it adds.
      const all = opts.newVersion ? planImport(current, files).files : { ...current, ...files };
      pushFiles(all);
      await openFiles(all, { imported: files });
    },

    async removeFile(name) {
      const s = get();
      if (!(name in s.files)) return;
      const files = { ...s.files };
      delete files[name];
      // The edits of modules only this file declared are put aside for a file of this name (see
      // changeFiles), in one undo step that brings back the file too.
      pushFiles(files);
      set({ files });
      scheduleAutosave();
      await get().rebuild();
    },

    async loadExample(name = 'auction') {
      // An example always opens as it is, even over an edited copy of itself.
      await openOtherDesign(EXAMPLES[name].files);
    },

    viewDesign() {
      const { viewMode, design, blockDesign } = get();
      return viewMode === 'blocks' ? (blockDesign ?? design) : design;
    },

    async setViewMode(mode) {
      if (mode === get().viewMode) return;
      applyViewMode(mode);
      const { design } = get();
      if (!design) return;
      const view = get().viewDesign()!;
      // Auto blocks do not exist in the full circuit: show the module they were cut from.
      const path = get().path.filter((p) => p.drawn || view.modules[p.module]);
      if (path.length && path[0].drawn) return get().openPath(path);
      await get().openPath(path.length ? path : [{ instance: design.top, module: design.top }]);
    },

    async setTop(top) {
      set({ topOverride: top });
      scheduleAutosave();
      await get().rebuild();
    },

    async rebuild() {
      const gen = ++rebuildGen;
      const { files } = get();
      const moduleNames = declaredModules(files);
      renameClashingDrawings(moduleNames);
      // A Top choice that the current files no longer declare is dropped.
      const topOverride = get().topOverride && moduleNames.includes(get().topOverride!) ? get().topOverride : undefined;
      set({ moduleNames, topOverride });
      if (Object.keys(files).length === 0) {
        navSeq++;
        cancelLayouts();
        layoutCache.clear();
        baseCache.clear();
        set({
          design: undefined,
          blockDesign: undefined,
          hierarchy: undefined,
          status: 'idle',
          error: undefined,
          codeFile: undefined,
          highlighted: new Set(),
          codeRanges: [],
        });
        const path = get().path;
        if (path[0]?.drawn && get().doc.drawn.includes(path[0].module)) await get().openPath(path);
        else await openFallback();
        return;
      }
      const t0 = performance.now();
      set({ status: 'elaborating', error: undefined, progress: undefined });
      try {
        const result = await elaborate(files, topOverride, (loaded, total) => {
          if (gen !== rebuildGen) return;
          set({ progress: { loaded, total }, status: loaded >= total ? 'elaborating' : 'loading' });
        });
        if (gen !== rebuildGen) return;
        set({ status: 'elaborating', log: result.log });
        const json = parseYosysJson(result.json);
        const design = buildDesign(json, files);
        const blockDesign = withAutoBlocks(design, files);
        const view = get().viewMode === 'blocks' ? blockDesign : design;
        const hierarchy = buildHierarchy(view);
        layoutCache.clear();
        baseCache.clear();
        flatAllowed.clear();
        // Keep the current drill-down path when it still exists in the new design.
        const old = get().path;
        let path: PathEntry[];
        if (old[0]?.drawn && get().doc.drawn.includes(old[0].module)) {
          path = old;
        } else {
          path = [{ instance: design.top, module: design.top }];
          for (const p of old.slice(1)) {
            if (p.drawn) break;
            const parent = view.modules[path[path.length - 1].module];
            const cell = parent?.cells.find((c) => c.isInstance && c.name === p.instance);
            if (!cell) break;
            path.push({ instance: cell.name, module: cell.type });
          }
        }
        const codeFile = get().codeFile && files[get().codeFile!] !== undefined ? get().codeFile : Object.keys(files)[0];
        set({ design, blockDesign, hierarchy, codeFile, base: undefined, baseLayout: undefined, sheet: '' });
        await get().openPath(path);
        if (gen === rebuildGen) set({ elapsedMs: performance.now() - t0 });
      } catch (e) {
        if (gen !== rebuildGen) return;
        const err = e as YosysError;
        const codeFile = get().codeFile && files[get().codeFile!] !== undefined ? get().codeFile : Object.keys(files)[0];
        set({ status: 'error', error: err.message, log: err.log ?? get().log, codeFile });
        // Drawings do not need Yosys.
        if (get().path[0]?.drawn) await get().openPath(get().path);
      }
    },

    async openPath(path) {
      if (path.length === 0) return;
      const seq = ++navSeq;
      // This navigation replaces any layout still running (for example a large full circuit).
      cancelLayouts();
      const last = path[path.length - 1];
      const { viewMode, rules } = get();
      const key = sheetKey(last, viewMode);
      const keepSelection = key === get().sheet;
      set({
        path,
        sheet: key,
        placing: keepSelection ? get().placing : undefined,
        ...(keepSelection ? {} : { selection: new Set<string>(), highlighted: new Set<string>(), codeRanges: [] }),
        bigFlat: undefined,
        // Until the end, base, layout and netlist are the previous ones (even for the same key:
        // other rules give another netlist).
        loadedSheet: undefined,
      });
      if (last.drawn) {
        if (!get().doc.drawn.includes(last.module)) return openFallback();
        set({
          base: undefined,
          baseLayout: undefined,
          loadedSheet: key,
          layout: keepSelection ? get().layout : undefined,
          status: get().error ? 'error' : 'ready',
        });
        refresh();
        return;
      }
      const { design } = get();
      const view = get().viewDesign();
      if (!design || !view || !view.modules[last.module]) {
        set({ base: undefined, baseLayout: undefined, layout: undefined, netlist: undefined });
        return;
      }
      const module = last.module;
      set({ status: 'layout' });
      const cacheKey = `${viewMode}:${module}:${rulesKey(rules)}`;
      const stale = () => seq !== navSeq || get().design !== design || get().rules !== rules || get().viewMode !== viewMode;
      let base = baseCache.get(cacheKey);
      if (!base) {
        if (viewMode === 'flat' && !flatAllowed.has(module) && !isPinned(get().doc.sheets[key])) {
          const cells = flatCellCount(view, module);
          if (cells > FLAT_CELL_LIMIT) {
            set({ layout: undefined, netlist: undefined, base: undefined, status: 'too-large', bigFlat: { module, cells } });
            return;
          }
        }
        // A full circuit can take a while to build: let the page draw the status first,
        // and skip the work if the user has already moved on.
        if (viewMode === 'flat') {
          await nextTask();
          if (stale()) return;
        }
        const source = viewMode === 'flat' ? withFlattened(view, module) : view;
        base = buildDiagram(source, module, rules);
        baseCache.set(cacheKey, base);
        if (viewMode === 'flat') {
          await nextTask();
          if (stale()) return;
        }
      }
      // ELK is needed for an unedited sheet, and to place symbols new since the last edit.
      // The edits are read only now: an undo while the netlist was built may have unpinned the sheet.
      const e = get().doc.sheets[key];
      let baseLayout: LayoutResult | undefined = layoutCache.get(cacheKey);
      const needsElk = !isPinned(e) || base.nodes.some((n) => !e!.pos[n.id] && !e!.hidden.includes(n.id));
      if (!baseLayout && needsElk) {
        baseLayout = await elkOf(cacheKey, base);
        if (!baseLayout || stale()) return;
      }
      const m = view.modules[module];
      const file = findFile(get().files, m?.src[0]?.file);
      set({
        base,
        baseLayout,
        loadedSheet: key,
        layout: keepSelection ? get().layout : undefined,
        status: get().error ? 'error' : 'ready',
        codeFile: file ?? get().codeFile,
      });
      refresh();
    },

    async drawBigFlat() {
      const big = get().bigFlat;
      if (!big || get().status !== 'too-large') return;
      flatAllowed.add(big.module);
      await get().openPath(get().path);
    },

    async enterInstance(instance, module, drawn) {
      if (get().path.length >= 32) return;
      await get().openPath([...get().path, { instance, module, ...(drawn ? { drawn: true } : {}) }]);
    },

    openNode(id) {
      const s = get();
      const n = s.layout?.nodes.find((x) => x.id === id);
      if (n?.kind !== 'instance' || !n.moduleName) return;
      // An instance from the Verilog instantiates a Verilog module; only a block drawn by hand can name a drawing.
      const byHand = isDrawnKey(s.sheet) || userIds(edits()).has(id);
      if (byHand && s.doc.drawn.includes(n.moduleName)) {
        void get().enterInstance(n.instanceName ?? n.moduleName, n.moduleName, true);
      } else if (get().viewDesign()?.modules[n.moduleName]) {
        void get().enterInstance(n.instanceName ?? n.moduleName, n.moduleName);
      }
    },

    select(ids, mode = 'replace') {
      const { layout, files } = get();
      const list = [...ids];
      let selection: Set<string>;
      if (mode === 'replace') selection = new Set(list);
      else {
        selection = new Set(get().selection);
        for (const id of list) {
          if (mode === 'toggle' && selection.has(id)) selection.delete(id);
          else selection.add(id);
        }
      }
      const ranges = (layout?.nodes ?? []).filter((n) => selection.has(n.id)).flatMap((n) => n.src);
      const file = findFile(files, ranges[0]?.file) ?? get().codeFile;
      set({ selection, highlighted: new Set(), codeRanges: ranges, codeFile: file });
    },

    selectAll() {
      const { layout } = get();
      if (!layout) return;
      get().select([...layout.nodes.map((n) => n.id), ...layout.edges.map((x) => x.id)]);
    },

    selectLine(file, line) {
      const { layout } = get();
      const hits = new Set<string>();
      for (const n of layout?.nodes ?? []) if (n.src.some((r) => rangeHasLine(r, file, line))) hits.add(n.id);
      set({
        highlighted: hits,
        selection: new Set(),
        codeRanges: [{ file, startLine: line, startCol: 1, endLine: line, endCol: 1 }],
      });
    },

    setCodeFile(file) {
      set({ codeFile: file });
    },

    setTheme(t) {
      set({ theme: t });
      scheduleAutosave();
    },

    setNotice(text) {
      set({ notice: text });
    },

    async toggleRule(id) {
      const rules = new Set(get().rules);
      if (rules.has(id)) rules.delete(id);
      else rules.add(id);
      set({ rules });
      scheduleAutosave();
      await get().openPath(get().path);
    },

    // ---------- editing ----------

    blockModules() {
      const here = currentModule();
      const verilog = Object.keys(get().viewDesign()?.modules ?? {}).filter((m) => !get().viewDesign()!.modules[m].auto);
      return [...get().doc.drawn, ...verilog].filter((m) => m !== here);
    },

    startPlacing(p) {
      set({ placing: p, notice: undefined });
    },

    placeAt(at, keepPlacing) {
      const p = get().placing;
      if (!p) return;
      let newIdValue = '';
      editSheet((e) => {
        const [id, e1] = newId(e, 'u');
        newIdValue = id;
        const node = newUserNode(id, p.sym, p.params ? { params: { ...newUserNode(id, p.sym).params, ...p.params } } : {});
        // Give pins and blocks a unique starting name.
        if (p.sym === 'input' || p.sym === 'output' || p.sym === 'inout' || p.sym === 'block') {
          const taken = new Set((get().netlist?.nodes ?? []).flatMap((n) => [n.label, n.subLabel ?? '']));
          const stem = p.sym === 'input' ? 'in' : p.sym === 'output' ? 'out' : p.sym === 'inout' ? 'io' : 'u';
          let k = 1;
          while (taken.has(`${stem}${k}`)) k++;
          node.name = `${stem}${k}`;
        }
        if (p.sym === 'text') node.name = 'Note';
        const size = sizeNode(symbolNode(node, interfaceOf), measureFor(get().theme));
        const pos = { x: snap(at.x - size.width / 2), y: snap(at.y - size.height / 2) };
        return addNodes(e1, [{ node, pos }]);
      });
      if (!newIdValue) return;
      set({ placing: keepPlacing ? p : undefined });
      get().select([newIdValue]);
    },

    previewMove(ids, dx, dy) {
      const s = get();
      if (!s.netlist || !s.sheet || !settled(s)) return;
      let e = edits();
      if (!isDrawnKey(s.sheet) && !isPinned(e)) {
        if (!s.baseLayout) return;
        e = layoutToEdits(e, s.baseLayout, 'existing');
      }
      refresh({ fast: moveNodes(e, s.netlist, ids, dx, dy) });
    },

    moveSelection(ids, dx, dy) {
      if (dx === 0 && dy === 0) {
        refresh();
        return;
      }
      editSheet((e, d) => moveNodes(e, d, ids, dx, dy), { moved: ids });
    },

    connectEnds(a, b, bends) {
      const s = get();
      if (!s.netlist || !s.layout || !settled(s)) return false;
      const c = resolveConnection(s.netlist, a, b);
      if ('error' in c) {
        set({ notice: c.error });
        return false;
      }
      let route: Point[] | undefined;
      if (bends.length) {
        // A wire drawn with bends keeps them: from the driver, through the bends, to the input.
        const pinOf = (end: WireEnd) => (end.kind === 'port' ? s.layout!.nodes.flatMap((n) => n.ports).find((q) => q.id === end.port) : undefined);
        const pointOf = (end: WireEnd): Point[] => {
          if (end.kind === 'port') {
            const p = pinOf(end);
            return p ? [{ x: p.x, y: p.y }] : [];
          }
          // From the wire's own source along its route to where the new wire leaves it.
          const edge = s.layout!.edges.find((x) => x.id === end.edge);
          if (!edge) return [end.at];
          const out: Point[] = [edge.points[0]];
          for (let i = 1; i < edge.points.length; i++) {
            const p = edge.points[i - 1];
            const q = edge.points[i];
            const onSeg =
              Math.min(p.x, q.x) - 1 <= end.at.x && end.at.x <= Math.max(p.x, q.x) + 1 && Math.min(p.y, q.y) - 1 <= end.at.y && end.at.y <= Math.max(p.y, q.y) + 1;
            if (onSeg) {
              out.push(p.x === q.x ? { x: p.x, y: end.at.y } : { x: end.at.x, y: p.y });
              return out;
            }
            out.push(q);
          }
          return out;
        };
        const from = pointOf(a);
        const to = pointOf(b);
        const drawn = drawnRoute([...from, ...bends, ...to.slice().reverse()], pinOf(a)?.side, pinOf(b)?.side);
        const ordered = c.reversed ? drawn.reverse() : drawn;
        if (ordered.length >= 2) route = ordered;
      }
      let id = '';
      editSheet((e) => {
        const [wid, next] = connect(e, c, route);
        id = wid;
        return next;
      });
      if (id) get().select([id]);
      set({ notice: undefined });
      return !!id;
    },

    deleteSelection() {
      const ids = get().selection;
      if (ids.size === 0) return;
      editSheet((e, d) => deleteItems(e, d, ids), { selection: new Set() });
    },

    renameItem(id, text) {
      editSheet((e) => rename(e, id, text));
    },

    resetItemLabel(id) {
      editSheet((e) => resetLabel(e, id));
    },

    setNodeParams(id, params) {
      editSheet((e) => setParams(e, id, params));
    },

    setEdgeSlice(id, slice) {
      editSheet((e) => setSlice(e, id, slice));
    },

    setEdgeRoute(id, points) {
      editSheet((e) => (points ? setRoute(e, id, points, true) : clearRoute(e, id)));
    },

    restoreHidden() {
      editSheet((e) => restoreHidden(e));
    },

    async autoLayout() {
      const s = get();
      if (!s.netlist || !s.sheet || !settled(s)) return;
      const sheet = s.sheet;
      const doc = s.doc;
      set({ status: 'layout' });
      let l: LayoutResult;
      try {
        l = await layoutDiagram(s.netlist, measureFor(s.theme));
      } catch (e) {
        set({ status: 'ready' });
        if (e instanceof LayoutCancelled) return;
        throw e;
      }
      set({ status: get().error ? 'error' : 'ready' });
      // Skip if the user moved on or edited meanwhile, or the netlist changed (other rules, re-import).
      if (get().sheet !== sheet || get().doc !== doc || get().base !== s.base) return;
      editSheet((e) => layoutToEdits({ ...e, pos: {}, routes: {} }, l, 'none'));
    },

    copy() {
      const s = get();
      if (!s.netlist || !s.layout || !settled(s)) return false;
      const copied = s.layout.nodes.filter((n) => s.selection.has(n.id));
      const clip = copyNodes(s.netlist, edits(), s.layout, new Set(copied.map((n) => n.id)), interfaceOf);
      if (!clip) return false;
      const x = Math.min(...copied.map((n) => n.x));
      const y = Math.min(...copied.map((n) => n.y));
      const box = { x, y, width: Math.max(...copied.map((n) => n.x + n.width)) - x, height: Math.max(...copied.map((n) => n.y + n.height)) - y };
      clipboard = { clip, box, sheet: s.sheet };
      return true;
    },

    cut() {
      if (get().copy()) get().deleteSelection();
    },

    paste(near) {
      const s = get();
      if (!clipboard || !s.layout || !settled(s)) return;
      const { clip, box, sheet } = clipboard;
      // On its own sheet: where it was copied from if that is free, otherwise below it, never on top of
      // it. On another sheet those coordinates can be far out of view (Ctrl+V would seem to do nothing):
      // there it goes where the user looks, and below what is already there.
      const from = near && sheet !== s.sheet ? { ...box, x: near.x - box.width / 2, y: near.y - box.height / 2 } : box;
      const where = pasteSpot(from, s.layout.nodes);
      const at2 = { x: snap(where.x), y: snap(where.y) };
      let pasted: string[] = [];
      editSheet((e) => {
        const [next, ids] = pasteClip(e, clip, at2);
        pasted = ids;
        return next;
      });
      if (pasted.length) get().select(pasted);
    },

    duplicate() {
      if (get().copy()) get().paste();
    },

    undo() {
      const s = get();
      const prev = s.past[s.past.length - 1];
      if (!prev) return;
      // The redo entry keeps where the change was made (not where Undo was pressed), so Redo shows it too.
      // A step that changed the files swaps the whole state: Redo comes back here.
      const redo = prev.files ? hereWithFiles() : { ...prev, doc: s.doc };
      set({ past: s.past.slice(0, -1), future: [redo, ...s.future], doc: prev.doc, dirty: true });
      scheduleAutosave();
      void (prev.files ? reopenFiles(prev) : showAfterHistory(prev));
    },

    redo() {
      const s = get();
      const next = s.future[0];
      if (!next) return;
      const undo = next.files ? hereWithFiles() : { ...next, doc: s.doc };
      set({ future: s.future.slice(1), past: [...s.past, undo], doc: next.doc, dirty: true });
      scheduleAutosave();
      void (next.files ? reopenFiles(next) : showAfterHistory(next));
    },

    newDrawing(name = 'drawing') {
      const s = get();
      const taken = new Set([...s.doc.drawn, ...Object.keys(s.design?.modules ?? {}), ...s.moduleNames]);
      const unique = uniqueModuleName(name, taken);
      const doc: EditDoc = { drawn: [...s.doc.drawn, unique], sheets: { ...s.doc.sheets, [`d:${unique}`]: emptyEdits() } };
      pushDoc(doc);
      void get().openPath([{ instance: unique, module: unique, drawn: true }]);
    },

    renameDrawing(from, to) {
      const s = get();
      const want = to.trim();
      if (!want || want === from || !s.doc.drawn.includes(from)) return undefined;
      if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(want)) return 'Use letters, digits and _ (a Verilog module name).';
      if (verilogIdent(want) !== want) return `${want} is a Verilog keyword.`;
      if (s.doc.drawn.includes(want) || s.design?.modules[want] || s.moduleNames.includes(want)) return `A module named ${want} already exists.`;
      const path = renamePathDrawing(s.path, from, want);
      pushDoc(renameDrawingIn(s.doc, from, want), { path, sheet: sheetKey(path[path.length - 1], s.viewMode) });
      refresh();
      return undefined;
    },

    deleteDrawing(name) {
      const s = get();
      if (!s.doc.drawn.includes(name)) return;
      const sheets = { ...s.doc.sheets };
      delete sheets[`d:${name}`];
      const doc: EditDoc = { drawn: s.doc.drawn.filter((d) => d !== name), sheets };
      // Its blocks stay, as instances of a module that no longer exists (no ports, no wires): say where.
      const users = sheetsUsing(doc, name);
      pushDoc(doc, users.length ? { notice: `Deleted ${name}, which is still used as a block on ${users.join(', ')}. Undo brings it back.` } : {});
      if (s.path.some((p) => p.drawn && p.module === name)) void openFallback();
      else refresh();
    },

    async convertToDrawing() {
      const s = get();
      if (!s.netlist || !s.layout || !settled(s)) return;
      const { blockDesign } = s;
      const module = currentModule();
      const main = toDrawing(s.netlist, s.layout, edits(), interfaceOf);
      // Automatic blocks are cut out of the Verilog by this app, so another design (or a changed file)
      // takes them away. The copy gets a drawing of its own for each one it uses, and for those they use,
      // so it keeps working without them. Instances of Verilog modules still name those modules.
      const moduleOf = (u: UserNode) => (u.sym === 'block' ? u.params.module : u.sym === 'raw' && u.raw?.kind === 'instance' ? u.raw.moduleName : undefined);
      const autoOf = (u: UserNode) => {
        const m = moduleOf(u);
        return m && blockDesign?.modules[m]?.auto ? m : undefined;
      };
      const subs = new Map<string, SheetEdits>();
      const queue = main.nodes.map(autoOf);
      while (queue.length) {
        const m = queue.shift();
        if (!m || subs.has(m)) continue;
        const sheet = await autoBlockSheet(m);
        if (!sheet) {
          set({ notice: 'Copy to new drawing was interrupted. Try again.' });
          return;
        }
        const d = toDrawing(sheet.netlist, sheet.layout, sheet.edits, interfaceOf);
        subs.set(m, d);
        queue.push(...d.nodes.map(autoOf));
      }
      // The files changed meanwhile: these blocks are gone.
      if (get().blockDesign !== blockDesign) return;
      const now = get();
      // The new drawings take no module's name, nor the name the Verilog export gives an automatic block
      // or Yosys's copy of a parameterized module (top/score → top_score): the export would then write
      // those under other names, with warnings about names the user never wrote.
      const madeUp = Object.keys(blockDesign?.modules ?? {}).map(verilogIdent);
      const taken = new Set([...now.doc.drawn, ...Object.keys(now.design?.modules ?? {}), ...now.moduleNames, ...madeUp]);
      const name = uniqueModuleName(`${module.replace(/^.*\//, '')}_drawing`, taken);
      taken.add(name);
      // Each block's drawing is named after the copy and the block (top/crop_points → top_drawing_crop_points).
      const names = new Map<string, string>();
      for (const m of subs.keys()) {
        names.set(m, uniqueModuleName(`${name}_${m.replace(/^.*\//, '')}`, taken));
        taken.add(names.get(m)!);
      }
      // Wires name a block's ports; a drawing's ports are named after its pins (see drawingPorts),
      // which are the block's ports as its sheet shows them (`in:<port>`, kept by toDrawing).
      const portNames = new Map<string, Map<string, string>>();
      for (const [m, d] of subs) {
        const byPin = new Map(drawingPorts(d).map((p) => [p.pin, p.name]));
        const map = new Map<string, string>();
        for (const p of blockDesign!.modules[m].ports) {
          const to = byPin.get(`${p.direction === 'input' ? 'in' : p.direction === 'output' ? 'out' : 'io'}:${p.name}`);
          if (to !== undefined) map.set(p.name, to);
        }
        portNames.set(m, map);
      }
      const retarget = (e: SheetEdits): SheetEdits => {
        const ports = new Map<string, Map<string, string>>();
        const nodes = e.nodes.map((u): UserNode => {
          const m = autoOf(u);
          if (!m) return u;
          ports.set(u.id, portNames.get(m)!);
          return { id: u.id, sym: 'block', params: { module: names.get(m)! }, ...(u.name ? { name: u.name } : {}) };
        });
        if (ports.size === 0) return e;
        const end = (x: { node: string; port: string }) => {
          const map = ports.get(x.node);
          const port = map && x.port.startsWith(`${x.node}.`) ? x.port.slice(x.node.length + 1) : undefined;
          const to = port === undefined ? undefined : map!.get(port);
          return to === undefined || to === port ? x : { ...x, port: `${x.node}.${to}` };
        };
        return { ...e, nodes, edges: e.edges.map((w) => ({ ...w, source: end(w.source), target: end(w.target) })) };
      };
      const sheets: EditDoc['sheets'] = { ...now.doc.sheets, [`d:${name}`]: retarget(main) };
      for (const [m, d] of subs) sheets[`d:${names.get(m)}`] = retarget(d);
      const doc: EditDoc = { drawn: [...now.doc.drawn, name, ...names.values()], sheets };
      // Say what the copy is made of, and what still comes from the Verilog files.
      const drawings = new Set(doc.drawn);
      const linked = new Set<string>();
      for (const d of [main, ...subs.values()]) {
        for (const u of d.nodes) {
          const m = moduleOf(u);
          if (m && !autoOf(u) && !drawings.has(m)) linked.add(m);
        }
      }
      const said = [
        names.size ? `Copied ${module} to ${name}, with its blocks as drawings of their own: ${[...names.values()].join(', ')}.` : '',
        linked.size ? `Instances of ${[...linked].join(', ')} still use those modules from your Verilog files.` : '',
      ].filter(Boolean);
      pushDoc(doc, said.length ? { notice: said.join(' ') } : {});
      void get().openPath([{ instance: name, module: name, drawn: true }]);
    },

    // ---------- files ----------

    savedFile() {
      const s = get();
      return {
        format: FILE_FORMAT,
        version: 1,
        files: s.files,
        ...(s.topOverride ? { top: s.topOverride } : {}),
        rules: [...s.rules],
        viewMode: s.viewMode,
        theme: s.theme,
        doc: compactDoc(s.doc),
        path: s.path,
      };
    },

    async loadSaved(text) {
      await applySaved(parseSavedFile(text));
    },

    async restoreAutosave() {
      if (typeof localStorage === 'undefined') return false;
      const text = localStorage.getItem(AUTOSAVE_KEY);
      if (!text) return false;
      try {
        const f = parseSavedFile(text);
        // Whether the work was saved to a file when the browser kept it (see scheduleAutosave).
        const saved = (JSON.parse(text) as { saved?: unknown }).saved === true;
        await applySaved(f, !saved);
        return true;
      } catch {
        return false;
      }
    },

    markSaved() {
      set({ dirty: false });
      // The browser's copy says so too, so a reload does not call the work unsaved.
      scheduleAutosave();
    },
  };
});

/** The symbol under a selection, for the UI. */
export function userNodeOf(id: string) {
  const s = useStore.getState();
  return s.doc.sheets[s.sheet]?.nodes.find((n) => n.id === id);
}

/** Whether an item was drawn by hand on the sheet on screen. */
export function isUserItem(id: string): boolean {
  const s = useStore.getState();
  const e = s.doc.sheets[s.sheet];
  return !!e && userIds(e).has(id);
}
