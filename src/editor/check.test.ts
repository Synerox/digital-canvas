import { describe, expect, it } from 'vitest';
import { moduleTitle } from '../core/names';
import { checkSheet } from './check';
import { emptyEdits } from './doc';
import { addNodes, effectiveDiagram } from './sheet';
import { newUserNode } from './symbols';

describe('checkSheet', () => {
  it("names a block's missing module as the user wrote it, not as Yosys does", () => {
    const div10 = "$paramod\\baud_gen\\DIV=s32'00000000000000000000000000001010";
    let e = emptyEdits();
    e = addNodes(e, [
      { node: newUserNode('u:1', 'block', { name: 'u_baud', params: { module: div10 } }), pos: { x: 0, y: 0 } },
      { node: newUserNode('u:2', 'block', { params: { module: '$paramod$4be1c0ffee\\fifo' } }), pos: { x: 0, y: 200 } },
    ]);
    const d = effectiveDiagram('m', undefined, e, () => undefined);
    const messages = checkSheet(d).messages;
    expect(messages).toContain('Block u_baud uses baud_gen #(DIV=10), which no longer exists.');
    expect(messages).toContain('Block u:2 uses fifo #(…), which no longer exists.');
    expect(messages.join(' ')).not.toContain('$paramod');
    // The panels and notices name it the same way.
    expect(moduleTitle(div10)).toBe('baud_gen #(DIV=10)');
  });
});
