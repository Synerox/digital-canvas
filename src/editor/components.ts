/**
 * Components of the library defined in JSON (Library › Components…), saved with the work.
 *
 * Two kinds:
 *
 * - A preset is a built-in symbol with its parameters set, for example an AND with 5 inputs
 *   or a 4-input MUX of 8-bit buses: `{ "name": "and5", "base": "and", "inputs": 5 }`.
 *   A placed preset is that symbol, as if placed from the library and changed in Properties.
 * - A part of its own has pins and no logic drawn: `{ "name": "alu", "inputs": ["a[7:0]",
 *   "b[7:0]"], "outputs": ["y[7:0]"] }`, or with numbers of pins, `{ "name": "lut",
 *   "inputs": 6, "outputs": 1 }`. It is placed as a block, an instance of the module of that
 *   name with these ports and no logic (a black box). A Verilog module or a drawing of the
 *   same name, made later, takes its place.
 *
 * The text the user writes is read by parseComponents, which explains what is wrong; the
 * file loader reads the saved definitions with loadComponents, which drops what is wrong.
 */
import { PARAM_LIMITS, SYMBOL_BY_KEY, type ModuleInterface, type ModulePort, type SymKey, type SymParams, type UserNode, literalWidth } from './symbols';
import { verilogIdent } from './verilog-ident';

export interface ComponentDef {
  /** The name in the library; for a part, also the name of the module its blocks instantiate. */
  name: string;
  /** What the library shows (and, for a part, the symbol's title); the name when left out. */
  title?: string;
  /** For a preset: the built-in symbol. */
  base?: SymKey;
  /** For a preset: its parameters (only those the symbol has). */
  params?: SymParams;
  /** For a part: its pins (inputs and inouts on the left, outputs on the right). */
  pins?: ModulePort[];
}

/** Symbols a preset can be based on: every built-in symbol that has parameters to set, but a block. */
export const PRESET_BASES: SymKey[] = Object.values(SYMBOL_BY_KEY)
  .filter((d) => !!d && d.key !== 'block' && d.params.length > 0)
  .map((d) => d!.key);

/** At most this many pins on a part, and this many components in the library. */
export const MAX_PINS = 128;
export const MAX_COMPONENTS = 200;

/** What the dialog shows for a library with no components yet. */
export const COMPONENTS_EXAMPLE = `[
  { "name": "and5", "title": "AND (5 inputs)", "base": "and", "inputs": 5 },
  { "name": "mux4x8", "title": "MUX 4 × 8 bits", "base": "mux", "inputs": 4, "width": 8 },
  { "name": "alu", "title": "ALU", "inputs": ["a[7:0]", "b[7:0]", "op[2:0]"], "outputs": ["y[7:0]", "zero"] },
  { "name": "lut6", "inputs": 6, "outputs": 1 }
]
`;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const NAME = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const [MIN_WIDTH, MAX_WIDTH] = PARAM_LIMITS.width;

/** The fields a preset of `base` may set. */
function presetFields(base: SymKey): string[] {
  return (SYMBOL_BY_KEY[base]?.params ?? []).filter((p) => p !== 'module');
}

/** Whether a component is a part of its own (a module with pins), not a preset. */
export function isPart(def: ComponentDef): def is ComponentDef & { pins: ModulePort[] } {
  return !!def.pins;
}

/** The part of the library named `name`, if there is one. */
export function partNamed(defs: readonly ComponentDef[] | undefined, name: string): (ComponentDef & { pins: ModulePort[] }) | undefined {
  const d = defs?.find((c) => c.name === name);
  return d && isPart(d) ? d : undefined;
}

/** The ports a block of a part gets. */
export function partInterface(def: ComponentDef & { pins: ModulePort[] }): ModuleInterface {
  return { label: def.title ?? def.name, ports: def.pins };
}

class Bad extends Error {}

/** The part's "width", and whether a pin took it (a pin with bits of its own, `a[7:0]`, does not). */
interface PartWidth {
  width: number;
  used: boolean;
}

