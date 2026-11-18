// Markdown -> HTML string. Runs in the render worker and in Node tests (no DOM needed).
// Sanitising happens afterwards on the main thread (sanitize.js).

import MarkdownIt from 'markdown-it';
import footnote from 'markdown-it-footnote';
import taskLists from 'markdown-it-task-lists';
import frontMatter from 'markdown-it-front-matter';
import githubAlerts from 'markdown-it-github-alerts';
import cjkFriendly from 'markdown-it-cjk-friendly';
import mdKatex from '@vscode/markdown-it-katex';
import katex from 'katex';
import hljs from 'highlight.js';
import GithubSlugger from 'github-slugger';
import { isChatMarkdown } from '../shared/chat.js';

const HIGHLIGHT_LIMIT = 200_000; // characters per code block; larger blocks stay plain

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function headingText(inline) {
  if (!inline || !inline.children) return inline ? inline.content : '';
  let s = '';
  for (const t of inline.children) {
    if (t.type === 'text' || t.type === 'code_inline' || t.type === 'math_inline') s += t.content;
    else if (t.type === 'image') s += headingText(t);
    else if (t.type === 'softbreak' || t.type === 'hardbreak') s += ' ';
  }
  return s;
}

function highlightCode(code, lang) {
  if (code.length <= HIGHLIGHT_LIMIT && lang && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    } catch {
      /* fall through */
    }
  }
  return escapeHtml(code);
}

// Full-width / CJK punctuation acts as a boundary for fuzzy links and emails
// ("邮箱：a@b.com", "、www.x.com"). Same-length replacement keeps match offsets valid.
const CJK_PUNCT_RE = /[　-〿！-／：-＠［-｀｛-･]/g;

function gfmLinkify(md) {
  // GFM extended autolinks: scheme links, emails and "www." hosts only. Other
  // fuzzy hosts are dropped so plain file names such as "readme.md" (".md" is a
  // real TLD) stay text.
  md.linkify.set({ fuzzyLink: true, fuzzyEmail: true, fuzzyIP: false });
  const match = md.linkify.match.bind(md.linkify);
  const test = md.linkify.test.bind(md.linkify);
  const prep = (s) => s.replace(CJK_PUNCT_RE, ' ');
  md.linkify.match = (text) => {
    const found = match(prep(text)) || [];
    return found.filter((m) => m.schema !== '' || /^www\./i.test(m.raw));
  };
  md.linkify.test = (text) => test(prep(text)) && md.linkify.match(text).length > 0;

  // markdown-it matches scheme autolinks on the raw source, so "\_" and "&amp;"
  // end up inside the URL. GFM recognises autolinks after escapes and entities
  // are resolved (WeChat archive text escapes "_" and "&" this way).
  const { unescapeAll } = md.utils;
  md.core.ruler.after('inline', 'mdv_linkify_unescape', (state) => {
    for (const blk of state.tokens) {
      if (blk.type !== 'inline' || !blk.children) continue;
      const ch = blk.children;
      for (let i = 0; i + 1 < ch.length; i++) {
        const t = ch[i];
        const txt = ch[i + 1];
        if (t.type !== 'link_open' || t.markup !== 'linkify' || txt.type !== 'text' || !/[\\&]/.test(txt.content)) continue;
        const fixed = unescapeAll(txt.content);
        const href = md.normalizeLink(fixed);
        if (!md.validateLink(href)) continue;
        txt.content = fixed;
        t.attrSet('href', href);
      }
    }
  });
}

// Inline $…$ with Pandoc/GitHub delimiter rules: the opening $ is followed by a
// non-space, the closing $ is preceded by a non-space and not followed by a digit.
// Keeps "价格 $5 到 $10" as text.
function strictInlineMath(state, silent) {
  const src = state.src;
  const start = state.pos;
  if (src.charCodeAt(start) !== 0x24 /* $ */ || src.charCodeAt(start + 1) === 0x24) return false;
  const first = src[start + 1];
  if (first === undefined || /\s/.test(first)) return false;
  let pos = start + 1;
  while ((pos = src.indexOf('$', pos)) !== -1) {
    let bs = 0;
    for (let k = pos - 1; src[k] === '\\'; k--) bs++;
    const prev = src[pos - 1];
    const next = src[pos + 1];
    if (bs % 2 === 0 && !/\s/.test(prev) && !(next >= '0' && next <= '9') && pos > start + 1) break;
    pos++;
  }
  if (pos === -1 || pos > state.posMax) return false;
  if (!silent) {
    const token = state.push('math_inline', 'math', 0);
    token.markup = '$';
    token.content = src.slice(start + 1, pos);
  }
  state.pos = pos + 1;
  return true;
}

