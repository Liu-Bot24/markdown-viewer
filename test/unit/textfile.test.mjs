import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import iconv from 'iconv-lite';
import { decodeText, detectEol } from '../../packages/core/src/shared/textformat.js';
import { encodeText, hashBytes, writeTextFile } from '../../packages/core/src/node/textfile.js';
import { ROOT } from './helpers.mjs';

// Scratch files live in the ignored test/output folder and are overwritten on every run.
const DIR = path.join(ROOT, 'test', 'output', 'textfile');
fs.mkdirSync(DIR, { recursive: true });

const SAMPLE = '# 月报 2026-10\r\n\r\n- 第一条：苹果🍎\r\n- 第二条 `code`\r\n';

const SAMPLES = {
  'UTF-8': Buffer.from(SAMPLE, 'utf8'),
  'UTF-8 BOM': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(SAMPLE, 'utf8')]),
  'UTF-16 LE': Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(SAMPLE, 'utf16le')]),
  'UTF-16 BE': Buffer.concat([Buffer.from([0xfe, 0xff]), iconv.encode(SAMPLE, 'utf16-be')]),
  GB18030: iconv.encode(SAMPLE, 'gb18030'),
};

/** What the editor does: work on '\n' text, join lines with the file's own line ending. */
function editLikeTheApp(text, edit) {
  const { eol } = detectEol(text);
  return edit(text.replace(/\r\n?/g, '\n')).split('\n').join(eol);
}

for (const [encoding, bytes] of Object.entries(SAMPLES)) {
  test(`${encoding}: decoding is detected and re-encoding reproduces the bytes`, () => {
    const d = decodeText(bytes);
    assert.equal(d.encoding, encoding);
    assert.equal(d.text, SAMPLE);
    assert.ok(encodeText(d.text, encoding).equals(bytes));
  });

  test(`${encoding}: saving an edit keeps encoding, BOM and CRLF`, async () => {
    const p = path.join(DIR, `edit-${encoding.replace(/\W+/g, '_')}.md`);
    fs.writeFileSync(p, bytes);
    const d = decodeText(bytes);
    const text = editLikeTheApp(d.text, (t) => t.replace('第二条', '第二条（已修改）') + '- 新增\n');
    const r = await writeTextFile(p, { text, encoding: d.encoding, expectHash: hashBytes(bytes) });
    assert.equal(r.ok, true, JSON.stringify(r));
    const want = SAMPLE.replace('第二条', '第二条（已修改）') + '- 新增\r\n';
    const got = fs.readFileSync(p);
    assert.ok(got.equals(encodeText(want, encoding)));
    assert.equal(decodeText(got).encoding, encoding);
    assert.equal(r.hash, hashBytes(got));
  });
}

test('line endings: dominant kind wins, mixed files are flagged', () => {
  assert.deepEqual(detectEol('a\r\nb\r\n'), { eol: '\r\n', mixed: false });
  assert.deepEqual(detectEol('a\nb\n'), { eol: '\n', mixed: false });
  assert.deepEqual(detectEol('a\rb\r'), { eol: '\r', mixed: false });
  assert.deepEqual(detectEol('a\r\nb\nc\r\n'), { eol: '\r\n', mixed: true });
  assert.deepEqual(detectEol('a\nb\nc\r\n'), { eol: '\n', mixed: true });
  assert.deepEqual(detectEol('no line break'), { eol: '\r\n', mixed: false });
});

test('LF file stays LF after an edit', async () => {
  const p = path.join(DIR, 'lf.md');
  const bytes = Buffer.from('a\nb\n', 'utf8');
  fs.writeFileSync(p, bytes);
  const text = editLikeTheApp('a\nb\n', (t) => t + 'c\n');
  const r = await writeTextFile(p, { text, encoding: 'UTF-8', expectHash: hashBytes(bytes) });
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(p, 'utf8'), 'a\nb\nc\n');
});

test('a file changed on disk since it was read is not overwritten without consent', async () => {
  const p = path.join(DIR, 'conflict.md');
  const original = Buffer.from('原文\n', 'utf8');
  fs.writeFileSync(p, original);
  fs.writeFileSync(p, '别人改过\n');
  const r = await writeTextFile(p, { text: '我的修改\n', encoding: 'UTF-8', expectHash: hashBytes(original) });
  assert.equal(r.code, 'ECONFLICT');
  assert.equal(fs.readFileSync(p, 'utf8'), '别人改过\n');
  const forced = await writeTextFile(p, { text: '我的修改\n', encoding: 'UTF-8', expectHash: hashBytes(original), allowConflict: true });
  assert.equal(forced.ok, true);
  assert.equal(fs.readFileSync(p, 'utf8'), '我的修改\n');
});

test('a file deleted since it was read is only recreated with consent', async () => {
  const p = path.join(DIR, 'gone.md');
  const original = Buffer.from('x\n', 'utf8');
  fs.writeFileSync(p, original);
  fs.unlinkSync(p);
  const r = await writeTextFile(p, { text: 'y\n', encoding: 'UTF-8', expectHash: hashBytes(original) });
  assert.equal(r.code, 'EGONE');
  assert.equal(fs.existsSync(p), false);
  const forced = await writeTextFile(p, { text: 'y\n', encoding: 'UTF-8', expectHash: hashBytes(original), allowConflict: true });
  assert.equal(forced.ok, true);
  assert.equal(fs.readFileSync(p, 'utf8'), 'y\n');
});

test('bytes the detected encoding cannot represent are reported before saving', async () => {
  const p = path.join(DIR, 'lossy.md');
  // valid GB18030 text followed by a byte that is not a valid sequence
  const bytes = Buffer.concat([iconv.encode('中文', 'gb18030'), Buffer.from([0x80])]);
  fs.writeFileSync(p, bytes);
  const d = decodeText(bytes);
  assert.equal(d.encoding, 'GB18030');
  const r = await writeTextFile(p, { text: d.text + '!', encoding: d.encoding, expectHash: hashBytes(bytes) });
  assert.equal(r.code, 'ELOSSY_ORIG');
  assert.ok(fs.readFileSync(p).equals(bytes));
  const forced = await writeTextFile(p, { text: d.text + '!', encoding: d.encoding, expectHash: hashBytes(bytes), allowLossy: true });
  assert.equal(forced.ok, true);
});

test('text that cannot be encoded is refused, not silently changed', async () => {
  const p = path.join(DIR, 'unencodable.md');
  const bytes = Buffer.from('a\n', 'utf8');
  fs.writeFileSync(p, bytes);
  const r = await writeTextFile(p, { text: 'a\uD800\n', encoding: 'UTF-8', expectHash: hashBytes(bytes) });
  assert.equal(r.code, 'ELOSSY');
  assert.ok(fs.readFileSync(p).equals(bytes));
});
