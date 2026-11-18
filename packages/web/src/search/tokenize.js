// Text preparation for the FTS5 index (tokenize='unicode61'): runs of CJK characters
// become overlapping two-character tokens ("下午三点" -> "下午 午三 三点") plus the run's
// last character on its own, so one-character queries can be answered by a prefix match.
// Everything else is left to unicode61 (case-folded words).

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const CJK_ONE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const WORD = /[\p{L}\p{N}\p{M}_]+/gu;
const WORD_ONE = /[\p{L}\p{N}\p{M}_]/u;

function bigrams(run, withTail) {
  const chars = Array.from(run);
  if (chars.length === 1) return chars;
  const out = [];
  for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i] + chars[i + 1]);
  if (withTail) out.push(chars[chars.length - 1]);
  return out;
}

/** Document text -> string of space-separated tokens for the index. */
export function indexText(text) {
  return tokensOf(text, true).join(' ');
}

/**
 * Tokens in order. Document side (doc=true) always adds each CJK run's tail character.
 * Query side adds it only when more tokens follow inside the same term.
 */
export function tokensOf(text, doc) {
  const s = String(text).toLowerCase();
  const out = [];
  let last = 0;
  const pushWords = (part) => {
    for (const w of part.match(WORD) || []) out.push(w);
  };
  const runs = [...s.matchAll(CJK)];
  runs.forEach((m, k) => {
    pushWords(s.slice(last, m.index));
    last = m.index + m[0].length;
    const more = k < runs.length - 1 || WORD_ONE.test(s.slice(last));
    out.push(...bigrams(m[0], doc || more));
  });
  pushWords(s.slice(last));
  return out;
}

/**
 * Parse a user query: whitespace separates terms that must all appear; "double quotes"
 * keep a phrase together. Returns terms: [{ text, tokens, prefixLast }].
 */
export function parseQuery(q) {
  const terms = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(String(q)))) {
    const text = (m[1] ?? m[2]).trim();
    if (!text) continue;
    const tokens = tokensOf(text, false);
    if (!tokens.length) continue;
    const lastTok = tokens[tokens.length - 1];
    // a lone CJK character, or a Latin/number word at the end, matches as a prefix
    const prefixLast = !CJK_ONE.test(lastTok) || Array.from(lastTok).length === 1;
    terms.push({ text, tokens, prefixLast });
  }
  return terms;
}

const quote = (t) => '"' + t.replace(/"/g, '""') + '"';

/** FTS5 MATCH expression for parsed terms (AND of phrases). */
export function ftsQuery(terms) {
  return terms
    .map((t) => {
      const parts = t.tokens.map(quote);
      const phrase = parts.join(' + ');
      return t.prefixLast ? phrase + ' *' : phrase;
    })
    .join(' AND ');
}

/** The same matching rules on plain text (for files not in the index yet). */
export function matchesText(text, terms) {
  const toks = tokensOf(text, true);
  return terms.every((t) => containsPhrase(toks, t));
}

function containsPhrase(toks, t) {
  const n = t.tokens.length;
  outer: for (let i = 0; i + n <= toks.length; i++) {
    for (let j = 0; j < n; j++) {
      const want = t.tokens[j];
      const got = toks[i + j];
      if (j === n - 1 && t.prefixLast ? !got.startsWith(want) : got !== want) continue outer;
    }
    return true;
  }
  return false;
}

/** Character ranges in `text` to highlight for the terms (case-insensitive substring of each term). */
export function highlightRanges(text, terms) {
  const lower = String(text).toLowerCase();
  const ranges = [];
  for (const t of terms) {
    const needle = t.text.toLowerCase().replace(/\s+/g, ' ');
    if (!needle) continue;
    for (let i = lower.indexOf(needle); i !== -1; i = lower.indexOf(needle, i + needle.length)) ranges.push([i, i + needle.length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  return merged;
}
