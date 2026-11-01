/**
 * Properties of the selection (or of the sheet when nothing is selected).
 * Names and parameters apply on Enter or when the field loses focus; every
 * change is one undo step.
 */
import { useEffect, useRef, useState } from 'react';
import type { SrcRange } from '../core/ir';
import { PARAM_LIMITS, SYMBOL_BY_KEY, literalWidth, type ParamName } from '../editor/symbols';
import { isDrawnKey } from '../editor/doc';
import { verilogIdent } from '../editor/verilog-export';
import { useStore } from './store';
import { ui } from './ui-events';

/** A text field that commits on Enter or blur and resets on Escape. */
function Field({
  value,
  onCommit,
  placeholder,
  id,
  inputRef,
  check,
}: {
  value: string;
  onCommit(v: string): void;
  placeholder?: string;
  id?: string;
  inputRef?: React.Ref<HTMLInputElement>;
  check?: (v: string) => string | undefined;
}) {
  const [text, setText] = useState(value);
  const [err, setErr] = useState<string>();
  useEffect(() => {
    setText(value);
    setErr(undefined);
  }, [value]);
  const commit = () => {
    if (text === value) return;
    const problem = check?.(text);
    if (problem) {
      setErr(problem);
      return;
    }
    setErr(undefined);
    onCommit(text);
  };
  return (
    <>
      <input
        id={id}
        ref={inputRef}
        className={err ? 'invalid' : ''}
        value={text}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit();
            (e.target as HTMLInputElement).blur();
          } else if (e.key === 'Escape') {
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

/** The source lines Source highlights for a symbol, each once and in order (an automatic block has many cells, often several per line). */
function srcLines(src: readonly SrcRange[]): number[] {
  const lines = new Set<number>();
  for (const r of src) for (let l = r.startLine; l <= Math.max(r.startLine, r.endLine); l++) lines.add(l);
  return [...lines].sort((a, b) => a - b);
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
      <div className="inspector">
        <h3>{drawn ? 'Drawing' : 'Sheet'}</h3>
        {drawn ? (
          <label className="prop">
            <span>Module name</span>
            <Field
              value={module}
              onCommit={(v) => {
                const err = s.renameDrawing(module, v);
                if (err) s.setNotice(err);
              }}
              check={(v) => {
                const want = v.trim();
                if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(want)) return 'Use letters, digits and _.';
                // A keyword is no legal module name: the export would have to write the module under another one.
                return verilogIdent(want) === want ? undefined : `${want} is a Verilog keyword.`;
              }}
            />
          </label>
        ) : (
          <p className="small muted">
            From Verilog: <b>{module}</b>. Your moves, added symbols and wires, renames and deletions are kept when the Verilog is imported again.
          </p>
        )}
        <p className="small muted">
          {s.layout.nodes.length} symbols, {s.layout.edges.length} wires
        </p>
        {s.issues.messages.length > 0 && (
          <ul className="issues small">
            {s.issues.messages.map((m) => (
              <li key={m}>{m}</li>
            ))}
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
            <button onClick={() => s.convertToDrawing()} title="Copy this sheet into a new drawing that is no longer tied to the Verilog">
              Copy to new drawing
            </button>
          )}
          {hidden > 0 && <button onClick={() => s.restoreHidden()}>Restore {hidden} deleted</button>}
          {drawn && (
            <button
              className="danger"
              onClick={() => {
                if (confirm(`Delete the drawing ${module}? (You can undo this.)`)) s.deleteDrawing(module);
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
        ? `Copied symbol (${node.cellType ?? node.kind})`
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
    const lines = srcLines(node.src);
    return (
      <div className="inspector">
        <h3>{title}</h3>
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
        {node.kind === 'instance' && node.moduleName && (
          <div className="prop-actions">
            <button onClick={() => s.openNode(id)}>Open {node.label}</button>
          </div>
        )}
        <dl className="ports small">
          {node.ports.map((p) => (
            <div key={p.id}>
              <dt>{p.name}</dt>
              <dd>
                {p.dir === 'in' ? 'in' : 'out'} · {p.width} bit{p.width === 1 ? '' : 's'}
              </dd>
            </div>
          ))}
        </dl>
        {lines.length > 0 && (
          <p className="small muted">
            Verilog {lines.length === 1 ? `line ${lines[0]} is` : `lines ${lineList(lines)} are`} highlighted in Source.
          </p>
        )}
        {!user && (
          <p className="small muted">
            Imported from Verilog: change the Verilog to change what it is. You can {renameable ? 'move, rename' : 'move'} or delete it here.
          </p>
        )}
        <div className="prop-actions">
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
    <div className="inspector">
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
        {edge.width} bit{edge.width === 1 ? '' : 's'}
        {s.issues.flagged.has(id) ? ' · does not match the input it feeds' : ''}
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
