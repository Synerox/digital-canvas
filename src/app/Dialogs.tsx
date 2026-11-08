/**
 * Dialogs: Import Verilog (paste or open code), Export Verilog (with a Yosys
 * check), and the shortcut sheet.
 */
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { type DNode, type Diagram, buildDiagram } from '../core/diagram';
import { diagramToVerilog, verilogIdent } from '../editor/verilog-export';
import { isPart, partNamed, partVerilog } from '../editor/components';
import { type EditDoc, type SheetEdits, emptyDoc, emptyEdits, sheetKey } from '../editor/doc';
import { effectiveDiagram } from '../editor/sheet';
import { downloadBlob } from '../render/export';
import { describeStatus, elaborate } from '../yosys/client';
import { parseYosysJson } from '../core/yosys-json';
import { declaredModules } from '../yosys/script';
import { type PutAside, changeFiles, importedTop, moduleTitle, planImport as planFiles, staleSlices, useStore, withoutModuleDefinitions } from './store';

/** Close a dialog on Escape, before the canvas and the shortcuts see the key. */
// oxlint-disable-next-line react/only-export-components
export function useEscape(onClose: () => void) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [onClose]);
}

const SAMPLE = `// Paste Verilog here, or open a file.
module half_adder (
  input  wire a,
  input  wire b,
  output wire s,
  output wire c
);
  assign s = a ^ b;
  assign c = a & b;
endmodule
`;

export interface ImportPlan {
  /** The name the code is imported under. */
  fname: string;
  /** Open files the import takes the place of: the code declares every module they declare. */
  replaced: string[];
  /** Open files that keep their other modules: the definitions the code declares again are cut out of them. */
  trimmed: { file: string; modules: string[] }[];
  /** Open files whose code the import changes, keeping the edits: `fname` when it is open, and the replaced and trimmed ones. */
  changed: string[];
  /** With Replace, of a new version of an open file: the other open files, which it leaves out. */
  removed: string[];
  /** With Replace, the open files when the code is another design: the edits on their sheets are put away. */
  closed: string[];
  /** Open files that declare some of the code's modules but could not be trimmed (Yosys reports them declared twice). */
  clashes: { file: string; modules: string[] }[];
  /** Modules that no open file declares after the import. */
  lost: string[];
  /** Modules whose edits, put aside when an earlier file of this name stopped declaring them, come back. */
  restored: string[];
  /**
   * When the name chosen for the code is not that of a removed file whose edits it would bring back:
   * that file and those modules, and whether this import puts those edits away (it opens another design).
   */
  couldRestore?: { file: string; modules: string[]; dropped: boolean };
  /** What to hand to setFiles. */
  apply: { files: Record<string, string>; replace: boolean; newVersion?: boolean };
}

/**
 * What importing `code` under the file name `name` does to the open files.
 * The code is a new version of the design (the store's planImport): an open
 * file whose modules it all declares is replaced (whatever its own file name),
 * one that shares only some modules keeps the others, and the edits made on
 * the sheets are kept. Undo brings the old files back. `kept`: the document
 * and the edits the store put aside, to say which of those come back.
 */
