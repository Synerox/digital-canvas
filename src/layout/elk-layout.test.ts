import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ElkNode } from 'elkjs/lib/elk-api';
import { buildDiagram } from '../core/diagram';
import { design } from '../core/test-utils';
import { type ElkLike, LayoutCancelled, cancelLayouts, layoutDiagram, setElkFactory } from './elk-layout';

const T = 60_000;
const SRC = 'module t(input [3:0] a, b, output [3:0] y); assign y = a + b; endmodule';

/** An ELK whose layouts never finish, like a worker that did not load. */
function stuckElk() {
  const terminateWorker = vi.fn<() => void>();
  const elk: ElkLike = { layout: () => new Promise<ElkNode>(() => {}), terminateWorker };
  return { elk, terminateWorker };
}

afterEach(() => setElkFactory(undefined));

describe('worker ELK', () => {
  it('redoes the layout on the main thread when the worker fails', async () => {
    const diagram = buildDiagram(await design({ 't.v': SRC }), 't');
    let fail: () => void = () => {};
    const worker = stuckElk();
    setElkFactory((failed) => {
      fail = failed;
      return worker.elk;
    });
    const pending = layoutDiagram(diagram);
    await new Promise((r) => setTimeout(r, 0));
    fail();
    const layout = await pending;
    expect(layout.nodes.length).toBe(diagram.nodes.length);
    expect(worker.terminateWorker).toHaveBeenCalled();
  }, T);

  it('stops running layouts and starts a fresh worker', async () => {
    const diagram = buildDiagram(await design({ 't.v': SRC }), 't');
    const made: ReturnType<typeof stuckElk>[] = [];
    setElkFactory(() => {
      const made1 = stuckElk();
      made.push(made1);
      return made1.elk;
    });
    const pending = layoutDiagram(diagram);
    await new Promise((r) => setTimeout(r, 0));
    cancelLayouts();
    await expect(pending).rejects.toBeInstanceOf(LayoutCancelled);
    expect(made.length).toBe(2);
    expect(made[0].terminateWorker).toHaveBeenCalled();
  }, T);

  it('cannot stop the main-thread ELK, so it lets it finish', async () => {
    const diagram = buildDiagram(await design({ 't.v': SRC }), 't');
    const pending = layoutDiagram(diagram);
    cancelLayouts();
    expect((await pending).nodes.length).toBe(diagram.nodes.length);
  }, T);
});
