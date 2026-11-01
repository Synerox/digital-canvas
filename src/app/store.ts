import { create } from 'zustand';
import { type Diagram, buildDiagram } from '../core/diagram';
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
  isPinned,
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
import { type InterfaceOf, type ModulePort, type SymKey, type SymParams, clampParam, newUserNode, symbolNode } from '../editor/symbols';
import { orthogonalize } from '../editor/router';
import { type SheetIssues, checkSheet } from '../editor/check';

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

export interface HistoryEntry {
  doc: EditDoc;
  path: PathEntry[];
  sheet: string;
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

  setFiles(files: Record<string, string>, replace: boolean): Promise<void>;
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
  paste(at?: Point): void;
  duplicate(): void;
  undo(): void;
  redo(): void;
  newDrawing(name?: string): void;
  renameDrawing(from: string, to: string): string | undefined;
  deleteDrawing(name: string): void;
  convertToDrawing(): void;

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
let clipboard: Clip | undefined;
let pasteCount = 0;
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
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`;
}

export const useStore = create<State>((set, get) => {
  // ---------- helpers that need the store ----------

  const interfaceOf: InterfaceOf = (name) => {
    const { doc, design } = get();
    if (doc.drawn.includes(name)) {
      const e = doc.sheets[`d:${name}`];
      const ports: ModulePort[] = [];
      const seen = new Set<string>();
      for (const n of e?.nodes ?? []) {
        if (n.sym !== 'input' && n.sym !== 'output' && n.sym !== 'inout') continue;
        const pname = (n.name ?? '').trim() || (n.sym === 'input' ? 'in' : n.sym === 'output' ? 'out' : 'io');
        if (seen.has(pname)) continue;
        seen.add(pname);
        ports.push({ name: pname, dir: n.sym, width: clampParam('width', n.params.width, 1) });
      }
      return { label: name, ports };
    }
    const m = get().viewDesign()?.modules[name] ?? design?.modules[name];
    if (!m) return undefined;
    return { label: m.displayName, ports: m.ports.map((p) => ({ name: p.name, dir: p.direction, width: p.bits.length })) };
  };

  const edits = (): SheetEdits => get().doc.sheets[get().sheet] ?? emptyEdits();

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
    if (!drawn && !s.base) return;
    const e = opts.fast ?? edits();
    const netlist = effectiveDiagram(currentModule(), drawn ? undefined : s.base, e, interfaceOf);
    const measure = measureFor(s.theme);
    let pos = e.pos;
    let routes = e.routes;
    let placed = false;
    if (!drawn && !isPinned(e)) {
      if (!s.baseLayout) return;
      const pinned = layoutToEdits(e, s.baseLayout, 'none');
      pos = pinned.pos;
      routes = pinned.routes;
    } else if (netlist.nodes.some((n) => !pos[n.id])) {
      pos = placeMissing(netlist, pos, s.baseLayout, (n) => sizeNode(n, measure));
      placed = true;
    }
    const g = buildGeometry({ netlist, pos, routes, measure, fast: !!opts.fast, moved: opts.moved, previous: s.layout });
    const issues = checkSheet(netlist);
    const selection = new Set([...s.selection].filter((id) => netlist.nodes.some((n) => n.id === id) || netlist.edges.some((x) => x.id === id)));
    const patch: Partial<State> = { netlist, layout: g.layout, issues, selection: selection.size === s.selection.size ? s.selection : selection };
    if (!opts.fast && (placed || Object.keys(g.routed).length) && (drawn || isPinned(e))) {
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
        localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(get().savedFile()));
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
    if (!s.sheet || !s.netlist || !s.layout || s.status === 'too-large') return;
    let e = edits();
    if (!isDrawnKey(s.sheet) && !isPinned(e)) {
      if (!s.baseLayout) return;
      e = layoutToEdits(e, s.baseLayout, 'existing');
    }
    const next = fn(e, s.netlist, s.layout);
    if (!next || next === e) return;
    commitDoc({ ...s.doc, sheets: { ...s.doc.sheets, [s.sheet]: next } }, opts);
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

  /** Show the first drawing, or nothing. */
  const openFallback = async () => {
    const { design, doc } = get();
    if (design) return get().openPath([{ instance: design.top, module: design.top }]);
    if (doc.drawn.length) return get().openPath([{ instance: doc.drawn[0], module: doc.drawn[0], drawn: true }]);
    set({ path: [], sheet: '', base: undefined, baseLayout: undefined, netlist: undefined, layout: undefined });
  };

  /** After undo/redo: show the sheet the change was made on, or redraw this one. */
  const showAfterHistory = async (entry: HistoryEntry) => {
    const { doc, sheet } = get();
    const drawnGone = (p: PathEntry[]) => p.some((x) => x.drawn && !doc.drawn.includes(x.module));
    if (entry.sheet && entry.sheet !== sheet && !drawnGone(entry.path)) return get().openPath(entry.path);
    if (drawnGone(get().path)) return openFallback();
    refresh();
  };

  const applySaved = async (f: SavedFile) => {
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
      past: [],
      future: [],
      dirty: false,
      selection: new Set(),
      path: f.path,
      sheet: '',
      layout: undefined,
      netlist: undefined,
      base: undefined,
      baseLayout: undefined,
      design: undefined,
      blockDesign: undefined,
      hierarchy: undefined,
    });
    await get().rebuild();
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
    past: [],
    future: [],
    dirty: false,
    interfaceOf,

    async setFiles(files, replace) {
      // Opening Verilog while a drawing is on screen shows the Verilog.
      const path = get().path[0]?.drawn ? [] : get().path;
      set({ files: replace ? files : { ...get().files, ...files }, path, ...(replace ? { topOverride: undefined } : {}) });
      scheduleAutosave();
      await get().rebuild();
    },

    async removeFile(name) {
      const files = { ...get().files };
      delete files[name];
      set({ files });
      scheduleAutosave();
      await get().rebuild();
    },

    async loadExample(name = 'auction') {
      set({ topOverride: undefined });
      await get().setFiles(EXAMPLES[name].files, true);
    },

    viewDesign() {
      const { viewMode, design, blockDesign } = get();
      return viewMode === 'blocks' ? (blockDesign ?? design) : design;
    },

    async setViewMode(mode) {
      if (mode === get().viewMode) return;
      const { design, blockDesign } = get();
      set({ viewMode: mode });
      scheduleAutosave();
      if (!design) return;
      const view = mode === 'blocks' ? (blockDesign ?? design) : design;
      set({ hierarchy: buildHierarchy(view) });
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
      });
      if (last.drawn) {
        if (!get().doc.drawn.includes(last.module)) return openFallback();
        set({ base: undefined, baseLayout: undefined, layout: keepSelection ? get().layout : undefined, status: get().error ? 'error' : 'ready' });
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
      const e = get().doc.sheets[key];
      const stale = () => seq !== navSeq || get().design !== design || get().rules !== rules || get().viewMode !== viewMode;
      let base = baseCache.get(cacheKey);
      if (!base) {
        if (viewMode === 'flat' && !flatAllowed.has(module) && !isPinned(e)) {
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
      const n = get().layout?.nodes.find((x) => x.id === id);
      if (n?.kind !== 'instance' || !n.moduleName) return;
      if (get().doc.drawn.includes(n.moduleName)) {
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
      if (!s.netlist || !s.sheet) return;
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
      if (!s.netlist || !s.layout) return false;
      const c = resolveConnection(s.netlist, a, b);
      if ('error' in c) {
        set({ notice: c.error });
        return false;
      }
      let route: Point[] | undefined;
      if (bends.length) {
        // A wire drawn with bends keeps them: from the driver, through the bends, to the input.
        const pointOf = (end: WireEnd): Point[] => {
          if (end.kind === 'port') {
            const p = s.layout!.nodes.flatMap((n) => n.ports).find((q) => q.id === end.port);
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
        const drawn = [...from, ...bends, ...to.slice().reverse()];
        const ordered = c.reversed ? drawn.reverse() : drawn;
        if (ordered.length >= 2) route = orthogonalize(ordered);
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
      if (!s.netlist || !s.sheet) return;
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
      // Skip if the user moved on or edited meanwhile.
      if (get().sheet !== sheet || get().doc !== doc) return;
      editSheet((e) => layoutToEdits({ ...e, pos: {}, routes: {} }, l, 'none'));
    },

    copy() {
      const s = get();
      if (!s.netlist || !s.layout) return false;
      const nodes = new Set([...s.selection].filter((id) => s.layout!.nodes.some((n) => n.id === id)));
      const clip = copyNodes(s.netlist, edits(), s.layout, nodes, interfaceOf);
      if (!clip) return false;
      clipboard = clip;
      pasteCount = 0;
      return true;
    },

    cut() {
      if (get().copy()) get().deleteSelection();
    },

    paste(at) {
      const clip = clipboard;
      const s = get();
      if (!clip || !s.layout) return;
      pasteCount++;
      let where = at;
      if (!where) {
        // Next to where it was copied from: offset a little more each time.
        const sel = s.layout.nodes.filter((n) => s.selection.has(n.id));
        const x = sel.length ? Math.min(...sel.map((n) => n.x)) : (s.layout.x ?? 0) + 40;
        const y = sel.length ? Math.min(...sel.map((n) => n.y)) : (s.layout.y ?? 0) + 40;
        where = { x: x + 20, y: y + 20 };
      }
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
      set({ past: s.past.slice(0, -1), future: [here(), ...s.future], doc: prev.doc, dirty: true });
      scheduleAutosave();
      void showAfterHistory(prev);
    },

    redo() {
      const s = get();
      const next = s.future[0];
      if (!next) return;
      set({ future: s.future.slice(1), past: [...s.past, here()], doc: next.doc, dirty: true });
      scheduleAutosave();
      void showAfterHistory(next);
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
      if (s.doc.drawn.includes(want) || s.design?.modules[want] || s.moduleNames.includes(want)) return `A module named ${want} already exists.`;
      const sheets: EditDoc['sheets'] = {};
      for (const [k, e] of Object.entries(s.doc.sheets)) {
        const nk = k === `d:${from}` ? `d:${want}` : k;
        // Blocks that instantiate the drawing follow the new name.
        const nodes = e.nodes.some((n) => n.sym === 'block' && n.params.module === from)
          ? e.nodes.map((n) => (n.sym === 'block' && n.params.module === from ? { ...n, params: { ...n.params, module: want } } : n))
          : e.nodes;
        sheets[nk] = nodes === e.nodes ? e : { ...e, nodes };
      }
      const doc: EditDoc = { drawn: s.doc.drawn.map((d) => (d === from ? want : d)), sheets };
      const path = s.path.map((p) => (p.drawn && p.module === from ? { ...p, module: want, instance: p.instance === from ? want : p.instance } : p));
      pushDoc(doc, { path, sheet: sheetKey(path[path.length - 1], s.viewMode) });
      refresh();
      return undefined;
    },

    deleteDrawing(name) {
      const s = get();
      if (!s.doc.drawn.includes(name)) return;
      const sheets = { ...s.doc.sheets };
      delete sheets[`d:${name}`];
      const doc: EditDoc = { drawn: s.doc.drawn.filter((d) => d !== name), sheets };
      pushDoc(doc);
      if (s.path.some((p) => p.drawn && p.module === name)) void openFallback();
      else refresh();
    },

    convertToDrawing() {
      const s = get();
      if (!s.netlist || !s.layout) return;
      const taken = new Set([...s.doc.drawn, ...Object.keys(s.design?.modules ?? {}), ...s.moduleNames]);
      const name = uniqueModuleName(`${currentModule().replace(/^.*\//, '')}_drawing`, taken);
      const sheetEdits = toDrawing(s.netlist, s.layout, edits(), interfaceOf);
      const doc: EditDoc = { drawn: [...s.doc.drawn, name], sheets: { ...s.doc.sheets, [`d:${name}`]: sheetEdits } };
      pushDoc(doc);
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
        await applySaved(f);
        set({ dirty: true });
        return true;
      } catch {
        return false;
      }
    },

    markSaved() {
      set({ dirty: false });
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
