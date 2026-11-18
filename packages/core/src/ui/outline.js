// Document outline (TOC). Virtualised so archive chats with thousands of
// headings stay cheap; chat documents list days instead of per-message headings.
// Headings with sub-headings fold; the filter ignores folding.
import { h, debounce } from './util.js';
import { weekday } from '../render/postprocess.js';

const ROW = 26;

export class Outline {
  constructor(app, container) {
    this.app = app;
    this.items = [];
    this.shown = [];
    this.pos = new Int32Array(0); // item index -> row in `shown`, -1 when hidden
    this.collapsed = new Set();
    this.folds = new WeakMap(); // view -> keys of its folded headings
    this.foldable = false;
    this.activeIndex = -1;
    this.view = null;
    this.title = h('div.outline-title', null, '大纲');
    this.collapseBtn = h('button.icon-btn.small', { title: '全部折叠', onclick: () => this.collapseAll() });
    this.expandBtn = h('button.icon-btn.small', { title: '全部展开', onclick: () => this.expandAll() });
    // chevrons meeting in the middle / pointing apart; the ⊟ ⊞ glyphs read as 日 田 in CJK fonts
    const icon = (d) => `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
    this.collapseBtn.innerHTML = icon('M5 1.5l3 3 3-3M5 14.5l3-3 3 3M2 8h12');
    this.expandBtn.innerHTML = icon('M5 4.5l3-3 3 3M5 11.5l3 3 3-3M2 8h12');
    this.filterInput = h('input.outline-filter', {
      type: 'search',
      placeholder: '筛选大纲…',
      oninput: debounce(() => this.applyFilter(), 120),
    });
    this.inner = h('div.outline-inner');
    this.scroller = h('div.outline-list', { onscroll: () => this.paint() }, this.inner);
    this.empty = h('div.outline-empty.muted', null, '没有标题');
    container.append(h('div.outline-header', null, this.title, this.collapseBtn, this.expandBtn), this.filterInput, this.scroller, this.empty);
    new ResizeObserver(() => this.paint()).observe(this.scroller);
  }

  setView(view) {
    // each open document keeps its folds across re-renders and tab switches; a new one starts unfolded
    if (this.view) this.folds.set(this.view, new Set([...this.collapsed].map((i) => this.items[i].key)));
    const kept = view && this.folds.get(view);
    this.view = view;
    this.items = [];
    this.activeIndex = -1;
    const m = view && view.meta;
    if (m && m.isChat && m.days && m.days.length) {
      this.title.textContent = `按日期（${m.days.length} 天 · ${m.messages} 条）`;
      this.items = m.days.map((d) => ({ level: 1, text: `${d.date} ${weekday(d.date)}`, badge: String(d.count), el: () => d.first }));
    } else if (m) {
      this.title.textContent = '大纲';
      const min = Math.min(...m.headings.map((x) => x.level), 6);
      const article = view.article;
      const seen = new Map();
      this.items = m.headings.map((x) => {
        let cached = null;
        const level = x.level - min + 1;
        const k = level + '\0' + x.text;
        const n = (seen.get(k) || 0) + 1;
        seen.set(k, n);
        return {
          level,
          text: x.text,
          line: x.line,
          key: k + '\0' + n,
          el: () => (cached && cached.isConnected ? cached : (cached = article.querySelector('#' + CSS.escape(x.id)))),
        };
      });
    } else this.title.textContent = '大纲';
    this.linkParents();
    this.collapsed = new Set();
    if (kept && kept.size) this.items.forEach((it, i) => it.kids && kept.has(it.key) && this.collapsed.add(i));
    this.filterInput.value = '';
    this.filterInput.style.display = this.items.length > 30 ? '' : 'none';
    this.applyFilter();
  }

  /** parent = nearest earlier heading of a smaller level; kids = has at least one child. */
  linkParents() {
    const stack = [];
    this.items.forEach((it, i) => {
      while (stack.length && this.items[stack[stack.length - 1]].level >= it.level) stack.pop();
      it.parent = stack.length ? stack[stack.length - 1] : -1;
      if (it.parent >= 0) this.items[it.parent].kids = true;
      stack.push(i);
    });
    this.foldable = this.items.some((it) => it.kids);
  }

  applyFilter() {
    this.rebuild();
    this.scroller.scrollTop = 0;
    this.paint(true);
    this.updateActive();
  }

  /** Recompute the visible rows from the filter and the folds. */
  rebuild() {
    const q = this.filterInput.value.trim().toLowerCase();
    this.filtering = !!q;
    const shown = [];
    if (q) this.items.forEach((it, i) => it.text.toLowerCase().includes(q) && shown.push({ it, i }));
    else {
      let foldLevel = 0; // inside a folded heading: rows deeper than this are hidden
      this.items.forEach((it, i) => {
        if (foldLevel && it.level > foldLevel) return;
        foldLevel = 0;
        shown.push({ it, i });
        if (it.kids && this.collapsed.has(i)) foldLevel = it.level;
      });
    }
    this.shown = shown;
    this.pos = new Int32Array(this.items.length).fill(-1);
    shown.forEach((x, k) => (this.pos[x.i] = k));
    this.inner.style.height = shown.length * ROW + 'px';
    this.empty.style.display = this.items.length ? 'none' : '';
    const folds = this.foldable && !q;
    this.collapseBtn.style.display = this.expandBtn.style.display = this.foldable ? '' : 'none';
    const all = folds ? this.allFolded() : null;
    this.collapseBtn.disabled = !folds || (all.size === this.collapsed.size && [...all].every((i) => this.collapsed.has(i)));
    this.expandBtn.disabled = !folds || this.collapsed.size === 0;
  }

  /** The row that stands for the current heading: itself, or the nearest visible ancestor when folded away. */
  shownActive() {
    let a = this.activeIndex;
    if (this.filtering) return a;
    while (a >= 0 && this.pos[a] < 0) a = this.items[a].parent;
    return a;
  }

  paint(force = false) {
    const top = this.scroller.scrollTop;
    const hgt = this.scroller.clientHeight || 600;
    const from = Math.max(0, Math.floor(top / ROW) - 10);
    const to = Math.min(this.shown.length, Math.ceil((top + hgt) / ROW) + 10);
    const active = this.shownActive();
    if (!force && this.range && this.range[0] === from && this.range[1] === to && this.paintedActive === active) return;
    this.range = [from, to];
    this.paintedActive = active;
    const folds = this.foldable && !this.filtering;
    const rows = [];
    for (let k = from; k < to; k++) {
      const { it, i } = this.shown[k];
      const closed = this.collapsed.has(i);
      const twisty = !this.foldable
        ? null
        : folds && it.kids
          ? h(closed ? 'span.outline-twisty' : 'span.outline-twisty.open', { title: closed ? '展开' : '折叠', onclick: (e) => (e.stopPropagation(), this.toggle(i)) })
          : h('span.outline-twisty');
      const row = h(
        'div.outline-item',
        {
          title: it.text,
          style: { top: k * ROW + 'px', paddingLeft: (this.foldable ? 2 : 10) + (it.level - 1) * 14 + 'px' },
          onclick: () => this.go(i),
        },
        twisty,
        h('span.outline-text', null, it.text),
        it.badge ? h('span.outline-badge', null, it.badge) : null,
      );
      row.classList.add('lv' + Math.min(it.level, 6));
      if (i === active) row.classList.add('active');
      rows.push(row);
    }
    this.inner.replaceChildren(...rows);
  }

  toggle(i) {
    if (this.collapsed.has(i)) this.collapsed.delete(i);
    else this.collapsed.add(i);
    this.refold();
  }

  /** Every heading that has sub-headings, except a lone top heading (a document title) and a lone chain below it. */
  allFolded() {
    const set = new Set();
    this.items.forEach((it, i) => it.kids && set.add(i));
    for (let p = -1; ; ) {
      const children = [];
      this.items.forEach((it, i) => it.parent === p && children.push(i));
      if (children.length !== 1 || !this.items[children[0]].kids) break;
      p = children[0];
      set.delete(p);
    }
    return set;
  }

  collapseAll() {
    this.collapsed = this.allFolded();
    this.refold();
  }

  expandAll() {
    this.collapsed.clear();
    this.refold();
  }

  /** After a fold change: keep the list where it is, but keep the current heading's row in view. */
  refold() {
    this.rebuild();
    this.reveal();
    this.paint(true);
  }

  reveal() {
    const a = this.shownActive();
    const k = a >= 0 ? this.pos[a] : -1;
    if (k < 0) return;
    const y = k * ROW;
    if (y < this.scroller.scrollTop || y > this.scroller.scrollTop + this.scroller.clientHeight - ROW) {
      this.scroller.scrollTop = Math.max(0, y - this.scroller.clientHeight / 2);
    }
  }

  go(i) {
    const it = this.items[i];
    const v = this.view;
    if (it && v && v.editing && v.editor && it.line != null) {
      v.editor.gotoLine(it.line);
      if (v.mode === 'edit') {
        this.activeIndex = i;
        this.paint(true);
        return;
      }
    }
    const el = it && it.el();
    if (!el || !this.view) return;
    this.view.stopPin();
    el.scrollIntoView({ block: 'start' });
    requestAnimationFrame(() => requestAnimationFrame(() => el.scrollIntoView({ block: 'start' })));
    this.activeIndex = i;
    this.paint(true);
  }

  /** Highlight the last item whose element is above the reading line. */
  updateActive() {
    if (!this.view || !this.items.length) return;
    const line = this.view.el.getBoundingClientRect().top + 80;
    let lo = 0;
    let hi = this.items.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const el = this.items[mid].el();
      const top = el ? el.getBoundingClientRect().top : Infinity;
      if (top <= line) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (best !== this.activeIndex) {
      this.activeIndex = best;
      this.reveal();
      this.paint(true);
    }
  }
}
