/**
 * IDs of the MUXes of case and if statements. What is saved for one (its place, the wires drawn from
 * it, its hidden or moved constants) must stay with that table when the code around it changes.
 */
import { describe, expect, it } from 'vitest';
import { buildDiagram } from './diagram';
import { type IRDesign, formatConst } from './ir';
import { design } from './test-utils';

const T = 60_000;

/** The ID of the one case MUX that has this constant in its table (as its default or one of its cases). */
function muxWith(d: IRDesign, module: string, value: string): string {
  const found = d.modules[module].cells.filter((c) => {
    if (c.type !== '$pmux' && c.type !== '$mux') return false;
    const w = c.connections.Y.length;
    const cases = Array.from({ length: c.connections.B.length / w }, (_, k) => c.connections.B.slice(k * w, (k + 1) * w));
    return [c.connections.A, ...cases].some((x) => x.every((b) => typeof b !== 'number') && formatConst(x) === value);
  });
  expect(found).toHaveLength(1);
  return found[0].id;
}

const consts = (d: IRDesign, module: string) =>
  new Map(buildDiagram(d, module).nodes.filter((n) => n.kind === 'const').map((n) => [n.id, n.label]));

/** The case MUXes that are told apart only by Yosys' cell order. */
const numbered = (d: IRDesign, module: string) =>
  d.modules[module].cells.filter((c) => (c.type === '$pmux' || c.type === '$mux') && c.id.includes('#')).map((c) => c.id);

async function designs(files: Record<string, string>[]): Promise<IRDesign[]> {
  const out: IRDesign[] = [];
  for (const f of files) out.push(await design(f));
  return out;
}

