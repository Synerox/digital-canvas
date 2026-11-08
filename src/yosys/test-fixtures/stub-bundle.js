// Stands in for @yowasp/yosys' bundle in worker.test.ts. Like the real bundle, it keeps the fetch
// it finds when it is evaluated and fetches its core on the first run; it compiles nothing.
const fetchAtLoad = globalThis.fetch;
const enc = new TextEncoder();
let core;

export async function runYosys(args, files = {}, opts = {}) {
  if (!core) {
    const res = await fetchAtLoad(new URL('./yosys.core.wasm', import.meta.url));
    core = new Uint8Array(await res.arrayBuffer());
  }
  if (args === undefined || args === null) return undefined;
  const stub = globalThis.__yosysStub ?? {};
  if (args[0] === '-V') {
    if (stub.failStart) throw new Error(stub.failStart);
    opts.stdout?.(enc.encode('Yosys stub\n'));
    return {};
  }
  opts.stdout?.(enc.encode(`read ${Object.keys(files).join(' ')}\n`));
  if (stub.designError) {
    opts.stdout?.(enc.encode(`ERROR: ${stub.designError}\n`));
    throw new Error('exit code 1');
  }
  return { 'design.json': JSON.stringify({ core: Array.from(core) }) };
}
