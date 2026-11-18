// Overwriting a file on a writable root. Only reached after every gate holds:
// writing not disabled, the root listed as writable and mounted read-write,
// the exact confirmation sentence typed, and the file unchanged since it was read.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hashBytes, writeTextFile } from '../../../core/src/node/textfile.js';

export const KEEP_VERSIONS = 5;

/** The sentence the user types to confirm; the server checks the same text. */
export function confirmSentence(name) {
  return `我确认用编辑后的内容覆盖 ${name}`;
}

async function saveOldVersion(stateDir, vpath, abs, bytes) {
  const dir = path.join(stateDir, 'versions', crypto.createHash('sha1').update(vpath).digest('hex').slice(0, 16));
  await fs.promises.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${stamp}-${path.basename(abs)}`);
  await fs.promises.writeFile(file, bytes);
  await fs.promises.writeFile(path.join(dir, 'path.txt'), vpath + '\n');
  const old = (await fs.promises.readdir(dir)).filter((n) => n !== 'path.txt').sort();
  for (const n of old.slice(0, Math.max(0, old.length - KEEP_VERSIONS))) await fs.promises.unlink(path.join(dir, n)).catch(() => {});
  return file;
}

/**
 * opts: { text, encoding, expectHash, allowLossy, confirm }.
 * Returns the writeTextFile result, or { ok: false, code } for a refused gate.
 */
export async function overwrite({ cfg, resolved, opts, log }) {
  const { root, abs, vpath } = resolved;
  if (cfg.disableWrite) return { ok: false, code: 'EWRITEOFF' };
  if (!root.writable) return { ok: false, code: 'EREADONLY' };
  if (typeof opts.text !== 'string' || typeof opts.encoding !== 'string') return { ok: false, code: 'EBADREQ' };
  if (opts.confirm !== confirmSentence(path.basename(abs))) return { ok: false, code: 'ECONFIRM' };
  if (!opts.expectHash) return { ok: false, code: 'EBADREQ' };
  // A conflict is never overridden on the web: export first, then reload.
  let current;
  try {
    current = await fs.promises.readFile(abs);
  } catch (e) {
    return { ok: false, code: e.code === 'ENOENT' ? 'EGONE' : e.code || 'EIO' };
  }
  if (hashBytes(current) !== opts.expectHash) return { ok: false, code: 'ECONFLICT' };
  try {
    await saveOldVersion(cfg.stateDir, vpath, abs, current);
  } catch (e) {
    return { ok: false, code: 'EVERSION', message: '无法保存旧版本：' + e.message };
  }
  const r = await writeTextFile(abs, { text: opts.text, encoding: opts.encoding, expectHash: opts.expectHash, allowConflict: false, allowLossy: !!opts.allowLossy });
  if (r.ok) log.info(`覆盖写回：${vpath}`);
  return r;
}