// oxlint-disable-next-line react/only-export-components
export function planImport(
  files: Record<string, string>,
  code: string,
  name: string,
  replace: boolean,
  kept: { doc: EditDoc; putAside: PutAside } = { doc: emptyDoc(), putAside: {} },
): ImportPlan {
  const mods = new Set(declaredModules({ 'x.v': code }));
  const covered: string[] = [];
  const shared: { file: string; modules: string[] }[] = [];
  if (mods.size > 0) {
    for (const f of Object.keys(files)) {
      const own = declaredModules({ [f]: files[f] });
      const both = own.filter((m) => mods.has(m));
      if (both.length === 0) continue;
      if (both.length === own.length) covered.push(f);
      else shared.push({ file: f, modules: both });
    }
  }
  // Named after the file it is a new version of. When all files are replaced, any file it shares a
  // module with will do: the store keeps the sheets' edits when the import reuses a file name.
  // Otherwise after the module it is about, under a name no open file has (that file would be
  // overwritten, with modules the code does not declare), nor a removed one (its edits would come back
  // on what may be another design's modules of the same names).
  const fresh = () => {
    const stem = (importedTop({ 'x.v': code }, [...mods]) ?? 'pasted').replace(/[^\w$.-]/g, '_');
    let n = `${stem}.v`;
    for (let i = 2; n in files || n in kept.putAside; i++) n = `${stem}_${i}.v`;
    return n;
  };
  const n = name.trim() || covered[0] || (replace ? shared[0]?.file : undefined) || fresh();
  const fname = /\.(v|sv|vh|svh)$/i.test(n) ? n : `${n}.v`;
  const incoming = { [fname]: code };
  // As the store's setFiles does it.
  const other = replace && !(fname in files || fname in kept.putAside);
  const plan = replace ? undefined : planFiles(files, incoming);
  const after = plan?.files ?? incoming;
  const sharedOf = (f: string) => shared.find((c) => c.file === f)?.modules ?? [];
  // Open files whose code changes (replaced, trimmed or updated); with Replace, the others are left out.
  const changed = other ? [] : Object.keys(files).filter((f) => after[f] !== files[f] && (!replace || f === fname));
  const removed = other || !replace ? [] : Object.keys(files).filter((f) => f !== fname);
  const now = new Set(declaredModules(after));
  const lost = other ? [] : [...new Set(declaredModules(files))].filter((m) => !now.has(m));
  const restored = other ? [] : changeFiles(kept.doc, kept.putAside, files, after).restored;
  // A removed file with edits for modules the code declares, that a typed name would bring back.
  const back = Object.entries(kept.putAside)
    .filter(([f]) => f !== fname && !(f in files))
    .map(([f, sheets]) => ({
      file: f,
      modules: [...mods].filter((m) => Object.keys(sheets).some((k) => k.replace(/^v:[a-z]+:/, '').replace(/\/.*$/, '') === m)),
      dropped: other,
    }))
    .find((c) => c.modules.length > 0);
  return {
    fname,
    replaced: plan?.replaced ?? [],
    trimmed: (plan?.trimmed ?? []).map((f) => ({ file: f, modules: sharedOf(f) })),
    changed,
    removed,
    closed: other ? Object.keys(files) : [],
    clashes: (plan?.clashes ?? []).map((f) => ({ file: f, modules: sharedOf(f) })),
    lost,
    restored,
    ...(back && restored.length === 0 ? { couldRestore: back } : {}),
    apply: replace ? { files: incoming, replace } : { files: incoming, replace: false, newVersion: true },
  };
}

