import { create } from 'zustand';
import { buildDiagram } from '../core/diagram';
import { DEFAULT_RULES, type RuleId } from '../core/rules';
import { type HierarchyNode, type IRDesign, type SrcRange, buildDesign, buildHierarchy } from '../core/ir';
import { parseYosysJson } from '../core/yosys-json';
import { flatCellCount, withFlattened } from '../core/flatten';
import { withAutoBlocks } from '../core/partition';
import { AUCTION_FILE, AUCTION_SOURCE } from '../examples/auction';
import { FRUIT_FILE, FRUIT_SOURCE } from '../examples/fruit-battle';
import { LayoutCancelled, type LayoutResult, cancelLayouts, layoutDiagram } from '../layout/elk-layout';
import { canvasMeasure } from '../render/export';
import { THEMES, type ThemeName } from '../render/theme';
import { YosysError, elaborate } from '../yosys/client';
import { declaredModules } from '../yosys/script';

export interface PathEntry {
  instance: string;
  module: string;
}

/** blocks: sub-modules and automatic functional blocks; flat: the whole circuit on one sheet. */
export type ViewMode = 'blocks' | 'flat';

export type ExampleName = 'auction' | 'fruit';

export const EXAMPLES: Record<ExampleName, { label: string; files: Record<string, string> }> = {
  auction: { label: 'Auction (hierarchical)', files: { [AUCTION_FILE]: AUCTION_SOURCE } },
  fruit: { label: 'Fruit Battle (single module)', files: { [FRUIT_FILE]: FRUIT_SOURCE } },
};

export type Status = 'idle' | 'loading' | 'elaborating' | 'layout' | 'ready' | 'error';

/** Above this many cells the full circuit is only drawn after the user asks again. */
export const FLAT_CELL_LIMIT = 250;

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
  layout?: LayoutResult;
  status: Status;
  progress?: { loaded: number; total: number };
  error?: string;
  log: string;
  selected?: string;
  /** Node ids highlighted from the code panel. */
  highlighted: Set<string>;
  /** Source ranges highlighted in the code panel. */
  codeRanges: SrcRange[];
  codeFile?: string;
  theme: ThemeName;
  rules: ReadonlySet<RuleId>;
  elapsedMs?: number;
  /** Set when the full circuit of a module is too large to draw without asking first. */
  bigFlat?: { module: string; cells: number };

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
  enterInstance(instance: string, module: string): Promise<void>;
  select(nodeId: string | undefined): void;
  selectLine(file: string, line: number): void;
  setCodeFile(file: string): void;
  setTheme(t: ThemeName): void;
  toggleRule(id: RuleId): Promise<void>;
  setTop(top: string | undefined): Promise<void>;
}

const layoutCache = new Map<string, LayoutResult>();
/** Modules whose large full circuit the user chose to draw (cleared on rebuild). */
const flatAllowed = new Set<string>();
/** Incremented by every rebuild/navigation, so a slow older call cannot overwrite a newer result. */
let rebuildGen = 0;
let navSeq = 0;

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

