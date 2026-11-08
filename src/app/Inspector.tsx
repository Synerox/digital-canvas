/**
 * Properties of the selection (or of the sheet when nothing is selected):
 * only what is needed. Names and parameters apply on Enter or when the field
 * loses focus; every change is one undo step. A symbol's settings as JSON are
 * edited in a window of their own (see SettingsPopup).
 */
import { useEffect, useRef, useState } from 'react';
import type { Diagram } from '../core/diagram';
import type { SrcRange } from '../core/ir';
import { checkSheet, openInputsMessage, scaleNote, wireShift } from '../editor/check';
import { PARAM_LIMITS, SYMBOL_BY_KEY, literalWidth, type ParamName } from '../editor/symbols';
import { isDrawnKey } from '../editor/doc';
import { verilogIdent } from '../editor/verilog-export';
import { moduleTitle, sameFile, sheetsUsing, staleSlices, useStore, viewModeOf } from './store';
import { ui } from './ui-events';
import { openSettings, partOfBlock, settingsOf } from './settings';

/**
 * A text field that commits on Enter or blur and resets on Escape. `check`
 * rejects text that is not well formed: the field keeps it, to be corrected,
 * and says why. `onCommit` may refuse the text by returning why: the field
 * then shows what is in effect again (the refused text would read as
 * applied), and says why below it.
 */
function Field({
  value,
  onCommit,
  placeholder,
  id,
  inputRef,
  check,
}: {
  value: string;
  onCommit(v: string): string | void;
  placeholder?: string;
  id?: string;
  inputRef?: React.Ref<HTMLInputElement>;
  check?: (v: string) => string | undefined;
}) {
  const [text, setText] = useState(value);
  const [err, setErr] = useState<string>();
  // Set by Escape: the blur that follows must not commit (it still sees the typed text).
  const cancelled = useRef(false);
  useEffect(() => {
    setText(value);
    setErr(undefined);
  }, [value]);
  const commit = () => {
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    if (text === value) return;
    const bad = check?.(text);
    if (bad) {
      setErr(bad);
      return;
    }
    const refused = onCommit(text);
    if (refused) setText(value);
    setErr(refused || undefined);
  };
  return (
    <>
      <input
        id={id}
        ref={inputRef}
        className={err && text !== value ? 'invalid' : ''}
        value={text}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          // A refusal is about the text that was refused; a check is about what is typed (see commit).
          if (err && text === value) setErr(undefined);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          // Both end the edit by leaving the field, and its blur commits: once, so a change is one undo step.
          if (e.key === 'Enter') {
            (e.target as HTMLInputElement).blur();
          } else if (e.key === 'Escape') {
            cancelled.current = true;
            setText(value);
            setErr(undefined);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      {err && <div className="field-error small">{err}</div>}
    </>
  );
}

const PARAM_TITLE: Record<ParamName, string> = {
  width: 'Width (bits)',
  inputs: 'Inputs',
  parts: 'Slices',
  value: 'Value',
  module: 'Module',
  shift: 'Shift amount (bits)',
};

function parseSlice(text: string, srcWidth: number): { lo: number; width: number } | undefined | 'bad' {
  const t = text.trim().replace(/^\[|\]$/g, '');
  if (!t) return undefined;
  const m = /^(\d+)(?::(\d+))?$/.exec(t);
  if (!m) return 'bad';
  const a = Number(m[1]);
  const b = m[2] === undefined ? a : Number(m[2]);
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  if (hi >= srcWidth) return 'bad';
  return { lo, width: hi - lo + 1 };
}

/**
 * The source lines Source highlights for a symbol, each once and in order (an automatic block
 * has many cells, often several per line). Only lines of open files count, so a range from a
 * damaged drawing file (lines 1 to 10⁹) costs no more than the file is long.
 */
function srcLines(src: readonly SrcRange[], files: Record<string, string>): number[] {
  const lines = new Set<number>();
  /** Lines per file, numbered as Source numbers them. */
  const count = new Map<string, number>();
  for (const r of src) {
    const file = Object.keys(files).find((f) => sameFile(r.file, f));
    if (file === undefined) continue;
    if (!count.has(file)) count.set(file, files[file].split('\n').length);
    const last = Math.min(Math.max(r.startLine, r.endLine), count.get(file)!);
    for (let l = Math.max(1, r.startLine); l <= last; l++) lines.add(l);
  }
  return [...lines].sort((a, b) => a - b);
}

/** Why the checks flag a wire (see checkSheet), which keeps one set of flagged wires for all reasons. */
function wireTrouble(d: Diagram, id: string): string[] {
  const e = d.edges.find((x) => x.id === id);
  const into = e && d.nodes.flatMap((n) => n.ports).find((p) => p.id === e.target.port);
  if (!e || !into) return [];
  // On its own, a wire can only be flagged for its width; with the other wires into its input, all
  // made as wide as that input, only for driving it together with them.
  const alone = checkSheet({ ...d, edges: [e] }).flagged.has(id);
  const others = d.edges.filter((x) => x.target.port === e.target.port).map((x) => ({ ...x, width: into.width, shift: undefined, label: undefined }));
  const doubled = checkSheet({ ...d, edges: others }).flagged.has(id);
  return [...(alone ? ['does not match the input it feeds'] : []), ...(doubled ? ['its input has another driver'] : [])];
}

/** Sorted line numbers, runs written as ranges: `31, 33, 35–48`. */
function lineList(lines: number[]): string {
  const out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    let j = i;
    while (j + 1 < lines.length && lines[j + 1] === lines[j] + 1) j++;
    out.push(j > i ? `${lines[i]}–${lines[j]}` : String(lines[i]));
    i = j + 1;
  }
  return out.join(', ');
}

