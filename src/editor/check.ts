/**
 * Quick checks of a drawing, shown in the editor only (never in exports):
 * wires whose width does not match the input they feed, inputs fed by two
 * wires, and pins left unconnected.
 */
import type { DEdge, Diagram } from '../core/diagram';
import { ARITHMETIC } from '../core/rules';

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

/** Low zero bits a `×2ⁿ` note on a wire adds (written by the import's "scale" rule, read the same way by the export). */
function scaleBits(label: string | undefined): number {
  const m = label ? /×\s*(\d+)/.exec(label) : null;
  if (!m) return 0;
  const k = Math.log2(Number(m[1]));
  return Number.isInteger(k) && k > 0 && k < 31 ? k : 0;
}

/**
 * Low zero bits a wire appends to what it carries, read as the export reads them: its `shift`
 * when it has one (a rename of the `×4` label does not change it), otherwise its label.
 */
export function wireShift(e: Pick<DEdge, 'shift' | 'label'>): number {
  if (e.shift !== undefined) return Number.isInteger(e.shift) && e.shift > 0 && e.shift < 31 ? e.shift : 0;
  return scaleBits(e.label);
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
  const port = new Map<string, { width: number; node: string; name: string; label: string; cellType?: string; inout: boolean }>();
  for (const n of d.nodes) {
    for (const p of n.ports) {
      port.set(p.id, { width: p.width, node: n.id, name: p.name, label: n.subLabel ?? n.label, cellType: n.cellType, inout: !!p.inout });
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
      if (mismatches++ < 3) messages.push(`A ${width}-bit wire feeds the ${t.width}-bit input ${t.name} of ${t.label || 'a symbol'}.`);
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
  const missing = d.nodes.filter((n) => n.attrs?.missingModule);
  for (const n of missing.slice(0, 3)) messages.push(`Block ${n.subLabel ?? n.id} uses ${n.moduleName}, which no longer exists.`);
  if (missing.length > 3) messages.push(`${missing.length - 3} more blocks of missing modules.`);
  return { flagged, reasons, messages, openPorts };
}
