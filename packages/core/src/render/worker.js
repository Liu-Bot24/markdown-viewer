// Render worker: Markdown -> HTML off the UI thread.
import { renderMarkdown } from './markdown.js';

self.onmessage = (e) => {
  const { id, text, opts } = e.data;
  try {
    const r = renderMarkdown(text, opts || {});
    self.postMessage({ id, ok: true, ...r });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.stack) || err) });
  }
};