/**
 * Properties of what is selected. Each item's panel is keyed by it: a field being typed in belongs to the item it
 * was opened on, so selecting another item (whose value may read the same) starts from that item's own values.
 */
export function Inspector({ onExportVerilog }: { onExportVerilog(): void }) {
  const s = useStore();
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onRename = (ev: Event) => {
      const id = (ev as CustomEvent<string>).detail;
      if (id && !useStore.getState().selection.has(id)) useStore.getState().select([id]);
      // Wait for the panel to show the item.
      setTimeout(() => {
        nameRef.current?.focus();
        nameRef.current?.select();
      }, 0);
    };
    ui.addEventListener('rename', onRename);
    return () => ui.removeEventListener('rename', onRename);
  }, []);

  if (!s.layout || !s.netlist) return null;
  const edits = s.doc.sheets[s.sheet];
  const sel = [...s.selection];
  const drawn = isDrawnKey(s.sheet);
  const module = s.path[s.path.length - 1]?.module ?? '';

  if (sel.length === 0) {
    const hidden = edits?.hidden.length ?? 0;
    return (
      <div className="inspector" key={s.sheet}>
        <h3>{drawn ? 'Drawing' : 'Sheet'}</h3>
        {drawn ? (
          <label className="prop">
            <span>Module name</span>
            <Field
              value={module}
              onCommit={(v) => s.renameDrawing(module, v)}
              check={(v) => {
                const want = v.trim();
                if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(want)) return 'Use letters, digits and _.';
                // A keyword is no legal module name: the export would have to write the module under another one.
                return verilogIdent(want) === want ? undefined : `${want} is a Verilog keyword.`;
              }}
            />
          </label>
        ) : (
          <p
            className="small muted"
            // Each view has sheets of its own: an edit here does not show in the other view, nor in its export.
            title={`Your moves, added symbols and wires, renames and deletions are kept when the Verilog is imported again. ${
              viewModeOf(s.sheet) === 'flat'
                ? 'They belong to the Full circuit: the Block diagram is edited apart.'
                : 'They belong to the Block diagram: the Full circuit is edited apart.'
            }`}
          >
            From Verilog: <b>{moduleTitle(module)}</b>. Your edits are kept when it is imported again.
          </p>
        )}
        <p className="small muted">
          {s.layout.nodes.length} symbols, {s.layout.edges.length} wires
        </p>
        {s.issues.messages.length > 0 && (
          <ul className="issues small">
            {s.issues.messages.map((m) =>
              // The open inputs are not marked on the sheet (a mark on every new symbol's pins reads as an
              // inverter's bubble): this line finds them.
              s.issues.openPorts?.size && m === openInputsMessage(s.issues.openPorts.size) ? (
                <li key={m}>
                  <button
                    className="link"
                    title="Select the symbols that have an input not connected"
                    onClick={() => s.select(s.layout!.nodes.filter((n) => n.ports.some((p) => s.issues.openPorts!.has(p.id))).map((n) => n.id))}
                  >
                    {m}
                  </button>
                </li>
              ) : (
                <li key={m}>{m}</li>
              ),
            )}
          </ul>
        )}
        <div className="prop-actions">
          <button onClick={() => void s.autoLayout()} title="Lay out the whole sheet again with ELK (undoable)">
            Auto layout
          </button>
          <button onClick={onExportVerilog} title="Write this sheet as Verilog">
            Export Verilog…
          </button>
          {!drawn && (
            <button onClick={() => s.convertToDrawing()} title="Copy this sheet into a new drawing you can edit freely. Automatic blocks become drawings of their own; instances of your Verilog modules still use those modules from your files.">
              Copy to new drawing
            </button>
          )}
          {hidden > 0 && <button onClick={() => s.restoreHidden()}>Restore {hidden} deleted</button>}
          {drawn && (
            <button
              className="danger"
              onClick={() => {
                const users = sheetsUsing(s.doc, module);
                const used = users.length ? ` It is used as a block on ${users.join(', ')}; those blocks will lose their pins.` : '';
                if (confirm(`Delete the drawing ${module}?${used} (You can undo this.)`)) s.deleteDrawing(module);
              }}
            >
              Delete drawing
            </button>
          )}
        </div>
      </div>
    );
  }

  if (sel.length > 1) {
    const nodes = sel.filter((id) => s.layout!.nodes.some((n) => n.id === id)).length;
    return (
      <div className="inspector">
        <h3>Selection</h3>
        <p className="small">
          {nodes} symbols, {sel.length - nodes} wires
        </p>
        <div className="prop-actions">
          <button onClick={() => s.duplicate()}>Duplicate</button>
          <button className="danger" onClick={() => s.deleteSelection()}>
            Delete
          </button>
        </div>
      </div>
    );
  }

  const id = sel[0];
  const node = s.layout.nodes.find((n) => n.id === id);
  if (node) {
    const user = edits?.nodes.find((n) => n.id === id);
    const def = user ? SYMBOL_BY_KEY[user.sym] : undefined;
    const title = user
      ? user.sym === 'raw'
        ? `Copied symbol (${moduleTitle(node.cellType ?? node.kind)})`
        : (def?.title ?? user.sym)
      : node.kind === 'instance'
        ? node.attrs?.auto
          ? 'Automatic block'
          : 'Module instance'
        : node.kind === 'cell'
          ? `Operator ${node.cellType ?? ''}`
          : node.kind === 'input' || node.kind === 'output' || node.kind === 'inout'
            ? `Module ${node.kind}`
            : node.kind === 'const'
              ? 'Constant'
              : node.kind === 'join'
                ? 'Concatenation'
                : node.kind;
    // An imported constant's label is its value: only the Verilog changes it.
    const renameable = user ? !!def?.named || user.sym === 'raw' : ['instance', 'input', 'output', 'inout'].includes(node.kind);
    const nameValue = user
      ? (user.name ?? '')
      : node.kind === 'instance'
        ? (node.subLabel ?? '')
        : node.label;
    const renamed = !user && edits?.labels[id] !== undefined;
    const lines = srcLines(node.src, s.files);
    // A block of a part has nothing to open, unless a drawing or Verilog module of that name defines it now.
    const part = user ? partOfBlock(s, node) : undefined;
    const settings = settingsOf(s, id);
    return (
      <div className="inspector" key={id}>
        <h3>{part ? `Part ${part.title ?? part.name}` : title}</h3>
        {renameable && (
          <label className="prop">
            <span>{user?.sym === 'text' ? 'Text' : node.kind === 'instance' ? 'Instance name' : 'Name'}</span>
            <Field inputRef={nameRef} value={nameValue} onCommit={(v) => s.renameItem(id, v)} />
            {renamed && (
              <button className="link small" onClick={() => s.resetItemLabel(id)}>
                Use the name from Verilog
              </button>
            )}
          </label>
        )}
        {user &&
          def?.params.map((p) => {
            if (p === 'module') {
              const options = s.blockModules();
              return (
                <label key={p} className="prop">
                  <span>{PARAM_TITLE[p]}</span>
                  <select value={user.params.module ?? ''} onChange={(e) => s.setNodeParams(id, { module: e.target.value })}>
                    {!options.includes(user.params.module ?? '') && <option value={user.params.module ?? ''}>{user.params.module || '(choose)'}</option>}
                    {options.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </label>
              );
            }
            if (p === 'value') {
              return (
                <label key={p} className="prop">
                  <span>{PARAM_TITLE[p]}</span>
                  <Field
                    value={user.params.value ?? ''}
                    placeholder="4'd2"
                    onCommit={(v) => s.setNodeParams(id, { value: v.trim() })}
                    check={(v) => (literalWidth(v) ? undefined : "Write a Verilog number such as 4'd2, 8'hFF or 1'b0.")}
                  />
                </label>
              );
            }
            const [lo, hi] = PARAM_LIMITS[p];
            const cur = user.params[p] ?? def.defaults[p] ?? lo;
            return (
              <label key={p} className="prop">
                <span>{p === 'width' && user.sym === 'decoder' ? 'Select bits' : PARAM_TITLE[p]}</span>
                <Field
                  value={String(cur)}
                  onCommit={(v) => s.setNodeParams(id, { [p]: Number(v) })}
                  check={(v) => {
                    const n = Number(v);
                    const max = p === 'width' && user.sym === 'decoder' ? 8 : hi;
                    return Number.isInteger(n) && n >= lo && n <= max ? undefined : `A whole number from ${lo} to ${max}.`;
                  }}
                />
              </label>
            );
          })}
        {node.kind === 'instance' && node.moduleName && !part && (
          <div className="prop-actions">
            <button onClick={() => s.openNode(id)}>Open {node.label}</button>
          </div>
        )}
        {node.ports.length > 0 && (
          <details className="ports small">
            <summary>
              {node.ports.length} pin{node.ports.length === 1 ? '' : 's'}
            </summary>
            <dl>
              {node.ports.map((p) => (
                <div key={p.id}>
                  <dt>{p.name}</dt>
                  <dd>
                    {p.dir === 'in' ? 'in' : 'out'} · {p.width} bit{p.width === 1 ? '' : 's'}
                  </dd>
                </div>
              ))}
            </dl>
          </details>
        )}
        {/* One line: where it comes from, and the lines Source highlights (Source shows only with the sheets of Verilog). */}
        {!user ? (
          <p className="small muted" title={`Change the Verilog to change what it is. You can ${renameable ? 'move, rename' : 'move'} or delete it here.`}>
            From Verilog{lines.length > 0 && `, ${lines.length === 1 ? `line ${lines[0]}` : `lines ${lineList(lines)}`} (highlighted in Source)`}.
          </p>
        ) : (
          !drawn &&
          lines.length > 0 && (
            <p className="small muted">
              Verilog {lines.length === 1 ? `line ${lines[0]} is` : `lines ${lineList(lines)} are`} highlighted in Source.
            </p>
          )
        )}
        <div className="prop-actions">
          {settings && (
            <button
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                openSettings(settings, r.left, r.bottom, id);
              }}
              title={part ? `The pins of ${part.name}, as JSON (changes every block of it). Double-clicking the block opens it too.` : 'The settings as JSON. Double-clicking the symbol opens them too.'}
            >
              {part ? 'Edit pins…' : 'JSON…'}
            </button>
          )}
          <button className="danger" onClick={() => s.deleteSelection()}>
            Delete
          </button>
        </div>
      </div>
    );
  }

  const edge = s.layout.edges.find((x) => x.id === id);
  if (!edge) return null;
  const userEdge = edits?.edges.find((x) => x.id === id);
  const srcPort = s.layout.nodes.flatMap((n) => n.ports).find((p) => p.id === edge.source.port);
  const manual = !!edits?.routes[id]?.manual;
  const sliceText = userEdge?.slice
    ? userEdge.slice.width === 1
      ? String(userEdge.slice.lo)
      : `${userEdge.slice.lo + userEdge.slice.width - 1}:${userEdge.slice.lo}`
    : '';
  return (
    <div className="inspector" key={id}>
      <h3>Wire</h3>
      <label className="prop">
        <span>Label</span>
        <Field inputRef={nameRef} value={edge.label ?? ''} placeholder="(none)" onCommit={(v) => s.renameItem(id, v.trim())} />
      </label>
      {userEdge && srcPort && srcPort.width > 1 && (
        <label className="prop">
          <span>Bits of the source</span>
          <Field
            value={sliceText}
            placeholder={`all ${srcPort.width} bits`}
            onCommit={(v) => {
              const sl = parseSlice(v, srcPort.width);
              if (sl !== 'bad') s.setEdgeSlice(id, sl && sl.width === srcPort.width ? undefined : sl);
            }}
            check={(v) => (parseSlice(v, srcPort.width) === 'bad' ? `Write hi:lo within 0..${srcPort.width - 1}, e.g. 3:0.` : undefined)}
          />
        </label>
      )}
      <p className="small muted">
        {[
          // A scaled wire says what it brings to its input, as the export writes it.
          `${edge.width} bit${edge.width === 1 ? '' : 's'}${wireShift(edge) ? ` ${scaleNote(wireShift(edge))} (${edge.width + wireShift(edge)} bits)` : ''}`,
          ...(s.issues.flagged.has(id) ? wireTrouble(s.netlist, id) : []),
          ...(s.issues.flagged.has(id) && staleSlices(s.netlist, s.doc.sheets[s.sheet]).some((w) => w.edge === id) ? ['takes bits its source no longer has'] : []),
        ].join(' · ')}
      </p>
      <div className="prop-actions">
        {manual && <button onClick={() => s.setEdgeRoute(id, undefined)}>Route automatically</button>}
        <button className="danger" onClick={() => s.deleteSelection()}>
          Delete
        </button>
      </div>
    </div>
  );
}
