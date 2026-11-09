import { describe, expect, it } from 'vitest';
import { verilogIdent } from './verilog-ident';

describe('verilogIdent', () => {
  it('keeps legal names and repairs the others', () => {
    expect(verilogIdent('sum_2')).toBe('sum_2');
    expect(verilogIdent('a$b')).toBe('a$b');
    expect(verilogIdent('module')).toBe('module_');
    expect(verilogIdent('logic')).toBe('logic_');
    expect(verilogIdent('2x')).toBe('_2x');
    expect(verilogIdent('a b')).toBe('a_b');
    expect(verilogIdent('x[3:0]')).toBe('x_3_0');
    expect(verilogIdent('$add')).toBe('add');
    expect(verilogIdent('')).toBe('unnamed');
    expect(verilogIdent('計數')).toBe('u8a08_u6578');
  });
});
