import { describe, expect, it } from 'vitest';
import { approxMeasure, type Point, sizeNode } from '../layout/elk-layout';
import { OUTLINES, type SheetEdits, emptyEdits, parseSavedFile } from './doc';
import { addNodes, connect, effectiveDiagram, fitNewOutlines, fitWider, makeRoom, resolveConnection, setParams } from './sheet';
import { type InterfaceOf, type SymKey, type SymParams, newUserNode } from './symbols';

const size = (width: number, height: number) => ({ width, height });

describe('makeRoom', () => {
  it('puts in a column for a wider symbol: what is right of it moves, routes stretch', () => {
    const e = {
      ...emptyEdits(),
      pos: { a: { x: 0, y: 0 }, b: { x: 0, y: 100 }, c: { x: 150, y: 0 }, d: { x: 50, y: 200 } },
      routes: { w: { points: [{ x: 100, y: 25 }, { x: 125, y: 25 }, { x: 125, y: 10 }, { x: 150, y: 10 }], label: { x: 110, y: 20, width: 10, height: 10 } } },
    };
    const was = new Map([
      ['a', size(100, 50)],
      ['b', size(100, 50)],
      ['c', size(40, 20)],
      ['d', size(40, 20)],
    ]);
    const out = makeRoom(e, was, new Map([['a', size(140, 50)]]));
    // c is right of a's old right edge; b is below a in its column and d starts inside it: they stay.
    expect(out.pos).toEqual({ a: { x: 0, y: 0 }, b: { x: 0, y: 100 }, c: { x: 190, y: 0 }, d: { x: 50, y: 200 } });
    // The wire leaves a's right edge (now 40 further) and keeps its shape.
    expect(out.routes.w.points).toEqual([
      { x: 140, y: 25 },
      { x: 165, y: 25 },
      { x: 165, y: 10 },
      { x: 190, y: 10 },
    ]);
    expect(out.routes.w.label).toEqual({ x: 150, y: 20, width: 10, height: 10 });
    // Nothing grew: the same edits.
    expect(makeRoom(e, was, new Map([['a', size(100, 50)]]))).toBe(e);
  });

  it('grows a taller symbol upwards when there is room, else downwards, with a row put in at its old bottom', () => {
    const e = {
      ...emptyEdits(),
      pos: { top: { x: 0, y: -40 }, a: { x: 0, y: 0 }, b: { x: 0, y: 60 }, side: { x: 300, y: 60 }, free: { x: 300, y: -200 } },
      routes: {
        // Between a and b.
        under: { points: [{ x: -50, y: 55 }, { x: 50, y: 55 }] },
        // Beside the column.
        beside: { points: [{ x: 200, y: 55 }, { x: 250, y: 55 }] },
        // Right above free: under it once it is taller.
        over: { points: [{ x: 280, y: -210 }, { x: 420, y: -210 }] },
      },
    };
    const was = new Map([
      ['top', size(100, 30)],
      ['a', size(100, 50)],
      ['b', size(100, 50)],
      ['side', size(100, 50)],
      ['free', size(100, 50)],
    ]);
    const out = makeRoom(e, was, new Map([['a', size(100, 70)], ['free', size(100, 70)]]));
    // free has room above it: its pins stay where they were.
    expect(out.pos.free).toEqual({ x: 300, y: -220 });
    // top is right above a: a grows down, and what is below it moves down as far, in its column or not.
    expect(out.pos.a).toEqual({ x: 0, y: 0 });
    expect(out.pos.b).toEqual({ x: 0, y: 80 });
    expect(out.pos.side).toEqual({ x: 300, y: 80 });
    // The wire that free covers now is routed again. The others move down with the row: the one between a and b still
    // runs between them.
    expect(Object.keys(out.routes)).toEqual(['under', 'beside']);
    expect(out.routes.under.points).toEqual([
      { x: -50, y: 75 },
      { x: 50, y: 75 },
    ]);
    expect(out.routes.beside.points).toEqual([
      { x: 200, y: 75 },
      { x: 250, y: 75 },
    ]);
  });

  it('moves what is below a symbol that grows downwards clear of what is beside it, routes and all', () => {
    // x is just under a, and y under x but left of a's column; the wire runs between them.
    const e = {
      ...emptyEdits(),
      pos: { top: { x: 0, y: -40 }, a: { x: 0, y: 0 }, x: { x: -30, y: 60 }, y: { x: -60, y: 90 } },
      routes: {
        other: { points: [{ x: -100, y: 85 }, { x: 5, y: 85 }], label: { x: -90, y: 75, width: 10, height: 10 } },
        up: { points: [{ x: -80, y: 85 }, { x: -80, y: 20 }] },
      },
    };
    const was = new Map([
      ['top', size(100, 30)],
      ['a', size(100, 50)],
      ['x', size(40, 20)],
      ['y', size(40, 20)],
    ]);
    const out = makeRoom(e, was, new Map([['a', size(100, 70)]]));
    // a cannot grow up (top is there): x and y both move down as far, so x does not land on y.
    expect(out.pos).toEqual({ top: { x: 0, y: -40 }, a: { x: 0, y: 0 }, x: { x: -30, y: 80 }, y: { x: -60, y: 110 } });
    // Wires keep their shapes: what is below a's old bottom moves down as far (one keeps running between x and y), and
    // a leg that crosses it grows.
    expect(out.routes.other.points).toEqual([
      { x: -100, y: 105 },
      { x: 5, y: 105 },
    ]);
    expect(out.routes.other.label).toEqual({ x: -90, y: 95, width: 10, height: 10 });
    expect(out.routes.up.points).toEqual([
      { x: -80, y: 105 },
      { x: -80, y: 20 },
    ]);
  });

  it('moves what starts close beside a symbol that grows downwards down with its pins', () => {
    // logic is right above a, so a grows downwards and its pins move down 20. tens starts 8 right of a, below a's
    // output pin (y 40): moved down that far, the pin would face it and its wire would run through tens.
    const e = (tensX: number) => ({
      ...emptyEdits(),
      pos: { logic: { x: 0, y: -60 }, a: { x: 0, y: 0 }, tens: { x: tensX, y: 50 }, far: { x: 400, y: 40 }, below: { x: 0, y: 120 } },
      routes: { out: { points: [{ x: tensX + 40, y: 80 }, { x: 300, y: 80 }] } },
    });
    const was = new Map([
      ['logic', size(100, 50)],
      ['a', size(100, 90)],
      ['tens', size(40, 60)],
      ['far', size(40, 60)],
      ['below', size(100, 20)],
    ]);
    const grow = new Map([['a', size(100, 110)]]);
    const close = makeRoom(e(108), was, grow);
    // tens moves down with a's pins, and so does everything below its top; what is further away stays.
    expect(close.pos).toEqual({ logic: { x: 0, y: -60 }, a: { x: 0, y: 0 }, tens: { x: 108, y: 70 }, far: { x: 400, y: 40 }, below: { x: 0, y: 140 } });
    expect(close.routes.out.points).toEqual([
      { x: 148, y: 100 },
      { x: 300, y: 100 },
    ]);
    // Two grid steps away there is room for the stubs: only what is below a's old bottom moves.
    const roomy = makeRoom(e(120), was, grow);
    expect(roomy.pos).toEqual({ logic: { x: 0, y: -60 }, a: { x: 0, y: 0 }, tens: { x: 120, y: 50 }, far: { x: 400, y: 40 }, below: { x: 0, y: 140 } });
    expect(roomy.routes.out.points).toEqual([
      { x: 160, y: 80 },
      { x: 300, y: 80 },
    ]);
  });

  it('grows a symbol downwards when a pin beside the band above it has no room for its stub', () => {
    const was = new Map([
      ['a', size(100, 90)],
      ['pin', size(40, 20)],
    ]);
    const grow = new Map([['a', size(100, 110)]]);
    // The pin's right edge is one grid step left of a, its middle 12 above a's top: its wire would start inside a grown upwards.
    const tight = makeRoom({ ...emptyEdits(), pos: { a: { x: 0, y: 0 }, pin: { x: -50, y: -22 } } }, was, grow);
    expect(tight.pos).toEqual({ a: { x: 0, y: 0 }, pin: { x: -50, y: -22 } });
    // Two grid steps away there is room for the stub: a grows upwards, its pins stay where they are.
    const roomy = makeRoom({ ...emptyEdits(), pos: { a: { x: 0, y: 0 }, pin: { x: -60, y: -22 } } }, was, grow);
    expect(roomy.pos).toEqual({ a: { x: 0, y: -20 }, pin: { x: -60, y: -22 } });
    // Beside a, below the band it grows into, a pin is as close to it either way: a grows upwards.
    const below = makeRoom({ ...emptyEdits(), pos: { a: { x: 0, y: 0 }, pin: { x: -50, y: 30 } } }, was, grow);
    expect(below.pos).toEqual({ a: { x: 0, y: -20 }, pin: { x: -50, y: 30 } });
  });
});

