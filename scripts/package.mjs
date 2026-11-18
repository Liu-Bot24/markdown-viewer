// Package the app as out/mdview-win32-x64/mdview.exe (run `npm run package`, which builds first).
// Only the runtime files go in: main/preload/shared sources, the built renderer, assets,
// and production node_modules (the renderer libraries are bundled by esbuild).
import { packager } from '@electron/packager';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (!fs.existsSync(path.join(root, 'dist', 'renderer', 'index.html'))) {
  console.error('dist/renderer is missing: run `node scripts/build.mjs` first');
  process.exit(1);
}

const KEEP = ['/package.json', '/src/main', '/src/preload', '/src/shared', '/packages/core/src/shared', '/packages/core/src/node', '/dist/renderer', '/assets', '/node_modules'];
function ignore(p) {
  if (!p) return false;
  const q = p.replace(/\\/g, '/');
  if (q.endsWith('.map') || q.startsWith('/node_modules/.bin') || q === '/node_modules/.package-lock.json') return true;
  if (q === '/node_modules/@mdv' || q.startsWith('/node_modules/@mdv/')) return true; // workspace links
  // keep listed paths, their contents, and the directories leading to them
  return !KEEP.some((k) => q === k || q.startsWith(k + '/') || k.startsWith(q + '/'));
}

// --out <dir>: package somewhere else (test builds), leaving out/ alone
const outArg = process.argv.indexOf('--out');
const [appPath] = await packager({
  dir: root,
  out: outArg !== -1 ? path.resolve(process.argv[outArg + 1]) : path.join(root, 'out'),
  name: 'mdview',
  executableName: 'mdview',
  appVersion: pkg.version,
  platform: 'win32',
  arch: 'x64',
  icon: path.join(root, 'assets', 'icon.ico'),
  asar: true,
  prune: true,
  overwrite: true,
  ignore,
  win32metadata: {
    CompanyName: 'mdview',
    FileDescription: pkg.productName,
    ProductName: pkg.productName,
    InternalName: 'mdview',
    OriginalFilename: 'mdview.exe',
  },
});
console.log('packaged ->', path.join(appPath, 'mdview.exe'));
