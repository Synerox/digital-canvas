// Copies @yowasp/yosys into public/yosys/, gzip-compressing the large core module.
// Run automatically before `dev` and `build`.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const pkgDir = path.resolve('node_modules/@yowasp/yosys');
const gen = path.join(pkgDir, 'gen');
const outDir = path.resolve('public/yosys');
const version = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version;
// Bump FORMAT when the files written here change shape, so existing copies are rebuilt.
const FORMAT = 3;
const stampText = `${version} format ${FORMAT}`;
const stamp = path.join(outDir, 'VERSION');

if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === stampText) {
  console.log(`public/yosys is up to date (@yowasp/yosys ${version})`);
  process.exit(0);
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
// The bundle's name carries its hash: the manifest (always fetched fresh) then names the bundle that
// matches the core, and a browser never pairs a new core with an older bundle from its HTTP cache.
const bundle = fs.readFileSync(path.join(gen, 'bundle.js'));
const bundleName = `bundle-${crypto.createHash('sha256').update(bundle).digest('hex').slice(0, 12)}.js`;
fs.writeFileSync(path.join(outDir, bundleName), bundle);

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
  // The browser checks downloads against this and keeps the core in its Cache Storage under it.
  const sha256 = crypto.createHash('sha256').update(gz).digest('hex');
  modules[f] = { chunks, gzip: true, size: gz.length, sha256 };
  console.log(`${f}: ${(raw.length / 1e6).toFixed(1)} MB -> ${(gz.length / 1e6).toFixed(1)} MB in ${chunks.length} file(s)`);
}
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({ bundle: bundleName, version, modules }, null, 2));
fs.writeFileSync(stamp, stampText);