export function createMarkdown({ math = true } = {}) {
  const md = new MarkdownIt({
    html: true,
    linkify: true,
    typographer: false,
    breaks: false,
  });
  gfmLinkify(md);
  // markdown-it rejects file: links by default; local viewers need them
  // (monthly reports fall back to file:/// links). Scripts stay blocked.
  md.validateLink = (url) => {
    const s = url.trim().toLowerCase();
    if (/^(vbscript|javascript):/.test(s)) return false;
    if (s.startsWith('data:')) return /^data:image\/(gif|png|jpeg|webp|avif|bmp|svg\+xml);/.test(s);
    return true;
  };

  // CommonMark won't close `**粗体。**正文` (punctuation inside, CJK letter outside);
  // this plugin relaxes the flanking rule next to CJK characters.
  md.use(cjkFriendly);
  md.use(footnote);
  md.use(taskLists, { enabled: false });
  md.use(githubAlerts);
  md.use(frontMatter, () => {});
  if (math) {
    md.use(mdKatex.default ?? mdKatex, { katex, throwOnError: false, strict: 'ignore', output: 'htmlAndMathml' });
    md.inline.ruler.at('math_inline', strictInlineMath);
  }

  // GitHub-compatible heading ids and source-line markers for top-level blocks.
  md.core.ruler.push('mdv_ids_lines', (state) => {
    const slugger = new GithubSlugger();
    const toks = state.tokens;
    const headings = [];
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.map && t.level === 0 && t.nesting !== -1 && t.type !== 'inline') t.attrSet('data-line', String(t.map[0]));
      if (t.type === 'heading_open') {
        const text = headingText(toks[i + 1]).trim();
        let id = t.attrGet('id');
        if (!id) {
          id = slugger.slug(text);
          t.attrSet('id', id);
        }
        headings.push({ level: Number(t.tag.slice(1)), text, id, line: t.map ? t.map[0] : 0 });
      }
    }
    state.env.headings = headings;
  });

  md.renderer.rules.front_matter = (tokens, idx) =>
    '<details class="mdv-frontmatter"><summary>Front Matter</summary><pre class="hljs"><code class="language-yaml">' +
    highlightCode(tokens[idx].meta, 'yaml') +
    '</code></pre></details>\n';

  md.renderer.rules.fence = (tokens, idx) => {
    const t = tokens[idx];
    const info = (t.info || '').trim();
    const lang = info.split(/\s+/)[0].toLowerCase();
    const line = t.map ? ` data-line="${t.map[0]}"` : '';
    if (lang === 'mermaid') {
      return `<pre class="mdv-mermaid"${line}><code>${escapeHtml(t.content)}</code></pre>\n`;
    }
    if (math && (lang === 'math' || lang === 'katex' || lang === 'latex-math')) {
      try {
        return `<div class="mdv-math-block"${line}>${katex.renderToString(t.content, { displayMode: true, throwOnError: false, strict: 'ignore', output: 'htmlAndMathml' })}</div>\n`;
      } catch {
        /* fall back to code */
      }
    }
    const cls = lang ? ` class="language-${escapeHtml(lang)}"` : '';
    const dataLang = lang ? ` data-lang="${escapeHtml(lang)}"` : '';
    return `<pre class="hljs"${line}${dataLang}><code${cls}>${highlightCode(t.content, lang)}</code></pre>\n`;
  };

  md.renderer.rules.code_block = (tokens, idx) => {
    const t = tokens[idx];
    const line = t.map ? ` data-line="${t.map[0]}"` : '';
    return `<pre class="hljs"${line}><code>${escapeHtml(t.content)}</code></pre>\n`;
  };

  return md;
}

const cache = new Map();
function getMd(opts) {
  const key = opts.math ? 'math' : 'nomath';
  if (!cache.has(key)) cache.set(key, createMarkdown(opts));
  return cache.get(key);
}

/**
 * Render a Markdown document.
 * Returns { html, headings, isChat, ms }.
 * Math is disabled for archive chat exports: their text is data, and "$" is
 * far more often currency than TeX there.
 */
export function renderMarkdown(text, { math } = {}) {
  const t0 = Date.now();
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const isChat = isChatMarkdown(src);
  const md = getMd({ math: math ?? !isChat });
  const env = {};
  const html = md.render(src, env);
  return { html, headings: env.headings || [], isChat, ms: Date.now() - t0 };
}
