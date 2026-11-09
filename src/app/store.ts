import { create } from 'zustand';
import { type DNode, type DPort, type Diagram, buildDiagram } from '../core/diagram';
import { DEFAULT_RULES, RULES, type RuleId } from '../core/rules';
import { type HierarchyNode, type IRDesign, type SrcRange, buildDesign, buildHierarchy, displayModuleName } from '../core/ir';
import { moduleTitle } from '../core/names';
import { parseYosysJson } from '../core/yosys-json';
import { flatCellCount, withFlattened } from '../core/flatten';
import { withAutoBlocks } from '../core/partition';
import { AUCTION_FILE, AUCTION_SOURCE } from '../examples/auction';
import { FRUIT_FILE, FRUIT_SOURCE } from '../examples/fruit-battle';
import { GRID, LayoutCancelled, type LayoutResult, type MeasureText, type Point, cancelLayouts, layoutDiagram, sizeNode } from '../layout/elk-layout';
import { canvasMeasure } from '../render/export';
import { THEME } from '../render/theme';
import { YosysError, type YosysErrorKind, type YosysStatus, elaborate } from '../yosys/client';
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
  markOldOutlines,
  OUTLINES,
  parseEdits,
  parseSavedFile,
  sheetKey,
} from '../editor/doc';
import { buildGeometry } from '../editor/geometry';
import {
  type Clip,
  type WireEnd,
  addNodes,
  clearRoute,
  connect,
  copyNodes,
  deleteItems,
  drawingPorts,
  effectiveDiagram,
  fitNewOutlines,
  fitWider,
  layoutToEdits,
  makeRoom,
  moveNodes,
  newId,
  pasteClip,
  placeMissing,
  rename,
  resetLabel,
  resolveConnection,
  restoreHidden,
  setParams,
  followComponents,
  keepLinks,
  unlinkChanged,
  setRoute,
  setSlice,
  toDrawing,
  userIds,
} from '../editor/sheet';
import { type InterfaceOf, type SymKey, type SymParams, type UserNode, newUserNode, symbolNode } from '../editor/symbols';
import { orthogonalize } from '../editor/router';
import { legContaining } from '../editor/draw-wire';
import { type SheetIssues, checkSheet } from '../editor/check';
import { verilogIdent } from '../editor/verilog-ident';
import { type ComponentDef, componentSymbol, followsPreset, isPart, partInterface, partNamed } from '../editor/components';

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
/** At most this many of the steps in the history only went to another sheet (see HistoryEntry.nav). */
const NAV_STEPS = 50;

export const AUTOSAVE_KEY = 'digital-canvas:work:v1';

/**
 * Edits of Verilog sheets put aside by the name of the file whose module they
 * belong to, while no open file declares that module (see changeFiles).
 */
export type PutAside = Record<string, EditDoc['sheets']>;

/** What Save and the browser's copy write: a saved file, with the edits put aside (they must outlive a reload, as the app says they are kept). */
export type SavedWork = SavedFile & { putAside?: PutAside };

/** The edits put aside in a saved file, made sane like the document's (see parseEdits). */
function parsePutAside(text: string): PutAside {
  const out: PutAside = {};
  let v: unknown;
  try {
    v = (JSON.parse(text) as { putAside?: unknown }).putAside;
  } catch {
    return out;
  }
  const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
  if (!isObj(v)) return out;
  for (const [file, sheets] of Object.entries(v)) {
    if (!isObj(sheets)) continue;
    const kept = Object.fromEntries(
      Object.entries(sheets)
        .filter(([k]) => /^v:(blocks|flat):/.test(k))
        .map(([k, e]) => [k, parseEdits(e)] as const)
        .filter(([, e]) => !isEmptyEdits(e)),
    );
    if (Object.keys(kept).length) out[file] = kept;
  }
  // Put aside in a file saved with older symbol outlines: they get room when they come back, as the document's do.
  for (const sheets of Object.values(out)) markOldOutlines(sheets, (JSON.parse(text) as { outlines?: unknown }).outlines);
  return out;
}

/** JSON with the keys of every object in order: equal data gives equal text, however it was built. */
function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x,
  );
}

/**
 * What a copy of the work in the browser holds, read as Open reads it: `work` is what a tab can
 * lose (the files, the rules, the edits and the edits put aside), `view` where it looks (sheet,
 * view, Top) and whether it is saved to a file. Undefined for text that is not a copy.
 */
export function copyKeys(text: string): { work: string; view: string } | undefined {
  try {
    const f = parseSavedFile(text);
    const saved = (JSON.parse(text) as { saved?: unknown }).saved === true;
    return {
      work: stableJson({ files: f.files, rules: [...f.rules].sort(), doc: compactDoc(f.doc), putAside: parsePutAside(text) }),
      view: stableJson({ top: f.top, viewMode: f.viewMode, path: f.path, saved }),
    };
  } catch {
    return undefined;
  }
}

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
  /** For a change of the drawing rules: the rules to go back to (they redraw every Verilog sheet). */
  rules?: RuleId[];
  /**
   * A step that only went to another sheet (opened a block, went up the breadcrumb, picked a module in the
   * hierarchy or a drawing, switched Block diagram and Full circuit): Undo goes back to `path` (in the view
   * `sheet` belongs to), Redo comes back. The document is not part of it.
   */
  nav?: boolean;
}

export interface Placing {
  sym: SymKey;
  params?: SymParams;
  /** The preset of the library it is placed from: the symbol follows the preset (see followComponents). */
  component?: string;
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
  /** What the running elaboration waits for: Yosys loading, or Yosys working on the design. */
  yosys?: YosysStatus;
  error?: string;
  /** Whether the error is in the design, a design Yosys did not finish, or Yosys failing to load. */
  errorKind?: YosysErrorKind;
  log: string;
  /** Selected symbols and wires. */
  selection: ReadonlySet<string>;
  /** Node ids highlighted from the code panel. */
  highlighted: Set<string>;
  /** Source ranges highlighted in the code panel. */
  codeRanges: SrcRange[];
  codeFile?: string;
  rules: ReadonlySet<RuleId>;
  elapsedMs?: number;
  /** The full circuit held back while status is 'too-large'. */
  bigFlat?: { module: string; cells: number };
  /** A symbol chosen in the library, waiting to be placed. */
  placing?: Placing;
  /** A short message about the last action (e.g. why a wire was refused). */
  notice?: string;
  /**
   * Another tab wrote its work to the browser's copy (one copy for all tabs): this tab stopped
   * keeping its own there, which would overwrite that work, until the user says which to keep.
   */
  autosavePaused?: boolean;

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
  /** Go to another sheet as a step of the undo history (see HistoryEntry.nav): what the user's clicks do. */
  navigate(path: PathEntry[]): Promise<void>;
  /** Draw the full circuit that `bigFlat` held back. */
  drawBigFlat(): Promise<void>;
  enterInstance(instance: string, module: string, drawn?: boolean): Promise<void>;
  /** Open the sub-module of a block, if it has one. */
  openNode(id: string): void;
  select(ids: Iterable<string>, mode?: 'replace' | 'toggle' | 'add'): void;
  selectAll(): void;
  selectLine(file: string, line: number): void;
  setCodeFile(file: string): void;
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
  /**
   * Wire two ends. `drawn`: the wire as the user drew it, from where it starts at `a` to where it ends at
   * `b` (a pin, or a point on a wire); it is stored as drawn. Without it the wire is routed automatically.
   */
  connectEnds(a: WireEnd, b: WireEnd, drawn?: Point[]): boolean;
  deleteSelection(): void;
  /** Rename a symbol or wire; returns why it was refused, if it was. */
  renameItem(id: string, text: string): string | undefined;
  resetItemLabel(id: string): void;
  setNodeParams(id: string, params: SymParams): void;
  setEdgeSlice(id: string, slice: { lo: number; width: number } | undefined): void;
  setEdgeRoute(id: string, points: Point[] | undefined): void;
  /** Reshape several wires in one undo step (a stretch that wires of a net share moves for all of them). */
  setEdgeRoutes(routes: Record<string, Point[]>): void;
  restoreHidden(): void;
  autoLayout(): Promise<void>;
  copy(): boolean;
  cut(): void;
  /**
   * Paste what Copy took: on the sheet it was copied from, beside the original
   * when that spot is in `view` (the part of the sheet on screen); on another
   * sheet, or when that spot is out of view, centred on `near` (where the user
   * looks). Without them (Duplicate), beside the original.
   */
  paste(near?: Point, view?: Box): void;
  duplicate(): void;
  undo(): void;
  redo(): void;
  newDrawing(name?: string): void;
  /**
   * Make these the components of the library (one undo step): the blocks of parts follow their pins, the
   * symbols placed from a preset its settings (and its new name, when `renamed` says it was renamed).
   */
  setComponents(defs: ComponentDef[], renamed?: Readonly<Record<string, string>>): void;
  /** Why a part of the library may not be named `name` (a drawing or a Verilog module has the name), or nothing. */
  componentNameTaken(name: string): string | undefined;
  renameDrawing(from: string, to: string): string | undefined;
  deleteDrawing(name: string): void;
  /** Copy the sheet on screen into a new drawing (with drawings of the automatic blocks it uses). */
  convertToDrawing(): Promise<void>;