describe('fitNewOutlines', () => {
  const none: InterfaceOf = () => undefined;
  /** A drawing saved with the old outlines: symbols at these corners, wires with these saved routes. */
  const sheet = (items: [string, SymKey, number, number, SymParams?][], routes: Record<string, Point[]> = {}, outlines = 1) => {
    let e = addNodes(
      emptyEdits(),
      items.map(([id, sym, x, y, params]) => {
        const node = newUserNode(id, sym);
        return { node: params ? { ...node, params: { ...node.params, ...params } } : node, pos: { x, y } };
      }),
    );
    for (const k of Object.keys(routes)) {
      const [from, to] = k.split('>');
      const d = effectiveDiagram('m', undefined, e, none);
      const c = resolveConnection(d, { kind: 'port', node: from.split('.')[0], port: from }, { kind: 'port', node: to.split('.')[0], port: to });
      if ('error' in c) throw new Error(c.error);
      let id: string;
      [id, e] = connect(e, c);
      e = { ...e, routes: { ...e.routes, [id]: { points: routes[k] } } };
    }
    return { ...e, oldOutlines: outlines };
  };
  const boxes = (e: SheetEdits) => {
    const d = effectiveDiagram('m', undefined, e, none);
    return d.nodes.map((n) => ({ id: n.id, ...e.pos[n.id], ...sizeNode(n, approxMeasure) }));
  };
  /** Pairs of symbols that overlap or touch. */
  const touchingBoxes = (e: SheetEdits) => {
    const list = boxes(e);
    const out: string[] = [];
    for (const a of list) for (const b of list) if (a.id < b.id && a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height) out.push(`${a.id}/${b.id}`);
    return out;
  };

  it('makes room under an adder that grew, and over it when that is free', () => {
    // An inverter 10 px under the old 40x40 adder; nothing over it: the adder grows up, the inverter stays.
    const up = sheet([
      ['u:1', 'add', 200, 100],
      ['u:2', 'not', 200, 150],
    ]);
    const a = fitNewOutlines(up, effectiveDiagram('m', undefined, up, none), approxMeasure);
    expect(a.pos).toEqual({ 'u:1': { x: 200, y: 80 }, 'u:2': { x: 200, y: 150 } });
    expect(a.oldOutlines).toBeUndefined();
    expect(touchingBoxes(a)).toEqual([]);
    // Another inverter right over it: the adder grows down, and what is under it moves down as far.
    const down = sheet([
      ['u:1', 'add', 200, 100],
      ['u:2', 'not', 200, 150],
      ['u:3', 'not', 200, 50],
    ]);
    const b = fitNewOutlines(down, effectiveDiagram('m', undefined, down, none), approxMeasure);
    expect(b.pos).toEqual({ 'u:1': { x: 200, y: 100 }, 'u:2': { x: 200, y: 170 }, 'u:3': { x: 200, y: 50 } });
    expect(touchingBoxes(b)).toEqual([]);
    // Wires of other nets: one 10 px under the old adder moves down with what is under it; one over it, where
    // the adder grows up into, is dropped (to be routed again); one well clear of it stays.
    const wires = {
      'u:2.Y>u:3.A': [{ x: 240, y: 170 }, { x: 260, y: 170 }, { x: 260, y: 150 }, { x: 180, y: 150 }, { x: 180, y: 70 }, { x: 200, y: 70 }],
    };
    const near = sheet(
      [
        ['u:1', 'add', 200, 100],
        ['u:2', 'not', 200, 160],
        ['u:3', 'not', 200, 50],
        ['u:4', 'input', 0, 300],
        ['u:5', 'output', 400, 300],
      ],
      { ...wires, 'u:4.out>u:5.in': [{ x: 40, y: 310 }, { x: 400, y: 310 }] },
    );
    const c = fitNewOutlines(near, effectiveDiagram('m', undefined, near, none), approxMeasure);
    const [w1, w2] = Object.keys(near.routes);
    expect(c.routes[w1].points.map((p) => p.y)).toEqual([190, 190, 170, 170, 70, 70]);
    expect(c.routes[w2].points.map((p) => p.y)).toEqual([330, 330]);
    const over = sheet(
      [
        ['u:1', 'add', 200, 100],
        ['u:2', 'not', 300, 80],
        ['u:3', 'not', 100, 80],
      ],
      { 'u:3.Y>u:2.A': [{ x: 140, y: 100 }, { x: 160, y: 100 }, { x: 160, y: 90 }, { x: 280, y: 90 }, { x: 280, y: 100 }, { x: 300, y: 100 }] },
    );
    const o = fitNewOutlines(over, effectiveDiagram('m', undefined, over, none), approxMeasure);
    expect(o.pos['u:1']).toEqual({ x: 200, y: 80 });
    expect(Object.keys(o.routes)).toEqual([]);
  });

  it('makes room right of a gate with more inputs that got wider, moving the wires there along', () => {
    // A 4-input AND (40 wide then, 60 now) 20 px left of an inverter; a wire of another net ran down between them.
    const e = sheet(
      [
        ['u:1', 'and', 200, 100, { inputs: 4 }],
        ['u:2', 'not', 260, 120],
        ['u:3', 'input', 0, 300],
        ['u:4', 'output', 400, 300],
      ],
      { 'u:3.out>u:4.in': [{ x: 40, y: 310 }, { x: 250, y: 310 }, { x: 250, y: 90 }, { x: 380, y: 90 }, { x: 380, y: 310 }, { x: 400, y: 310 }] },
    );
    const out = fitNewOutlines(e, effectiveDiagram('m', undefined, e, none), approxMeasure);
    expect(out.pos['u:1']).toEqual({ x: 200, y: 100 });
    // Everything right of the gate's old right edge moved 20 px right, the wire's points there too.
    expect(out.pos['u:2']).toEqual({ x: 280, y: 120 });
    expect(out.pos['u:4']).toEqual({ x: 420, y: 300 });
    expect(touchingBoxes(out)).toEqual([]);
    const [w] = Object.keys(e.routes);
    expect(out.routes[w].points.map((p) => p.x)).toEqual([40, 270, 270, 400, 400, 420]);
  });

  it('gives a reduction gate saved with the outlines of version 2 its lead, and leaves what had its size then', () => {
    // A reduce OR of 8 bits (40 wide then, 50 now) and a 4-input AND (60 wide since version 2), inverters right of each.
    const e = sheet(
      [
        ['u:1', 'or', 200, 100, { mode: 'reduce', width: 8 }],
        ['u:2', 'not', 260, 100],
        ['u:3', 'and', 200, 300, { inputs: 4 }],
        ['u:4', 'not', 280, 310],
      ],
      {},
      2,
    );
    const out = fitNewOutlines(e, effectiveDiagram('m', undefined, e, none), approxMeasure);
    // Everything right of the gate's old right edge moves 10 px right (as a wider gate's neighbours do).
    expect(out.pos).toEqual({ 'u:1': { x: 200, y: 100 }, 'u:2': { x: 270, y: 100 }, 'u:3': { x: 200, y: 300 }, 'u:4': { x: 290, y: 310 } });
    expect(touchingBoxes(out)).toEqual([]);
    expect(out.oldOutlines).toBeUndefined();
    // Saved before version 2, the AND grew too.
    expect(fitNewOutlines({ ...e, oldOutlines: 1 }, effectiveDiagram('m', undefined, e, none), approxMeasure).pos['u:4']).toEqual({ x: 300, y: 310 });
  });

  it('changes nothing but the mark where no symbol grew', () => {
    // A MUX got narrower: nothing moves for it.
    const e = sheet([
      ['u:1', 'mux', 200, 100],
      ['u:2', 'not', 280, 110],
    ]);
    const out = fitNewOutlines(e, effectiveDiagram('m', undefined, e, none), approxMeasure);
    expect(out.pos).toEqual(e.pos);
    expect(out.routes).toEqual(e.routes);
    expect(out.oldOutlines).toBeUndefined();
  });

  it('grows an adder down, not up into where a block whose pins are not known yet may reach', () => {
    const e = sheet([
      ['u:1', 'block', 200, 0, { module: 'alu8' }],
      ['u:2', 'add', 200, 140],
    ]);
    // A block of a module with one pin is drawn as tall as one whose module is not loaded (no pins): over that
    // block, the band the adder grows up into is free.
    const one: InterfaceOf = (m) => (m === 'alu8' ? { label: m, ports: [{ name: 'a', dir: 'input', width: 1 }] } : undefined);
    const known = effectiveDiagram('m', undefined, e, one);
    const missing = effectiveDiagram('m', undefined, e, none);
    const block = (d: typeof known) => sizeNode(d.nodes.find((n) => n.id === 'u:1')!, approxMeasure);
    expect(missing.nodes.find((n) => n.id === 'u:1')!.attrs?.missingModule).toBe(true);
    expect(block(missing).height).toBe(block(known).height);
    expect(fitNewOutlines(e, known, approxMeasure).pos['u:2']).toEqual({ x: 200, y: 120 });
    // Once its Verilog loads, the block may have more pins and reach further down: the adder grows down.
    const out = fitNewOutlines(e, missing, approxMeasure);
    expect(out.pos).toEqual(e.pos);
    expect(out.oldOutlines).toBeUndefined();
  });
});

