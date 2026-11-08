/**
 * Library › Components: the components of the library, written as JSON (see editor/components).
 * Saving is one undo step; the blocks of a part follow its pins.
 */
import { useDeferredValue, useMemo, useState } from 'react';
import { COMPONENTS_EXAMPLE, componentsJson, isPart, parseComponents } from '../editor/components';
import { sheetsUsing, useStore } from './store';
import { MOD, useEscape } from './Dialogs';

export function ComponentsDialog({ onClose }: { onClose(): void }) {
  const defs = useStore((s) => s.doc.components);
  const doc = useStore((s) => s.doc);
  const nameTaken = useStore((s) => s.componentNameTaken);
  // A part the library has already keeps its name, also once a drawing or Verilog module has it (that module
  // then takes its place): only new parts must not take a module's name.
  const taken = useMemo(() => {
    const had = new Set((defs ?? []).filter(isPart).map((d) => d.name));
    return (name: string) => (had.has(name) ? undefined : nameTaken(name));
  }, [defs, nameTaken]);
  const setComponents = useStore((s) => s.setComponents);
  const [text, setText] = useState(() => (defs?.length ? componentsJson(defs) : COMPONENTS_EXAMPLE));
  useEscape(onClose);

  const typed = useDeferredValue(text);
  const result = useMemo(() => parseComponents(typed, taken), [typed, taken]);
  // Parts that go away while blocks use them: those blocks lose their pins (and wires) until Undo.
  const orphaned = useMemo(() => {
    if (!result.defs) return [];
    const kept = new Set(result.defs.filter(isPart).map((d) => d.name));
    return (defs ?? []).filter((d) => isPart(d) && !kept.has(d.name) && sheetsUsing(doc, d.name).length > 0).map((d) => d.name);
  }, [result, defs, doc]);

  const save = () => {
    const r = parseComponents(text, taken);
    if (!r.defs) return;
    setComponents(r.defs);
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal components-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Components"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') save();
        }}
      >
        <div className="modal-head">
          <b>Components (JSON)</b>
          <button className="icon" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <p className="small">
          A list of components for the library, saved with your work. A <b>preset</b> is a library symbol with its settings, for example{' '}
          <code>{'{ "name": "and5", "base": "and", "inputs": 5 }'}</code>: <code>base</code> is <code>and</code>, <code>or</code>, <code>mux</code>,{' '}
          <code>add</code>… and the other fields are what Properties shows for it (<code>inputs</code>, <code>width</code>, <code>parts</code>,{' '}
          <code>shift</code>, <code>value</code>). A <b>part</b> has pins of its own and no logic:{' '}
          <code>{'{ "name": "alu", "inputs": ["a[7:0]", "b[7:0]"], "outputs": ["y[7:0]"] }'}</code>, or numbers of pins such as{' '}
          <code>{'"inputs": 6'}</code> (named in0, in1…, with <code>width</code> bits each). A part is placed as a block and exported as an empty module. What is placed
          from a component changes with it (except a symbol changed on its own).
        </p>
        {!defs?.length && <p className="small muted">An example to start from: change it, or clear it to have none.</p>}
        <textarea
          className="code-input"
          value={text}
          spellCheck={false}
          rows={14}
          aria-label="Components as JSON"
          onChange={(e) => setText(e.target.value)}
        />
        {result.defs ? (
          <p className="small muted">
            {result.defs.length === 0
              ? 'No components.'
              : `${result.defs.length} component${result.defs.length === 1 ? '' : 's'}: ${result.defs.map((d) => d.name).join(', ')}.`}
          </p>
        ) : (
          <div className="field-error small">{result.error}</div>
        )}
        {orphaned.length > 0 && (
          <p className="small">
            {orphaned.join(', ')} {orphaned.length === 1 ? 'is' : 'are'} placed as blocks, which keep their places but lose their pins and wires (Undo brings
            them back).
          </p>
        )}
        <div className="row">
          <button className="primary" onClick={save} disabled={!!result.error}>
            Save
          </button>
          <button onClick={onClose}>Cancel</button>
          <span className="small muted">{MOD}+Enter saves</span>
        </div>
      </div>
    </div>
  );
}
