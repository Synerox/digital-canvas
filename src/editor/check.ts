/**
 * Quick checks of a drawing, shown in the editor only (never in exports):
 * wires whose width does not match the input they feed, inputs fed by two
 * wires, and pins left unconnected.
 */
import type { Diagram } from '../core/diagram';
import { ARITHMETIC } from '../core/rules';

export interface SheetIssues {
  /** Wires drawn in the warning colour. */
  flagged: Set<string>;
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

export function checkSheet(d: Diagram): SheetIssues {
  const flagged = new Set<string>();
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
    const width = e.width + scaleBits(e.label);
    // Arithmetic and compare operands are zero-extended (how Verilog widens them, and how
    // the import's "Hide zero extension" rule draws them), so a narrower wire is fine there.
    const extended = width < t.width && t.cellType !== undefined && ARITHMETIC.has(t.cellType);
    if (t.width !== width && !extended) {
      flagged.add(e.id);
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
    for (const id of drivers) if (id.startsWith('w:')) flagged.add(id);
  }
  if (doubles) messages.push(`${plural(doubles, 'input')} driven by more than one wire.`);

  // Inouts need no driver: an open one is left unconnected, never tied to a value.
  const openPorts = new Set<string>();
  for (const n of d.nodes) {
    if (n.kind === 'text') continue;
    for (const p of n.ports) if (p.dir === 'in' && !p.inout && n.kind !== 'inout' && !into.has(p.id)) openPorts.add(p.id);
  }
  if (openPorts.size) messages.push(`${plural(openPorts.size, 'input')} not connected.`);
  return { flagged, messages, openPorts };
}