describe('fitWider', () => {
  const none: InterfaceOf = () => undefined;
  /** A drawing: symbols at these corners, wires with these saved routes (drawn by the user when `manual`). */
  const sheet = (items: [string, SymKey, number, number, SymParams?][], routes: Record<string, Point[]> = {}, manual = false) => {
    let e = addNodes(
      emptyEdits(),
      items.map(([id, sym, x, y, params]) => {
        const node = newUserNode(id, sym);
        return { node: params ? { ...node, params: { ...node.params, ...params } } : node, pos: { x, y } };
      }),
    );
    for (const k of Object.keys(routes)) {
      const [from, to] = k.split('>');
      const d = effectiveDiagram('m', undefined, e, none);
      const c = resolveConnection(d, { kind: 'port', node: from.split('.')[0], port: from }, { kind: 'port', node: to.split('.')[0], port: to });
      if ('error' in c) throw new Error(c.error);
      let id: string;
      [id, e] = connect(e, c);
      e = { ...e, routes: { ...e.routes, [id]: { points: routes[k], ...(manual ? { manual: true } : {}) } } };
    }
    return e;
  };
  const OR8 = { inputs: 2, width: 8, mode: 'bitwise' } as const;
  /** Switch these gates to Reduce (40 wide then, 50 now) and make room. */
  const reduce = (e: SheetEdits, ids: string[], iface: InterfaceOf = none) => {
    const next = ids.reduce((acc, id) => setParams(acc, id, { mode: 'reduce' }), e);
    return fitWider(next, effectiveDiagram('m', undefined, next, iface), new Map(ids.map((id) => [id, { width: 40, height: 40 }])), approxMeasure);
  };

  it('grows into free room: nothing moves; its own wires start at its edge, or are routed again', () => {
    const e = sheet(
      [
        ['u:1', 'or', 100, 100, OR8],
        ['u:2', 'not', 300, 40],
        ['u:3', 'not', 300, 300],
      ],
      { 'u:1.Y>u:2.A': [{ x: 140, y: 120 }, { x: 260, y: 120 }, { x: 260, y: 60 }, { x: 300, y: 60 }] },
    );
    const [w] = Object.keys(e.routes);
    const out = reduce(e, ['u:1']);
    expect(out.pos).toEqual(e.pos);
    expect(out.routes[w].points).toEqual([{ x: 150, y: 120 }, { x: 260, y: 120 }, { x: 260, y: 60 }, { x: 300, y: 60 }]);
    // As the router leaves a pin (two grid steps, then a bend), through the band it grows into: routed again.
    const bent = sheet(
      [
        ['u:1', 'or', 100, 100, OR8],
        ['u:2', 'not', 300, 40],
      ],
      { 'u:1.Y>u:2.A': [{ x: 140, y: 120 }, { x: 160, y: 120 }, { x: 160, y: 60 }, { x: 300, y: 60 }] },
    );
    const again = reduce(bent, ['u:1']);
    expect(again.pos).toEqual(bent.pos);
    expect(again.routes).toEqual({});
    // Drawn so by the user: kept, so there is no room; what is right of the gate moves.
    const drawn = sheet(
      [
        ['u:1', 'or', 100, 100, OR8],
        ['u:2', 'not', 300, 40],
      ],
      { 'u:1.Y>u:2.A': [{ x: 140, y: 120 }, { x: 160, y: 120 }, { x: 160, y: 60 }, { x: 300, y: 60 }] },
      true,
    );
    const pushed = reduce(drawn, ['u:1']);
    expect(pushed.pos['u:2']).toEqual({ x: 310, y: 40 });
    expect(pushed.routes[Object.keys(drawn.routes)[0]].points.map((p) => p.x)).toEqual([150, 170, 170, 310]);
  });

  it('pushes when a symbol is close, or a block whose pins are not known yet may reach there', () => {
    const near = sheet([
      ['u:1', 'or', 100, 100, OR8],
      ['u:2', 'not', 160, 100],
      ['u:3', 'not', 300, 300],
    ]);
    expect(reduce(near, ['u:1']).pos).toMatchObject({ 'u:2': { x: 170, y: 100 }, 'u:3': { x: 310, y: 300 } });
    // A block of a module not loaded (or that failed) is drawn small; it may be taller once it loads.
    const block = sheet([
      ['u:1', 'block', 150, 20, { module: 'alu8' }],
      ['u:2', 'or', 100, 100, OR8],
    ]);
    expect(effectiveDiagram('m', undefined, block, none).nodes.find((n) => n.id === 'u:1')!.attrs?.missingModule).toBe(true);
    expect(reduce(block, ['u:2']).pos['u:1']).toEqual({ x: 160, y: 20 });
    // One left of the gate would not move with a push either: it changes nothing.
    const far = sheet([
      ['u:1', 'block', 0, 0, { module: 'gone' }],
      ['u:2', 'or', 600, 600, OR8],
      ['u:3', 'not', 900, 900],
    ]);
    expect(reduce(far, ['u:2']).pos).toEqual(far.pos);
  });

  it('places a wire label in the band again, and leaves wires not drawn now as they are', () => {
    // A straight wire drawn by the user, its label where the gate grows: the label goes, the wire is shortened.
    const labelled = sheet(
      [
        ['u:1', 'or', 100, 100, OR8],
        ['u:2', 'not', 220, 100],
      ],
      { 'u:1.Y>u:2.A': [{ x: 140, y: 120 }, { x: 220, y: 120 }] },
      true,
    );
    const [w] = Object.keys(labelled.routes);
    const withLabel = { ...labelled, routes: { [w]: { ...labelled.routes[w], label: { x: 145, y: 104, width: 40, height: 14 } } } };
    const out = reduce(withLabel, ['u:1']);
    expect(out.pos).toEqual(labelled.pos);
    expect(out.routes[w]).toEqual({ points: [{ x: 150, y: 120 }, { x: 220, y: 120 }], manual: true });
    // A wire into the B input of a gate switched to Reduce is not drawn (it comes back with its pin): it is no reason
    // to push, and its route is kept for when it comes back.
    const hidden = setParams(
      sheet(
        [
          ['u:1', 'or', 100, 100, OR8],
          ['u:2', 'or', 220, 100, OR8],
        ],
        { 'u:1.Y>u:2.B': [{ x: 140, y: 120 }, { x: 200, y: 120 }, { x: 200, y: 130 }, { x: 220, y: 130 }] },
        true,
      ),
      'u:2',
      { mode: 'reduce' },
    );
    expect(effectiveDiagram('m', undefined, hidden, none).edges).toEqual([]);
    const kept = reduce(hidden, ['u:1']);
    expect(kept.pos).toEqual(hidden.pos);
    expect(kept.routes).toEqual(hidden.routes);
  });

  it('moves the rest as one column when any of the gates has no room, so wires keep their shapes', () => {
    // Two gates of a preset, one under the other: the lower one has an inverter close by.
    const e = sheet(
      [
        ['u:1', 'or', 100, 100, OR8],
        ['u:2', 'or', 100, 200, OR8],
        ['u:3', 'not', 300, 40],
        ['u:4', 'not', 160, 200],
      ],
      { 'u:1.Y>u:3.A': [{ x: 140, y: 120 }, { x: 260, y: 120 }, { x: 260, y: 60 }, { x: 300, y: 60 }] },
    );
    const out = reduce(e, ['u:1', 'u:2']);
    expect(out.pos).toMatchObject({ 'u:1': { x: 100, y: 100 }, 'u:2': { x: 100, y: 200 }, 'u:3': { x: 310, y: 40 }, 'u:4': { x: 170, y: 200 } });
    expect(out.routes[Object.keys(e.routes)[0]].points).toEqual([{ x: 150, y: 120 }, { x: 270, y: 120 }, { x: 270, y: 60 }, { x: 310, y: 60 }]);
  });

  it('pushes as before for a gate that is also taller (its output pin moves down)', () => {
    const e = sheet(
      [
        ['u:1', 'and', 100, 100],
        ['u:2', 'not', 220, 100],
      ],
      { 'u:1.Y>u:2.A': [{ x: 140, y: 120 }, { x: 220, y: 120 }] },
      true,
    );
    const next = setParams(e, 'u:1', { inputs: 3 });
    const out = fitWider(next, effectiveDiagram('m', undefined, next, none), new Map([['u:1', { width: 40, height: 40 }]]), approxMeasure);
    expect(out.pos['u:2']).toEqual({ x: 230, y: 100 });
  });
});

