/**
 * IDs of the MUXes of nested case statements. What is saved for one (its place, the wires drawn from
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
      expect(muxWith(d, 'ctrl', "4'd7")).toBe("$pmux{Y>$mux.B[2'd1]>$pmux.B[2'd1]>Y=y}");
      expect(muxWith(d, 'ctrl', "4'd11")).toBe("$pmux{Y>$mux.B[2'd2]>$pmux.B[2'd2]>Y=y}");
      const c = consts(d, 'ctrl');
      expect(c.get("const:cell:$pmux{Y>$mux.B[2'd1]>$pmux.B[2'd1]>Y=y}.B[2'd0]")).toBe("4'd5");
      expect(c.get("const:cell:$pmux{Y>$mux.B[2'd2]>$pmux.B[2'd2]>Y=y}.B[2'd0]")).toBe("4'd9");
      expect(numbered(d, 'ctrl')).toEqual([]);
    }
    expect(muxWith(versions[2], 'ctrl', "4'd14")).toBe("$pmux{Y>$mux.B[2'd0]>$pmux.B[2'd0]>Y=y}");
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
      expect(muxWith(d, 'ctrl', "4'd7")).toBe("$pmux{Y>$pmux.B[2'd1]>$mux.A>Y=$0\\y}");
      expect(muxWith(d, 'ctrl', "4'd11")).toBe("$pmux{Y>$pmux.B[2'd2]>$mux.A>Y=$0\\y}");
      expect(consts(d, 'ctrl').get("const:cell:$pmux{Y>$pmux.B[2'd2]>$mux.A>Y=$0\\y}.B[2'd0]")).toBe("4'd9");
      expect(numbered(d, 'ctrl')).toEqual([]);
    }
    expect(muxWith(regC, 'ctrl', "4'd3")).toBe("$pmux{Y>$pmux.B[2'd0]>$mux.A>Y=$0\\y}");
    expect(muxWith(regE, 'ctrl', "4'd14")).toBe("$pmux{Y>$pmux.B[2'd3]>$mux.A>Y=$0\\y}");
  }, T);

  it('keeps the MUX and constant IDs of a nested table when one of its values changes', async () => {
    const [before, after] = await designs([
      clocked([table(0, 1), table(1, 5), table(2, 9)]),
      clocked([table(0, 1), table(1, 5), table(2, 9).replace("4'd10", "4'd8")]),
    ]);
    const ids = (d: IRDesign) => d.modules.ctrl.cells.map((c) => c.id).sort();
    expect(ids(after)).toEqual(ids(before));
    const id = "const:cell:$pmux{Y>$pmux.B[2'd2]>$mux.A>Y=$0\\y}.B[2'd1]";
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
    // selects on, `(b)`, not by how many statements come before (Yosys' `$1\y`) or after it.
    for (const clock of [false, true]) {
      const end = clock ? 'Y=$0\\y' : 'Y=y';
      for (const d of await designs([
        block(clock, [flat('a', 1), flat('b', 3), flat('c', 5)]),
        block(clock, [flat('b', 3), flat('c', 5)]),
      ])) {
        expect(muxWith(d, 't', "4'd3")).toBe(`$pmux{Y>(b)>${end}}`);
      }
      const inner = await designs([
        block(clock, [nested('a', 1), nested('b', 4)]),
        block(clock, [nested('a', 1), nested('b', 4), nested('c', 7)]),
        block(clock, [nested('b', 4), nested('c', 7)]),
      ]);
      const ids = inner.map((d) => muxWith(d, 't', "4'd6"));
      expect(ids[0]).toMatch(/\(b\)>Y=/);
      expect(ids).toEqual([ids[0], ids[0], ids[0]]);
      expect(muxWith(inner[1], 't', "4'd3")).not.toBe(ids[0]);
      for (const d of inner) expect(numbered(d, 't')).toEqual([]);
    }
  }, T);
});