/** A pin given as `"a"`, `"a[7:0]"` or `{ "name": "a", "width": 8 }`. */
function pinOf(v: unknown, dir: ModulePort['dir'], width: PartWidth, where: string): ModulePort {
  if (typeof v === 'string') {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_$]*)\s*(?:\[\s*(\d+)\s*:\s*(\d+)\s*\])?\s*$/.exec(v);
    if (!m) throw new Bad(`${where}: "${v}" is not a pin such as "a" or "a[7:0]".`);
    if (m[2] === undefined) width.used = true;
    // The pins are numbered from 0 ([7:0]): a[8:1] is 8 bits wide too, written a[7:0].
    const w = m[2] === undefined ? width.width : Math.abs(Number(m[2]) - Number(m[3])) + 1;
    return { name: m[1], dir, width: checkWidth(w, where) };
  }
  if (isObj(v) && typeof v.name === 'string') {
    if (!NAME.test(v.name)) throw new Bad(`${where}: "${v.name}" is not a pin name (letters, digits and _).`);
    for (const k of Object.keys(v)) if (k !== 'name' && k !== 'width') throw new Bad(`${where}: a pin has a "name" and a "width", not "${k}".`);
    if (v.width === undefined) width.used = true;
    return { name: v.name, dir, width: v.width === undefined ? width.width : checkWidth(v.width, where) };
  }
  throw new Bad(`${where}: write a pin as "a", "a[7:0]" or { "name": "a", "width": 8 }.`);
}

function checkWidth(w: unknown, where: string): number {
  if (typeof w !== 'number' || !Number.isInteger(w) || w < MIN_WIDTH || w > MAX_WIDTH) {
    throw new Bad(`${where}: a width is a whole number from ${MIN_WIDTH} to ${MAX_WIDTH}.`);
  }
  return w;
}

/** The pins of one side: a number of pins (named in0, in1… or out0, out1…) or a list of pins. */
function pinsOf(v: unknown, dir: ModulePort['dir'], width: PartWidth, where: string): ModulePort[] {
  if (v === undefined) return [];
  const stem = dir === 'input' ? 'in' : dir === 'output' ? 'out' : 'io';
  if (typeof v === 'number') {
    if (!Number.isInteger(v) || v < 0 || v > MAX_PINS) throw new Bad(`${where}: a number of pins from 0 to ${MAX_PINS}.`);
    if (v > 0) width.used = true;
    return Array.from({ length: v }, (_, k) => ({ name: v === 1 && dir === 'output' ? 'out' : `${stem}${k}`, dir, width: width.width }));
  }
  if (!Array.isArray(v)) throw new Bad(`${where}: a number of pins, or a list such as ["a[7:0]", "b"].`);
  return v.map((p, k) => pinOf(p, dir, width, `${where} ${k + 1}`));
}

/**
 * One component as written. `taken` says why a part may not have a name (a Verilog module or a
 * drawing has it), or nothing.
 */