/** `initial`: a dropped file that declares modules of open files under another name (see planDrop). */
export function ImportDialog({ onClose, initial }: { onClose(): void; initial?: { name: string; code: string } }) {
  const files = useStore((s) => s.files);
  const doc = useStore((s) => s.doc);
  const putAside = useStore((s) => s.putAside);
  const setFiles = useStore((s) => s.setFiles);
  const [name, setName] = useState(initial?.name ?? '');
  const [code, setCode] = useState(initial?.code ?? '');
  const [replace, setReplace] = useState(Object.keys(files).length === 0);
  const fileInput = useRef<HTMLInputElement>(null);
  useEscape(onClose);

  // Shown for the code as typed a moment ago (scanning a long file on every key is slow); the import reads the code as it is.
  const deferred = useDeferredValue(code);
  const { fname, replaced, trimmed, changed, removed, closed, clashes, lost, restored, couldRestore } = useMemo(
    () => planImport(files, deferred, name, replace, { doc, putAside }),
    [files, deferred, name, replace, doc, putAside],
  );
  const plural = (list: unknown[], one: string, more: string) => (list.length === 1 ? one : more);

  const run = async () => {
    onClose();
    const { apply } = planImport(files, code, name, replace, { doc, putAside });
    await setFiles(apply.files, apply.replace, { newVersion: apply.newVersion });
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal import-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Import Verilog"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && code.trim()) void run();
        }}
      >
        <div className="modal-head">
          <b>Import Verilog</b>
          <button className="icon" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        {initial ? (
          <p className="small">
            <b>{initial.name}</b> declares modules that open files declare too. Here is what importing it does; tick Replace to open it as another design
            instead, or Cancel.
          </p>
        ) : (
          <p className="small muted">
            Paste or open Verilog / SystemVerilog. Yosys reads it in your browser (nothing is uploaded) and every module becomes a sheet you can edit:
            move, rename and delete symbols, and draw more. Importing changed code later keeps your edits.
          </p>
        )}
        {trimmed.map((t) => (
          <p key={t.file} className="small">
            Replaces <b>{t.modules.join(', ')}</b> in <b>{t.file}</b>; its other modules stay.
          </p>
        ))}
        {(changed.length > 0 || removed.length > 0) && (
          <p className="small">
            {changed.length > 0 && (
              <>
                {replaced.length ? 'Replaces' : 'Updates'} <b>{changed.join(', ')}</b>. Your moves, renames, deletions and hand-drawn parts on{' '}
                {plural(changed, 'its', 'their')} sheets are kept.{' '}
              </>
            )}
            {removed.length > 0 && (
              <>
                Leaves out <b>{removed.join(', ')}</b>.{' '}
              </>
            )}
            {lost.length > 0 && (
              <>
                No open file declares <b>{lost.join(', ')}</b> any more.{' '}
              </>
            )}
            Undo brings the old {plural([...changed, ...removed], 'file', 'files')} back{lost.length > 0 ? ', with the edits on those modules' : ''}.
          </p>
        )}
        {closed.length > 0 && (
          <p className="small">
            Opens the code as another design in place of <b>{closed.join(', ')}</b>, without the edits made on {plural(closed, 'its', 'their')} sheets
            (Undo brings back the {plural(closed, 'file', 'files')} with the edits).
          </p>
        )}
        {restored.length > 0 && (
          <p className="small">
            Brings back your edits on <b>{restored.join(', ')}</b> from the earlier <b>{fname}</b>.
          </p>
        )}
        {couldRestore && (
          <p className="small muted">
            Your edits on <b>{couldRestore.modules.join(', ')}</b> from the removed <b>{couldRestore.file}</b>{' '}
            {couldRestore.dropped
              ? `go with this import (Undo brings them back). Name the file ${couldRestore.file} to keep them.`
              : `are kept: name the file ${couldRestore.file} to bring them back.`}
          </p>
        )}
        {clashes.map((c) => (
          <p key={c.file} className="small error-text">
            <b>{c.file}</b> also declares <b>{c.modules.join(', ')}</b>, and the definition could not be cut out of it. Yosys will report{' '}
            {c.modules.length === 1 ? 'that module' : 'those modules'} declared twice until one of the files no longer declares{' '}
            {c.modules.length === 1 ? 'it' : 'them'}.
          </p>
        ))}
        <textarea
          className="code-input"
          value={code}
          placeholder={SAMPLE}
          spellCheck={false}
          autoFocus
          onChange={(e) => setCode(e.target.value)}
        />
        <div className="row">
          <label className="small">
            File name <input value={name} placeholder={fname} onChange={(e) => setName(e.target.value)} style={{ width: 140 }} />
          </label>
          <label className="small radio">
            <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /> Replace the current files
          </label>
          <span className="spacer" />
          <button onClick={() => setCode(SAMPLE.replace(/^\/\/.*\n/, ''))}>Example</button>
          <button onClick={() => fileInput.current?.click()}>Open file…</button>
          <input
            ref={fileInput}
            type="file"
            accept=".v,.sv,.vh,.svh"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              setName(f.name);
              setCode(await f.text());
            }}
          />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!code.trim()} onClick={() => void run()} title="Ctrl+Enter">
            Import
          </button>
        </div>
      </div>
    </div>
  );
}

export interface VerilogOut {
  /** The module as the code names it (the Yosys top, and the name of the downloaded file). */
  name: string;
  code: string;
  warnings: string[];
  /** What Yosys reads to check the code, and the module to elaborate. */
  check: { files: Record<string, string>; top: string };
  /** Modules the code instantiates but leaves to the user's files (it does not define them), and those files. */
  external?: { modules: string[]; files: string[] };
  /** Modules of the user's files that the code defines again as their sheets show them, with the edits made there. */
  redefined?: string[];
}

const isPin = (n: DNode) => n.kind === 'input' || n.kind === 'output' || n.kind === 'inout';

/** Whether a sheet's edits could change what its module does: anything but moves, wire routes and notes. */
const hasLogicEdits = (e: SheetEdits | undefined) =>
  !!e && (e.hidden.length > 0 || e.edges.length > 0 || e.nodes.some((n) => n.sym !== 'text') || Object.keys(e.labels).length > 0);

/**
 * Verilog for the sheet on screen, and for the modules it instantiates that
 * no Verilog file defines: drawings, automatic blocks, and Yosys's copies of
 * parameterized modules, each with the edits made on its sheet. A module of
 * the user's files is instantiated by name and left to the files, unless its
 * sheet changes its logic: then it is written as the sheet shows it, so the
 * export never quietly uses the file's version instead. The check reads the
 * files too, without the definitions the code makes again.
 */
