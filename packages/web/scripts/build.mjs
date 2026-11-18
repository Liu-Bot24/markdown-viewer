// Bundle the web front end into packages/web/dist/public (served by the server).
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const web = path.resolve(import.meta.dirname, '..');
const core = path.resolve(web, '..', 'core');
const out = path.join(web, 'dist', 'public');
const require = createRequire(import.meta.url);
const watch = process.argv.includes('--watch');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'assets'), { recursive: true });

const katexDir = path.dirname(require.resolve('katex/package.json'));
const common = {
  bundle: true,
  target: ['chrome110', 'safari16', 'firefox115'],
  minify: !watch,
  sourcemap: 'linked',
  legalComments: 'none',
  alias: { katex: katexDir },
  logLevel: 'warning',
};

const builds = [
  {
    ...common,
    entryPoints: { app: path.join(web, 'src/shell/app-web.js') },
    outdir: out,
    format: 'esm',
    splitting: true,
    chunkNames: 'chunks/[name]-[hash]',
  },
  { ...common, entryPoints: { worker: path.join(core, 'src/render/worker.js') }, outdir: out, format: 'esm' },
  {
    ...common,
    entryPoints: { app: path.join(web, 'src/shell/web.css') },
    outdir: out,
    loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file' },
    assetNames: 'fonts/[name]-[hash]',
  },
];

for (const [from, to] of [
  ['src/shell/index.html', 'index.html'],
  ['src/shell/login.html', 'login.html'],
  ['src/shell/login.js', 'assets/login.js'],
  ['src/shell/login.css', 'assets/login.css'],
]) {
  fs.copyFileSync(path.join(web, from), path.join(out, to));
}
const icon = path.resolve(web, '..', '..', 'assets', 'icon.png');
if (fs.existsSync(icon)) fs.copyFileSync(icon, path.join(out, 'icon.png'));

if (watch) {
  for (const b of builds) (await esbuild.context(b)).watch();
  console.log('watching…');
} else {
  const t0 = Date.now();
  await Promise.all(builds.map((b) => esbuild.build(b)));
  console.log(`web front end built in ${Date.now() - t0} ms -> ${path.relative(process.cwd(), out)}`);
}
