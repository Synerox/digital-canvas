/** Builds the Yosys command line used for elaboration only (no optimisation, no techmap). */

const SOURCE_EXT = /\.(v|sv|verilog)$/i;
const SV_EXT = /\.sv$/i;

export function isSourceFile(name: string): boolean {
  return SOURCE_EXT.test(name);
}

function quote(name: string): string {
  return /[\s;"]/.test(name) ? `"${name.replace(/"/g, '')}"` : name;
}

/** SystemVerilog packages must be read before the files that import them. */
function isPackage(text: string): boolean {
  return /^\s*package\s+\w+/m.test(text);
}

export const JSON_OUT = 'design.json';

export interface ScriptOptions {
  top?: string;
  /** Read .v files with -sv too (default). Off retries plain Verilog-2005 that uses SV keywords as names. */
  svForPlainVerilog?: boolean;
}

export function yosysScript(files: Record<string, string>, opts: ScriptOptions = {}): string {
  const sources = Object.keys(files)
    .filter(isSourceFile)
    .sort((a, b) => Number(isPackage(files[b])) - Number(isPackage(files[a])));
  const reads: string[] = [];
  if (opts.svForPlainVerilog === false) {
    const sv = sources.filter((f) => SV_EXT.test(f));
    const v = sources.filter((f) => !SV_EXT.test(f));
    if (sv.length) reads.push(`read_verilog -sv ${sv.map(quote).join(' ')}`);
    if (v.length) reads.push(`read_verilog ${v.map(quote).join(' ')}`);
  } else {
    reads.push(`read_verilog -sv ${sources.map(quote).join(' ')}`);
  }
  return [
    ...reads,
    `hierarchy -check ${opts.top ? `-top ${quote(opts.top)}` : '-auto-top'}`,
    'proc -noopt',
    // Merge $memrd/$memwr cells of each memory into one $mem_v2 block.
    'memory_collect',
    'opt_clean',
    `write_json ${JSON_OUT}`,
  ].join('; ');
}

export function yosysArgs(files: Record<string, string>, opts: ScriptOptions = {}): string[] {
  return ['-p', yosysScript(files, opts)];
}

/** Module names declared in the sources (comments stripped), for the Top selector. */
export function declaredModules(files: Record<string, string>): string[] {
  const names = new Set<string>();
  for (const [name, text] of Object.entries(files)) {
    if (!isSourceFile(name)) continue;
    const clean = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const m of clean.matchAll(/^\s*module\s+(?:automatic\s+|static\s+)?([A-Za-z_][\w$]*)/gm)) names.add(m[1]);
  }
  return [...names].sort();
}