// Exported for the tests; the dialog below is its only user.
// oxlint-disable-next-line react/only-export-components
export function exportCurrent(): VerilogOut {
  const s = useStore.getState();
  const module = s.path[s.path.length - 1]?.module ?? 'top';
  const declared = new Set(declaredModules(s.files));
  /** Where sub-module sheets are edited: the block diagram, the view whose sheets instantiate them. */
  const blocks = s.blockDesign ?? s.design;
  const blocksSheet = (mod: string) => s.doc.sheets[sheetKey({ instance: mod, module: mod }, 'blocks')];
  /** Module names that only this app gave: automatic blocks and Yosys's `$paramod…` modules. */
  const madeUpNames = new Map<string, string>();
  /** Names of modules that exist under that name anyway: the user's Verilog modules and the drawings. */
  const taken = new Set([...declared, ...s.doc.drawn.map(verilogIdent), ...(s.doc.components ?? []).filter(isPart).map((c) => c.name)]);
  /** Warnings about the sub-modules, listed after the sheet's own. */
  const later: string[] = [];
  /**
   * The name a made-up module is written under: as an instance writes it (`top/score` → `top_score`),
   * unless a drawing or a Verilog module already has that name.
   */
  const madeUpName = (mod: string) => {
    let n = madeUpNames.get(mod);
    if (n) return n;
    const stem = verilogIdent(mod);
    n = stem;
    for (let i = 2; taken.has(n); i++) n = `${stem}_${i}`;
    taken.add(n);
    madeUpNames.set(mod, n);
    if (n !== stem) later.push(`${moduleTitle(mod)}: written as module ${n}, as another module is called ${stem}`);
    return n;
  };
  const isAuto = (mod: string) => !!s.blockDesign?.modules[mod]?.auto;
  const isParamod = (mod: string) => mod.startsWith('$paramod');
  const isMadeUp = (mod: string) => isAuto(mod) || isParamod(mod);
  // Named as its parents' exports name it, so that they fit this one.
  const name = isMadeUp(module) ? madeUpName(module) : verilogIdent(module);
  taken.add(name);
  if (!s.netlist) return { name, code: '', warnings: ['Nothing to export.'], check: { files: {}, top: name } };
  const parts: string[] = [];
  const warnings: string[] = [];
  const done = new Set<string>([module]);
  /** Module names the code defines. */
  const defined = new Set<string>([name]);
  /** Modules instantiated from the user's files, which the code does not define. */
  const fromFiles = new Set<string>();
  /** Modules of the user's files the code defines (as their sheets show them). */
  const redefined: string[] = [];
  /** Verilog modules the export reads the block diagram sheets of, or leaves to the files. */
  const visited = new Set<string>();

  const bases = new Map<string, Diagram>();
  /** A Verilog module's block diagram sheet before edits. */
  const baseOf = (mod: string) => {
    let d = bases.get(mod);
    if (!d) {
      d = buildDiagram(blocks!, mod, s.rules);
      bases.set(mod, d);
    }
    return d;
  };
  const instancesOf = (mod: string) => (blocks?.modules[mod]?.cells ?? []).filter((c) => c.isInstance).map((c) => c.type);
  /** Pins renamed on the module's sheet: the ports of the files' module (which its instances connect) keep their names. */
  const renamedPins = (mod: string) => {
    const e = blocksSheet(mod);
    if (!e || Object.keys(e.labels).length === 0 || !blocks?.modules[mod]) return [];
    return baseOf(mod)
      .nodes.filter((n) => isPin(n) && e.labels[n.id] && e.labels[n.id] !== n.label)
      .map((n) => `${e.labels[n.id]} keeps its Verilog name ${n.label}`);
  };
  const sheetChanged = new Map<string, boolean>();
  /**
   * Whether a module of the user's files must be written from its sheet: the sheet deletes or adds
   * logic, or an automatic block cut out of it or a parameterized module it instantiates (which only
   * exist in its netlist) must be. Also when it instantiates a parameterized module whose plain module
   * is written from its sheet: the files' text would then name a module the check has no parameters for.
   */
  const fromSheet = (mod: string): boolean => {
    const known = sheetChanged.get(mod);
    if (known !== undefined) return known;
    sheetChanged.set(mod, false);
    const e = blocksSheet(mod);
    const base = e && blocks?.modules[mod] ? baseOf(mod) : undefined;
    // Deleted items of an older version of the Verilog that are gone from this one change nothing.
    const ids = new Set([...(base?.nodes ?? []).map((n) => n.id), ...(base?.edges ?? []).map((x) => x.id)]);
    const own = !!e && (e.hidden.some((id) => ids.has(id)) || e.edges.length > 0 || e.nodes.some((n) => n.sym !== 'text'));
    const changed =
      own ||
      instancesOf(mod).some(
        (c) =>
          ((isAuto(c) || isParamod(c)) && fromSheet(c)) ||
          (isParamod(c) && declared.has(blocks!.modules[c]?.displayName ?? '') && fromSheet(blocks!.modules[c].displayName)),
      );
    sheetChanged.set(mod, changed);
    return changed;
  };
  /** The diagram with its instances of made-up modules naming them as the code defines them. */
  const named = (d: Diagram): Diagram => ({
    ...d,
    nodes: d.nodes.map((n) => {
      const as = n.kind === 'instance' && n.moduleName ? madeUpNames.get(n.moduleName) : undefined;
      return as ? { ...n, moduleName: as } : n;
    }),
  });
  const subModules = (d: Diagram) => {
    for (const n of d.nodes) {
      const sub = n.kind === 'instance' ? n.moduleName : undefined;
      if (!sub || done.has(sub)) continue;
      if (s.doc.drawn.includes(sub)) {
        add(sub, effectiveDiagram(sub, undefined, s.doc.sheets[`d:${sub}`] ?? emptyEdits(), s.interfaceOf), sub);
      } else if (isAuto(sub)) {
        // An automatic block is cut out of a Verilog module by this app, so no file defines it.
        add(sub, verilogBlock(sub), madeUpName(sub));
      } else if (declared.has(sub)) {
        fileModule(sub);
      } else if (isParamod(sub) && blocks?.modules[sub]) {
        // Yosys's copy of a parameterized module for one set of parameters (`sub #(.W(8))`): no file
        // declares it under this name, so it is defined here as Yosys elaborated it, like an automatic block.
        const note = `// ${blocks.modules[sub].displayName} as Yosys elaborated it with the parameters of ${sub.replace(/\s+/g, ' ')}`;
        add(sub, verilogBlock(sub), madeUpName(sub), note);
      } else if (partNamed(s.doc.components, sub)) {
        // A part of the library has pins and no logic: declared as a black box, so that the code elaborates.
        done.add(sub);
        defined.add(sub);
        parts.push(partVerilog(partNamed(s.doc.components, sub)!));
        later.push(`${sub} is a component of the library with pins only: it is written as an empty module (a black box) for you to fill in`);
      } else {
        done.add(sub);
        warnings.push(`Module ${moduleTitle(sub)} (instance ${n.instanceName ?? n.subLabel ?? n.label}) is not defined by a drawing or your Verilog files`);
      }
    }
  };
  /**
   * A module of the user's files: written from its sheet when that changes its logic (see fromSheet),
   * otherwise left to the files. The modules the files' version instantiates are looked at too: one
   * written from its sheet takes the place of the files' module of that name there as well.
   */
  const fileModule = (sub: string) => {
    if (fromSheet(sub)) {
      redefined.push(sub);
      add(sub, verilogBlock(sub), sub, `// ${sub} as its sheet shows it, with your edits: it takes the place of ${sub} in your Verilog files`);
      return;
    }
    done.add(sub);
    fromFiles.add(sub);
    const renamed = renamedPins(sub);
    if (renamed.length) later.push(`${sub} comes from your Verilog files: ${renamed.join('; ')}`);
    inFiles(sub);
  };
  /** The sub-modules of a module that comes from the files (and is not written here). */
  const inFiles = (mod: string) => {
    if (visited.has(mod)) return;
    visited.add(mod);
    for (const c of instancesOf(mod)) {
      if (declared.has(c)) {
        if (!done.has(c)) fileModule(c);
      } else if (isAuto(c) || isParamod(c)) inFiles(c);
    }
  };
  /**
   * A Verilog module (an automatic block, a parameterized module or a module of the files) as its
   * block diagram sheet shows it, but with the ports its instances connect: they take them from the
   * Verilog (see interfaceOf), not from the sheet. So a pin renamed on the sheet keeps its Verilog
   * name, a deleted pin is written all the same, and pins drawn by hand are left out with their wires
   * (no instance connects them). Everything else drawn, deleted or renamed inside is kept: that is its logic.
   */
  const verilogBlock = (sub: string): Diagram => {
    visited.add(sub);
    const base = baseOf(sub);
    const e = blocksSheet(sub) ?? emptyEdits();
    const pins = new Map(base.nodes.filter(isPin).map((n) => [n.id, n.label]));
    const renamed = Object.keys(e.labels).filter((id) => pins.has(id) && e.labels[id] && e.labels[id] !== pins.get(id));
    const deleted = e.hidden.filter((id) => pins.has(id));
    const labels = Object.fromEntries(Object.entries(e.labels).filter(([id]) => !pins.has(id)));
    const d = effectiveDiagram(sub, base, { ...e, labels, hidden: e.hidden.filter((id) => !pins.has(id)) }, s.interfaceOf);
    const extra = d.nodes.filter((n) => isPin(n) && !pins.has(n.id));
    const changes = [
      ...renamed.map((id) => `${e.labels[id]} keeps its Verilog name ${pins.get(id)}`),
      ...deleted.map((id) => `the deleted ${pins.get(id)} is written all the same`),
      ...extra.map((n) => `${n.label}, drawn on its sheet, is left out`),
    ];
    if (changes.length) later.push(`${moduleTitle(sub)}: its instances connect the pins its Verilog gives it: ${changes.join('; ')}`);
    if (!extra.length) return d;
    const gone = new Set(extra.map((n) => n.id));
    return { ...d, nodes: d.nodes.filter((n) => !gone.has(n.id)), edges: d.edges.filter((x) => !gone.has(x.source.node) && !gone.has(x.target.node)) };
  };
  /** Sub-modules go first, so the file reads bottom-up. `note`: a comment line that says what the module is. */
  const add = (mod: string, d: Diagram, as: string, note?: string) => {
    done.add(mod);
    subModules(d);
    const r = diagramToVerilog(named(d), as);
    defined.add(verilogIdent(as));
    parts.push(note ? `${note}\n${r.code}` : r.code);
    const stale = staleSlices(d, s.doc.drawn.includes(mod) ? s.doc.sheets[`d:${mod}`] : blocksSheet(mod)).map((w) => w.text);
    later.push(...[...r.warnings, ...stale].map((w) => `${moduleTitle(mod)}: ${w}`));
  };
  /**
   * The block diagram and the full circuit are edited apart (a sheet of each, by module): say when
   * the other view has edits this export leaves out.
   */
  const otherView = (): string[] => {
    if (s.path[s.path.length - 1]?.drawn || !s.design) return [];
    if (s.viewMode === 'blocks') {
      const edited = [...visited].filter((m) => !isAuto(m) && hasLogicEdits(s.doc.sheets[sheetKey({ instance: m, module: m }, 'flat')]));
      return edited.length
        ? [`Edits made in the Full circuit (on ${edited.map(moduleTitle).join(', ')}) are not in this export: the Block diagram and the Full circuit are edited apart`]
        : [];
    }
    // The full circuit of a module holds every module under it.
    const under = new Set<string>();
    const walk = (m: string) => {
      if (under.has(m)) return;
      under.add(m);
      for (const c of s.design!.modules[m]?.cells ?? []) if (c.isInstance) walk(c.type);
    };
    walk(module);
    const edited = [
      ...new Set(
        Object.keys(s.doc.sheets)
          .filter((k) => k.startsWith('v:blocks:') && hasLogicEdits(s.doc.sheets[k]))
          .map((k) => k.slice('v:blocks:'.length))
          .filter((m) => under.has(m.replace(/\/.*$/, '')))
          .map((m) => m.replace(/\/.*$/, '')),
      ),
    ];
    return edited.length
      ? [`Edits made in the Block diagram (on ${edited.map(moduleTitle).join(', ')}) are not in the Full circuit: the two views are edited apart`]
      : [];
  };

  // An automatic block, a parameterized module or any module opened from its parent's block diagram is
  // written as its parents' exports write it: one definition everywhere. The design's top (or a module
  // opened as Top) has no parent here and is written as its sheet shows it, pins and all.
  const onScreenBlock = s.viewMode === 'blocks' && !s.path[s.path.length - 1]?.drawn && !!blocks?.modules[module] && (isMadeUp(module) || s.path.length > 1);
  const onScreen = onScreenBlock ? verilogBlock(module) : s.netlist;
  if (!s.path[s.path.length - 1]?.drawn) visited.add(module);
  subModules(onScreen);
  const sheet = named(onScreen);
  const top = diagramToVerilog(sheet, isMadeUp(module) ? name : module);
  warnings.push(...top.warnings, ...staleSlices(onScreen, s.doc.sheets[s.sheet]).map((w) => w.text), ...later, ...otherView());
  const code = [...parts, top.code].join('\n');
  const own = { name, code, warnings, ...(redefined.length ? { redefined } : {}) };
  if (fromFiles.size === 0) return { ...own, check: { files: { [`${name}.v`]: code }, top: name } };

  // The modules it instantiates are in the user's files, and so is a Verilog sheet's own module:
  // check a copy of this module under a name of its own, so that the two definitions do not clash.
  // The modules written here from their sheets are cut out of the files, which use these instead.
  const inUse = new Set([...declared, ...defined, ...Object.keys(s.files)]);
  const unused = (stem: string, ext = '') => {
    let n = `${stem}${ext}`;
    for (let i = 2; inUse.has(n); i++) n = `${stem}_${i}${ext}`;
    return n;
  };
  const checkFiles: Record<string, string> = {};
  const cut = new Set(redefined);
  for (const [f, text] of Object.entries(s.files)) {
    const again = declaredModules({ [f]: text }).filter((m) => cut.has(m));
    const rest = again.length ? withoutModuleDefinitions(text, new Set(again)) : text;
    if (rest === undefined) warnings.push(`Check with Yosys: ${again.join(', ')} could not be left out of ${f}, so Yosys sees ${again.length === 1 ? 'it' : 'them'} defined twice`);
    checkFiles[f] = rest ?? text;
  }
  const checkTop = declared.has(name) ? unused(`${name}_export`) : name;
  const checkCode = checkTop === name ? code : [...parts, diagramToVerilog(sheet, checkTop).code].join('\n');
  const external = [...fromFiles].sort();
  const files = Object.keys(s.files).filter((f) => declaredModules({ [f]: s.files[f] }).some((m) => fromFiles.has(m)));
  return { ...own, check: { files: { ...checkFiles, [unused(name, '.v')]: checkCode }, top: checkTop }, external: { modules: external, files } };

}

