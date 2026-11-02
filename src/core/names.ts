/**
 * A module name as the user wrote it. Yosys names its copy of a parameterized
 * module `$paramod\ripple\N=s32'00…01000`; that reads `ripple #(N=8)`. Long
 * parameter lists are hashed (`$paramod$3f…\ripple`): `ripple #(…)`.
 */
export function moduleTitle(name: string): string {
  const m = /^\$paramod(\$[0-9a-f]+)?\\([^\\]+)((?:\\.*)?)$/.exec(name);
  if (!m) return name;
  if (m[1] || !m[3]) return `${m[2]} #(…)`;
  const value = (v: string) => {
    const c = /^(s?)(\d+)'([01]+)$/.exec(v);
    if (!c) return v;
    let n = BigInt(`0b${c[3]}`);
    if (c[1] && c[3].length > 0 && c[3][0] === '1') n -= 1n << BigInt(c[3].length);
    return String(n);
  };
  const params = m[3]
    .slice(1)
    .split('\\')
    .map((p) => {
      const i = p.indexOf('=');
      return i < 0 ? p : `${p.slice(0, i)}=${value(p.slice(i + 1))}`;
    });
  return `${m[2]} #(${params.join(', ')})`;
}
