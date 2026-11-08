/**
 * The small window that edits a component as JSON: a placed symbol's settings
 * (`{ "sym": "and", "inputs": 5, "width": 1 }`), or a component of the
 * library (a part's pins, a preset's settings). Double-clicking the symbol, a
 * part's block or a component of the library opens it; Properties has a
 * button for it too. Apply is one undo step.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { type ComponentDef, MAX_COMPONENTS, editComponent, freeComponentName, isPart, parseSymbolJson, settingsHint } from '../editor/components';
import { SYMBOL_BY_KEY, type SymKey, type SymParams } from '../editor/symbols';
import { MOD, useEscape } from './Dialogs';
import { sheetsPlacing, sheetsUsing, useStore } from './store';
import { type SettingsRequest, type Subject, subjectOf } from './settings';
import { ui } from './ui-events';

/** Mounted once: shows the window when asked to (see openSettings). */
export function SettingsPopup() {
  const [open, setOpen] = useState<{ subject: Subject; x: number; y: number; from?: string; n: number }>();
  useEffect(() => {
    let n = 0;
    const onOpen = (ev: Event) => {
      const { target, x, y, from } = (ev as CustomEvent<SettingsRequest>).detail;
      const subject = subjectOf(useStore.getState(), target);
      if (subject) setOpen({ subject, x, y, from, n: ++n });
    };
    ui.addEventListener('edit-settings', onOpen);
    return () => ui.removeEventListener('edit-settings', onOpen);
  }, []);
  if (!open) return null;
  return <SettingsWindow key={open.n} subject={open.subject} x={open.x} y={open.y} from={open.from} onClose={() => setOpen(undefined)} />;
}

