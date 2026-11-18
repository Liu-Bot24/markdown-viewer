// Dependency direction between the editions: desktop -> core, web -> core, nothing else.
// core never imports Electron or either edition; Node built-ins only in core/src/node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..', '..');
const CORE = path.join(repo, 'packages', 'core');
const WEB = path.join(repo, 'packages', 'web');
const DESKTOP = path.join(repo, 'src');

function files(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules' && e.name !== 'dist') out.push(...files(p));
    } else if (/\.(m?js|cjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

const SPEC_RE = /(?:^|[\s;])(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|(?:^|[\s;(])import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;

function imports(file) {
  const text = fs.readFileSync(file, 'utf8');
  return [...text.matchAll(SPEC_RE)].map((m) => m[1] || m[2] || m[3] || m[4]);
}

const inside = (p, dir) => p === dir || p.startsWith(dir + path.sep);

function check(dir, rule) {
  const bad = [];
  for (const f of files(dir)) {
    for (const spec of imports(f)) {
      const target = spec.startsWith('.') ? path.resolve(path.dirname(f), spec) : null;
      const why = rule(f, spec, target);
      if (why) bad.push(`${path.relative(repo, f)} -> ${spec}: ${why}`);
    }
  }
  return bad;
}

test('core imports neither edition, nor Electron, and Node built-ins only in core/src/node', () => {
  const bad = check(path.join(CORE, 'src'), (f, spec, target) => {
    if (spec === 'electron') return 'Electron';
    if (target && !inside(target, CORE)) return 'outside core';
    if (/^node:|^(fs|path|os|crypto|child_process)$/.test(spec) && !inside(f, path.join(CORE, 'src', 'node'))) return 'Node built-in outside core/src/node';
    return null;
  });
  assert.deepEqual(bad, []);
});

test('the web edition uses core, never the desktop sources', () => {
  const bad = check(path.join(WEB, 'src'), (f, spec, target) => {
    if (spec === 'electron') return 'Electron';
    if (target && !inside(target, WEB) && !inside(target, CORE)) return 'outside web and core';
    return null;
  });
  assert.deepEqual(bad, []);
});

test('the desktop edition uses core, never the web edition', () => {
  const bad = check(DESKTOP, (f, spec, target) => (target && inside(target, WEB) ? 'web edition' : null));
  assert.deepEqual(bad, []);
});

test('the import scan sees the imports it checks', () => {
  const specs = imports(path.join(CORE, 'src', 'ui', 'app.js'));
  assert.ok(specs.includes('./util.js') && specs.includes('../shared/paths.js'));
});
