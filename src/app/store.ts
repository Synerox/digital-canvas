import { create } from 'zustand';
import { buildDiagram } from '../core/diagram';
import { DEFAULT_RULES, type RuleId } from '../core/rules';
import { type HierarchyNode, type IRDesign, type SrcRange, buildDesign, buildHierarchy } from '../core/ir';
import type { YosysDesign } from '../core/yosys-json';
import { AUCTION_FILE, AUCTION_SOURCE } from '../examples/auction';
import { type LayoutResult, layoutDiagram } from '../layout/elk-layout';
import { canvasMeasure } from '../render/export';
import { THEMES, type ThemeName } from '../render/theme';
import { YosysError, elaborate } from '../yosys/client';

export interface PathEntry {
  instance: string;
  module: string;
}

export type Status = 'idle' | 'loading' | 'elaborating' | 'layout' | 'ready' | 'error';

interface State {
  files: Record<string, string>;
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

function rangeHasLine(r: SrcRange, file: string, line: number): boolean {
  const same = r.file === file || r.file.endsWith('/' + file) || file.endsWith('/' + r.file);
  return same && line >= r.startLine && line <= r.endLine;
}

export const useStore = create<State>((set, get) => ({
  files: {},
  path: [],
  status: 'idle',
  log: '',
  highlighted: new Set(),
  codeRanges: [],
  theme: 'report',
  rules: DEFAULT_RULES,

  async setFiles(files, replace) {
    set({ files: replace ? files : { ...get().files, ...files } });
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
    const { files, topOverride } = get();
    if (Object.keys(files).length === 0) {
      set({ design: undefined, hierarchy: undefined, layout: undefined, path: [], status: 'idle', error: undefined });
      return;
    }
    const t0 = performance.now();
    set({ status: 'loading', error: undefined, progress: undefined });
    try {
      const result = await elaborate(files, topOverride, (loaded, total) => {
        set({ progress: { loaded, total }, status: loaded >= total ? 'elaborating' : 'loading' });
      });
      set({ status: 'elaborating', log: result.log });
      const json = JSON.parse(result.json) as YosysDesign;
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
      set({ design, hierarchy, codeFile: get().codeFile && files[get().codeFile!] ? get().codeFile : Object.keys(files)[0] });
      await get().openPath(path);
      set({ elapsedMs: performance.now() - t0 });
    } catch (e) {
      const err = e as YosysError;
      set({ status: 'error', error: err.message, log: err.log ?? get().log });
    }
  },

  async openPath(path) {
    const { design, theme, rules } = get();
    if (!design || path.length === 0) return;
    const module = path[path.length - 1].module;
    set({ status: 'layout', path, selected: undefined, highlighted: new Set(), codeRanges: [] });
    let layout = layoutCache.get(module);
    if (!layout) {
      const diagram = buildDiagram(design, module, rules);
      layout = await layoutDiagram(diagram, canvasMeasure(THEMES[theme].font));
      layoutCache.set(module, layout);
    }
    const m = design.modules[module];
    const file = m?.src[0]?.file;
    set({ layout, status: 'ready', codeFile: file && get().files[file] !== undefined ? file : get().codeFile });
    if (m?.src[0]) set({ codeRanges: [] });
  },

  async enterInstance(instance, module) {
    await get().openPath([...get().path, { instance, module }]);
  },

  select(nodeId) {
    const { layout, files } = get();
    const node = layout?.nodes.find((n) => n.id === nodeId);
    const ranges = node?.src ?? [];
    const file = ranges[0] && files[ranges[0].file] !== undefined ? ranges[0].file : get().codeFile;
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