/** The window itself, next to the point (x, y) in the page, asked for on the symbol `from` (if any). */
export function SettingsWindow({ subject, x, y, from, onClose }: { subject: Subject; x: number; y: number; from?: string; onClose(): void }) {
  const setNodeParams = useStore((s) => s.setNodeParams);
  const setComponents = useStore((s) => s.setComponents);
  const nameTaken = useStore((s) => s.componentNameTaken);
  const doc = useStore((s) => s.doc);
  // A Verilog module or a drawing of a part's name defines its blocks in its place (see partOfBlock).
  const shadowed = useStore(
    (s) => subject.kind === 'component' && isPart(subject.def) && (s.doc.drawn.includes(subject.def.name) || !!s.viewDesign()?.modules[subject.def.name]),
  );
  const [text, setText] = useState(subject.text);
  const [said, setSaid] = useState<string>();
  const box = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState({ left: x + 12, top: y + 12 });
  useEscape(onClose);

  // Next to the point, all of it on the screen.
  useLayoutEffect(() => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    const left = Math.max(8, Math.min(x + 12, window.innerWidth - r.width - 8));
    const top = Math.max(8, Math.min(y + 12, window.innerHeight - r.height - 8));
    setAt((a) => (a.left === left && a.top === top ? a : { left, top }));
  }, [x, y, text, said]);

  // A part the library has already keeps its name, also once a module has it (see ComponentsDialog).
  const taken = useMemo(() => {
    const had = new Set((doc.components ?? []).filter(isPart).map((d) => d.name));
    return (name: string) => (had.has(name) ? undefined : nameTaken(name));
  }, [doc.components, nameTaken]);

  /** What the text says: the symbol's settings, or the library with the component changed; or what is wrong. */
  const result = useMemo((): { params?: SymParams; defs?: ComponentDef[]; error?: string } => {
    if (subject.kind === 'node') return parseSymbolJson(text, subject.sym);
    return editComponent(doc.components ?? [], subject.def.name, text, taken);
  }, [subject, text, doc.components, taken]);
  const error = result.error;

  const apply = () => {
    if (error !== undefined) return;
    if (text !== subject.text) {
      if (subject.kind === 'node' && result.params) setNodeParams(subject.id, result.params);
      else if (subject.kind === 'component' && result.defs) {
        // In the same place of the list: when its name changed, what was placed from it follows the new name.
        const from = subject.def.name;
        const to = result.defs[(doc.components ?? []).findIndex((c) => c.name === from)]?.name;
        setComponents(result.defs, to && to !== from ? { from, to } : undefined);
      }
    }
    onClose();
  };

  /** Add the settings typed to the library as a component of its own (the symbol stays as it is until Apply). */
  const saveAsComponent = () => {
    if (subject.kind !== 'node' || !result.params) return;
    if ((doc.components?.length ?? 0) >= MAX_COMPONENTS) {
      setSaid(`The library holds at most ${MAX_COMPONENTS} components.`);
      return;
    }
    const p = result.params;
    // and3, add8, mux4x8: the count of inputs (or slices), and the width when it is a bus.
    const count = p.inputs ?? p.parts;
    const bits = p.width && p.width > 1 ? `${count !== undefined ? 'x' : ''}${p.width}` : '';
    const name = freeComponentName(doc.components, `${subject.sym}${count ?? ''}${bits}`, nameTaken);
    setComponents([...(doc.components ?? []), { name, base: subject.sym, params: p }]);
    setSaid(`Added ${name} to Components.${text !== subject.text ? ' Apply changes this symbol too.' : ''}`);
  };

  const symTitle = (sym: SymKey) => SYMBOL_BY_KEY[sym]?.title ?? sym;
  let title: string;
  let hint: string;
  let note: string | undefined;
  if (subject.kind === 'node') {
    title = symTitle(subject.sym);
    hint = `Sets ${settingsHint(subject.sym)}.`;
    const from = subject.component;
    if (from && doc.components?.some((c) => c.name === from && !isPart(c))) note = `Placed from ${from}: a change here is for this symbol only (it stops following ${from}).`;
  } else {
    const d = subject.def;
    title = `${d.title ?? d.name} (component)`;
    hint = isPart(d)
      ? 'Pins: "inputs", "outputs", "inouts" as names such as "a" or "a[7:0]", or a number of pins; "width" is the bits of every pin written without them ("a").'
      : `Sets ${settingsHint(d.base!)}; "base" is the symbol.`;
    const blocks = isPart(d) ? sheetsUsing(doc, d.name) : [];
    const placed = isPart(d) ? [] : sheetsPlacing(doc, d.name);
    const kept = result.defs?.find((c) => c.name === d.name);
    if (shadowed) {
      note = `A Verilog module or drawing named ${d.name} defines its blocks now: these pins are not used.`;
    } else if (blocks.length && result.defs && !(kept && isPart(kept))) {
      note = `Blocks of ${d.name} on ${blocks.join(', ')} lose their pins and wires (Undo brings them back).`;
    } else if (blocks.length) {
      note = `Changes every block of ${d.name}.`;
    } else if (placed.length) {
      note = `Changes the symbols placed from ${d.name} on ${placed.join(', ')} (but those changed on their own).`;
    }
  }

  return (
    <div
      className="modal-backdrop popup-backdrop"
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return;
        // A click outside closes it, but more clicks on what it was opened on (a symbol, a component of the library)
        // do not: clicking on after a double-click is not clicking away.
        const under = document
          .elementsFromPoint(e.clientX, e.clientY)
          .map((el) => el.closest('[data-node-id], [data-settings-from]'))
          .find((el) => el !== null);
        if (from !== undefined && under && (under.getAttribute('data-node-id') ?? under.getAttribute('data-settings-from')) === from) return;
        onClose();
      }}
    >
      <div
        ref={box}
        className="modal popup"
        style={at}
        role="dialog"
        aria-modal="true"
        aria-label={`${title}: JSON`}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            apply();
          }
        }}
      >
        <div className="modal-head">
          <b>{title}</b>
          <button className="icon" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <textarea
          className={`code-input popup-json ${error !== undefined ? 'invalid' : ''}`}
          value={text}
          rows={Math.min(14, Math.max(3, text.split('\n').length))}
          spellCheck={false}
          autoFocus
          aria-label="JSON"
          onChange={(e) => {
            setText(e.target.value);
            setSaid(undefined);
          }}
        />
        {error !== undefined ? <div className="field-error small">{error}</div> : <p className="small muted">{hint}</p>}
        {note && <p className="small">{note}</p>}
        {said && <p className="small">{said}</p>}
        <div className="row">
          <button className="primary" onClick={apply} disabled={error !== undefined}>
            Apply
          </button>
          <button onClick={onClose}>Cancel</button>
          {subject.kind === 'node' && (
            <button className="link small" onClick={saveAsComponent} disabled={error !== undefined} title="Add these settings to the library (Components)">
              Save as a component
            </button>
          )}
          <span className="small muted popup-keys">{MOD}+Enter applies</span>
        </div>
      </div>
    </div>
  );
}
