// How a text file is stored on disk: encoding (with BOM) and line endings.
// Decoding runs in the renderer and in tests; encoding needs iconv-lite (main process).

/** Decode file bytes: UTF-8 (with or without BOM), else UTF-16 by BOM, else GB18030. */
export function decodeText(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8[0] === 0xff && u8[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(u8), encoding: 'UTF-16 LE' };
  if (u8[0] === 0xfe && u8[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(u8), encoding: 'UTF-16 BE' };
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(u8);
    return { text, encoding: u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf ? 'UTF-8 BOM' : 'UTF-8' };
  } catch {
    return { text: new TextDecoder('gb18030').decode(u8), encoding: 'GB18030' };
  }
}

/**
 * Dominant line ending of `text` ('\r\n', '\n' or '\r'); `mixed` when more than one kind occurs.
 * A file without any line break gets the Windows default.
 */
export function detectEol(text) {
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) {
        crlf++;
        i++;
      } else cr++;
    } else if (c === 10) lf++;
  }
  const kinds = (crlf > 0) + (lf > 0) + (cr > 0);
  let eol = '\r\n';
  if (lf > crlf && lf >= cr) eol = '\n';
  else if (cr > crlf && cr > lf) eol = '\r';
  return { eol, mixed: kinds > 1 };
}

export const eolName = (eol) => (eol === '\r\n' ? 'CRLF' : eol === '\n' ? 'LF' : 'CR');