export function VerilogExportDialog({ onClose }: { onClose(): void }) {
  const out = useMemo(() => exportCurrent(), []);
  const [check, setCheck] = useState<{ ok: boolean; text: string }>();
  const [busy, setBusy] = useState(false);
  /** Yosys still loading for the check: what the button says meanwhile. */
  const [loading, setLoading] = useState<string>();
  const [message, setMessage] = useState<string>();
  useEscape(onClose);
  // A check still waiting or running when the dialog closes is withdrawn.
  const checkAbort = useRef<AbortController>(undefined);
  useEffect(() => () => checkAbort.current?.abort(), []);

  const runCheck = async () => {
    setBusy(true);
    setCheck(undefined);
    try {
      checkAbort.current = new AbortController();
      const r = await elaborate(
        out.check.files,
        out.check.top,
        (y) => setLoading(y.stage === 'run' ? undefined : describeStatus(y)),
        checkAbort.current.signal,
      );
      const json = parseYosysJson(r.json);
      const m = json.modules[out.check.top];
      const done = `Yosys elaborated ${out.name}: ${Object.keys(m?.ports ?? {}).length} ports, ${Object.keys(m?.cells ?? {}).length} cells.`;
      // Code that elaborates can still leave outputs undriven (a cell with no Verilog form): not a pass.
      const undriven = out.warnings.filter((w) => /left undriven/.test(w)).length;
      setCheck(undriven ? { ok: false, text: `${done} But ${undriven === 1 ? 'one cell has' : `${undriven} cells have`} no Verilog form and ${undriven === 1 ? 'its outputs are' : 'their outputs are'} left undriven (see the warnings).` } : { ok: true, text: done });
    } catch (e) {
      setCheck({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
      setLoading(undefined);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Export Verilog" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>Verilog for {out.name}</b>
          <button className="icon" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <textarea className="code-input" readOnly value={out.code} rows={16} />
        {/* The file is not complete on its own: say what else it needs, or it is mistaken for a design that elaborates by itself. */}
        {out.external && (
          <p className="small">
            Not self-contained: it instantiates <b>{out.external.modules.join(', ')}</b> from your Verilog {out.external.files.length === 1 ? 'file' : 'files'}{' '}
            <b>{out.external.files.join(', ')}</b> without defining {out.external.modules.length === 1 ? 'it' : 'them'}. Use it together with{' '}
            {out.external.files.length === 1 ? 'that file' : 'those files'} (Check with Yosys reads {out.external.files.length === 1 ? 'it' : 'them'} too).
          </p>
        )}
        {out.redefined && (
          <p className="small">
            <b>{out.redefined.join(', ')}</b> {out.redefined.length === 1 ? 'is' : 'are'} written here as {out.redefined.length === 1 ? 'its sheet shows it' : 'their sheets show them'},
            with your edits{out.external ? ': leave the definition in your Verilog files out when you use them together' : ', in place of the definition in your Verilog files'}.
          </p>
        )}
        {out.warnings.length > 0 && (
          <ul className="issues small">
            {out.warnings.slice(0, 12).map((w, i) => (
              <li key={i}>{w}</li>
            ))}
            {out.warnings.length > 12 && <li>{out.warnings.length - 12} more…</li>}
          </ul>
        )}
        {check && <p className={`small ${check.ok ? '' : 'error-text'}`}>{check.text}</p>}
        <div className="row">
          <button onClick={() => void runCheck()} disabled={busy}>
            {busy ? (loading ?? 'Checking…') : 'Check with Yosys'}
          </button>
          <span className="spacer" />
          <button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(out.code);
                setMessage('Copied.');
              } catch {
                setMessage('The browser blocked the clipboard: select the code and copy it.');
              }
            }}
          >
            Copy
          </button>
          <button onClick={() => downloadBlob(new Blob([out.code], { type: 'text/plain' }), `${out.name}.v`)}>Download .v</button>
        </div>
        {message && <p className="small">{message}</p>}
      </div>
    </div>
  );
}