describe('IDs of nested case MUXes', () => {
  const comb = (item0: string) => ({
    'ctrl.v': `module ctrl(input [1:0] mode, input [1:0] sel, output reg [3:0] y);
  always @*
    case (mode)
      2'd0: ${item0}
      2'd1: case (sel) 2'd0: y = 4'd5; 2'd1: y = 4'd6; default: y = 4'd7; endcase
      2'd2: case (sel) 2'd0: y = 4'd9; 2'd1: y = 4'd10; default: y = 4'd11; endcase
      default: y = 4'd15;
    endcase
endmodule
`,
  });

  it('keeps the tables of a combinational block on their IDs when an earlier item gets or loses an if or a case', async () => {
    // Yosys numbers the wires of nested cases (`$2\y`, `$3\y`) by the statements before them: they used to
    // name the tables, so an if added to item 0 gave the 9/10/11 table's ID (and its wires) to the 5/6/7 one.
    const versions = await designs([
      comb("y = 4'd0;"),
      comb("if (sel == 2'd3) y = 4'd8; else y = 4'd0;"),
      comb("case (sel) 2'd0: y = 4'd12; 2'd1: y = 4'd13; default: y = 4'd14; endcase"),
      comb("y = 4'd0;"),
    ]);
    for (const d of versions) {
      expect(muxWith(d, 'ctrl', "4'd7")).toBe("$pmux{case sel>mode==2'd1>Y=y}");
      expect(muxWith(d, 'ctrl', "4'd11")).toBe("$pmux{case sel>mode==2'd2>Y=y}");
      const c = consts(d, 'ctrl');
      expect(c.get("const:cell:$pmux{case sel>mode==2'd1>Y=y}.B[2'd0]")).toBe("4'd5");
      expect(c.get("const:cell:$pmux{case sel>mode==2'd2>Y=y}.B[2'd0]")).toBe("4'd9");
      expect(numbered(d, 'ctrl')).toEqual([]);
    }
    expect(muxWith(versions[2], 'ctrl', "4'd14")).toBe("$pmux{case sel>mode==2'd0>Y=y}");
  }, T);

  const clocked = (items: string[]) => ({
    'ctrl.v': `module ctrl(input clk, rst, input [1:0] mode, input [1:0] sel, output reg [3:0] y);
  always @(posedge clk)
    if (rst) y <= 4'd0;
    else case (mode)
${items.map((x) => `      ${x}\n`).join('')}    endcase
endmodule
`,
  });
  const table = (mode: number, v: number) =>
    `2'd${mode}: case (sel) 2'd0: y <= 4'd${v}; 2'd1: y <= 4'd${v + 1}; default: y <= 4'd${v + 2}; endcase`;

  it('tells the sibling tables of a clocked block apart by their item, not by Yosys cell order', async () => {
    // They used to share one path ID told apart by #n in Yosys' order, so a table added for mode 3 took
    // the #2 of the mode-2 table, and with it the wire a student had drawn from that MUX.
    const [regC, regE, regB] = await designs([
      clocked([table(0, 1), table(1, 5), table(2, 9), 'default: y <= y;']),
      clocked([table(0, 1), table(1, 5), table(2, 9), table(3, 12)]),
      clocked(["2'd0: y <= 4'd1;", table(1, 5), table(2, 9), 'default: y <= y;']),
    ]);
    for (const d of [regC, regE, regB]) {
      expect(muxWith(d, 'ctrl', "4'd7")).toBe("$pmux{case sel>mode==2'd1>!rst>Y=$0\\y}");
      expect(muxWith(d, 'ctrl', "4'd11")).toBe("$pmux{case sel>mode==2'd2>!rst>Y=$0\\y}");
      expect(consts(d, 'ctrl').get("const:cell:$pmux{case sel>mode==2'd2>!rst>Y=$0\\y}.B[2'd0]")).toBe("4'd9");
      expect(numbered(d, 'ctrl')).toEqual([]);
    }
    expect(muxWith(regC, 'ctrl', "4'd3")).toBe("$pmux{case sel>mode==2'd0>!rst>Y=$0\\y}");
    expect(muxWith(regE, 'ctrl', "4'd14")).toBe("$pmux{case sel>mode==2'd3>!rst>Y=$0\\y}");
  }, T);

  it('keeps the MUX and constant IDs of a nested table when one of its values changes', async () => {
    const [before, after] = await designs([
      clocked([table(0, 1), table(1, 5), table(2, 9)]),
      clocked([table(0, 1), table(1, 5), table(2, 9).replace("4'd10", "4'd8")]),
    ]);
    const ids = (d: IRDesign) => d.modules.ctrl.cells.map((c) => c.id).sort();
    expect(ids(after)).toEqual(ids(before));
    const id = "const:cell:$pmux{case sel>mode==2'd2>!rst>Y=$0\\y}.B[2'd1]";
    expect(consts(before, 'ctrl').get(id)).toBe("4'd10");
    expect(consts(after, 'ctrl').get(id)).toBe("4'd8");
    expect([...consts(after, 'ctrl').keys()].sort()).toEqual([...consts(before, 'ctrl').keys()].sort());
  }, T);

  const block = (clock: boolean, statements: string[]) => ({
    't.v': `module t(input clk, input [1:0] a, b, c, s, output reg [3:0] y);
  always ${clock ? '@(posedge clk)' : '@*'} begin
${clock ? '' : "    y = 4'd0;\n"}${statements.map((x) => `    ${x.replace(/ = /g, clock ? ' <= ' : ' = ')}\n`).join('')}  end
endmodule
`,
  });
  const flat = (sel: string, v: number) => `case (${sel}) 2'd0: y = 4'd${v}; 2'd1: y = 4'd${v + 1}; endcase`;
  const nested = (sel: string, v: number) =>
    `case (${sel}) 2'd1: case (s) 2'd0: y = 4'd${v}; 2'd1: y = 4'd${v + 1}; default: y = 4'd${v + 2}; endcase endcase`;

  it('keeps the ID of a case statement when one before or after it in the block is added or removed', async () => {
    // A statement's value goes on through the later ones that assign the same signal; it is named by what it
    // selects on, `case b`, not by how many statements come before (Yosys' `$1\y`) or after it.
    for (const clock of [false, true]) {
      const end = clock ? 'Y=$0\\y' : 'Y=y';
      for (const d of await designs([
        block(clock, [flat('a', 1), flat('b', 3), flat('c', 5)]),
        block(clock, [flat('b', 3), flat('c', 5)]),
      ])) {
        expect(muxWith(d, 't', "4'd3")).toBe(`$pmux{case b>${end}}`);
      }
      const inner = await designs([
        block(clock, [nested('a', 1), nested('b', 4)]),
        block(clock, [nested('a', 1), nested('b', 4), nested('c', 7)]),
        block(clock, [nested('b', 4), nested('c', 7)]),
      ]);
      const ids = inner.map((d) => muxWith(d, 't', "4'd6"));
      expect(ids[0]).toMatch(/^\$pmux\{case s>b==2'd1>Y=/);
      expect(ids).toEqual([ids[0], ids[0], ids[0]]);
      expect(muxWith(inner[1], 't', "4'd3")).not.toBe(ids[0]);
      for (const d of inner) expect(numbered(d, 't')).toEqual([]);
    }
  }, T);
});

/**
 * The values of the cases of each MUX of an if or case statement by its ID (`4'd5/4'd6`, `*` for one that is not a
 * constant). What a MUX keeps when it selects nothing is left out: it is the value an earlier statement gives.
 */
function tables(d: IRDesign, module: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of d.modules[module].cells) {
    if ((c.type !== '$pmux' && c.type !== '$mux') || !c.name.startsWith('$procmux$')) continue;
    const w = c.connections.Y.length;
    const parts = Array.from({ length: c.connections.B.length / w }, (_, k) => c.connections.B.slice(k * w, (k + 1) * w));
    const table = parts.map((x) => (x.every((b) => typeof b !== 'number') ? formatConst(x) : '*'));
    if (table.some((x) => x !== '*' && !/^\d+'bx+$/.test(x))) out.set(c.id, table.join('/'));
  }
  return out;
}

/** An ID found before and after an edit names the same table: no table takes over what was saved for another. */
function expectNoSwap(before: IRDesign, after: IRDesign, module: string) {
  const b = tables(after, module);
  for (const [id, table] of tables(before, module)) if (b.has(id)) expect(`${id} ${b.get(id)}`).toBe(`${id} ${table}`);
}

describe('IDs of the MUXes of if and case statements never move to another table', () => {
  it('names a table in an if/else-if chain by its whole branch, so an if added before the chain moves nothing', async () => {
    // Every if was named by how many MUX inputs lay between it and y: with `if (hold)` in front of the chain the
    // 5/6/7 table got the ID of the 9/10/11 one, and the wire drawn from it exported the other table.
    const chain = (clock: boolean, first: string) => ({
      'ctrl.v': `module ctrl(input clk, rst, load, shift, hold, input [1:0] sel, output reg [3:0] y);
  always ${clock ? '@(posedge clk)' : '@*'} begin
    ${clock ? "if (rst) y <= 4'd0;\n    else " : "y = 4'd0;\n    "}${first}if (load) case (sel) 2'd0: y = 4'd5; 2'd1: y = 4'd6; default: y = 4'd7; endcase
    else if (shift) case (sel) 2'd0: y = 4'd9; 2'd1: y = 4'd10; default: y = 4'd11; endcase
  end
endmodule
`.replace(/ = /g, clock ? ' <= ' : ' = '),
    });
    const [c1a, c1b, regifA, regifB] = await designs([
      chain(false, ''),
      chain(false, "if (hold) y = 4'd15;\n    else "),
      chain(true, ''),
      chain(true, 'if (hold) y <= y;\n    else '),
    ]);
    expect(muxWith(c1a, 'ctrl', "4'd7")).toBe('$pmux{case sel>load>Y=y}');
    expect(muxWith(c1a, 'ctrl', "4'd11")).toBe('$pmux{case sel>shift>!load>Y=y}');
    expect(muxWith(c1b, 'ctrl', "4'd7")).toBe('$pmux{case sel>load>!hold>Y=y}');
    expect(muxWith(c1b, 'ctrl', "4'd11")).toBe('$pmux{case sel>shift>!load>!hold>Y=y}');
    expect(muxWith(regifA, 'ctrl', "4'd11")).toBe('$pmux{case sel>shift>!load>!rst>Y=$0\\y}');
    expect(muxWith(regifB, 'ctrl', "4'd11")).toBe('$pmux{case sel>shift>!load>!hold>!rst>Y=$0\\y}');
    for (const [a, b] of [
      [c1a, c1b],
      [regifA, regifB],
    ]) {
      expectNoSwap(a, b, 'ctrl');
      expectNoSwap(b, a, 'ctrl');
      expect(numbered(a, 'ctrl')).toEqual([]);
      expect(numbered(b, 'ctrl')).toEqual([]);
    }
  }, T);

  const block = (clock: boolean, statements: string[]) => ({
    't.v': `module t(input clk, a1, b1, input [1:0] a, b, c, s, output reg [3:0] y);
  always ${clock ? '@(posedge clk)' : '@*'} begin
${clock ? '' : "    y = 4'd0;\n"}${statements.map((x) => `    ${x.replace(/ = /g, clock ? ' <= ' : ' = ')}\n`).join('')}  end
endmodule
`,
  });
  const items = (sel: string, labels: number[], v: number) => `case (${sel}) ${labels.map((l, k) => `2'd${l}: y = 4'd${v + k};`).join(' ')} endcase`;

  it('tells case statements in sequence on the same selector apart by their items, so removing one moves nothing', async () => {
    // They were told apart by Yosys' cell order (`#1`): removing the first gave its ID to the second.
    for (const clock of [false, true]) {
      const end = clock ? 'Y=$0\\y' : 'Y=y';
      const [three, two] = await designs([
        block(clock, [items('a', [0, 1], 1), items('a', [2, 3], 5), items('a', [0, 3], 9)]),
        block(clock, [items('a', [2, 3], 5), items('a', [0, 3], 9)]),
      ]);
      for (const d of [three, two]) {
        expect(muxWith(d, 't', "4'd5")).toBe(`$pmux{case a{a==2'd2,a==2'd3}>${end}}`);
        expect(muxWith(d, 't', "4'd9")).toBe(`$pmux{case a{a==2'd0,a==2'd3}>${end}}`);
        expect(numbered(d, 't')).toEqual([]);
      }
      expect(muxWith(three, 't', "4'd1")).toBe(`$pmux{case a{a==2'd0,a==2'd1}>${end}}`);
      expectNoSwap(three, two, 't');
      expectNoSwap(two, three, 't');
    }
  }, T);

  it('keeps the ID of the last case statement on its table when another one is appended after it', async () => {
    // The last statement was named only by the signal it drives (`$pmux{Y=y}`): the appended one took it over.
    for (const clock of [false, true]) {
      const end = clock ? 'Y=$0\\y' : 'Y=y';
      const [two, three] = await designs([
        block(clock, [items('a', [0, 1], 1), items('b', [0, 1], 3)]),
        block(clock, [items('a', [0, 1], 1), items('b', [0, 1], 3), items('c', [0, 1], 5)]),
      ]);
      for (const d of [two, three]) {
        expect(muxWith(d, 't', "4'd3")).toBe(`$pmux{case b>${end}}`);
        expect(consts(d, 't').get(`const:cell:$pmux{case b>${end}}.B[2'd0]`)).toBe("4'd3");
      }
      expect(muxWith(three, 't', "4'd5")).toBe(`$pmux{case c>${end}}`);
      expectNoSwap(two, three, 't');
      expectNoSwap(three, two, 't');
    }
  }, T);

  it('names the tables of a one-hot case (1\'b1) by their item, so an item put in front moves nothing', async () => {
    // Every item compares with 1'b1: they were all `[1'b1]`, told apart by how many items came before.
    const onehot = (clock: boolean, first: string) => ({
      't.v': `module t(input clk, rst, input [3:0] st, input [1:0] s, output reg [3:0] y);
  always ${clock ? '@(posedge clk)' : '@*'}
    ${clock ? "if (rst) y = 4'd0; else " : ''}case (1'b1)
      ${first}st[1]: case (s) 2'd0: y = 4'd5; 2'd1: y = 4'd6; default: y = 4'd7; endcase
      st[2]: case (s) 2'd0: y = 4'd9; 2'd1: y = 4'd10; default: y = 4'd11; endcase
      default: y = 4'd15;
    endcase
endmodule
`.replace(/ = /g, clock ? ' <= ' : ' = '),
    });
    for (const clock of [false, true]) {
      const end = clock ? '!rst>Y=$0\\y' : 'Y=y';
      const [before, after] = await designs([
        onehot(clock, ''),
        onehot(clock, "st[0]: case (s) 2'd0: y = 4'd1; 2'd1: y = 4'd2; default: y = 4'd3; endcase\n      "),
      ]);
      for (const d of [before, after]) {
        expect(muxWith(d, 't', "4'd7")).toBe(`$pmux{case s>1'b1==st[1]>${end}}`);
        expect(muxWith(d, 't', "4'd11")).toBe(`$pmux{case s>1'b1==st[2]>${end}}`);
        expect(numbered(d, 't')).toEqual([]);
      }
      expectNoSwap(before, after, 't');
      expectNoSwap(after, before, 't');
    }
  }, T);

  it('names the MUXes of ifs in sequence by their condition and branch, not by Yosys cell order', async () => {
    // `$mux{a1}` and `$mux{a1}#1` (the x Yosys puts around the branch, and the if) traded places when the
    // statements were swapped.
    const table = (v: number) => `case (s) 2'd0: y = 4'd${v}; 2'd1: y = 4'd${v + 1}; default: y = 4'd${v + 2}; endcase`;
    const [ab, ba] = await designs([block(false, [`if (a1) ${table(1)}`, `if (b1) ${table(4)}`]), block(false, [`if (b1) ${table(4)}`, `if (a1) ${table(1)}`])]);
    const roles = (d: IRDesign) =>
      new Map(
        d.modules.t.cells
          .filter((c) => c.name.startsWith('$procmux$') && c.type === '$mux')
          .map((c) => [c.id, c.connections.A.every((b) => b === 'x') ? 'x' : 'if'] as const),
      );
    expect(roles(ab)).toEqual(roles(ba));
    expect([...roles(ab).keys()].sort()).toEqual(['$mux{if a1 else x>a1>Y=y}', '$mux{if a1>Y=y}', '$mux{if b1 else x>b1>Y=y}', '$mux{if b1>Y=y}']);
    expect(muxWith(ab, 't', "4'd3")).toBe('$pmux{case s>a1>Y=y}');
    expect(muxWith(ba, 't', "4'd3")).toBe('$pmux{case s>a1>Y=y}');
  }, T);
});

describe('IDs of statements in sequence that assign the same signal', () => {
  const block = (clock: boolean, statements: string[]) => ({
    't.v': `module t(input clk, en, e, b, input [1:0] op, m, a, s, output reg [3:0] y);
  always ${clock ? '@(posedge clk)' : '@*'} begin
${clock ? '' : "    y = 4'd0;\n"}${statements.map((x) => `    ${x.replace(/ = /g, clock ? ' <= ' : ' = ')}\n`).join('')}  end
endmodule
`,
  });
  /** The constants of the case table whose value the MUX with this ID passes on (undefined when there is none). */
  const tableUnder = (d: IRDesign, id: string) => {
    const cells = d.modules.t.cells;
    const bits = cells.find((c) => c.id === id)?.connections.B ?? [];
    const table = cells.find((c) => c.type === '$pmux' && c.connections.Y.some((b) => bits.includes(b)));
    return table && tables(d, 't').get(table.id);
  };

  it('keeps the ID of a statement off a later one on the same selector and condition that keeps its value twice', async () => {
    // The appended statement keeps the value of the first one in its if and in its case: the first one's IDs ended
    // in `*` instead of the signal, and the appended table took over `$pmux{case op>en>Y=$0\y}`, the if MUX `$mux{if en>Y=$0\y}`.
    for (const clock of [true, false]) {
      const first = "if (en) case (op) 2'd0: y = 4'd1; 2'd1: y = 4'd2; default: y = 4'd3; endcase";
      const [one, ...more] = await designs([
        block(clock, [first]),
        block(clock, [first, "if (en) case (op) 2'd2: y = 4'd7; 2'd3: y = 4'd8; endcase"]),
        block(clock, [first, "if (en) case (op) 2'd0: y = 4'd7; 2'd1: y = 4'd8; endcase"]),
      ]);
      for (const after of more) {
        expectNoSwap(one, after, 't');
        expectNoSwap(after, one, 't');
        for (const c of one.modules.t.cells.filter((x) => x.type === '$mux' && x.name.startsWith('$procmux$'))) {
          const now = tableUnder(after, c.id);
          if (now) expect(now).toBe(tableUnder(one, c.id));
        }
        expect(after.modules.t.cells.filter((c) => c.name.startsWith('$procmux$') && c.id.includes('*}')).map((c) => c.id)).toEqual([]);
      }
    }
  }, T);

  it('keeps the ID of a statement off a later one that has an if without else or a case without default in an item', async () => {
    for (const clock of [true, false]) {
      const first = "case (a) 2'd0: y = 4'd1; 2'd1: y = 4'd2; endcase";
      const [one, ...more] = await designs([
        block(clock, [first]),
        block(clock, [first, "case (a) 2'd2: if (b) y = 4'd5; 2'd3: y = 4'd6; endcase"]),
        block(clock, [first, "case (a) 2'd2: case (m) 2'd0: y = 4'd5; 2'd1: y = 4'd7; endcase 2'd3: y = 4'd6; endcase"]),
      ]);
      for (const after of more) {
        expectNoSwap(one, after, 't');
        expectNoSwap(after, one, 't');
      }
    }
  }, T);

  it('never gives the ID of a case statement to an earlier one whose value it overwrote once it is put in an if', async () => {
    // The first case is dead while the second (with a default) overwrites it, and Yosys drops it. Once the
    // second was put in `if (e)`, the first appeared with the ID the second had, and took over its edits.
    for (const clock of [true, false]) {
      const dead = "case (m) 2'd2: y = 4'd3; 2'd3: y = 4'd4; endcase";
      const full = "case (m) 2'd0: y = 4'd8; 2'd1: y = 4'd10; default: y = 4'd11; endcase";
      const [plain, wrapped] = await designs([block(clock, [dead, full]), block(clock, [dead, `if (e) ${full}`])]);
      expectNoSwap(plain, wrapped, 't');
      expectNoSwap(wrapped, plain, 't');
      expect(muxWith(wrapped, 't', "4'd3")).not.toBe(muxWith(plain, 't', "4'd8"));
    }
  }, T);

  it('keeps the IDs of case statements on the same selector with the same labels when a value changes', async () => {
    // They were told apart by their values: changing 4'd6 renamed that table and every later one.
    for (const clock of [true, false]) {
      const edits = await designs([
        block(clock, ["case (a) 2'd0: y = 4'd1; 2'd1: y = 4'd2; endcase", "case (a) 2'd0: y = 4'd5; 2'd1: y = 4'd6; endcase"]),
        block(clock, ["case (a) 2'd0: y = 4'd1; 2'd1: y = 4'd2; endcase", "case (a) 2'd0: y = 4'd5; 2'd1: y = 4'd7; endcase"]),
        block(clock, ["case (a) 2'd0: y = 4'd9; 2'd1: y = 4'd2; endcase", "case (a) 2'd0: y = 4'd5; 2'd1: y = 4'd6; endcase"]),
      ]);
      const ids = (d: IRDesign) => d.modules.t.cells.map((c) => c.id).sort();
      for (const d of edits) {
        expect(ids(d)).toEqual(ids(edits[0]));
        expect(numbered(d, 't')).toEqual([]);
      }
      const second = muxWith(edits[0], 't', "4'd5");
      expect(muxWith(edits[1], 't', "4'd5")).toBe(second);
      expect(consts(edits[0], 't').get(`const:cell:${second}.B[2'd1]`)).toBe("4'd6");
      expect(consts(edits[1], 't').get(`const:cell:${second}.B[2'd1]`)).toBe("4'd7");
      expect(muxWith(edits[2], 't', "4'd9")).toBe(muxWith(edits[0], 't', "4'd1"));
    }
  }, T);

  it('renames case statements alike but for their values when one is added or removed, instead of moving their IDs', async () => {
    const twin = (v: number) => `case (a) 2'd0: y = 4'd${v}; 2'd1: y = 4'd${v + 1}; endcase`;
    const other = "case (a) 2'd0: case (s) 2'd0: y = 4'd13; 2'd1: y = 4'd14; endcase 2'd1: y = 4'd15; endcase";
    for (const clock of [true, false]) {
      const [two, three, more] = await designs([
        block(clock, [twin(1), other, twin(5)]),
        block(clock, [twin(9), twin(1), other, twin(5)]),
        block(clock, [twin(1), other, twin(5), twin(3)]),
      ]);
      for (const [a, b] of [
        [two, three],
        [two, more],
      ]) {
        expectNoSwap(a, b, 't');
        expectNoSwap(b, a, 't');
        expect(numbered(b, 't')).toEqual([]);
        // The statement of another shape keeps its ID.
        expect(muxWith(b, 't', "4'd15")).toBe(muxWith(a, 't', "4'd15"));
      }
    }
  }, T);

  it('does not read a condition with > in it as two nested ifs', async () => {
    const [nested, compare] = await designs([
      block(false, ["if (b) begin if (a) case (s) 2'd0: y = 4'd1; 2'd1: y = 4'd2; default: y = 4'd3; endcase end"]),
      block(false, ["if (a>b) case (s) 2'd0: y = 4'd5; 2'd1: y = 4'd6; default: y = 4'd7; endcase"]),
    ]);
    expect(muxWith(compare, 't', "4'd7")).toBe('$pmux{case s>a\\>b>Y=y}');
    expect(muxWith(nested, 't', "4'd3")).toBe('$pmux{case s>a>b>Y=y}');
    expectNoSwap(nested, compare, 't');
  }, T);

  it('keeps the IDs of long else-if chains and one-hot cases short', async () => {
    const n = 40;
    const chain = Array.from({ length: n }, (_, k) => `${k ? 'else ' : ''}if (c[${k}]) case (s) 2'd0: y <= 8'd${k}; 2'd1: y <= 8'd${k + 1}; default: y <= 8'd${k + 2}; endcase`);
    const items = Array.from({ length: n }, (_, k) => `st[${k}]: case (s) 2'd0: y = 8'd${k}; 2'd1: y = 8'd${k + 1}; default: y = 8'd${k + 2}; endcase`);
    const [ifs, onehot] = await designs([
      { 'c.v': `module c(input clk, input [${n - 1}:0] c, input [1:0] s, output reg [7:0] y);\n  always @(posedge clk)\n    ${chain.join('\n    ')}\nendmodule\n` },
      { 'o.v': `module o(input [${n - 1}:0] st, input [1:0] s, output reg [7:0] y);\n  always @* begin\n    y = 8'd0;\n    case (1'b1)\n      ${items.join('\n      ')}\n    endcase\n  end\nendmodule\n` },
    ]);
    for (const [d, module] of [
      [ifs, 'c'],
      [onehot, 'o'],
    ] as const) {
      const ids = d.modules[module].cells.filter((c) => c.name.startsWith('$procmux$') && c.type.endsWith('mux')).map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(Math.max(...ids.map((x) => x.length))).toBeLessThanOrEqual(160);
      expect(numbered(d, module)).toEqual([]);
    }
  }, T);
});
