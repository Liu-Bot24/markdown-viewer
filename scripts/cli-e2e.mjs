// End-to-end check of the command-line contract and the single-instance hand-off:
// a first instance runs test/selftest/cli.json and waits; second instances are then
// launched with `<path>#anchor`, a relative path containing `#`, and `--anchor`.
// Each second instance must exit 0 quickly and the first must show its target.
//
// usage: node scripts/cli-e2e.mjs [path-to-mdview.exe]   (default: electron in dev mode)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = path.join(root, 'test', 'fixtures');
const exe = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const appArgs = process.argv[2] ? [] : [root]; // absolute: launches below use other working directories
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mdview-cli-e2e-'));
const env = { ...process.env, MDV_USER_DATA: userData, MDV_LOG: '1', MDV_TEST_ROOT: root };

function run(args, cwd) {
  const t0 = Date.now();
  const p = spawn(exe, [...appArgs, ...args], { cwd, env, windowsHide: true });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  return { p, t0, get out() { return out; } };
}

function exited(h, timeout) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      h.p.kill();
      resolve({ code: 'timeout', ms: Date.now() - h.t0 });
    }, timeout);
    h.p.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, ms: Date.now() - h.t0 });
    });
  });
}

const chat = path.join(fixtures, 'wechat', '聊天记录归档', '01_个人私聊', '测试 联系人🍎', '聊天记录', '2026-09_001.md');
const hashChat = path.join(fixtures, 'wechat', '聊天记录归档', '01_个人私聊', '#', '聊天记录', '2026-09_001.md');
const report = path.join('..', '聊天记录月报', '2026-09', '月报_2026-09.md');

// cold start with a relative target (cwd = test/fixtures/wechat/聊天记录归档)
const first = run([report + '#一页速览', '--selftest', path.join(root, 'test', 'selftest', 'cli.json')], path.join(fixtures, 'wechat', '聊天记录归档'));
const firstExit = exited(first, 120000);
for (let i = 0; i < 300 && !first.out.includes('selftest: ready'); i++) await new Promise((r) => setTimeout(r, 100));
if (!first.out.includes('selftest: ready')) {
  console.error('first instance did not become ready\n' + first.out);
  process.exit(1);
}
// Wait until the first instance has reported on `step` (its PASS/FAIL line), so each
// hand-off is checked before the next one replaces it.
async function stepDone(step, timeout = 40000) {
  const re = new RegExp(`^(PASS|FAIL) ${step} `, 'm');
  for (const t0 = Date.now(); Date.now() - t0 < timeout; ) {
    if (re.test(first.out)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

const launches = [
  { name: 'path#anchor', step: 'handoff-path-hash-anchor', args: [chat + '#msg-0000000000000000000000a7'], cwd: os.tmpdir() },
  { name: 'relative path with #', step: 'handoff-relative-hash-dir', args: ['sub#dir\\inner file.md'], cwd: path.join(fixtures, 'gfm') },
  { name: '--anchor option', step: 'handoff-anchor-option', args: [hashChat, '--anchor', 'msg-00000000000000000000hash2'], cwd: root },
];
let failed = 0;
await stepDone('cold-start-target');
for (const l of launches) {
  const r = await exited(run(l.args, l.cwd), 15000);
  const ok = r.code === 0;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} second instance (${l.name}) exit=${r.code} in ${r.ms} ms`);
  await stepDone(l.step);
}

const f = await firstExit;
const lines = first.out.split(/\r?\n/).filter((s) => /^(PASS|FAIL|selftest:|open-targets)/.test(s));
console.log(lines.join('\n'));
if (f.code !== 0) failed++;
console.log(failed ? `cli-e2e: FAILED (${failed})` : 'cli-e2e: all passed');
fs.rmSync(userData, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
