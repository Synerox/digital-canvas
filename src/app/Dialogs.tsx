/**
 * Dialogs: Import Verilog (paste or open code), Export Verilog (with a Yosys
 * check), and the shortcut sheet.
 */
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { type Diagram, buildDiagram } from '../core/diagram';
import { diagramToVerilog, verilogIdent } from '../editor/verilog-export';
import { emptyEdits, sheetKey } from '../editor/doc';
import { effectiveDiagram } from '../editor/sheet';
import { downloadBlob } from '../render/export';
import { elaborate } from '../yosys/client';
import { parseYosysJson } from '../core/yosys-json';
import { declaredModules } from '../yosys/script';
import { useStore } from './store';

function useEscape(onClose: () => void) {
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

export function ImportDialog({ onClose }: { onClose(): void }) {
  const files = useStore((s) => s.files);
  const setFiles = useStore((s) => s.setFiles);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [replace, setReplace] = useState(Object.keys(files).length === 0);
  const fileInput = useRef<HTMLInputElement>(null);
  useEscape(onClose);

  // Code that declares the same modules as open files is a new version of them: it replaces
  // them (whatever its own file name), and the edits made on their sheets are kept.
  const deferred = useDeferredValue(code);
  const sameAs = useMemo(() => {
    const mods = new Set(declaredModules({ 'x.v': deferred }));
    if (mods.size === 0) return [];
    return Object.keys(files).filter((f) => declaredModules({ [f]: files[f] }).some((m) => mods.has(m)));
  }, [deferred, files]);
  const fname = (() => {
    const n = name.trim() || sameAs[0] || 'pasted.v';
    return /\.(v|sv|vh|svh)$/i.test(n) ? n : `${n}.v`;
  })();
  /** Open files that the import takes the place of (both would declare the same modules). */
  const replaced = replace ? [] : sameAs.filter((f) => f !== fname);
  const changed = replace ? [] : [...(files[fname] !== undefined ? [fname] : []), ...replaced];

  const run = async () => {
    onClose();
    if (replaced.length === 0) {
      await setFiles({ [fname]: code }, replace);
      return;
    }
    const next = { ...files };
    for (const f of replaced) delete next[f];
    await setFiles({ ...next, [fname]: code }, true);
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
        {changed.length > 0 && (
          <p className="small">
            {replaced.length ? 'Replaces' : 'Updates'} <b>{changed.join(', ')}</b>. Your moves, renames, deletions and hand-drawn parts on its sheets are
            kept.
          </p>
        )}
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
            File name <input value={name} placeholder={sameAs[0] ?? 'pasted.v'} onChange={(e) => setName(e.target.value)} style={{ width: 140 }} />
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

/**
 * Verilog for the sheet on screen, and for the modules it instantiates that
 * no Verilog file defines: drawings and automatic blocks. Modules from the
 * user's files are instantiated by name; the check reads those files too.
 */
// Exported for the tests; the dialog below is its only user.
// oxlint-disable-next-line react/only-export-components
export function exportCurrent(): VerilogOut {
  const s = useStore.getState();
  const module = s.path[s.path.length - 1]?.module ?? 'top';
  // Written as an instance writes it (`top/crop_points` → `top_crop_points`), so a parent's export fits this one.
  const name = verilogIdent(module);
  if (!s.netlist) return { name, code: '', warnings: ['Nothing to export.'], check: { files: {}, top: name } };
  const declared = new Set(declaredModules(s.files));
  const parts: string[] = [];
  const warnings: string[] = [];
  /** Warnings about the sub-modules, listed after the sheet's own. */
  const later: string[] = [];
  const done = new Set<string>([module]);
  /** Module names the code defines. */
  const defined = new Set<string>([name]);
  /** Instantiates a module that only the user's files define. */
  let usesFiles = false;
  const subModules = (d: Diagram) => {
    for (const n of d.nodes) {
      const sub = n.kind === 'instance' ? n.moduleName : undefined;
      if (!sub || done.has(sub)) continue;
      if (s.doc.drawn.includes(sub)) {
        add(sub, effectiveDiagram(sub, undefined, s.doc.sheets[`d:${sub}`] ?? emptyEdits(), s.interfaceOf), sub);
      } else if (s.blockDesign?.modules[sub]?.auto) {
        // An automatic block is cut out of a Verilog module by this app, so no file defines it: write it
        // as its own sheet shows it, under the name the instance uses.
        const base = buildDiagram(s.blockDesign, sub, s.rules);
        const e = s.doc.sheets[sheetKey({ instance: sub, module: sub }, 'blocks')] ?? emptyEdits();
        add(sub, effectiveDiagram(sub, base, e, s.interfaceOf), verilogIdent(sub));
      } else if (declared.has(sub)) {
        usesFiles = true;
      } else {
        done.add(sub);
        warnings.push(`Module ${sub} (instance ${n.instanceName ?? n.subLabel ?? n.label}) is not defined by a drawing or your Verilog files`);
      }
    }
  };
  /** Sub-modules go first, so the file reads bottom-up. */
  const add = (mod: string, d: Diagram, as: string) => {
    done.add(mod);
    subModules(d);
    const r = diagramToVerilog(d, as);
    defined.add(verilogIdent(as));
    parts.push(r.code);
    later.push(...r.warnings.map((w) => `${mod}: ${w}`));
  };
  subModules(s.netlist);
  const top = diagramToVerilog(s.netlist, module);
  warnings.push(...top.warnings, ...later);
  const code = [...parts, top.code].join('\n');
  if (!usesFiles) return { name, code, warnings, check: { files: { [`${name}.v`]: code }, top: name } };

  // The modules it instantiates are in the user's files, and so is a Verilog sheet's own module:
  // check a copy of this module under a name of its own, so that the two definitions do not clash.
  const taken = new Set([...declared, ...defined, ...Object.keys(s.files)]);
  const unused = (stem: string, ext = '') => {
    let n = `${stem}${ext}`;
    for (let i = 2; taken.has(n); i++) n = `${stem}_${i}${ext}`;
    return n;
  };
  const checkTop = declared.has(name) ? unused(`${name}_export`) : name;
  const checkCode = checkTop === name ? code : [...parts, diagramToVerilog(s.netlist, checkTop).code].join('\n');
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
