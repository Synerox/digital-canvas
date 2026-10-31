import { runYosys } from '@yowasp/yosys';
import { JSON_OUT, yosysArgs } from '../yosys/script';
import { buildDesign, type IRDesign } from './ir';
import { type YosysDesign, parseYosysJson } from './yosys-json';

/** Run the app's real Yosys script in Node. */
export async function elaborate(files: Record<string, string>, top?: string): Promise<YosysDesign> {
  const out = (await runYosys(yosysArgs(files, { top }), files, {
    stdout: () => {},
    stderr: () => {},
  })) as Record<string, string | Uint8Array>;
  const raw = out[JSON_OUT];
  return parseYosysJson(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
}

export async function design(files: Record<string, string>, top?: string): Promise<IRDesign> {
  return buildDesign(await elaborate(files, top), files);
}
