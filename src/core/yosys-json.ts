/**
 * Types for the JSON produced by Yosys `write_json`.
 * Only the fields Digital Canvas reads are listed.
 */

/** A signal bit: a net number, or a constant ('0', '1', 'x', 'z'). */
export type YosysBit = number | '0' | '1' | 'x' | 'z';

export type YosysDirection = 'input' | 'output' | 'inout';

export interface YosysPort {
  direction: YosysDirection;
  bits: YosysBit[];
  offset?: number;
  upto?: number;
  signed?: number;
}

export interface YosysCell {
  hide_name: number;
  type: string;
  parameters: Record<string, string>;
  attributes: Record<string, string>;
  port_directions?: Record<string, YosysDirection>;
  connections: Record<string, YosysBit[]>;
}

export interface YosysNetname {
  hide_name: number;
  bits: YosysBit[];
  offset?: number;
  upto?: number;
  signed?: number;
  attributes: Record<string, string>;
}

export interface YosysModule {
  attributes: Record<string, string>;
  parameter_default_values?: Record<string, string>;
  ports: Record<string, YosysPort>;
  cells: Record<string, YosysCell>;
  netnames: Record<string, YosysNetname>;
}

export interface YosysDesign {
  creator?: string;
  modules: Record<string, YosysModule>;
}

/**
 * Parse `write_json` output. Yosys escapes each byte of a non-ASCII string
 * (such as the file name 加法器.v) as a sign-extended escape (backslash, u, FFFFFF, byte),
 * which JSON.parse would read as U+FFFF followed by text. Decode those bytes as UTF-8 first.
 */
export function parseYosysJson(text: string): YosysDesign {
  const fixed = text.replace(/(?:\\uFFFFFF[0-9A-Fa-f]{2})+/g, (seq) => {
    const bytes = [...seq.matchAll(/\\uFFFFFF([0-9A-Fa-f]{2})/g)].map((m) => parseInt(m[1], 16));
    return JSON.stringify(new TextDecoder().decode(new Uint8Array(bytes))).slice(1, -1);
  });
  return JSON.parse(fixed) as YosysDesign;
}