function componentOf(v: unknown, k: number, taken: (name: string) => string | undefined): ComponentDef {
  const at = `Component ${k + 1}`;
  if (!isObj(v)) throw new Bad(`${at}: write each component as { "name": …, … }.`);
  const name = v.name;
  if (typeof name !== 'string' || !NAME.test(name)) throw new Bad(`${at}: "name" is a name of letters, digits and _ (such as "and5").`);
  const where = `${name}`;
  if (verilogIdent(name) !== name) throw new Bad(`${where}: ${name} is a Verilog keyword; choose another name.`);
  if (v.title !== undefined && (typeof v.title !== 'string' || !v.title.trim())) throw new Bad(`${where}: "title" is a text.`);
  const title = typeof v.title === 'string' ? v.title.trim() : undefined;
  if (v.base !== undefined) {
    const base = v.base as SymKey;
    if (typeof v.base !== 'string' || !PRESET_BASES.includes(base)) {
      throw new Bad(`${where}: "base" is one of the library's symbols: ${PRESET_BASES.join(', ')}.`);
    }
    const fields = presetFields(base);
    const params: SymParams = {};
    for (const [key, val] of Object.entries(v)) {
      if (key === 'name' || key === 'title' || key === 'base') continue;
      if (!fields.includes(key)) {
        throw new Bad(`${where}: ${SYMBOL_BY_KEY[base]!.title} has ${fields.length ? fields.map((f) => `"${f}"`).join(', ') : 'nothing to set'}, not "${key}".`);
      }
      if (key === 'value') {
        if (typeof val !== 'string' || !literalWidth(val)) throw new Bad(`${where}: "value" is a Verilog number such as "4'd2".`);
        params.value = val.trim();
        continue;
      }
      const lim = PARAM_LIMITS[key as keyof typeof PARAM_LIMITS];
      const hi = key === 'width' && base === 'decoder' ? 8 : lim[1];
      if (typeof val !== 'number' || !Number.isInteger(val) || val < lim[0] || val > hi) {
        throw new Bad(`${where}: "${key}" is a whole number from ${lim[0]} to ${hi}.`);
      }
      params[key as 'width' | 'inputs' | 'parts' | 'shift'] = val;
    }
    return { name, ...(title ? { title } : {}), base, params };
  }
  for (const key of Object.keys(v)) {
    if (!['name', 'title', 'inputs', 'outputs', 'inouts', 'width'].includes(key)) {
      throw new Bad(`${where}: a part has "inputs", "outputs", "inouts" and "width", not "${key}" (or give a "base" symbol for a preset).`);
    }
  }
  const why = taken(name);
  if (why) throw new Bad(`${where}: ${why}`);
  const width: PartWidth = { width: v.width === undefined ? 1 : checkWidth(v.width, `${where} "width"`), used: false };
  const pins = [
    ...pinsOf(v.inputs, 'input', width, `${where} input`),
    ...pinsOf(v.inouts, 'inout', width, `${where} inout`),
    ...pinsOf(v.outputs, 'output', width, `${where} output`),
  ];
  if (pins.length === 0) throw new Bad(`${where}: give it "inputs" and "outputs" (or a "base" symbol for a preset).`);
  // A "width" that no pin takes and no pin has would change nothing: say so, rather than leave the pins as they
  // were (one that some pins have already, as the JSON shown writes it, is as good as left out).
  if (v.width !== undefined && !width.used && !pins.some((p) => p.width === width.width)) {
    const own = pins[0];
    throw new Bad(
      `${where}: "width" sets the bits of pins written without them, such as "${own.name}"; every pin here has bits of its own (such as "${own.name}[${own.width - 1}:0]"): change those, or write the pins without bits.`,
    );
  }
  if (pins.length > MAX_PINS) throw new Bad(`${where}: at most ${MAX_PINS} pins.`);
  const seen = new Set<string>();
  for (const p of pins) {
    if (seen.has(p.name)) throw new Bad(`${where}: two pins are named ${p.name}.`);
    if (verilogIdent(p.name) !== p.name) throw new Bad(`${where}: the pin name ${p.name} is a Verilog keyword.`);
    seen.add(p.name);
  }
  return { name, ...(title ? { title } : {}), pins };
}

/**
 * Read the components the user wrote: a JSON list (or one object). Says what is wrong with the first
 * component that is not right, by its name or its place in the list.
 */
