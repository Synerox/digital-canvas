/**
 * Quick checks of a drawing, shown in the editor only (never in exports):
 * wires whose width does not match the input they feed, inputs fed by two
 * wires, pins left unconnected, and pins the Verilog has to rename.
 */
import type { DEdge, Diagram } from '../core/diagram';
import { moduleTitle } from '../core/names';
import { ARITHMETIC } from '../core/rules';
import { verilogIdent } from './verilog-export';

export interface SheetIssues {
  /** Wires drawn in the warning colour. */
  flagged: Set<string>;
  /**
   * Why each flagged wire is flagged, as the wire panel words it: a width mismatch and a
   * second driver on its input are told apart (a wire can have both).
   */
  reasons?: Map<string, string>;
  messages: string[];
  /** Input ports with no wire (drawn with an open circle while editing). */
  openPorts?: Set<string>;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Low zero bits a wire appends to what it carries (an imported `×4` wire has 2), read as the
 * export reads them: only from its `shift`. Its label is text the user may rename, never logic.
 */
export function wireShift(e: Pick<DEdge, 'shift'>): number {
  return e.shift !== undefined && Number.isInteger(e.shift) && e.shift > 0 && e.shift < 31 ? e.shift : 0;
}

/** The note the import's "scale" rule writes on a wire that appends `shift` zero bits (`×4` for 2). */
export const scaleNote = (shift: number) => `×${2 ** shift}`;

const list = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/**
 * Pins whose names the Verilog export changes to keep its ports apart. diagramToVerilog names the
 * pins first, in drawing order, as verilogIdent of their labels, and writes a name that is already
 * taken as a_2, a_3…: two pins drawn as `a` would be one signal to a reader but two ports there.
 */
function pinNameClashes(d: Diagram): string[] {
  const used = new Set<string>();
  /** Pins by the Verilog name they ask for: their labels, and the names the export writes. */
  const wanted = new Map<string, { labels: string[]; written: string[] }>();
  for (const n of d.nodes) {
    if (n.kind !== 'input' && n.kind !== 'output' && n.kind !== 'inout') continue;
    const ident = verilogIdent(n.label);
    let name = ident;
    for (let i = 2; used.has(name); i++) name = `${ident}_${i}`;
    used.add(name);
    const g = wanted.get(ident) ?? { labels: [], written: [] };
    g.labels.push(n.label.trim());
    g.written.push(name);
    wanted.set(ident, g);
  }
  const out: string[] = [];
  for (const [ident, { labels, written }] of wanted) {
    const renamed = written.filter((w) => w !== ident);
    if (renamed.length === 0) continue;
    const k = labels.length;
    // Only a pin named like another's written name (a_2 next to two pins a) is renamed on its own.
    if (k === 1) {
      out.push(`Another pin is written as ${ident}, so the Verilog calls pin ${labels[0]} ${renamed[0]}.`);
      continue;
    }
    const names = [...new Set(labels)];
    const who = names.length === 1 ? `${k === 2 ? 'Two' : k} pins are named ${names[0]}` : `Pins ${list(names)} have the same Verilog name ${ident}`;
    const which = renamed.length === k ? 'them' : k === 2 ? 'the second' : 'the others';
    out.push(`${who}; the Verilog calls ${which} ${list(renamed)}.`);
  }
  return out;
}

export function checkSheet(d: Diagram): SheetIssues {
  const flagged = new Set<string>();
  const reasons = new Map<string, string>();
  const flag = (id: string, reason: string) => {
    flagged.add(id);
    const had = reasons.get(id);
    reasons.set(id, had ? `${had}, and ${reason}` : reason);
  };
  const messages: string[] = [];
  const port = new Map<string, { width: number; node: string; name: string; label: string; what: string; cellType?: string; inout: boolean }>();
  for (const n of d.nodes) {
    for (const p of n.ports) {
      // Named in words where the drawn label is only a mark: a split reads `}{`, a join `{ }`.
      const what = n.kind === 'split' ? 'a split' : n.kind === 'join' ? 'a concatenation' : n.subLabel ?? (n.label || 'a symbol');
      port.set(p.id, { width: p.width, node: n.id, name: p.name, label: n.subLabel ?? n.label, what, cellType: n.cellType, inout: !!p.inout });
    }
  }
  const into = new Map<string, string[]>();
  for (const e of d.edges) into.set(e.target.port, [...(into.get(e.target.port) ?? []), e.id]);
  const sourceOf = new Map(d.edges.map((e) => [e.id, e.source.port]));

  let mismatches = 0;
  for (const e of d.edges) {
    if (!e.id.startsWith('w:')) continue;
    const t = port.get(e.target.port);
    if (!t) continue;
    const width = e.width + wireShift(e);
    // Arithmetic and compare operands are zero-extended (how Verilog widens them, and how
    // the import's "Hide zero extension" rule draws them), so a narrower wire is fine there.
    const extended = width < t.width && t.cellType !== undefined && ARITHMETIC.has(t.cellType);
    if (t.width !== width && !extended) {
      flag(e.id, 'does not match the input it feeds');
      // A scaled wire is named as it is drawn (2 bits, `×4`), with the width it brings to the input.
      const wire = width === e.width ? `${width}-bit wire` : `${e.width}-bit wire ${scaleNote(wireShift(e))} (${width} bits)`;
      if (mismatches++ < 3) messages.push(`A ${wire} feeds the ${t.width}-bit input ${t.name} of ${t.what}.`);
    }
  }
  if (mismatches > 3) messages.push(`${mismatches - 3} more width mismatches.`);

  // An inout port at the far end of a wire only shares the net; it is not a second driver.
  let doubles = 0;
  for (const [, ids] of into) {
    const drivers = ids.filter((id) => !port.get(sourceOf.get(id)!)?.inout);
    if (drivers.length < 2 || !drivers.some((id) => id.startsWith('w:'))) continue;
    doubles++;
    for (const id of drivers) if (id.startsWith('w:')) flag(id, 'its input has another driver');
  }
  if (doubles) messages.push(`${plural(doubles, 'input')} driven by more than one wire.`);

  // Inouts need no driver: an open one is left unconnected, never tied to a value.
  const openPorts = new Set<string>();
  for (const n of d.nodes) {
    if (n.kind === 'text') continue;
    for (const p of n.ports) if (p.dir === 'in' && !p.inout && n.kind !== 'inout' && !into.has(p.id)) openPorts.add(p.id);
  }
  if (openPorts.size) messages.push(`${plural(openPorts.size, 'input')} not connected.`);
  const clashes = pinNameClashes(d);
  messages.push(...clashes.slice(0, 3));
  if (clashes.length > 3) messages.push(`${clashes.length - 3} more repeated pin names.`);
  const missing = d.nodes.filter((n) => n.attrs?.missingModule);
  for (const n of missing.slice(0, 3)) messages.push(`Block ${n.subLabel ?? n.id} uses ${moduleTitle(n.moduleName ?? '')}, which no longer exists.`);
  if (missing.length > 3) messages.push(`${missing.length - 3} more blocks of missing modules.`);
  return { flagged, reasons, messages, openPorts };
}
