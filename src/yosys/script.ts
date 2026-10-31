/** Builds the Yosys command line used for elaboration only (no optimisation, no techmap). */

const SOURCE_EXT = /\.(v|sv|verilog)$/i;

export function isSourceFile(name: string): boolean {
  return SOURCE_EXT.test(name);
}

function quote(name: string): string {
  return /[\s;"]/.test(name) ? `"${name.replace(/"/g, '')}"` : name;
}

export const JSON_OUT = 'design.json';

export function yosysScript(files: string[], top?: string): string {
  const sources = files.filter(isSourceFile);
  return [
    `read_verilog -sv ${sources.map(quote).join(' ')}`,
    `hierarchy -check ${top ? `-top ${quote(top)}` : '-auto-top'}`,
    'proc -noopt',
    'opt_clean',
    `write_json ${JSON_OUT}`,
  ].join('; ');
}

export function yosysArgs(files: string[], top?: string): string[] {
  return ['-p', yosysScript(files, top)];
}