export function parseComponents(
  text: string,
  taken: (name: string) => string | undefined = () => undefined,
): { defs: ComponentDef[]; error?: undefined } | { error: string; defs?: undefined } {
  if (!text.trim()) return { defs: [] };
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    return { error: `Not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  const list = Array.isArray(v) ? v : [v];
  if (list.length > MAX_COMPONENTS) return { error: `At most ${MAX_COMPONENTS} components.` };
  try {
    const defs = list.map((c, k) => componentOf(c, k, taken));
    const names = new Set<string>();
    for (const d of defs) {
      if (names.has(d.name)) throw new Bad(`Two components are named ${d.name}.`);
      names.add(d.name);
    }
    return { defs };
  } catch (e) {
    if (e instanceof Bad) return { error: e.message };
    throw e;
  }
}

/** An object as JSON on one line, spaced to read: `{ "name": "a", "inputs": ["x", "y"] }`. */
function oneLine(o: Record<string, unknown>): string {
  const value = (v: unknown) => (Array.isArray(v) ? `[${v.map((x) => JSON.stringify(x)).join(', ')}]` : JSON.stringify(v));
  return `{ ${Object.entries(o).map(([k, v]) => `${JSON.stringify(k)}: ${value(v)}`).join(', ')} }`;
}

/** A pin as the JSON writes it: `a` when it has the part's `width` (see partWidth), else its bits, `a[7:0]` (or `a[0:0]`). */
function pinText(p: ModulePort, width: number): string {
  return p.width === width ? p.name : `${p.name}[${p.width - 1}:0]`;
}

/**
 * The "width" the JSON of a part writes once, for the pins that have it: the width of most of its buses
 * (the wider one of two as common), so that changing it changes the data width and leaves the other pins
 * (a 3-bit op, a 1-bit flag, written with their bits) as they are. 1 when no pin is a bus.
 */
function partWidth(pins: readonly ModulePort[]): number {
  const count = new Map<number, number>();
  for (const p of pins) if (p.width > 1) count.set(p.width, (count.get(p.width) ?? 0) + 1);
  let best = 1;
  let most = 0;
  for (const [w, k] of count) {
    if (k > most || (k === most && w > best)) {
      best = w;
      most = k;
    }
  }
  return best;
}

/**
 * One component as JSON: on one line, `{ "name": "and5", "base": "and", "inputs": 5 }`, as the list of
 * Components writes each; or, `multiline`, one item to a line, as the window that edits one shows it.
 */
export function componentJson(d: ComponentDef, multiline = false): string {
  const o: Record<string, unknown> = { name: d.name, ...(d.title ? { title: d.title } : {}) };
  if (isPart(d)) {
    // The pins of the part's width are written as names and the width once, so that changing "width" changes them.
    const width = partWidth(d.pins);
    for (const [key, dir] of [['inputs', 'input'], ['inouts', 'inout'], ['outputs', 'output']] as const) {
      const pins = d.pins.filter((p) => p.dir === dir);
      if (pins.length) o[key] = pins.map((p) => pinText(p, width));
    }
    if (width > 1) o.width = width;
  } else {
    o.base = d.base;
    Object.assign(o, d.params);
  }
  return multiline ? JSON.stringify(o, null, 2) : oneLine(o);
}

/** The components as JSON the user can edit (and parseComponents reads back to the same). */
export function componentsJson(defs: readonly ComponentDef[]): string {
  if (defs.length === 0) return '[]\n';
  return `[\n${defs.map((d) => `  ${componentJson(d)}`).join(',\n')}\n]\n`;
}

/**
 * Read the JSON of one component (see componentJson) in place of the component named `name`: the library
 * with it changed, or what is wrong. `taken` says why a new part may not have a name (see parseComponents).
 */
export function editComponent(
  defs: readonly ComponentDef[],
  name: string,
  text: string,
  taken: (name: string) => string | undefined = () => undefined,
): { defs: ComponentDef[]; error?: undefined } | { error: string; defs?: undefined } {
  const r = parseComponents(text, taken);
  if (!r.defs) return { error: r.error.replace(/^Component 1: /, '') };
  if (r.defs.length !== 1) return { error: 'Write one component here, as { "name": …, … } (Components › Edit… changes the whole list).' };
  const [d] = r.defs;
  if (d.name !== name && defs.some((x) => x.name === d.name)) return { error: `Another component is named ${d.name}.` };
  return { defs: defs.map((x) => (x.name === name ? d : x)) };
}

/** The components of a saved file: those that are right, as written there. */
export function loadComponents(v: unknown): ComponentDef[] {
  if (!Array.isArray(v)) return [];
  const out: ComponentDef[] = [];
  const names = new Set<string>();
  for (const c of v.slice(0, MAX_COMPONENTS)) {
    if (!isObj(c)) continue;
    // Saved as the dialog keeps them: pins with their direction. Read through the user's form, so that
    // one rule says what a component may be.
    const spec: Record<string, unknown> = { name: c.name, ...(c.title !== undefined ? { title: c.title } : {}) };
    // Only parameters: one named "name", "base" or "title" would take the place of the component's own.
    if (c.base !== undefined) {
      const params = isObj(c.params) ? Object.entries(c.params).filter(([k]) => !['name', 'base', 'title'].includes(k)) : [];
      Object.assign(spec, Object.fromEntries(params), { base: c.base });
    }
    else if (Array.isArray(c.pins)) {
      const pins = c.pins.filter(isObj);
      const side = (dir: string) => pins.filter((p) => p.dir === dir).map((p) => ({ name: p.name, width: p.width }));
      Object.assign(spec, { inputs: side('input'), inouts: side('inout'), outputs: side('output') });
    }
    const r = parseComponents(JSON.stringify(spec));
    const d = r.defs?.[0];
    if (d && !names.has(d.name)) {
      names.add(d.name);
      out.push(d);
    }
  }
  return out;
}

/** The library item a component places: its symbol and parameters. */
export function componentSymbol(def: ComponentDef): { sym: SymKey; params: SymParams } {
  return isPart(def) ? { sym: 'block', params: { module: def.name } } : { sym: def.base!, params: { ...def.params } };
}

/** Every setting of a `sym` symbol: `params`, with the library's defaults for those it leaves out. */
export function fullSettings(sym: SymKey, params: SymParams): SymParams {
  const out: SymParams = {};
  const def = SYMBOL_BY_KEY[sym];
  for (const f of presetFields(sym)) {
    const v = params[f as keyof SymParams] ?? def?.defaults[f as keyof SymParams];
    if (v !== undefined) (out as Record<string, unknown>)[f] = v;
  }
  return out;
}

/**
 * Whether the symbol `n` follows the preset it was placed from: the library has that preset, for the same
 * symbol, with the symbol's settings. A link is kept only while this holds, so that changing a preset never
 * changes a symbol whose settings are no longer the preset's (one changed on its own, pasted from another file,
 * or placed again after Undo changed the preset back).
 */
export function followsPreset(n: UserNode, defs: readonly ComponentDef[] | undefined): boolean {
  if (!n.component) return false;
  const def = defs?.find((c) => c.name === n.component);
  return !!def && !isPart(def) && def.base === n.sym && sameSettings(n.sym, n.params, componentSymbol(def).params);
}

/**
 * The presets renamed from `before` to `after` (old name to new name). The Components window edits the whole
 * list as text, so it cannot say: a preset whose name is gone was renamed to a new one of the same symbol with
 * the same settings, when only that one has them (and it only those of that one); otherwise to the new one in
 * its place, as when its line was edited: the only preset gone and the only one new between the same two
 * components that stay. Anything else (deleted here, added there) is no rename: what was placed from it keeps
 * its settings and follows nothing, rather than take another preset's settings.
 */
export function renamedPresets(before: readonly ComponentDef[] | undefined, after: readonly ComponentDef[]): Record<string, string> {
  const out: Record<string, string> = {};
  const old = before ?? [];
  const had = new Set(old.map((c) => c.name));
  const has = new Set(after.map((c) => c.name));
  let gone = old.filter((c) => !isPart(c) && !has.has(c.name));
  let fresh = after.filter((c) => !isPart(c) && !had.has(c.name));
  const same = (a: ComponentDef, b: ComponentDef) => a.base === b.base && sameSettings(a.base!, componentSymbol(a).params, componentSymbol(b).params);
  const pair = (from: ComponentDef, to: ComponentDef) => {
    out[from.name] = to.name;
    gone = gone.filter((c) => c !== from);
    fresh = fresh.filter((c) => c !== to);
  };
  for (const g of [...gone]) {
    const match = fresh.filter((n) => same(g, n));
    if (match.length === 1 && gone.filter((o) => same(o, match[0])).length === 1) pair(g, match[0]);
  }
  // Its place: the components that stay on either side of it.
  const stays = (c: ComponentDef) => had.has(c.name) && has.has(c.name);
  const place = (list: readonly ComponentDef[], c: ComponentDef) => {
    const k = list.indexOf(c);
    const prev = list.slice(0, k).findLast(stays)?.name ?? '';
    const next = list.slice(k + 1).find(stays)?.name ?? '';
    return `${prev}|${next}`;
  };
  for (const g of [...gone]) {
    const at = place(old, g);
    const there = fresh.filter((n) => place(after, n) === at);
    if (there.length === 1 && there[0].base === g.base && gone.filter((o) => place(old, o) === at).length === 1) pair(g, there[0]);
  }
  return out;
}

/** Whether two `sym` symbols have the same settings (a setting left out is the library's default). */
export function sameSettings(sym: SymKey, a: SymParams, b: SymParams): boolean {
  const x = fullSettings(sym, a);
  const y = fullSettings(sym, b);
  const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
  return [...keys].every((k) => x[k as keyof SymParams] === y[k as keyof SymParams]);
}

/**
 * A placed symbol's settings as JSON, one item to a line, as the window that edits them shows them:
 * `{ "sym": "and", "inputs": 3, "width": 1 }` written out.
 */
export function symbolJson(sym: SymKey, params: SymParams): string {
  const def = SYMBOL_BY_KEY[sym];
  const o: Record<string, unknown> = { sym };
  for (const f of presetFields(sym)) {
    const v = params[f as keyof SymParams] ?? def?.defaults[f as keyof SymParams];
    if (v !== undefined) o[f] = v;
  }
  return JSON.stringify(o, null, 2);
}

/** What the JSON of a placed symbol may set, with the numbers each takes: `"inputs" 2–32, "width" 1–256 bits`. */
export function settingsHint(sym: SymKey): string {
  return presetFields(sym)
    .map((f) => {
      if (f === 'value') return `"value" a Verilog number such as "4'd2"`;
      const [lo, hi] = PARAM_LIMITS[f as keyof typeof PARAM_LIMITS];
      // "width" is bits, not the size of the drawing: say so (the symbol shows them on its pins).
      const unit = f === 'width' ? (sym === 'decoder' ? ' select bits' : ' bits') : f === 'shift' ? ' bits of the shift amount' : '';
      return `"${f}" ${lo}–${f === 'width' && sym === 'decoder' ? 8 : hi}${unit}`;
    })
    .join(', ');
}

/**
 * Read the JSON of a placed symbol (see symbolJson): the parameters it sets, checked as a preset's
 * are. The symbol stays what it is: "sym" may be left out, but not changed.
 */
export function parseSymbolJson(text: string, sym: SymKey): { params: SymParams; error?: undefined } | { error: string; params?: undefined } {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    return { error: `Not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!isObj(v)) return { error: 'Write the settings as { "inputs": 3, … }.' };
  const { sym: s, ...rest } = v;
  const title = SYMBOL_BY_KEY[sym]?.title ?? sym;
  const own = Object.keys(rest).find((k) => k === 'name' || k === 'title' || k === 'base');
  if (own) return { error: `"${own}" is not a setting of a placed symbol (Properties names it).` };
  if (s !== undefined && s !== sym) return { error: `This is ${/^[AEIOU]/.test(title) ? 'an' : 'a'} ${title}: "sym" stays "${sym}" (place another symbol to have another one).` };
  try {
    const d = componentOf({ ...rest, name: 'symbol', base: sym }, 0, () => undefined);
    return { params: d.params ?? {} };
  } catch (e) {
    if (e instanceof Bad) return { error: e.message.replace(/^symbol: /, '') };
    throw e;
  }
}

/** A name for a new component: `stem`, or stem_2, stem_3… when one has it. */
export function freeComponentName(defs: readonly ComponentDef[] | undefined, stem: string, taken: (name: string) => string | undefined = () => undefined): string {
  const used = new Set((defs ?? []).map((d) => d.name));
  // Not a Verilog keyword either (a 1-bit NOT would otherwise be named `not`).
  const ok = (n: string) => NAME.test(n) && verilogIdent(n) === n && !used.has(n) && !taken(n);
  if (ok(stem)) return stem;
  for (let i = 2; ; i++) if (ok(`${stem}_${i}`)) return `${stem}_${i}`;
}