describe('outline version in saved files', () => {
  const file = (outlines: number | undefined, sheets: Record<string, unknown>) =>
    JSON.stringify({ format: 'digital-canvas', version: 1, ...(outlines === undefined ? {} : { outlines }), doc: { sheets, drawn: ['d'] } });
  const pinned = { pos: { 'u:1': { x: 0, y: 0 } }, nodes: [{ id: 'u:1', sym: 'add', params: { width: 4 } }] };

  it('marks the pinned sheets of a file saved before, and keeps the mark of a sheet not drawn since', () => {
    const old = parseSavedFile(file(undefined, { 'd:d': pinned, 'v:blocks:top': { labels: { a: 'b' } } })).doc.sheets;
    expect(old['d:d'].oldOutlines).toBe(1);
    // A sheet ELK lays out each time has no positions saved: nothing to move.
    expect(old['v:blocks:top'].oldOutlines).toBeUndefined();
    expect(parseSavedFile(file(OUTLINES, { 'd:d': pinned })).doc.sheets['d:d'].oldOutlines).toBeUndefined();
    // Marked `true` by a version before 3 (older than version 2 then), or by the version.
    expect(parseSavedFile(file(OUTLINES, { 'd:d': { ...pinned, oldOutlines: true } })).doc.sheets['d:d'].oldOutlines).toBe(1);
    expect(parseSavedFile(file(OUTLINES, { 'd:d': { ...pinned, oldOutlines: 2 } })).doc.sheets['d:d'].oldOutlines).toBe(2);
    expect(parseSavedFile(file(2, { 'd:d': { ...pinned, oldOutlines: true } })).doc.sheets['d:d'].oldOutlines).toBe(1);
    expect(parseSavedFile(file(2, { 'd:d': pinned })).doc.sheets['d:d'].oldOutlines).toBe(2);
  });
});