  // ----- files -----
  savedFile(): SavedWork;
  loadSaved(text: string): Promise<void>;
  /** Start from the browser's autosaved work, if any; returns false when there is none. */
  restoreAutosave(): Promise<boolean>;
  markSaved(): void;
  /**
   * Another tab wrote `text` to the browser's copy: stop overwriting it (see autosavePaused), unless
   * it holds the work this tab last wrote or read there (that tab only opened it, or looked around).
   */
  otherTabSaved(text: string): void;
  /** Keep this tab's work in the browser's copy again, in place of the other tab's. */
  keepThisTab(): void;
  /** Write a copy that is waiting to be written now (the page is being closed or reloaded). */
  flushAutosave(): void;
}

const layoutCache = new Map<string, LayoutResult>();
const baseCache = new Map<string, Diagram>();
/** Modules whose large full circuit the user chose to draw (cleared on rebuild). */
const flatAllowed = new Set<string>();
/** Incremented by every rebuild/navigation, so a slow older call cannot overwrite a newer result. */
let rebuildGen = 0;
/** Withdraws the Yosys run of the previous rebuild: its result would be dropped anyway. */
let rebuildAbort: AbortController | undefined;
let navSeq = 0;
/** What Copy took, the box of the copied symbols, and the sheet they were copied from (see paste). */
let clipboard: { clip: Clip; box: Box; sheet: string } | undefined;
let autosaveTimer: ReturnType<typeof setTimeout> | undefined;
/** What this tab last wrote to the browser's copy, or read from it (see copyKeys). */
let copied: { work: string; view: string } | undefined;
/**
 * The work as it was then (`doc`, and the objects that hold the rest of it), and the document as only
 * this tab's drawing of its sheets has changed it since (`derived`: the places of symbols added since
 * the sheet was last edited, routes found; see refresh). While the work is still this, the tab has
 * changed nothing.
 */
let copiedWork: { doc: EditDoc; derived: EditDoc; files: Record<string, string>; rules: ReadonlySet<RuleId>; putAside: PutAside } | undefined;

