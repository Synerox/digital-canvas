/**
 * Dialogs: Import Verilog (paste or open code), Export Verilog (with a Yosys
 * check), and the shortcut sheet.
 */
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { type DNode, type Diagram, buildDiagram } from '../core/diagram';
import { diagramToVerilog, verilogIdent } from '../editor/verilog-export';
import { emptyEdits, sheetKey } from '../editor/doc';
import { effectiveDiagram } from '../editor/sheet';
import { downloadBlob } from '../render/export';
import { elaborate } from '../yosys/client';
import { parseYosysJson } from '../core/yosys-json';
import { declaredModules } from '../yosys/script';
import { planImport as planFiles, useStore } from './store';

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
  /** Open files the import changes: `fname` when it is open, and the replaced ones. */
  changed: string[];
  /** Open files that declare some of the code's modules but could not be trimmed (Yosys reports them declared twice). */
  clashes: { file: string; modules: string[] }[];
  /** Modules of the open file `fname` that the code no longer declares. */
  lost: string[];
  /** What to hand to setFiles. */
  apply: { files: Record<string, string>; replace: boolean; newVersion?: boolean };
}

/**
 * What importing `code` under the file name `name` does to the open files.
 * The code is a new version of the design (the store's planImport): an open
 * file whose modules it all declares is replaced (whatever its own file name),
 * one that shares only some modules keeps the others, and the edits made on
 * the sheets are kept. Undo brings the old files back.
 */
// oxlint-disable-next-line react/only-export-components
export function planImport(files: Record<string, string>, code: string, name: string, replace: boolean): ImportPlan {
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
  const n = name.trim() || covered[0] || (replace ? shared[0]?.file : undefined) || 'pasted.v';
  const fname = /\.(v|sv|vh|svh)$/i.test(n) ? n : `${n}.v`;
  if (replace) return { fname, replaced: [], trimmed: [], changed: [], clashes: [], lost: [], apply: { files: { [fname]: code }, replace } };
  const plan = planFiles(files, { [fname]: code });
  const sharedOf = (f: string) => shared.find((c) => c.file === f)?.modules ?? [];
  const updated = files[fname] !== undefined;
  const changed = [...(updated ? [fname] : []), ...plan.replaced, ...plan.trimmed];
  const lost = updated ? declaredModules({ [fname]: files[fname] }).filter((m) => !mods.has(m)) : [];
  return {
    fname,
    replaced: plan.replaced,
    trimmed: plan.trimmed.map((f) => ({ file: f, modules: sharedOf(f) })),
    changed,
    clashes: plan.clashes.map((f) => ({ file: f, modules: sharedOf(f) })),
    lost,
    apply: { files: { [fname]: code }, replace: false, newVersion: true },
  };
}

