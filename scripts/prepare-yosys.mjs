// Copies @yowasp/yosys into public/yosys/, gzip-compressing the large core module.
// Run automatically before `dev` and `build`.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const pkgDir = path.resolve('node_modules/@yowasp/yosys');
const gen = path.join(pkgDir, 'gen');
const outDir = path.resolve('public/yosys');
const version = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version;
const stamp = path.join(outDir, 'VERSION');

if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === version) {
  console.log(`public/yosys is up to date (@yowasp/yosys ${version})`);
  process.exit(0);
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(path.join(gen, 'bundle.js'), path.join(outDir, 'bundle.js'));

const CHUNK = 12 * 1024 * 1024; // keep each file well under hosting limits
const modules = {};
for (const f of fs.readdirSync(gen).filter((f) => f.endsWith('.wasm'))) {
  const raw = fs.readFileSync(path.join(gen, f));
  const gz = zlib.gzipSync(raw, { level: 9 });
  const chunks = [];
  for (let i = 0, k = 0; i < gz.length; i += CHUNK, k++) {
    const name = `${f.replace(/\.wasm$/, '')}.${k}.bin`;
    fs.writeFileSync(path.join(outDir, name), gz.subarray(i, i + CHUNK));
    chunks.push(name);
  }
  modules[f] = { chunks, gzip: true, size: gz.length };
  console.log(`${f}: ${(raw.length / 1e6).toFixed(1)} MB -> ${(gz.length / 1e6).toFixed(1)} MB in ${chunks.length} file(s)`);
}
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({ bundle: 'bundle.js', modules }, null, 2));
fs.writeFileSync(stamp, version);