const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

const HINTS: [string[], string][] = [
  [['Click', 'library'], 'Pick a symbol, then click the canvas to place it'],
  [['Shift', 'Click'], 'Place another copy (while placing)'],
  [['I'], 'Search the symbol library'],
  [['Drag', 'pin'], 'Draw a wire: it bends where the pointer turns; let go on a pin or a wire'],
  [['Click', 'pin'], 'Start a wire: click to add bends, click a pin or wire to finish'],
  [['Alt', 'Drag', 'wire'], 'Draw a branch from that wire'],
  [['Backspace'], 'Remove the last bend while drawing a wire'],
  [['Esc'], 'Stop drawing or placing; clear the selection'],
  [['Drag', 'symbol'], 'Move (snaps to the grid)'],
  [['Drag', 'wire'], 'Move that segment (or the bend under the pointer); the pins stay'],
  [['Click'], 'Select; Shift or Ctrl adds to the selection'],
  [['Drag', 'empty'], 'Box select (to the right: inside; to the left: touching)'],
  [['↑ ↓ ← →'], 'Nudge the selection (Shift: 5 grid steps)'],
  [['Double-click'], 'Open a block (' + MOD + '+Z goes back up); edit a symbol, a part or a library component as JSON; rename a pin, note or wire'],
  [['Enter'], 'Rename the selection'],
  [['Delete'], 'Delete the selection'],
  [[MOD, 'C / X / V'], 'Copy, cut, paste'],
  [[MOD, 'D'], 'Duplicate'],
  [[MOD, 'A'], 'Select all'],
  [[MOD, 'Z'], 'Undo; also goes back to the sheet before (out of an opened block)'],
  [[MOD, 'Shift', 'Z'], 'Redo (also ' + MOD + '+Y)'],
  [[MOD, 'S'], 'Save the drawing (.dcanvas.json)'],
  [[MOD, 'O'], 'Open a drawing'],
  [[MOD, 'I'], 'Import Verilog'],
  [['L'], 'Auto layout the sheet'],
  [['Wheel'], 'Scroll; Shift+wheel scrolls sideways'],
  [[MOD, 'Wheel'], 'Zoom'],
  [['Space', 'Drag'], 'Pan (also middle or right drag)'],
  [['F'], 'Fit to window'],
];

export function Hints({ onClose }: { onClose(): void }) {
  return (
    <section className="hints" aria-label="Shortcuts">
      <header>
        <b>Shortcuts</b>
        <button className="icon" onClick={onClose} aria-label="Close shortcuts">
          ×
        </button>
      </header>
      <ul>
        {HINTS.map(([keys, what], i) => (
          <li key={i}>
            <span className="keys">
              {keys.map((k, j) => (
                <kbd key={j}>{k}</kbd>
              ))}
            </span>
            <span>{what}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export { MOD };