export function ImportDialog({ onClose }: { onClose(): void }) {
  const files = useStore((s) => s.files);
  const setFiles = useStore((s) => s.setFiles);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [replace, setReplace] = useState(Object.keys(files).length === 0);
  const fileInput = useRef<HTMLInputElement>(null);
  useEscape(onClose);

  // Shown for the code as typed a moment ago (scanning a long file on every key is slow); the import reads the code as it is.
  const deferred = useDeferredValue(code);
  const { fname, replaced, trimmed, changed, clashes, lost } = useMemo(() => planImport(files, deferred, name, replace), [files, deferred, name, replace]);

  const run = async () => {
    onClose();
    const { apply } = planImport(files, code, name, replace);
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
        <p className="small muted">
          Paste or open Verilog / SystemVerilog. Yosys reads it in your browser (nothing is uploaded) and every module becomes a sheet you can edit:
          move, rename and delete symbols, and draw more. Importing changed code later keeps your edits.
        </p>
        {trimmed.map((t) => (
          <p key={t.file} className="small">
            Replaces <b>{t.modules.join(', ')}</b> in <b>{t.file}</b>; its other modules stay.
          </p>
        ))}
        {changed.length > 0 && (
          <p className="small">
            {replaced.length ? 'Replaces' : 'Updates'} <b>{changed.join(', ')}</b>. Your moves, renames, deletions and hand-drawn parts on its sheets are
            kept (Undo brings the old {changed.length === 1 ? 'file' : 'files'} back).
            {lost.length > 0 && (
              <>
                {' '}
                The new code no longer declares <b>{lost.join(', ')}</b>.
              </>
            )}
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
}

const isPin = (n: DNode) => n.kind === 'input' || n.kind === 'output' || n.kind === 'inout';

/**
 * Verilog for the sheet on screen, and for the modules it instantiates that
 * no Verilog file defines: drawings, automatic blocks, and Yosys's copies of
 * parameterized modules. Modules from the user's files are instantiated by
 * name; the check reads those files too.
 */
// Exported for the tests; the dialog below is its only user.
// oxlint-disable-next-line react/only-export-components
export function exportCurrent(): VerilogOut {
  const s = useStore.getState();
  const module = s.path[s.path.length - 1]?.module ?? 'top';
  const declared = new Set(declaredModules(s.files));
  /** Module names that only this app gave: automatic blocks and Yosys's `$paramod…` modules. */
  const madeUpNames = new Map<string, string>();
  /** Names of modules that exist under that name anyway: the user's Verilog modules and the drawings. */
  const taken = new Set([...declared, ...s.doc.drawn.map(verilogIdent)]);
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
    if (n !== stem) later.push(`${mod}: written as module ${n}, as another module is called ${stem}`);
    return n;
  };
  const isAuto = (mod: string) => !!s.blockDesign?.modules[mod]?.auto;
  const isMadeUp = (mod: string) => isAuto(mod) || mod.startsWith('$paramod');
  // Named as its parents' exports name it, so that they fit this one.
  const name = isMadeUp(module) ? madeUpName(module) : verilogIdent(module);
  taken.add(name);
  if (!s.netlist) return { name, code: '', warnings: ['Nothing to export.'], check: { files: {}, top: name } };
  const parts: string[] = [];
  const warnings: string[] = [];
  const done = new Set<string>([module]);
  /** Module names the code defines. */
  const defined = new Set<string>([name]);
  /** Instantiates a module that only the user's files define. */
  let usesFiles = false;
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
      const view = s.blockDesign?.modules[sub] ? s.blockDesign : s.design;
      if (s.doc.drawn.includes(sub)) {
        add(sub, effectiveDiagram(sub, undefined, s.doc.sheets[`d:${sub}`] ?? emptyEdits(), s.interfaceOf), sub);
      } else if (isAuto(sub)) {
        // An automatic block is cut out of a Verilog module by this app, so no file defines it.
        add(sub, autoBlock(sub), madeUpName(sub));
      } else if (declared.has(sub)) {
        usesFiles = true;
      } else if (sub.startsWith('$paramod') && view?.modules[sub]) {
        // Yosys's copy of a parameterized module for one set of parameters (`sub #(.W(8))`): no file
        // declares it under this name, so it is defined here as Yosys elaborated it, like an automatic block.
        const note = `// ${view.modules[sub].displayName} as Yosys elaborated it with the parameters of ${sub.replace(/\s+/g, ' ')}`;
        add(sub, buildDiagram(view, sub, s.rules), madeUpName(sub), note);
      } else {
        done.add(sub);
        warnings.push(`Module ${sub} (instance ${n.instanceName ?? n.subLabel ?? n.label}) is not defined by a drawing or your Verilog files`);
      }
    }
  };
  /**
   * An automatic block as its sheet shows it, but with the ports its instances connect: they take
   * them from the Verilog (see interfaceOf), not from the sheet. So a pin renamed on the sheet keeps
   * its Verilog name, a deleted pin is written all the same, and pins drawn by hand are left out
   * with their wires (no instance connects them). Everything else drawn, deleted or renamed inside
   * the block is kept: that is its logic.
   */
  const autoBlock = (sub: string): Diagram => {
    const base = buildDiagram(s.blockDesign!, sub, s.rules);
    const e = s.doc.sheets[sheetKey({ instance: sub, module: sub }, 'blocks')] ?? emptyEdits();
    const pins = new Map(base.nodes.filter(isPin).map((n) => [n.id, n.label]));
    const renamed = Object.keys(e.labels).filter((id) => pins.has(id) && e.labels[id] !== pins.get(id));
    const deleted = e.hidden.filter((id) => pins.has(id));
    const labels = Object.fromEntries(Object.entries(e.labels).filter(([id]) => !pins.has(id)));
    const d = effectiveDiagram(sub, base, { ...e, labels, hidden: e.hidden.filter((id) => !pins.has(id)) }, s.interfaceOf);
    const extra = d.nodes.filter((n) => isPin(n) && !pins.has(n.id));
    const changes = [
      ...renamed.map((id) => `${e.labels[id]} keeps its Verilog name ${pins.get(id)}`),
      ...deleted.map((id) => `the deleted ${pins.get(id)} is written all the same`),
      ...extra.map((n) => `${n.label}, drawn on its sheet, is left out`),
    ];
    if (changes.length) later.push(`${sub}: its instances connect the pins its Verilog gives it: ${changes.join('; ')}`);
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
    later.push(...r.warnings.map((w) => `${mod}: ${w}`));
  };
  // An automatic block on screen is written as its parents' exports write it: one definition everywhere.
  const onScreen = isAuto(module) ? autoBlock(module) : s.netlist;
  subModules(onScreen);
  const sheet = named(onScreen);
  const top = diagramToVerilog(sheet, isMadeUp(module) ? name : module);
  warnings.push(...top.warnings, ...later);
  const code = [...parts, top.code].join('\n');
  if (!usesFiles) return { name, code, warnings, check: { files: { [`${name}.v`]: code }, top: name } };

  // The modules it instantiates are in the user's files, and so is a Verilog sheet's own module:
  // check a copy of this module under a name of its own, so that the two definitions do not clash.
  const inUse = new Set([...declared, ...defined, ...Object.keys(s.files)]);
  const unused = (stem: string, ext = '') => {
    let n = `${stem}${ext}`;
    for (let i = 2; inUse.has(n); i++) n = `${stem}_${i}${ext}`;
    return n;
  };
  const checkTop = declared.has(name) ? unused(`${name}_export`) : name;
  const checkCode = checkTop === name ? code : [...parts, diagramToVerilog(sheet, checkTop).code].join('\n');
  return { name, code, warnings, check: { files: { ...s.files, [unused(name, '.v')]: checkCode }, top: checkTop } };
}

