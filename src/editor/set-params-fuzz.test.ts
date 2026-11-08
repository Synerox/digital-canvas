import { describe, expect, it } from 'vitest';
import { checkSheet } from './check';
import { emptyEdits, type SheetEdits } from './doc';
import { addNodes, connect, effectiveDiagram, newId, resolveConnection, setParams } from './sheet';
import { type InterfaceOf, type SymKey, type SymParams, newUserNode } from './symbols';

/**
 * Random wiring and random changes of slices, widths and inputs (wires hidden and coming back, wires drawn while
 * others are hidden, an inout's wire sharing an input): a change of settings never makes an input that had one
 * driver have two, and drops a stored wire only when its input has a driver after the change.
 */
const iface: InterfaceOf = (m) => (m === 'pad' ? { label: 'pad', ports: [{ name: 'io', dir: 'inout', width: 4 }] } : undefined);

/** xorshift32: the same sequences on every run. */
function random(seed: number) {
  let x = seed >>> 0 || 1;
  return () => ((x ^= x << 13), (x ^= x >>> 17), (x ^= x << 5), (x >>> 0) / 4294967296);
}

const doubles = (e: SheetEdits) => checkSheet(effectiveDiagram('m', undefined, e, iface)).messages.some((m) => m.includes('more than one wire'));

describe('changing settings, at random', () => {
  it('never makes a second driver, and drops a wire only when its input is driven', () => {
    const trouble: string[] = [];
    for (let seed = 1; seed <= 400; seed++) {
      const r = random(seed);
      const pick = <T,>(a: readonly T[]) => a[Math.floor(r() * a.length)];
      let e = emptyEdits();
      const add = (sym: SymKey, params: SymParams) => {
        const [id, e1] = newId(e, 'u');
        const u = newUserNode(id, sym);
        u.params = { ...u.params, ...params };
        e = addNodes(e1, [{ node: u, pos: { x: 0, y: 0 } }]);
        return id;
      };
      const changeable = [
        add('split', { parts: 3, width: 4 }),
        add('split', { parts: 4, width: 2 }),
        add('concat', { parts: 3, width: 4 }),
        add('mux', { inputs: 4, width: 4 }),
        add('and', { inputs: 3, width: 4 }),
      ];
      add('input', { width: 4 });
      add('input', { width: 12 });
      add('output', { width: 4 });
      add('block', { module: 'pad' });
      for (let step = 0; step < 40; step++) {
        if (r() < 0.5) {
          const d = effectiveDiagram('m', undefined, e, iface);
          const ports = d.nodes.flatMap((n) => n.ports.map((p) => ({ kind: 'port' as const, node: n.id, port: p.id })));
          const [a, b] = [pick(ports), pick(ports)];
          const c = a.node === b.node ? undefined : resolveConnection(d, a, b);
          if (c && !('error' in c)) e = connect(e, c)[1];
          continue;
        }
        const id = pick(changeable);
        const n = e.nodes.find((x) => x.id === id)!;
        const p: SymParams = {};
        if (n.sym === 'split' || n.sym === 'concat') {
          if (r() < 0.7) p.parts = 2 + Math.floor(r() * 4);
          if (r() < 0.5) p.width = 1 + Math.floor(r() * 4);
        } else p.inputs = 2 + Math.floor(r() * 4);
        const next = setParams(e, id, p, iface);
        const what = `seed ${seed} step ${step}: ${id} ${JSON.stringify(n.params)} -> ${JSON.stringify(p)}`;
        if (!doubles(e) && doubles(next)) trouble.push(`${what} makes a second driver`);
        const shown = effectiveDiagram('m', undefined, next, iface).edges;
        for (const g of e.edges.filter((x) => !next.edges.some((y) => y.id === x.id))) {
          // Its input is driven after the change (by a wire stored on the same port, which may have a new name).
          const twins = new Set(e.edges.filter((x) => x.target.port === g.target.port).map((x) => x.id));
          if (!shown.some((x) => x.target.port === g.target.port || twins.has(x.id))) trouble.push(`${what} drops ${g.id}`);
        }
        e = next;
      }
    }
    expect(trouble).toEqual([]);
  }, 120_000);
});
