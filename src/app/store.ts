import { create } from 'zustand';
import { buildDiagram } from '../core/diagram';
import { DEFAULT_RULES, type RuleId } from '../core/rules';
import { type HierarchyNode, type IRDesign, type SrcRange, buildDesign, buildHierarchy } from '../core/ir';
import { parseYosysJson } from '../core/yosys-json';
import { AUCTION_FILE, AUCTION_SOURCE } from '../examples/auction';
import { type LayoutResult, layoutDiagram } from '../layout/elk-layout';
import { canvasMeasure } from '../render/export';
import { THEMES, type ThemeName } from '../render/theme';
import { YosysError, elaborate } from '../yosys/client';
import { declaredModules } from '../yosys/script';

export interface PathEntry {
  instance: string;
  module: string;
}

export type Status = 'idle' | 'loading' | 'elaborating' | 'layout' | 'ready' | 'error';

interface State {
  files: Record<string, string>;
  /** Modules declared in the sources, for the Top selector. */
  moduleNames: string[];
  topOverride?: string;
  design?: IRDesign;
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

  setFiles(files: Record<string, string>, replace: boolean): Promise<void>;
  removeFile(name: string): Promise<void>;
  loadExample(): Promise<void>;
  rebuild(): Promise<void>;
  openPath(path: PathEntry[]): Promise<void>;
  enterInstance(instance: string, module: string): Promise<void>;
  select(nodeId: string | undefined): void;
  selectLine(file: string, line: number): void;
  setCodeFile(file: string): void;
  setTheme(t: ThemeName): void;
  toggleRule(id: RuleId): Promise<void>;
  setTop(top: string | undefined): Promise<void>;
}

const layoutCache = new Map<string, LayoutResult>();
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

  async loadExample() {
    set({ topOverride: undefined });
    await get().setFiles({ [AUCTION_FILE]: AUCTION_SOURCE }, true);
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
      const hierarchy = buildHierarchy(design);
      layoutCache.clear();
      // Keep the current drill-down path when it still exists in the new design.
      const old = get().path;
      const path: PathEntry[] = [{ instance: design.top, module: design.top }];
      for (const p of old.slice(1)) {
        const parent = design.modules[path[path.length - 1].module];
        const cell = parent?.cells.find((c) => c.isInstance && c.name === p.instance);
        if (!cell) break;
        path.push({ instance: cell.name, module: cell.type });
      }
      const codeFile = get().codeFile && files[get().codeFile!] !== undefined ? get().codeFile : Object.keys(files)[0];
      set({ design, hierarchy, codeFile });
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
    const { design, theme, rules } = get();
    if (!design || path.length === 0) return;
    const seq = ++navSeq;
    const module = path[path.length - 1].module;
    set({ status: 'layout', path, selected: undefined, highlighted: new Set(), codeRanges: [] });
    let layout = layoutCache.get(module);
    if (!layout) {
      const diagram = buildDiagram(design, module, rules);
      layout = await layoutDiagram(diagram, canvasMeasure(THEMES[theme].font));
      // A newer navigation or rebuild happened while ELK was running.
      if (seq !== navSeq || get().design !== design || get().rules !== rules) return;
      layoutCache.set(module, layout);
    }
    const m = design.modules[module];
    const file = findFile(get().files, m?.src[0]?.file);
    set({ layout, status: get().error ? 'error' : 'ready', codeFile: file ?? get().codeFile });
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