export const useStore = create<State>((set, get) => ({
  files: {},
  moduleNames: [],
  path: [],
  status: 'idle',
  log: '',
  highlighted: new Set(),
  codeRanges: [],
  theme: 'report',
  rules: DEFAULT_RULES,
  viewMode: 'blocks',

  async setFiles(files, replace) {
    set({ files: replace ? files : { ...get().files, ...files }, ...(replace ? { topOverride: undefined } : {}) });
    await get().rebuild();
  },

  async removeFile(name) {
    const files = { ...get().files };
    delete files[name];
    set({ files });
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
    if (!design) return;
    const view = mode === 'blocks' ? (blockDesign ?? design) : design;
    set({ hierarchy: buildHierarchy(view) });
    // Auto blocks do not exist in the full circuit: show the module they were cut from.
    const path = get().path.filter((p) => view.modules[p.module]);
    await get().openPath(path.length ? path : [{ instance: design.top, module: design.top }]);
  },

  async setTop(top) {
    set({ topOverride: top });
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
      set({
        design: undefined,
        blockDesign: undefined,
        hierarchy: undefined,
        layout: undefined,
        path: [],
        status: 'idle',
        error: undefined,
        codeFile: undefined,
        selected: undefined,
        highlighted: new Set(),
        codeRanges: [],
      });
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
      flatAllowed.clear();
      // Keep the current drill-down path when it still exists in the new design.
      const old = get().path;
      const path: PathEntry[] = [{ instance: design.top, module: design.top }];
      for (const p of old.slice(1)) {
        const parent = view.modules[path[path.length - 1].module];
        const cell = parent?.cells.find((c) => c.isInstance && c.name === p.instance);
        if (!cell) break;
        path.push({ instance: cell.name, module: cell.type });
      }
      const codeFile = get().codeFile && files[get().codeFile!] !== undefined ? get().codeFile : Object.keys(files)[0];
      set({ design, blockDesign, hierarchy, codeFile });
      await get().openPath(path);
      if (gen === rebuildGen) set({ elapsedMs: performance.now() - t0 });
    } catch (e) {
      if (gen !== rebuildGen) return;
      const err = e as YosysError;
      const codeFile = get().codeFile && files[get().codeFile!] !== undefined ? get().codeFile : Object.keys(files)[0];
      set({ status: 'error', error: err.message, log: err.log ?? get().log, codeFile });
    }
  },

  async openPath(path) {
    const { design, theme, rules, viewMode } = get();
    const view = get().viewDesign();
    if (!design || !view || path.length === 0) return;
    const seq = ++navSeq;
    // This navigation replaces any layout still running (for example a large full circuit).
    cancelLayouts();
    const module = path[path.length - 1].module;
    set({ status: 'layout', path, selected: undefined, highlighted: new Set(), codeRanges: [], bigFlat: undefined });
    const key = `${viewMode}:${module}`;
    let layout = layoutCache.get(key);
    if (!layout && viewMode === 'flat' && !flatAllowed.has(module)) {
      const cells = flatCellCount(view, module);
      if (cells > FLAT_CELL_LIMIT) {
        set({ layout: undefined, status: get().error ? 'error' : 'ready', bigFlat: { module, cells } });
        return;
      }
    }
    if (!layout) {
      const source = viewMode === 'flat' ? withFlattened(view, module) : view;
      const diagram = buildDiagram(source, module, rules);
      try {
        layout = await layoutDiagram(diagram, canvasMeasure(THEMES[theme].font));
      } catch (e) {
        if (e instanceof LayoutCancelled) return;
        throw e;
      }
      // A newer navigation or rebuild happened while ELK was running.
      if (seq !== navSeq || get().design !== design || get().rules !== rules || get().viewMode !== viewMode) return;
      layoutCache.set(key, layout);
    }
    const m = view.modules[module];
    const file = findFile(get().files, m?.src[0]?.file);
    set({ layout, status: get().error ? 'error' : 'ready', codeFile: file ?? get().codeFile });
  },

  async drawBigFlat() {
    const big = get().bigFlat;
    if (!big) return;
    flatAllowed.add(big.module);
    await get().openPath(get().path);
  },

  async enterInstance(instance, module) {
    await get().openPath([...get().path, { instance, module }]);
  },

  select(nodeId) {
    const { layout, files } = get();
    const node = layout?.nodes.find((n) => n.id === nodeId);
    const ranges = node?.src ?? [];
    const file = findFile(files, ranges[0]?.file) ?? get().codeFile;
    set({ selected: nodeId, highlighted: new Set(), codeRanges: ranges, codeFile: file });
  },

  selectLine(file, line) {
    const { layout } = get();
    const hits = new Set<string>();
    for (const n of layout?.nodes ?? []) if (n.src.some((r) => rangeHasLine(r, file, line))) hits.add(n.id);
    set({
      highlighted: hits,
      selected: undefined,
      codeRanges: [{ file, startLine: line, startCol: 1, endLine: line, endCol: 1 }],
    });
  },

  setCodeFile(file) {
    set({ codeFile: file });
  },

  setTheme(t) {
    set({ theme: t });
  },

  async toggleRule(id) {
    const rules = new Set(get().rules);
    if (rules.has(id)) rules.delete(id);
    else rules.add(id);
    set({ rules });
    layoutCache.clear();
    await get().openPath(get().path);
  },
}));
