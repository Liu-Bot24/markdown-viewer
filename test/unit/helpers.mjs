import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';
import fs from 'node:fs';
import path from 'node:path';
import { renderMarkdown } from '../../packages/core/src/render/markdown.js';
import { createSanitizer } from '../../packages/core/src/render/sanitize.js';
import { postprocess } from '../../packages/core/src/render/postprocess.js';

export const ROOT = path.resolve(import.meta.dirname, '..', '..');
export const FIXTURES = path.join(ROOT, 'test', 'fixtures');

const dom = new JSDOM('<!doctype html><html><body></body></html>');
const { window } = dom;
const sanitizer = createSanitizer(createDOMPurify(window));

/** Same pipeline as the app: markdown-it -> DOMPurify -> post-process. */
export function renderDoc(text, filePath, ctx = {}) {
  const r = renderMarkdown(text, ctx);
  const frag = sanitizer.toFragment(r.html);
  const root = window.document.createElement('article');
  root.appendChild(frag);
  const pp = postprocess(root, { filePath, isChat: r.isChat, inlineMedia: true, selfIds: new Set(), ...ctx });
  return { root, html: root.innerHTML, headings: r.headings, isChat: r.isChat, pp, parseMs: r.ms };
}

export function renderFile(rel, ctx) {
  const p = path.isAbsolute(rel) ? rel : path.join(FIXTURES, rel);
  return { ...renderDoc(fs.readFileSync(p, 'utf8'), p, ctx), path: p };
}

export const exists = (p) => fs.existsSync(p);
export const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};