export function VerilogExportDialog({ onClose }: { onClose(): void }) {
  const out = useMemo(() => exportCurrent(), []);
  const [check, setCheck] = useState<{ ok: boolean; text: string }>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  useEscape(onClose);

  const runCheck = async () => {
    setBusy(true);
    setCheck(undefined);
    try {
      const r = await elaborate(out.check.files, out.check.top);
      const json = parseYosysJson(r.json);
      const m = json.modules[out.check.top];
      setCheck({ ok: true, text: `Yosys elaborated ${out.name}: ${Object.keys(m?.ports ?? {}).length} ports, ${Object.keys(m?.cells ?? {}).length} cells.` });
    } catch (e) {
      setCheck({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
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
            {busy ? 'Checking…' : 'Check with Yosys'}
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
  [['Drag', 'pin'], 'Draw a wire to another pin or onto a wire'],
  [['Click', 'pin'], 'Start a wire: click to add bends, click a pin or wire to finish'],
  [['Backspace'], 'Remove the last bend while drawing a wire'],
  [['Esc'], 'Stop drawing or placing; clear the selection'],
  [['Drag', 'symbol'], 'Move (snaps to the grid; hold Alt for free moves)'],
  [['Drag', 'wire'], 'Move that wire segment'],
  [['Click'], 'Select; Shift or Ctrl adds to the selection'],
  [['Drag', 'empty'], 'Box select (to the right: inside; to the left: touching)'],
  [['↑ ↓ ← →'], 'Nudge the selection (Shift: 5 grid steps)'],
  [['Double-click'], 'Open a block; rename a pin, note or wire'],
  [['Enter'], 'Rename the selection'],
  [['Delete'], 'Delete the selection'],
  [[MOD, 'C / X / V'], 'Copy, cut, paste'],
  [[MOD, 'D'], 'Duplicate'],
  [[MOD, 'A'], 'Select all'],
  [[MOD, 'Z'], 'Undo'],
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
