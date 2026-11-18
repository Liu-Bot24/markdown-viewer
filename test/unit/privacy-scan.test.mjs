// The publishing privacy scan: catches what must not go public, leaves placeholders and
// neutral text alone. All values below are made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanText, historyFindings } from '../../scripts/privacy-scan.mjs';

const rules = (text, terms) => scanText(text, terms).map((f) => f.rule);

test('local paths, private addresses and account ids are caught', () => {
  assert.deepEqual(rules('C:\\Users\\someone\\Desktop'), ['Windows user folder']);
  assert.deepEqual(rules('D:\\资料\\笔记'), ['Windows path on a data drive']);
  assert.deepEqual(rules('E:/work/project'), ['Windows path on a data drive']);
  assert.deepEqual(rules('/tmp/zfsv3/sata1/x/data'), ['NAS storage path']);
  assert.deepEqual(rules('ssh 192.168.7.20 and 10.1.2.3'), ['private IPv4 address', 'private IPv4 address']);
  assert.deepEqual(rules('mail me: someone@mail.test.org'), ['e-mail address']);
  assert.deepEqual(rules('tel 13912345678'), ['mainland mobile number']);
  assert.deepEqual(rules('wxid_abc123def'), ['WeChat account id']);
  // a path inside a file:// URL is still a path once decoded
  assert.deepEqual(rules('file:///D:/' + encodeURIComponent('资料') + '/a.md'), ['Windows path on a data drive']);
  assert.deepEqual(rules('12345678901@chatroom'), ['chatroom id']);
  assert.deepEqual(rules('token ghp_' + 'a'.repeat(36)), ['access token']);
  assert.deepEqual(rules('-----BEGIN OPENSSH PRIVATE KEY-----'), ['private key']);
  assert.deepEqual(rules('MDV_PASSWORD_HASH=scrypt:16384:8:1:' + 'A'.repeat(22) + ':' + 'B'.repeat(43)), ['password hash']);
});

test('placeholders, neutral paths and allowed addresses are not flagged', () => {
  const clean = [
    'C:\\Users\\<name>\\AppData',
    'C:\\Users\\Public',
    'D:\\<归档目录>',
    'X:\\示例归档\\01_个人私聊 and X:\\proj\\rel',
    'a@b.com and foo@bar.example.com',
    'wxid_bigpeer and wxid_hashpeer01',
    '/roots/archive and /state and /cache',
    '/tmp/zfsv3/<存储池>/…',
    'noreply@anthropic.com, someone@example.com',
    'version 1.2.3.4, 172.15.0.1 is public, 8.8.8.8',
    'wxid_test01 and wxid_xxxx',
    'wxid_zhangsan and wxid_wangwu',
    'file:///X:/' + encodeURIComponent('示例归档') + '/a%20b.md',
    'a timestamp 1794907635493 is not a phone number',
    'port 8080:8080',
  ].join('\n');
  assert.deepEqual(scanText(clean), []);
});

test('deny-list terms match case-insensitively and are masked in the report', () => {
  const f = scanText('Hello Secret-Host here', ['secret-host']);
  assert.equal(f.length, 1);
  assert.equal(f[0].rule, 'deny list');
  assert.equal(f[0].match, 's*********t');
  assert.deepEqual(scanText('nothing here', ['secret-host']), []);
});

test('a private term inside another finding is masked too', () => {
  const f = scanText('D:\\资料\\某某测试群\\a.md', ['某某测试群']);
  assert.ok(f.length >= 2);
  for (const x of f) assert.ok(!x.match.includes('某某测试群'), x.match);
});

test('the history scan reads every commit, including ones only the reflog still holds', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdv-history-'));
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...a], { cwd: dir, stdio: 'pipe' }).toString().trim();
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  try {
    git('init', '-q', '-b', 'main');
    write('a.md', 'see E:/work/project/notes\n');
    write('Secret-Host.md', 'nothing\n');
    write('scripts/privacy-scan.mjs', "rule example 'D:\\\\资料\\\\笔记'\n");
    git('add', '.');
    git('commit', '-q', '-m', 'first, mail someone@mail.test.org');
    const first = 'commit ' + git('rev-parse', '--short=7', 'HEAD');
    const where = (h) => h.findings.map((f) => `${f.where} ${f.rule}`).sort();
    const expected = [
      `${first} message e-mail address`,
      `${first}:Secret-Host.md deny list`,
      `${first}:a.md Windows path on a data drive`,
    ];
    // a later commit cleans the files: the first version is still found
    write('a.md', 'see X:\\proj\\notes\n');
    fs.rmSync(path.join(dir, 'Secret-Host.md'));
    git('commit', '-q', '-am', 'second');
    let h = historyFindings(dir, ['secret-host']);
    assert.equal(h.commits, 2);
    assert.deepEqual(where(h), expected);
    // no branch holds the first commit any more, but the reflog does
    git('checkout', '-q', '--orphan', 'fresh');
    git('commit', '-q', '-m', 'fresh start');
    git('branch', '-D', 'main');
    assert.deepEqual(where(historyFindings(dir, ['secret-host'])), expected);
    git('reflog', 'expire', '--expire=now', '--all');
    h = historyFindings(dir, ['secret-host']);
    assert.equal(h.commits, 1);
    assert.deepEqual(h.findings, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an ASCII deny-list term must stand alone; other scripts match anywhere', () => {
  assert.equal(scanText('a Mark here', ['mark']).length, 1);
  assert.deepEqual(scanText('Markdown and bookmark', ['mark']), []);
  assert.equal(scanText('群名是某某测试群吗', ['某某测试群']).length, 1);
});
