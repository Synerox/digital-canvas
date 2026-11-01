/**
 * Dialogs: Import Verilog (paste or open code), Export Verilog (with a Yosys
 * check), and the shortcut sheet.
 */
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { diagramToVerilog } from '../editor/verilog-export';
import { isDrawnKey } from '../editor/doc';
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

  // Code that declares the same modules as an open file is a new version of that file:
  // it replaces the file, and the edits made on its sheets are kept.
  const deferred = useDeferredValue(code);
  const sameAs = useMemo(() => {
    const mods = new Set(declaredModules({ 'x.v': deferred }));
    if (mods.size === 0) return undefined;
    return Object.keys(files).find((f) => declaredModules({ [f]: files[f] }).some((m) => mods.has(m)));
  }, [deferred, files]);
  const fname = (() => {
    const n = name.trim() || sameAs || 'pasted.v';
    return /\.(v|sv|vh|svh)$/i.test(n) ? n : `${n}.v`;
  })();

  const run = async () => {
    onClose();
    await setFiles({ [fname]: code }, replace);
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
        {!replace && files[fname] !== undefined && (
          <p className="small">
            Updates <b>{fname}</b>. Your moves, renames, deletions and hand-drawn parts on its sheets are kept.
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
            File name <input value={name} placeholder={sameAs ?? 'pasted.v'} onChange={(e) => setName(e.target.value)} style={{ width: 140 }} />
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

/** Verilog for the sheet on screen, and for the drawings it instantiates. */
function exportCurrent(): { name: string; code: string; warnings: string[] } {
  const s = useStore.getState();
  const module = s.path[s.path.length - 1]?.module ?? 'top';
  const name = module.replace(/[^A-Za-z0-9_$]/g, '_');
  if (!s.netlist) return { name, code: '', warnings: ['Nothing to export.'] };
  const parts: string[] = [];
  const warnings: string[] = [];
  const done = new Set<string>();
  const add = (mod: string, d: typeof s.netlist) => {
    if (done.has(mod) || !d) return;
    done.add(mod);
    // Drawings used as blocks go first, so the file reads bottom-up.
    for (const n of d.nodes) {
      if (n.kind === 'instance' && n.moduleName && s.doc.drawn.includes(n.moduleName) && !done.has(n.moduleName)) {
        const e = s.doc.sheets[`d:${n.moduleName}`];
        if (e) add(n.moduleName, effectiveDiagram(n.moduleName, undefined, e, s.interfaceOf));
      }
    }
    const r = diagramToVerilog(d, mod.replace(/^.*\//, '').replace(/[^A-Za-z0-9_$]/g, '_'));
    parts.push(r.code);
    warnings.push(...r.warnings.map((w) => (mod === module ? w : `${mod}: ${w}`)));
  };
  add(module, s.netlist);
  return { name, code: parts.join('\n'), warnings };
}

export function VerilogExportDialog({ onClose }: { onClose(): void }) {
  const out = useMemo(() => exportCurrent(), []);
  const sheet = useStore((s) => s.sheet);
  const files = useStore((s) => s.files);
  const [check, setCheck] = useState<{ ok: boolean; text: string }>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  useEscape(onClose);

  const runCheck = async () => {
    setBusy(true);
    setCheck(undefined);
    try {
      // Blocks may instantiate Verilog modules: elaborate with the user's files too.
      const fname = `${out.name}_drawing.v`;
      const usesVerilog = isDrawnKey(sheet) && Object.keys(files).length > 0;
      const r = await elaborate({ ...(usesVerilog ? files : {}), [fname]: out.code }, out.name);
      const json = parseYosysJson(r.json);
      const m = json.modules[out.name];
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
