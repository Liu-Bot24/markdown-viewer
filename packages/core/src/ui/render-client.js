// Main-thread side of the render pipeline: worker RPC + sanitize + post-process.
import DOMPurify from 'dompurify';
import { createSanitizer } from '../render/sanitize.js';
import { postprocess } from '../render/postprocess.js';

const sanitizer = createSanitizer(DOMPurify);
let worker = null;
let seq = 0;
const waiting = new Map();

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const w = waiting.get(e.data.id);
      if (!w) return;
      waiting.delete(e.data.id);
      if (e.data.ok) w.resolve(e.data);
      else w.reject(new Error(e.data.error));
    };
    worker.onerror = (e) => {
      for (const w of waiting.values()) w.reject(new Error(e.message || 'render worker failed'));
      waiting.clear();
      worker = null;
    };
  }
  return worker;
}

export function renderToHtml(text, opts = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    getWorker().postMessage({ id, text, opts });
  });
}

export { decodeText } from '../shared/textformat.js';

/**
 * Full pipeline into `article`. Returns timing + metadata.
 * ctx: { filePath, inlineMedia, selfIds, chunk, math }
 */
export async function renderInto(article, text, ctx) {
  const t0 = performance.now();
  const r = await renderToHtml(text, { math: ctx.math });
  const t1 = performance.now();
  const frag = sanitizer.toFragment(r.html);
  const t2 = performance.now();
  const holder = document.createElement('div');
  holder.appendChild(frag);
  const pp = postprocess(holder, { ...ctx, isChat: r.isChat });
  const range = document.createRange();
  range.selectNodeContents(holder);
  article.replaceChildren(range.extractContents());
  const t3 = performance.now();
  return {
    headings: r.headings,
    isChat: r.isChat,
    pp,
    timing: { parse: Math.round(t1 - t0), sanitize: Math.round(t2 - t1), dom: Math.round(t3 - t2), total: Math.round(t3 - t0) },
  };
}
