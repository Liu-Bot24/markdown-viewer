// Saving edited documents back in the file's own encoding, refusing to overwrite
// changes made on disk by someone else since the document was read.

import crypto from 'node:crypto';
import fs from 'node:fs';
import iconv from 'iconv-lite';
import { decodeText } from '../shared/textformat.js';

export const hashBytes = (b) => crypto.createHash('sha256').update(b).digest('hex');

export function encodeText(text, encoding) {
  switch (encoding) {
    case 'UTF-8':
      return Buffer.from(text, 'utf8');
    case 'UTF-8 BOM':
      return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
    case 'UTF-16 LE':
      return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
    case 'UTF-16 BE':
      return Buffer.concat([Buffer.from([0xfe, 0xff]), iconv.encode(text, 'utf16-be')]);
    case 'GB18030':
      return iconv.encode(text, 'gb18030');
    default:
      throw new Error('unsupported encoding ' + encoding);
  }
}

/**
 * Write `text` to `p` in `encoding`.
 * expectHash: hash of the bytes the editor was loaded from (null for a new file).
 * allowConflict: overwrite even though the file changed or vanished on disk.
 * allowLossy: write even though re-encoding the original would not reproduce its bytes
 *             (the file contained bytes the detected encoding cannot represent).
 * Returns { ok, hash, mtimeMs, size } or { ok: false, code } with code one of
 * ECONFLICT, EGONE, ELOSSY (text not representable), ELOSSY_ORIG, or an fs error code.
 */
export async function writeTextFile(p, { text, encoding, expectHash = null, allowConflict = false, allowLossy = false }) {
  let current = null;
  try {
    current = await fs.promises.readFile(p);
  } catch (e) {
    if (e.code !== 'ENOENT') return { ok: false, code: e.code || 'EIO', message: String(e.message || e) };
  }
  if (!allowConflict) {
    if (expectHash && !current) return { ok: false, code: 'EGONE' };
    if (current && hashBytes(current) !== expectHash) return { ok: false, code: 'ECONFLICT' };
  }
  let bytes;
  try {
    bytes = encodeText(text, encoding);
  } catch (e) {
    return { ok: false, code: 'ELOSSY', message: String(e.message || e) };
  }
  if (decodeText(bytes).text !== text) return { ok: false, code: 'ELOSSY' };
  if (!allowLossy && current && hashBytes(current) === expectHash) {
    const orig = decodeText(current);
    let again = null;
    try {
      again = encodeText(orig.text, encoding);
    } catch {
      /* treated as lossy below */
    }
    if (!again || !again.equals(current)) return { ok: false, code: 'ELOSSY_ORIG' };
  }
  try {
    // In place, like most editors: keeps the file's identity, ACLs and hard links.
    await fs.promises.writeFile(p, bytes);
    const st = await fs.promises.stat(p);
    return { ok: true, hash: hashBytes(bytes), mtimeMs: st.mtimeMs, size: st.size };
  } catch (e) {
    return { ok: false, code: e.code || 'EIO', message: String(e.message || e) };
  }
}