let measurer: MeasureText | undefined;
/** Text measurement in the drawings' font (one canvas, made when first needed). */
export function textMeasure(): MeasureText {
  return (measurer ??= canvasMeasure(THEME.font));
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
  // Never a Verilog keyword: no Verilog module can have that name.
  base = verilogIdent(base);
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`;
}

// The panels name modules as the user wrote them; so do the sheet checks (editor/check), which share it.
export { moduleTitle };

/** The view a Verilog sheet key belongs to (undefined for a drawing or no sheet). */
export function viewModeOf(key: string): ViewMode | undefined {
  const m = /^v:(blocks|flat):/.exec(key);
  return m ? (m[1] as ViewMode) : undefined;
}

/** Whether two paths go down the same instances to the same sheet. */
export function samePath(a: readonly PathEntry[], b: readonly PathEntry[]): boolean {
  return a.length === b.length && a.every((x, i) => x.instance === b[i].instance && x.module === b[i].module && !x.drawn === !b[i].drawn);
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
  return { ...doc, drawn: doc.drawn.map((d) => (d === from ? to : d)), sheets };
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

/** Where symbols placed from the preset `component` (and still following it) are, by sheet name. */
export function sheetsPlacing(doc: EditDoc, component: string): string[] {
  const out = new Set<string>();
  for (const [k, e] of Object.entries(doc.sheets)) {
    if (e.nodes.some((n) => n.component === component && followsPreset(n, doc.components))) out.add(k.replace(/^d:|^v:[a-z]+:/, ''));
  }
  return [...out];
}

/**
 * What is being placed once the library is `defs` (its presets renamed as `renamed` says): a preset chosen to be
 * placed is placed as it is now, or no more when it is gone. `placing` itself when that changes nothing.
 */
export function placingNow(placing: Placing | undefined, defs: readonly ComponentDef[] | undefined, renamed?: Readonly<Record<string, string>>): Placing | undefined {
  if (!placing?.component) return placing;
  const name = renamed && Object.hasOwn(renamed, placing.component) ? renamed[placing.component] : placing.component;
  const def = defs?.find((c) => c.name === name);
  if (!def || isPart(def) || def.base !== placing.sym) return undefined;
  const now: Placing = { ...componentSymbol(def), component: def.name };
  // The params exactly as the library writes them (the palette shows the preset chosen by comparing them).
  return now.component === placing.component && JSON.stringify(now.params ?? {}) === JSON.stringify(placing.params ?? {}) ? placing : now;
}

/**
 * The document without the edits of Verilog sheets (drawings stay). Those
 * edits are keyed by module name only, so another design must not inherit them.
 * Returns `doc` itself when there is nothing to drop.
 */
export function withoutVerilogEdits(doc: EditDoc): EditDoc {
  const verilog = Object.keys(doc.sheets).filter((k) => !isDrawnKey(k));
  if (!verilog.some((k) => !isEmptyEdits(doc.sheets[k]))) return doc;
  return { ...doc, sheets: Object.fromEntries(Object.entries(doc.sheets).filter(([k]) => isDrawnKey(k))) };
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
    // The library may have changed meanwhile: what no longer has its preset's settings stops following it.
    sheets = { ...sheets, ...Object.fromEntries(back.map((k) => [k, keepLinks(kept[k], doc.components)])) };
    for (const k of back) restored.add(own.find((m) => ofModules(k, [m]))!);
    // What came back is in the document now (and in the undo history): it is not put aside twice.
    const rest = Object.fromEntries(Object.entries(kept).filter(([k]) => !back.includes(k)));
    aside = { ...aside };
    if (Object.keys(rest).length) aside[f] = rest;
    else delete aside[f];
  }
  return { doc: sheets === doc.sheets ? doc : { ...doc, sheets }, putAside: aside, restored: [...restored] };
}

/** The module at each instance path of a design (`u_a/u_b`; the top's is ''). */
function modulesByPath(design: IRDesign): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (module: string, path: string, depth: number) => {
    out.set(path, module);
    if (depth >= 64) return;
    for (const c of design.modules[module]?.cells ?? []) {
      if (c.isInstance && design.modules[c.type]) walk(c.type, path ? `${path}/${c.name}` : c.name, depth + 1);
    }
  };
  walk(design.top, '', 0);
  return out;
}

export interface ParamodFollow {
  doc: EditDoc;
  /** Modules whose edits now belong to the module that took their place. */
  moved: { from: string; to: string }[];
  /**
   * Modules that blocks name on drawings made by Copy to new drawing of a module with their instances, whose blocks
   * there now name the module that took their place; `on`: those sheets.
   */
  blocks: { from: string; to: string; on: string[] }[];
  /**
   * Modules with edits that the design no longer has, and that nothing took the place of: a parameterized
   * module, or a module used with its default parameters whose instances all give it parameters now.
   */
  lost: string[];
  /**
   * Modules that blocks name, which the design no longer has, and whose blocks lost their pins: nothing took the place
   * of the module, or their sheets are no copies of a module with its instances; `on`: their sheets. `parameters`: its
   * instances are there, with other parameters.
   */
  stranded: { module: string; on: string[]; parameters: boolean }[];
}

/** Whether a module is `module` or one of its automatic blocks (`<module>/<block>`). */
const isOrIn = (name: string, module: string) => name === module || name.startsWith(`${module}/`);

/** The module an instance on a sheet names: a block's, or that of an instance copied as it was drawn (`raw`). */
const instanceModule = (u: UserNode) => (u.sym === 'block' ? u.params.module : u.sym === 'raw' && u.raw?.kind === 'instance' ? u.raw.moduleName : undefined);

/**
 * Yosys names its copy of a parameterized module after the parameters
 * (`$paramod\baud_gen\DIV=…`; with the default parameters it keeps the
 * module's name), and the edits of its sheets are keyed by that name, as are
 * the copies Copy to new drawing makes of its instances (blocks, or instances
 * kept as they were drawn). When new code gives the instances other parameters
 * (or gives them some, or takes them away), the edits follow the module to its
 * new name: to the module that is now at the instances of the old one, if that
 * is the same Verilog module, new in the design and has no edits of its own.
 * On a copy of a module with those instances, its blocks of the old module
 * follow them whether the module had edits or not. Another drawing's blocks
 * are no copies: they use the module as the Library offers it, and the new
 * parameters of an instance elsewhere are not theirs, so they keep their
 * module. The others are `lost` and `stranded` (they stay in the
 * document: code with the old parameters shows them again). Nothing moves or
 * is lost when the design has another top. Returns `doc` itself when nothing
 * moves.
 */
export function followParamods(doc: EditDoc, before: IRDesign, after: IRDesign): ParamodFollow {
  // Under another top, the modules of the old one are only out of sight (Top brings them back).
  if (before.top !== after.top) return { doc, moved: [], blocks: [], lost: [], stranded: [] };
  const edited = (m: string) => Object.keys(doc.sheets).some((k) => ofModules(k, [m]) && !isEmptyEdits(doc.sheets[k]));
  const names = (n: UserNode, m: string) => {
    const x = instanceModule(n);
    return !!x && isOrIn(x, m);
  };
  /** The sheets with instances of a module (or of its automatic blocks), of those that `pick` takes. */
  const users = (m: string, pick: (n: UserNode, e: SheetEdits) => boolean = () => true) => [
    ...new Set(Object.entries(doc.sheets).flatMap(([k, e]) => (e.nodes.some((n) => names(n, m) && pick(n, e)) ? [k.replace(/^d:|^v:[a-z]+:/, '')] : []))),
  ];
  const was = modulesByPath(before);
  const now = modulesByPath(after);
  const gone = Object.keys(before.modules).filter((m) => !after.modules[m] && (edited(m) || users(m).length > 0));
  /** The modules now at the instances of a gone one that are the same Verilog module. */
  const same = new Map(
    gone.map((g) => [
      g,
      new Set(
        [...was]
          .filter(([, m]) => m === g)
          .map(([p]) => now.get(p))
          .filter((m): m is string => m !== undefined && displayModuleName(m) === displayModuleName(g)),
      ),
    ]),
  );
  // The one that took its place: new in the design, and alone there.
  const successor = new Map<string, string>();
  for (const g of gone) {
    const at = [...same.get(g)!].filter((m) => !before.modules[m]);
    if (at.length === 1) successor.set(g, at[0]);
  }
  const target = new Map(
    gone.filter(edited).map((g) => {
      const to = successor.get(g);
      return [g, to && !edited(to) ? to : undefined];
    }),
  );
  // Two old modules that end up as one: whose edits would it show?
  const claims = (to: string) => [...target.values()].filter((t) => t === to).length;
  const moved = [...target].flatMap(([from, to]) => (to && claims(to) === 1 ? [{ from, to }] : []));
  // A module used with its defaults is gone too when its instances are deleted: that is no change of parameters.
  const lost = [...target.keys()].filter((g) => !moved.some((m) => m.from === g) && (g.startsWith('$paramod') || same.get(g)!.size > 0));
  // Copy to new drawing keeps the IDs of the instances it copies (`cell:u_baud`), and nothing else gives a symbol such
  // an ID (placed and pasted ones get `u:<n>`): a sheet with a copy of an instance of the old module is a copy of a
  // module with that instance, and its blocks of the old module follow the instances. Also when the code has renamed
  // the instance since: the copy keeps the name it had.
  const copied = (e: SheetEdits, g: string) => e.nodes.some((n) => instanceModule(n) === g && n.id.startsWith('cell:'));
  /** The old module whose instances a symbol on sheet `e` follows (it names that module or one of its automatic blocks). */
  const followed = (n: UserNode, e: SheetEdits) => {
    const m = instanceModule(n);
    return m === undefined ? undefined : [...successor.keys()].find((g) => isOrIn(m, g) && copied(e, g));
  };
  const blocks = gone.flatMap((g) => {
    const on = users(g, (n, e) => followed(n, e) === g);
    return on.length ? [{ from: g, to: successor.get(g)!, on }] : [];
  });
  // An instance copied as it was drawn keeps its pins.
  const stranded = gone.flatMap((g) => {
    const on = users(g, (n, e) => n.sym === 'block' && followed(n, e) === undefined);
    return on.length ? [{ module: g, on, parameters: same.get(g)!.size > 0 }] : [];
  });
  if (moved.length === 0 && blocks.length === 0) return { doc, moved, blocks, lost, stranded };
  /** A module's new name (its automatic blocks go along). */
  const renamed = (rename: ReadonlyMap<string, string>, m: string) => {
    for (const [from, to] of rename) if (isOrIn(m, from)) return to + m.slice(from.length);
    return m;
  };
  const keys = new Map(moved.map((m) => [m.from, m.to]));
  const keyOf = (k: string) => {
    const m = /^(v:[a-z]+:)(.*)$/.exec(k);
    return m ? m[1] + renamed(keys, m[2]) : k;
  };
  const follow = (e: SheetEdits): SheetEdits => {
    const nodes = e.nodes.map((n): UserNode => {
      const g = followed(n, e);
      if (g === undefined) return n;
      const to = renamed(new Map([[g, successor.get(g)!]]), instanceModule(n)!);
      if (n.sym === 'block') return { ...n, params: { ...n.params, module: to } };
      // Its pins take the widths the new parameters give them, as a block's do.
      const width = new Map((after.modules[to]?.ports ?? []).map((p) => [p.name, p.bits.length]));
      const ports = n.raw!.ports.map((p) => {
        const w = width.get(p.name);
        return w === undefined || w === p.width ? p : { ...p, width: w };
      });
      return { ...n, raw: { ...n.raw!, cellType: to, moduleName: to, ports } };
    });
    return nodes.some((n, i) => n !== e.nodes[i]) ? { ...e, nodes } : e;
  };
  const sheets: EditDoc['sheets'] = {};
  // The moved edits take the place of what the new module's sheets hold (nothing: it has no edits).
  for (const [k, e] of Object.entries(doc.sheets)) if (keyOf(k) === k) sheets[k] = follow(e);
  for (const [k, e] of Object.entries(doc.sheets)) if (keyOf(k) !== k) sheets[keyOf(k)] = follow(e);
  return { doc: { ...doc, sheets }, moved, blocks, lost, stranded };
}

/**
 * Wires drawn with a bit range that their source no longer has (it was made
 * narrower since): the sheet takes them as carrying all of the source, which
 * their labels (`d[7:4]`) hide.
 */
export function staleSlices(d: Diagram, e: SheetEdits | undefined): { edge: string; source: string; text: string }[] {
  const own = (n: DNode) => (n.kind === 'input' || n.kind === 'output' || n.kind === 'inout' || n.kind === 'const' ? n.label : (n.subLabel ?? n.label));
  /** A symbol with several outputs names the one the wire leaves. */
  const nameOf = (n: DNode, port: DPort) => (n.ports.filter((p) => p.dir === 'out').length > 1 ? `${own(n)}.${port.name}` : own(n));
  return (e?.edges ?? []).flatMap((u) => {
    const from = d.nodes.find((n) => n.id === u.source.node);
    const port = from?.ports.find((p) => p.id === u.source.port);
    if (!u.slice || !from || !port || u.slice.lo + u.slice.width <= port.width) return [];
    const to = d.nodes.find((n) => n.id === u.target.node);
    const hi = u.slice.lo + u.slice.width - 1;
    const name = nameOf(from, port);
    const text =
      `The wire from ${name}${to ? ` to ${own(to)}` : ''} takes ${hi === u.slice.lo ? `bit ${hi}` : `bits ${hi}:${u.slice.lo}`}, ` +
      `but ${name} has ${port.width} bit${port.width === 1 ? '' : 's'} now: it carries all of ${name}. Set its bits again, or widen ${name}.`;
    return [{ edge: u.id, source: from.id, text }];
  });
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

export type DropPlan =
  /** New versions of open files (by file name), or files that share no module with any: setFiles with newVersion. */
  | { kind: 'update'; plan: ImportPlan }
  /** One file that declares modules of open files under another name: let Import Verilog say what importing it does. */
  | { kind: 'ask'; name: string; code: string }
  /** Several such files: added as they are, and the notice says which modules are now declared twice. */
  | { kind: 'add'; twice: string[] };

/**
 * What dropping Verilog files on the window does. Modules are matched by name
 * only, so a file that declares a module an open file declares may be another
 * design (two `top`s): it must not take that file's place, nor its edits,
 * unseen. Only a file named like an open file (or like a removed one whose
 * edits are put aside) is taken for a new version of it, as Import does.
 */
export function planDrop(open: Record<string, string>, putAside: PutAside, dropped: Record<string, string>): DropPlan {
  const fresh = Object.keys(dropped).filter((f) => !(f in open) && !(f in putAside));
  // Modules of the open files that the drop does not update.
  const kept = new Set(declaredModules(Object.fromEntries(Object.entries(open).filter(([f]) => !(f in dropped)))));
  const twice = [...new Set(fresh.flatMap((f) => declaredModules({ [f]: dropped[f] }).filter((m) => kept.has(m))))];
  if (twice.length === 0) return { kind: 'update', plan: planImport(open, dropped) };
  if (Object.keys(dropped).length === 1) return { kind: 'ask', name: fresh[0], code: dropped[fresh[0]] };
  return { kind: 'add', twice };
}

/**
 * What File › Open Verilog files does with the files picked: a set with a file
 * named like an open file (or like a removed one whose edits are put aside) is
 * a new version of the design, all of it. Its other files are new parts of it
 * (a file split in two, say), so an open file whose modules they declare again
 * gives way to them, as on Import (see planImport): unlike a drop (planDrop),
 * nothing is left declared twice. Undefined for another design, opened in
 * place of the open files.
 */
export function planOpen(open: Record<string, string>, putAside: PutAside, picked: Record<string, string>): ImportPlan | undefined {
  return Object.keys(picked).some((f) => f in open || f in putAside) ? planImport(open, picked) : undefined;
}

/**
 * The points of a wire from its source up to `at`, a point on it (`at` itself left out): the stretch of
 * its net a new wire that starts or ends there shares. Nothing when `at` is not on it (the wire was
 * redrawn meanwhile): the new wire then does not reach its source, and the sheet routes it again.
 */
export function wireUpTo(points: readonly Point[], at: Point): Point[] {
  const i = legContaining(points, at);
  return i === undefined ? [] : points.slice(0, i + 1);
}

/** The editor's state and actions, for helpers that read it (see useStore.getState). */
export type EditorState = State;

export const useStore = create<State>((set, get) => {
  // ---------- helpers that need the store ----------

  const interfaceOf: InterfaceOf = (name) => {
    const { doc, design, blockDesign } = get();
    if (doc.drawn.includes(name)) return { label: name, ports: drawingPorts(doc.sheets[`d:${name}`]) };
    // Not viewDesign(): a block copied from an automatic block names a module only the block
    // view has, and it must keep its ports (and wires) when the full circuit is shown.
    const m = blockDesign?.modules[name] ?? design?.modules[name];
    if (m) return { label: m.displayName, ports: m.ports.map((p) => ({ name: p.name, dir: p.direction, width: p.bits.length })) };
    // A part of the library: a module with pins and no logic, until a drawing or Verilog of that name defines it.
    const part = partNamed(doc.components, name);
    return part ? partInterface(part) : undefined;
  };

  /** Names the parts of the library take, which a new drawing must not take too. */
  const partNames = () => (get().doc.components ?? []).filter(isPart).map((c) => c.name);

  const edits = (): SheetEdits => get().doc.sheets[get().sheet] ?? emptyEdits();

  /** False while a Verilog sheet is being opened: what is on screen still belongs to the previous one. */
  const settled = (s: State) => isDrawnKey(s.sheet) || s.loadedSheet === s.sheet;

  /**
   * A sheet's netlist with the symbols the user deleted from it too (they keep their positions, and come back
   * there with Restore): room made for a symbol that grew keeps clear of them, and they get room themselves.
   */
  const withHidden = (module: string, base: Diagram | undefined, e: SheetEdits, shown?: Diagram): Diagram =>
    shown && !e.hidden.length ? shown : effectiveDiagram(module, base, restoreHidden(e), interfaceOf);

  /**
   * A Verilog sheet's netlist before edits (cached, as openPath builds it), when the design has its module. A full
   * circuit only up to FLAT_CELL_LIMIT cells, as building a bigger one takes a while.
   */
  const baseOf = (mode: ViewMode, module: string): Diagram | undefined => {
    const { rules, design, blockDesign } = get();
    const cacheKey = `${mode}:${module}:${rulesKey(rules)}`;
    let base = baseCache.get(cacheKey);
    if (base) return base;
    const view = mode === 'blocks' ? (blockDesign ?? design) : design;
    if (!view?.modules[module] || (mode === 'flat' && flatCellCount(view, module) > FLAT_CELL_LIMIT)) return undefined;
    base = buildDiagram(mode === 'flat' ? withFlattened(view, module) : view, module, rules);
    baseCache.set(cacheKey, base);
    return base;
  };

  /**
   * The sheets after symbols on them took other settings (`before` → `after`, as when a preset changes): those
   * that got wider (a gate with more inputs) make room, as in Properties (see setNodeParams). A Verilog sheet whose
   * netlist cannot be had now (see baseOf) is left as it is.
   */
  const roomForWider = (before: EditDoc['sheets'], after: EditDoc['sheets']): EditDoc['sheets'] => {
    if (after === before) return after;
    const measure = textMeasure();
    const width = (u: UserNode) => sizeNode(symbolNode(u, interfaceOf), measure).width;
    let out = after;
    for (const [key, e] of Object.entries(after)) {
      const old = before[key];
      if (!old || old === e) continue;
      const widths = new Map<string, number>();
      for (const u of e.nodes) {
        const was = old.nodes.find((x) => x.id === u.id);
        if (was && was !== u && e.pos[u.id] && width(u) > width(was)) widths.set(u.id, width(was));
      }
      if (!widths.size) continue;
      const mode = viewModeOf(key);
      const module = mode ? key.slice(`v:${mode}:`.length) : key.slice(2);
      const base = mode ? baseOf(mode, module) : undefined;
      if (mode && !base) continue;
      if (out === after) out = { ...after };
      out[key] = fitWider(e, withHidden(module, base, e), widths, measure);
    }
    return out;
  };

  /** A history entry for the document as it is now. */
  const here = (): HistoryEntry => ({ doc: get().doc, path: get().path, sheet: get().sheet });

  /** Push the current document on the undo stack and replace it. */
  const pushDoc = (doc: EditDoc, extra: Partial<State> = {}) => {
    set({ past: [...get().past.slice(-(HISTORY - 1)), here()], future: [], doc, dirty: true, ...extra });
    scheduleAutosave();
  };

  const currentModule = () => get().path[get().path.length - 1]?.module ?? '';

  /**
   * Going to another sheet is a step of the undo history: Ctrl+Z goes back to the sheet before (after
   * opening a block, back to its parent), Ctrl+Shift+Z comes back. Unlike an edit it keeps the redo
   * history: what was undone can still be redone after a look at another sheet (a step that only
   * navigates changes nothing the steps there depend on). Nothing is recorded when no sheet is open yet
   * or the path stays the same.
   */
  const navStep = (to?: PathEntry[]) => {
    const s = get();
    if (!s.sheet || (to && samePath(to, s.path))) return;
    set({ past: withNavStep(s.past, { ...here(), nav: true }) });
  };

  /**
   * The history with a navigation step added. Browsing must not push the edits out: past NAV_STEPS
   * navigation steps, or a full history, the oldest navigation step goes (an edit only when there is no other).
   */
  const withNavStep = (past: readonly HistoryEntry[], entry: HistoryEntry): HistoryEntry[] => {
    const out = [...past, entry];
    while (out.filter((h) => h.nav).length > NAV_STEPS || out.length > HISTORY) {
      const i = out.findIndex((h) => h.nav);
      out.splice(i < out.length - 1 ? i : 0, 1);
    }
    return out;
  };

  /** Whether `entry` is where the user is now: the same sheet, reached the same way. */
  const isHere = (entry: HistoryEntry) => entry.sheet === get().sheet && samePath(entry.path, get().path);

  /** Undo or Redo of a navigation step: open its sheet, in its view. */
  const goTo = (entry: HistoryEntry) => {
    const mode = viewModeOf(entry.sheet);
    if (mode && mode !== get().viewMode) applyViewMode(mode);
    return get().openPath(entry.path);
  };

  /** Whether a history entry's sheet can still be opened (a drawing may be gone, a module renamed away). */
  const canOpen = (entry: HistoryEntry): boolean => {
    const last = entry.path[entry.path.length - 1];
    if (!last) return false;
    const s = get();
    if (entry.path.some((x) => x.drawn && !s.doc.drawn.includes(x.module))) return false;
    if (last.drawn) return true;
    const mode = viewModeOf(entry.sheet) ?? s.viewMode;
    const view = mode === 'blocks' ? (s.blockDesign ?? s.design) : s.design;
    return !!view?.modules[last.module];
  };

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
    let e = opts.fast ?? edits();
    const netlist = effectiveDiagram(currentModule(), drawn ? undefined : s.base, e, interfaceOf);
    const measure = textMeasure();
    // Saved with the symbol outlines of before: the symbols that grew since get room, once (stored below).
    const refitted = !!e.oldOutlines;
    if (e.oldOutlines) e = fitNewOutlines(e, withHidden(currentModule(), drawn ? undefined : s.base, e, netlist), measure);
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
      pos = placeMissing(netlist, pos, s.baseLayout, (n) => sizeNode(n, measure), routes);
    }
    // placeMissing keeps symbols apart and off nearby wires when it can; stored wires that still
    // run through a symbol placed now are routed again, as after a move.
    const moved = placed.length ? new Set([...(opts.moved ?? []), ...placed]) : opts.moved;
    const g = buildGeometry({ netlist, pos, routes, measure, fast: !!opts.fast, moved, previous: s.layout });
    let issues = checkSheet(netlist, { verilog: !drawn });
    // A wire whose bit range its source no longer has carries all of it, which its label hides (see staleSlices).
    const stale = staleSlices(netlist, e);
    if (stale.length) issues = { ...issues, flagged: new Set([...issues.flagged, ...stale.map((w) => w.edge)]), messages: [...issues.messages, ...stale.map((w) => w.text)] };
    const selection = new Set([...s.selection].filter((id) => netlist.nodes.some((n) => n.id === id) || netlist.edges.some((x) => x.id === id)));
    const patch: Partial<State> = { netlist, layout: g.layout, issues, selection: selection.size === s.selection.size ? s.selection : selection };
    if (!opts.fast && (refitted || placed.length || Object.keys(g.routed).length) && (drawn || isPinned(e))) {
      const stored: SheetEdits = { ...e, pos, routes: { ...e.routes, ...g.routed } };
      patch.doc = { ...s.doc, sheets: { ...s.doc.sheets, [key]: stored } };
      if (copiedWork?.derived === s.doc) copiedWork = { ...copiedWork, derived: patch.doc };
    }
    set(patch);
  };

  /** `force`: write even what the copy holds already (it may be another tab's work: see keepThisTab). */
  const writeAutosave = (force = false) => {
    clearTimeout(autosaveTimer);
    autosaveTimer = undefined;
    if (get().autosavePaused) return;
    const s = get();
    // A tab that has changed nothing of the work since it read or wrote the copy (it only looked) writes the work as
    // it was then: what drawing its sheets added (see copiedWork) would be other work to the tab working on it, which
    // would stop keeping the copy.
    const looked = !force && copiedWork && s.doc === copiedWork.derived && s.files === copiedWork.files && s.rules === copiedWork.rules && s.putAside === copiedWork.putAside;
    // Whether the work is saved to a file goes along (only here, not in saved files): see restoreAutosave.
    const text = JSON.stringify({ ...s.savedFile(), ...(looked ? { doc: compactDoc(copiedWork!.doc) } : {}), ...(s.dirty ? {} : { saved: true }) });
    const keys = copyKeys(text);
    // Nothing changed since this tab read or wrote the copy (it was only opened): writing it again would tell other
    // tabs it changed.
    if (!force && keys && copied && keys.work === copied.work && keys.view === copied.view) return;
    try {
      localStorage.setItem(AUTOSAVE_KEY, text);
      copied = keys;
      if (!looked) copiedWork = { doc: s.doc, derived: s.doc, files: s.files, rules: s.rules, putAside: s.putAside };
    } catch {
      set({ notice: 'Could not keep a copy in this browser (storage is full or blocked). Use File › Save drawing.' });
    }
  };

  const scheduleAutosave = () => {
    if (typeof localStorage === 'undefined' || get().autosavePaused) return;
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(writeAutosave, 400);
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
      l = await layoutDiagram(diagram, textMeasure());
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
    const { blockDesign, rules, doc } = get();
    if (!blockDesign?.modules[module]) return undefined;
    const cacheKey = `blocks:${module}:${rulesKey(rules)}`;
    let base = baseCache.get(cacheKey);
    if (!base) {
      base = buildDiagram(blockDesign, module, rules);
      baseCache.set(cacheKey, base);
    }
    const saved = doc.sheets[sheetKey({ instance: module, module }, 'blocks')] ?? emptyEdits();
    const netlist = effectiveDiagram(module, base, saved, interfaceOf);
    const measure = textMeasure();
    // As refresh() draws it: with room for the symbols that grew since an older file was saved.
    const e = saved.oldOutlines ? fitNewOutlines(saved, withHidden(module, base, saved, netlist), measure) : saved;
    let { pos, routes } = e;
    if (!isPinned(e) || netlist.nodes.some((n) => !pos[n.id])) {
      const elk = await elkOf(cacheKey, base);
      if (!elk) return undefined;
      if (!isPinned(e)) ({ pos, routes } = layoutToEdits(e, elk, 'none'));
      else pos = placeMissing(netlist, pos, elk, (n) => sizeNode(n, measure), routes);
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
   * Drawings and Verilog modules share one namespace: blocks and drill-down
   * find a module by name. New and renamed drawings avoid the
   * names of Verilog modules, but Verilog imported later can declare one. Such a
   * drawing is renamed, with the blocks that use it, also in the undo history,
   * so that no undo brings the clash back.
   */
  const renameClashingDrawings = (moduleNames: readonly string[]) => {
    const s = get();
    const clash = s.doc.drawn.filter((d) => moduleNames.includes(d));
    if (clash.length === 0) return;
    const history = [...s.past, ...s.future];
    const taken = new Set([...moduleNames, ...s.doc.drawn, ...history.flatMap((h) => h.doc.drawn), ...partNames()]);
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
    const { doc, path, sheet } = fix({ doc: s.doc, path: s.path, sheet: s.sheet });
    const list = [...names].map(([from, to]) => `${from} → ${to}`).join(', ');
    set({
      doc,
      path,
      sheet,
      past: s.past.map(fix),
      future: s.future.map(fix),
      dirty: true,
      notice: `Renamed drawing ${list}: the Verilog now declares a module with that name.`,
    });
    scheduleAutosave();
  };

  /**
   * Start over from a saved file. `dirty`: the work is not saved to a file (it comes from the browser's copy).
   * `fromCopy`: it is the browser's copy, which `copied` holds.
   */
  const applySaved = async (f: SavedFile, dirty = false, putAside: PutAside = {}, fromCopy = false) => {
    navSeq++;
    cancelLayouts();
    layoutCache.clear();
    baseCache.clear();
    set({
      files: f.files,
      topOverride: f.top,
      rules: new Set(f.rules.filter((r) => RULES.some((x) => x.id === r))),
      viewMode: f.viewMode,
      doc: f.doc,
      putAside,
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
    if (fromCopy) {
      const s = get();
      copiedWork = { doc: s.doc, derived: s.doc, files: s.files, rules: s.rules, putAside: s.putAside };
    }
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
    if (Object.keys(s.files).length === 0 && s.past.every((h) => h.nav) && doc === s.doc && Object.keys(putAside).length === 0) return;
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

  /**
   * After a new version of the files is open: the edits of modules whose instances have other
   * parameters now follow them to the names those give them, and so do the blocks that name them
   * (see followParamods), in the import's undo step, and the notice says so, and whose edits and
   * blocks no longer show. `before`: the design before the import, and the notice then (what the
   * import said itself stays).
   */
  const followParamodEdits = async (before: IRDesign | undefined, files: Record<string, string>, noticeBefore: string | undefined) => {
    const s = get();
    if (!before || !s.design || s.design === before || s.files !== files) return;
    const f = followParamods(s.doc, before, s.design);
    if (f.moved.length === 0 && f.blocks.length === 0 && f.lost.length === 0 && f.stranded.length === 0) return;
    const titles = (ms: string[]) => ms.map(moduleTitle).join(', ');
    const them = (ms: string[]) => (ms.length === 1 ? 'it' : 'them');
    // A module used with its default parameters has its own name.
    const copies = f.lost.filter((m) => m.startsWith('$paramod'));
    const defaults = f.lost.filter((m) => !m.startsWith('$paramod'));
    const said = [
      s.notice !== noticeBefore ? s.notice : undefined,
      ...f.moved.map(
        (m) => `Your edits on ${moduleTitle(m.from)} now apply to ${moduleTitle(m.to)}${m.to.startsWith('$paramod') ? ', its new parameters' : ' with its default parameters'}.`,
      ),
      ...f.blocks.map((b) => `The blocks of ${moduleTitle(b.from)} on ${titles(b.on)} now use ${moduleTitle(b.to)}.`),
      copies.length ? `Your edits on ${titles(copies)} no longer show: no instance uses ${them(copies)} with those parameters now.` : undefined,
      defaults.length
        ? `Your edits on ${titles(defaults)} no longer show: no instance uses ${them(defaults)} with ${defaults.length === 1 ? 'its' : 'their'} default parameters now.`
        : undefined,
      ...f.stranded.map(
        (b) =>
          `The blocks of ${moduleTitle(b.module)} on ${titles(b.on)} have no pins now: ${
            !b.parameters
              ? 'the design no longer has that module'
              : b.module.startsWith('$paramod')
                ? 'no instance uses it with those parameters now'
                : 'no instance uses it with its default parameters now'
          }.`,
      ),
      f.lost.length ? 'Undo brings back the old code with them.' : f.stranded.length ? 'Undo brings back the old code.' : undefined,
    ];
    set({ doc: f.doc, notice: said.filter(Boolean).join(' ') });
    if (f.doc === s.doc) return;
    scheduleAutosave();
    // The sheet on screen was opened without them.
    if (f.doc.sheets[s.sheet] !== s.doc.sheets[s.sheet]) await get().openPath(get().path);
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
      const { files: current, putAside, design, notice } = get();
      if (replace) {
        // Replacing all files keeps the edits only when it is a new version of the open design:
        // it reuses a file name (File › Open Verilog of the same files), or the name of a removed
        // file whose edits are put aside.
        if (!Object.keys(files).some((f) => f in current || f in putAside)) return openOtherDesign(files);
        // Open files it leaves out come back with Undo; so do the old versions of the others.
        pushFiles(files);
        await openFiles(files, { clearTop: true });
        await followParamodEdits(design, files, notice);
        return;
      }
      // With `newVersion`, the same design under other file names: the edits stay. Open files it
      // replaces, cuts a module out of or updates come back with Undo, and so does the file set
      // without the files it adds.
      const all = opts.newVersion ? planImport(current, files).files : { ...current, ...files };
      pushFiles(all);
      await openFiles(all, { imported: files });
      await followParamodEdits(design, all, notice);
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
      // On a drawing the switch changes only the hierarchy listed, not the sheet: no step to go back.
      if (!get().path[get().path.length - 1]?.drawn) navStep();
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
      rebuildAbort?.abort();
      const abort = (rebuildAbort = new AbortController());
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
          errorKind: undefined,
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
      set({ status: 'elaborating', error: undefined, errorKind: undefined, yosys: undefined });
      try {
        const result = await elaborate(
          files,
          topOverride,
          (yosys) => {
            if (gen !== rebuildGen) return;
            set({ yosys, status: yosys.stage === 'run' ? 'elaborating' : 'loading' });
          },
          abort.signal,
        );
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
        set({ status: 'error', error: err.message, errorKind: err.kind ?? 'design', log: err.log ?? get().log, codeFile });
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
      await get().navigate([...get().path, { instance, module, ...(drawn ? { drawn: true } : {}) }]);
    },

    async navigate(path) {
      if (path.length === 0) return;
      navStep(path);
      await get().openPath(path);
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

    setNotice(text) {
      set({ notice: text });
    },

    async toggleRule(id) {
      const s = get();
      const rules = new Set(s.rules);
      if (rules.has(id)) rules.delete(id);
      else rules.add(id);
      // An undo step: Ctrl+Z right after it must undo it, not an older edit out of sight.
      set({ rules, past: [...s.past.slice(-(HISTORY - 1)), { ...here(), rules: [...s.rules] }], future: [] });
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
        // Linked to its preset only while it has the preset's settings (see followsPreset).
        if (p.component && followsPreset({ ...node, component: p.component }, get().doc.components)) node.component = p.component;
        const size = sizeNode(symbolNode(node, interfaceOf), textMeasure());
        let pos = { x: snap(at.x - size.width / 2), y: snap(at.y - size.height / 2) };
        // A second click on the same spot would put the new symbol exactly over the last one, hiding it: it goes a
        // little down and to the right instead, where both show.
        const over = (p: Point) => (get().layout?.nodes ?? []).some((n) => Math.abs(n.x - p.x) < 1 && Math.abs(n.y - p.y) < 1);
        for (let i = 0; i < 100 && over(pos); i++) pos = { x: pos.x + 2 * GRID, y: pos.y + 2 * GRID };
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

    connectEnds(a, b, drawn) {
      const s = get();
      if (!s.netlist || !s.layout || !settled(s)) return false;
      const c = resolveConnection(s.netlist, a, b);
      if ('error' in c) {
        set({ notice: c.error });
        return false;
      }
      let route: Point[] | undefined;
      if (drawn && drawn.length >= 2) {
        const layout = s.layout;
        /** The stretch of the net from its source to where the drawn wire starts at this end (without that point). */
        const lead = (end: WireEnd): Point[] => {
          if (end.kind === 'wire') {
            const e = layout.edges.find((x) => x.id === end.edge);
            return e ? wireUpTo(e.points, end.at) : [];
          }
          if (end.port === c.source.port || end.port === c.target.port) return [];
          // An input joined to another input: the net reaches this one on its own wire.
          const into = layout.edges.find((x) => x.target.port === end.port);
          return into ? into.points.slice(0, -1) : [];
        };
        const full = orthogonalize([...lead(a), ...drawn, ...lead(b).reverse()]);
        // Stored from the driver to the input, whichever end the user started at.
        if (full.length >= 2) route = c.reversed ? full.reverse() : full;
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
      const d = get().netlist;
      const isPin = (n: DNode) => n.kind === 'input' || n.kind === 'output' || n.kind === 'inout';
      const n = d?.nodes.find((x) => x.id === id);
      const want = text.trim() ? verilogIdent(text.trim()) : undefined;
      // Two pins of one name would read as one signal, but a block of a drawing gives them two ports (see drawingPorts).
      const other = n && want && isPin(n) ? d!.nodes.find((x) => x.id !== id && isPin(x) && verilogIdent(x.label) === want) : undefined;
      if (other) {
        const why =
          other.label.trim() === text.trim()
            ? `Another pin is named ${other.label}. Pick another name.`
            : `Another pin, ${other.label}, has the same Verilog name ${want}. Pick another name.`;
        set({ notice: why });
        return why;
      }
      editSheet((e) => rename(e, id, text));
      return undefined;
    },

    resetItemLabel(id) {
      editSheet((e) => resetLabel(e, id));
    },

    setNodeParams(id, params) {
      const before = get().doc;
      editSheet((e, _netlist, layout) => {
        // Changed on its own, a symbol placed from a preset no longer follows the preset.
        const next = unlinkChanged(setParams(e, id, params, interfaceOf), id, get().doc.components);
        // Wider now (a gate with more inputs): what is right of it moves right rather than being covered.
        const was = layout.nodes.find((n) => n.id === id);
        if (next === e || !was || !next.pos[id]) return next;
        const s = get();
        const d = withHidden(currentModule(), isDrawnKey(s.sheet) ? undefined : s.base, next);
        return fitWider(next, d, new Map([[id, was.width]]), textMeasure());
      });
      // A narrower symbol can leave a wire with a bit range it no longer has: say so at once (the sheet lists it too).
      const s = get();
      if (s.doc === before || !s.netlist) return;
      const stale = staleSlices(s.netlist, s.doc.sheets[s.sheet]).filter((w) => w.source === id);
      if (stale.length) set({ notice: stale.map((w) => w.text).join(' ') });
    },

    setEdgeSlice(id, slice) {
      editSheet((e) => setSlice(e, id, slice));
    },

    setEdgeRoute(id, points) {
      editSheet((e) => (points ? setRoute(e, id, points, true) : clearRoute(e, id)));
    },

    setEdgeRoutes(routes) {
      const list = Object.entries(routes).filter(([, p]) => p.length >= 2);
      if (!list.length) return;
      editSheet((e) => list.reduce((acc, [id, p]) => setRoute(acc, id, p, true), e));
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
        l = await layoutDiagram(s.netlist, textMeasure());
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

    paste(near, view) {
      const s = get();
      if (!clipboard || !s.layout || !settled(s)) return;
      const { clip, box, sheet } = clipboard;
      // On its own sheet: where it was copied from if that is free, otherwise below it, never on top of
      // it. Those coordinates can be far out of view, on another sheet or after the view moved (after a
      // Cut, the old spot): Ctrl+V would seem to do nothing. Then it goes where the user looks, and
      // below what is already there.
      const beside = sheet === s.sheet ? pasteSpot(box, s.layout.nodes) : undefined;
      /** Whole on screen; along a side longer than the view, its middle. */
      const along = (at: number, size: number, from: number, length: number) =>
        size <= length ? at >= from && at + size <= from + length : at + size / 2 >= from && at + size / 2 <= from + length;
      const seen = (p: Point) => !view || (along(p.x, box.width, view.x, view.width) && along(p.y, box.height, view.y, view.height));
      const where = beside && (!near || seen(beside)) ? beside : pasteSpot(near ? { ...box, x: near.x - box.width / 2, y: near.y - box.height / 2 } : box, s.layout.nodes);
      const at2 = { x: snap(where.x), y: snap(where.y) };
      let pasted: string[] = [];
      editSheet((e, d) => {
        // The sheet's netlist, so imported pins and instances count when pasted names are made unique.
        const [next, ids] = pasteClip(e, clip, at2, d);
        pasted = ids;
        // A copy follows a preset of this library only while it has its settings (it may come from another file).
        return keepLinks(next, get().doc.components);
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
      if (prev.nav) {
        // Back to the sheet before. One that can no longer be opened is passed over.
        set({ past: s.past.slice(0, -1) });
        if (!canOpen(prev) || isHere(prev)) return get().undo();
        set({ future: [{ ...here(), nav: true }, ...s.future] });
        void goTo(prev);
        return;
      }
      // The redo entry keeps where the change was made (not where Undo was pressed), so Redo shows it too.
      // A step that changed the files swaps the whole state: Redo comes back here.
      const redo = prev.files ? hereWithFiles() : { ...prev, doc: s.doc, ...(prev.rules ? { rules: [...s.rules] } : {}) };
      set({
        past: s.past.slice(0, -1),
        future: [redo, ...s.future],
        doc: prev.doc,
        dirty: true,
        // A preset being placed is placed as the library has it now.
        placing: placingNow(s.placing, prev.doc.components),
        ...(prev.rules ? { rules: new Set(prev.rules) } : {}),
      });
      scheduleAutosave();
      // Other rules redraw the sheet on screen (they apply to all).
      void (prev.files ? reopenFiles(prev) : prev.rules ? get().openPath(get().path) : showAfterHistory(prev));
    },

    redo() {
      const s = get();
      const next = s.future[0];
      if (!next) return;
      if (next.nav) {
        set({ future: s.future.slice(1) });
        if (!canOpen(next) || isHere(next)) return get().redo();
        set({ past: withNavStep(s.past, { ...here(), nav: true }) });
        void goTo(next);
        return;
      }
      const undo = next.files ? hereWithFiles() : { ...next, doc: s.doc, ...(next.rules ? { rules: [...s.rules] } : {}) };
      set({
        future: s.future.slice(1),
        past: [...s.past, undo],
        doc: next.doc,
        dirty: true,
        placing: placingNow(s.placing, next.doc.components),
        ...(next.rules ? { rules: new Set(next.rules) } : {}),
      });
      scheduleAutosave();
      void (next.files ? reopenFiles(next) : next.rules ? get().openPath(get().path) : showAfterHistory(next));
    },

    newDrawing(name = 'drawing') {
      const s = get();
      const taken = new Set([...s.doc.drawn, ...Object.keys(s.design?.modules ?? {}), ...s.moduleNames, ...partNames()]);
      const unique = uniqueModuleName(name, taken);
      const doc: EditDoc = { ...s.doc, drawn: [...s.doc.drawn, unique], sheets: { ...s.doc.sheets, [`d:${unique}`]: emptyEdits() } };
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
      if (partNames().includes(want)) return `A component of the library is named ${want}.`;
      const path = renamePathDrawing(s.path, from, want);
      pushDoc(renameDrawingIn(s.doc, from, want), { path, sheet: sheetKey(path[path.length - 1], s.viewMode) });
      refresh();
      return undefined;
    },

    setComponents(defs, renamed) {
      const s = get();
      const doc: EditDoc = { ...s.doc };
      if (defs.length) doc.components = defs;
      else delete doc.components;
      // The symbols placed from a preset follow it: one undo step with the change of the library.
      doc.sheets = roomForWider(s.doc.sheets, followComponents(s.doc.sheets, s.doc.components, defs, renamed, interfaceOf));
      if (doc.sheets === s.doc.sheets && JSON.stringify(doc.components ?? []) === JSON.stringify(s.doc.components ?? [])) return;
      const placing = placingNow(s.placing, defs, renamed);
      pushDoc(doc, placing !== s.placing ? { placing } : {});
      refresh();
    },

    componentNameTaken(name) {
      const s = get();
      if (s.doc.drawn.includes(name)) return `a drawing is named ${name}.`;
      if (s.design?.modules[name] || s.blockDesign?.modules[name] || s.moduleNames.includes(name)) return `a module of your Verilog is named ${name}.`;
      return undefined;
    },

    deleteDrawing(name) {
      const s = get();
      if (!s.doc.drawn.includes(name)) return;
      const sheets = { ...s.doc.sheets };
      delete sheets[`d:${name}`];
      const doc: EditDoc = { ...s.doc, drawn: s.doc.drawn.filter((d) => d !== name), sheets };
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
      const autoOf = (u: UserNode) => {
        const m = instanceModule(u);
        return m && blockDesign?.modules[m]?.auto ? m : undefined;
      };
      const subs = new Map<string, SheetEdits>();
      /** Where each sheet's symbols were drawn: the copies keep their places. */
      const layouts = new Map<SheetEdits, LayoutResult>([[main, s.layout]]);
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
        layouts.set(d, sheet.layout);
        queue.push(...d.nodes.map(autoOf));
      }
      // The files changed meanwhile: these blocks are gone.
      if (get().blockDesign !== blockDesign) return;
      const now = get();
      // The new drawings take no module's name, nor the Verilog name of an automatic block or of
      // Yosys's copy of a parameterized module (top/score → top_score), so no two modules read alike.
      const madeUp = Object.keys(blockDesign?.modules ?? {}).map(verilogIdent);
      const taken = new Set([...now.doc.drawn, ...Object.keys(now.design?.modules ?? {}), ...now.moduleNames, ...madeUp, ...partNames()]);
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
        // An automatic block is often named after the output it drives (block game_result, output game_result).
        // In Verilog an instance and a port of one module cannot share a name: the copy names its block apart
        // from the pins (game_result_2), as that name is made up and the pin's is the user's.
        const pinKinds: readonly string[] = ['input', 'output', 'inout'];
        const pinSym = (u: UserNode) => pinKinds.includes(u.sym === 'raw' ? (u.raw?.kind ?? '') : u.sym);
        const used = new Set([
          ...drawingPorts(e).map((p) => verilogIdent(p.name)),
          ...e.nodes.filter((u) => !autoOf(u) && !pinSym(u) && u.name).map((u) => verilogIdent(u.name!)),
        ]);
        const nodes = e.nodes.map((u): UserNode => {
          const m = autoOf(u);
          if (!m) return u;
          ports.set(u.id, portNames.get(m)!);
          let name = u.name;
          if (name) {
            const stem = verilogIdent(name);
            let n = stem;
            for (let i = 2; used.has(n); i++) n = `${stem}_${i}`;
            used.add(n);
            if (n !== stem) name = n;
          }
          return { id: u.id, sym: 'block', params: { module: names.get(m)! }, ...(name ? { name } : {}) };
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
      const doc: EditDoc = { ...now.doc, drawn: [...now.doc.drawn, name, ...names.values()], sheets };
      // A block is titled with its drawing's name now, longer than the automatic block's, and named under it: it
      // grows, and what is right of it moves right to make room, so no block covers another one or its pins and wires.
      const iface: InterfaceOf = (n) => (doc.drawn.includes(n) ? { label: n, ports: drawingPorts(doc.sheets[`d:${n}`]) } : interfaceOf(n));
      const measure = textMeasure();
      const copies: [SheetEdits, string][] = [[main, `d:${name}`], ...[...subs].map(([m, d]): [SheetEdits, string] => [d, `d:${names.get(m)}`])];
      for (const [d, key] of copies) {
        const e = sheets[key];
        const was = new Map(layouts.get(d)!.nodes.map((n) => [n.id, { width: n.width, height: n.height }]));
        const grown = new Map(e.nodes.filter((u) => d.nodes.some((x) => x.id === u.id && autoOf(x))).map((u) => [u.id, sizeNode(symbolNode(u, iface), measure)]));
        sheets[key] = makeRoom(e, was, grown);
      }
      // Say what the copy is made of, and what still comes from the Verilog files.
      const drawings = new Set(doc.drawn);
      const linked = new Set<string>();
      for (const d of [main, ...subs.values()]) {
        for (const u of d.nodes) {
          const m = instanceModule(u);
          if (m && !autoOf(u) && !drawings.has(m)) linked.add(m);
        }
      }
      const said = [
        names.size ? `Copied ${moduleTitle(module)} to ${name}, with its blocks as drawings of their own: ${[...names.values()].join(', ')}.` : '',
        linked.size ? `Instances of ${[...linked].map(moduleTitle).join(', ')} still use those modules from your Verilog files.` : '',
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
        outlines: OUTLINES,
        files: s.files,
        ...(s.topOverride ? { top: s.topOverride } : {}),
        rules: [...s.rules],
        viewMode: s.viewMode,
        doc: compactDoc(s.doc),
        path: s.path,
        ...(Object.keys(s.putAside).length ? { putAside: s.putAside } : {}),
      };
    },

    async loadSaved(text) {
      await applySaved(parseSavedFile(text), false, parsePutAside(text));
    },

    async restoreAutosave() {
      if (typeof localStorage === 'undefined') return false;
      const text = localStorage.getItem(AUTOSAVE_KEY);
      if (!text) return false;
      try {
        const f = parseSavedFile(text);
        // Whether the work was saved to a file when the browser kept it (see scheduleAutosave).
        const saved = (JSON.parse(text) as { saved?: unknown }).saved === true;
        // This tab shows the browser's copy now, whichever tab wrote it: it keeps it up to date again,
        // from here (opening it changes nothing to write).
        set({ autosavePaused: false });
        copied = copyKeys(text);
        await applySaved(f, !saved, parsePutAside(text), true);
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

    otherTabSaved(text) {
      // A tab that only opened this work, or opened other sheets of it, overwrites nothing of this tab's: its copy
      // holds the work this tab last wrote or read (with keys in another order, maybe), so this tab's next edits
      // can go on replacing it.
      const keys = copyKeys(text);
      if (keys && copied && keys.work === copied.work) return;
      clearTimeout(autosaveTimer);
      autosaveTimer = undefined;
      set({ autosavePaused: true });
    },

    keepThisTab() {
      set({ autosavePaused: false });
      if (typeof localStorage !== 'undefined') writeAutosave(true);
    },

    flushAutosave() {
      if (autosaveTimer !== undefined) writeAutosave();
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
