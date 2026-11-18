// Bundle the desktop renderer (app, render worker, styles) into dist/renderer.
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'dist', 'renderer');
const require = createRequire(import.meta.url);
const watch = process.argv.includes('--watch');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// One KaTeX copy for the whole bundle (the plugin pins an older nested version).
const katexDir = path.dirname(require.resolve('katex/package.json'));
const common = {
  bundle: true,
  target: 'chrome130',
  minify: !watch,
  sourcemap: 'linked',
  legalComments: 'none',
  alias: { katex: katexDir },
  logLevel: 'warning',
};

const builds = [
  {
    ...common,
    entryPoints: { app: path.join(root, 'src/renderer/app-desktop.js') },
    outdir: out,
    format: 'esm',
    splitting: true,
    chunkNames: 'chunks/[name]-[hash]',
  },
  {
    ...common,
    entryPoints: { worker: path.join(root, 'packages/core/src/render/worker.js') },
    outdir: out,
    format: 'esm',
  },
  {
    ...common,
    entryPoints: { app: path.join(root, 'packages/core/src/ui/styles/app.css') },
    outdir: out,
    loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file' },
    assetNames: 'fonts/[name]-[hash]',
  },
];

fs.copyFileSync(path.join(root, 'src/renderer/index.html'), path.join(out, 'index.html'));

if (watch) {
  for (const b of builds) (await esbuild.context(b)).watch();
  console.log('watching…');
} else {
  const t0 = Date.now();
  await Promise.all(builds.map((b) => esbuild.build(b)));
  console.log(`renderer built in ${Date.now() - t0} ms -> ${path.relative(root, out)}`);
}
