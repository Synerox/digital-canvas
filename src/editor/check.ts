/**
 * Quick checks of a drawing, shown in the editor only (never in exports):
 * wires whose width does not match the input they feed, inputs fed by two
 * wires, and pins left unconnected.
 */
import type { Diagram } from '../core/diagram';

export interface SheetIssues {
  /** Wires drawn in the warning colour. */
  flagged: Set<string>;
  messages: string[];
  /** Input ports with no wire (drawn with an open circle while editing). */
  openPorts?: Set<string>;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function checkSheet(d: Diagram): SheetIssues {
  const flagged = new Set<string>();
  const messages: string[] = [];
  const port = new Map<string, { width: number; node: string; name: string; label: string }>();
  for (const n of d.nodes) for (const p of n.ports) port.set(p.id, { width: p.width, node: n.id, name: p.name, label: n.subLabel ?? n.label });
  const into = new Map<string, string[]>();
  for (const e of d.edges) into.set(e.target.port, [...(into.get(e.target.port) ?? []), e.id]);

  let mismatches = 0;
  for (const e of d.edges) {
    if (!e.id.startsWith('w:')) continue;
    const t = port.get(e.target.port);
    if (t && t.width !== e.width) {
      flagged.add(e.id);
      if (mismatches++ < 3) messages.push(`A ${e.width}-bit wire feeds the ${t.width}-bit input ${t.name} of ${t.label || 'a symbol'}.`);
    }
  }
  if (mismatches > 3) messages.push(`${mismatches - 3} more width mismatches.`);

  let doubles = 0;
  for (const [, ids] of into) {
    if (ids.length < 2 || !ids.some((id) => id.startsWith('w:'))) continue;
    doubles++;
    for (const id of ids) if (id.startsWith('w:')) flagged.add(id);
  }
  if (doubles) messages.push(`${plural(doubles, 'input')} driven by more than one wire.`);

  const openPorts = new Set<string>();
  for (const n of d.nodes) {
    if (n.kind === 'text') continue;
    for (const p of n.ports) if (p.dir === 'in' && !into.has(p.id)) openPorts.add(p.id);
  }
  if (openPorts.size) messages.push(`${plural(openPorts.size, 'input')} not connected.`);
  return { flagged, messages, openPorts };
}
