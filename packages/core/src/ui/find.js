// In-document search using the CSS Custom Highlight API: no DOM mutation, so
// large documents, anchors and selection keep working.
import { h, debounce } from './util.js';

const MAX_MATCHES = 20000;

export class FindBar {
  constructor(app, container) {
    this.app = app;
    this.matches = [];
    this.current = -1;
    this.view = null;
    this.input = h('input.find-input', {
      type: 'search',
      placeholder: '在文档中查找',
      oninput: debounce(() => this.run(), 160),
      onkeydown: (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.step(e.shiftKey ? -1 : 1);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          this.close();
        }
      },
    });
    this.caseBox = h('input', { type: 'checkbox', onchange: () => this.run() });
    this.count = h('span.find-count', null, '');
    this.el = h(
      'div.findbar',
      null,
      this.input,
      this.count,
      h('button.icon-btn', { title: '上一个 (Shift+Enter)', onclick: () => this.step(-1) }, '↑'),
      h('button.icon-btn', { title: '下一个 (Enter)', onclick: () => this.step(1) }, '↓'),
      h('label.find-opt', { title: '区分大小写' }, this.caseBox, 'Aa'),
      h('button.icon-btn', { title: '关闭 (Esc)', onclick: () => this.close() }, '×'),
    );
    container.append(this.el);
    this.supported = typeof CSS !== 'undefined' && 'highlights' in CSS;
  }

  get isOpen() {
    return this.el.classList.contains('open');
  }

  open() {
    this.el.classList.add('open');
    const sel = window.getSelection().toString().trim();
    if (sel && sel.length < 200 && !sel.includes('\n')) this.input.value = sel;
    this.input.focus();
    this.input.select();
    this.run();
  }

  close() {
    this.el.classList.remove('open');
    this.clear();
    if (this.view) this.view.el.focus({ preventScroll: true });
  }

  clear() {
    if (this.supported) {
      CSS.highlights.delete('mdv-find');
      CSS.highlights.delete('mdv-find-current');
    }
    this.matches = [];
    this.current = -1;
    this.count.textContent = '';
  }

  setView(view) {
    this.view = view;
    if (this.isOpen) this.run();
  }

  /** Text nodes that are visible in the current view mode. */
  textNodes(root) {
    const chat = this.view && this.view.el.classList.contains('chat-view');
    const skip = chat ? '.mdv-ui, .mdv-msg-h, .mdv-msg-meta, script, style' : '.mdv-ui, .mdv-chrome, script, style';
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement && n.parentElement.closest(skip) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    const out = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n);
    return out;
  }

  run() {
    this.clear();
    const q = this.input.value;
    if (!q || !this.view || !this.view.meta) return;
    const cs = this.caseBox.checked;
    const needle = cs ? q : q.toLowerCase();
    const nodes = this.textNodes(this.view.article);
    // Search per text node plus across adjacent nodes inside the same block.
    let buf = '';
    const map = []; // [startOffsetInBuf, node]
    for (const n of nodes) {
      map.push([buf.length, n]);
      buf += n.data;
    }
    const hay = cs ? buf : buf.toLowerCase();
    const ranges = [];
    let ni = 0;
    for (let i = hay.indexOf(needle); i !== -1 && ranges.length < MAX_MATCHES; i = hay.indexOf(needle, i + needle.length)) {
      while (ni + 1 < map.length && map[ni + 1][0] <= i) ni++;
      let nj = ni;
      const end = i + needle.length;
      while (nj + 1 < map.length && map[nj + 1][0] < end) nj++;
      // StaticRange, not Range: the document keeps every live Range up to date on
      // each DOM mutation until it is garbage-collected, so thousands of them make
      // the next document render orders of magnitude slower.
      ranges.push(new StaticRange({ startContainer: map[ni][1], startOffset: i - map[ni][0], endContainer: map[nj][1], endOffset: end - map[nj][0] }));
    }
    this.matches = ranges;
    if (this.supported) CSS.highlights.set('mdv-find', new Highlight(...ranges));
    if (ranges.length) {
      // start from the first match below the current viewport top
      const top = this.view.el.getBoundingClientRect().top;
      let start = ranges.findIndex((r) => {
        const el = r.startContainer.parentElement;
        return el && el.getBoundingClientRect().bottom >= top;
      });
      this.current = start === -1 ? 0 : start;
      this.show();
    } else this.count.textContent = '无结果';
  }

  step(d) {
    if (!this.matches.length) {
      this.run();
      return;
    }
    this.current = (this.current + d + this.matches.length) % this.matches.length;
    this.show();
  }

  show() {
    const r = this.matches[this.current];
    if (!r) return;
    if (!r.startContainer.isConnected) {
      // the document was re-rendered since the search ran
      this.run();
      return;
    }
    this.count.textContent = `${this.current + 1}/${this.matches.length}${this.matches.length >= MAX_MATCHES ? '+' : ''}`;
    if (this.supported) CSS.highlights.set('mdv-find-current', new Highlight(r));
    const el = r.startContainer.parentElement;
    if (!el) return;
    // open collapsed <details> that contain the match
    for (let d = el.closest('details'); d; d = d.parentElement && d.parentElement.closest('details')) d.open = true;
    this.view.stopPin();
    el.scrollIntoView({ block: 'center' });
    requestAnimationFrame(() => {
      const live = document.createRange();
      live.setStart(r.startContainer, r.startOffset);
      live.setEnd(r.endContainer, r.endOffset);
      const rect = live.getBoundingClientRect();
      live.detach();
      const box = this.view.el.getBoundingClientRect();
      if (rect.height && (rect.top < box.top || rect.bottom > box.bottom)) this.view.el.scrollTop += rect.top - box.top - box.height / 2;
    });
  }
}
