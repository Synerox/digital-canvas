/**
 * Dialogs: Import Verilog (paste or open code) and the Hints sheet (keys and
 * mouse actions).
 */
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { type EditDoc, emptyDoc } from '../editor/doc';
import { declaredModules } from '../yosys/script';
import { type PutAside, changeFiles, importedTop, planImport as planFiles, useStore } from './store';

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

const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

const HINTS: [string[], string][] = [
  [['Click', 'library'], 'Pick a symbol: each click on the canvas places a copy, until Esc'],
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
  [['Click', 'drawing'], `Open it from the Drawings list and select it there: Delete deletes it, ${MOD}+C / ${MOD}+V copy and paste it, ${MOD}+D duplicates it (× deletes it too)`],
  [['L'], 'Auto layout the sheet'],
  [['Wheel'], 'Scroll; Shift+wheel scrolls sideways'],
  [[MOD, 'Wheel'], 'Zoom'],
  [['Space', 'Drag'], 'Pan (also middle or right drag)'],
  [['F'], 'Fit to window'],
];

export function Hints({ onClose }: { onClose(): void }) {
  return (
    <section className="hints" aria-label="Hints">
      <header>
        <b>Hints</b>
        <button className="icon" onClick={onClose} aria-label="Close hints">
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
