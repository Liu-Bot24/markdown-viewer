// Cross-file search: scope first (this conversation, a folder, a root, everything),
// results stream in grouped by conversation and date, cancellable at any time.
import { h, toast, debounce } from '../../../core/src/ui/util.js';
import { basename, dirname, isMarkdownPath } from '../../../core/src/shared/paths.js';
import { isMessageAnchor } from '../../../core/src/shared/chat.js';
import { isLocalPath } from './local.js';
import { showDialog } from './ui.js';

const fmtTime = (ms) => {
  if (!ms) return '尚未完成';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
};

function marked(text, ranges) {
  const out = [];
  let at = 0;
  for (const [a, b] of ranges || []) {
    if (a > at) out.push(text.slice(at, a));
    out.push(h('mark', null, text.slice(a, b)));
    at = b;
  }
  out.push(text.slice(at));
  return out;
}

export class SearchPanel {
  constructor(app, el) {
    this.app = app;
    this.el = el;
    this.ctrl = null;
    this.state = null;
    this.offset = 0;
    this.lastGroup = null;
    this.input = h('input.search-input', { type: 'search', placeholder: '搜索消息和文档，空格分隔多个词，引号表示整句', enterkeyhint: 'search', onkeydown: (e) => e.key === 'Enter' && this.run() });
    this.scopeSel = h('select.search-scope', { onchange: () => this.onScopeChange() });
    this.fromIn = h('input.search-date', { type: 'month', title: '从这个月开始' });
    this.toIn = h('input.search-date', { type: 'month', title: '到这个月为止' });
    this.senderSel = h('select.search-sender', null, h('option', { value: '' }, '所有发送者'));
    this.typeSel = h('select.search-type', null, h('option', { value: '' }, '所有类型'));
    this.statusEl = h('div.search-status.muted');
    this.indexEl = h('div.search-index.muted');
    this.results = h('div.search-results');
    this.moreBtn = h('button.btn.small.search-more', { onclick: () => this.run({ more: true }), style: { display: 'none' } }, '加载更多');
    this.cancelBtn = h('button.btn.small', { onclick: () => this.cancel(), style: { display: 'none' } }, '取消');
    this.bgBtn = h('button.btn.small', { onclick: () => this.toBackground(), style: { display: 'none' } }, '放到后台全量扫描');
    el.append(
      h(
        'div.search-head',
        null,
        h('div.search-row', null, this.input, h('button.btn.primary.small', { onclick: () => this.run() }, '搜索'), h('button.icon-btn', { title: '关闭 (Esc)', onclick: () => this.close() }, '×')),
        h('div.search-row.search-filters', null, this.scopeSel, this.fromIn, h('span.muted', null, '至'), this.toIn, this.senderSel, this.typeSel),
        h('div.search-row', null, this.statusEl, this.cancelBtn, this.bgBtn),
      ),
      this.results,
      this.moreBtn,
      this.indexEl,
    );
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (this.app.peek.isOpen) this.app.peek.close(); // the preview opened from a result
        else if (this.ctrl) this.cancel();
        else this.close();
      }
    });
    this.loadFilters = debounce(() => this.fillFilters(), 200);
  }

  get isOpen() {
    return document.body.classList.contains('search-open');
  }

  /** Scope choices from what the user is looking at: the current conversation or folder first. */
  scopes() {
    const out = [];
    const v = this.app.activeView;
    const tree = this.app.tree;
    if (v && !isLocalPath(v.path)) {
      const dir = dirname(v.path);
      if (v.meta && v.meta.isChat) {
        const session = dirname(dir);
        out.push({ value: session, label: `这个会话：${basename(session)}` });
      }
      out.push({ value: dir, label: `所在文件夹：${basename(dir)}` });
      out.push({ value: v.path, label: `只搜这个文件：${basename(v.path)}` });
    }
    if (tree.selectedDir && !isLocalPath(tree.selectedDir) && tree.selectedDir !== '/' && !out.some((o) => o.value === tree.selectedDir)) {
      out.unshift({ value: tree.selectedDir, label: `选中的文件夹：${basename(tree.selectedDir)}` });
    }
    const root = v && !isLocalPath(v.path) ? '/' + v.path.split('/')[1] : tree.selectedDir && !isLocalPath(tree.selectedDir) && tree.selectedDir !== '/' ? '/' + tree.selectedDir.split('/')[1] : null;
    for (const r of this.app.webRoots || []) {
      const val = '/' + r.name;
      if (!out.some((o) => o.value === val)) out.push({ value: val, label: `整个根：${r.name}`, isRoot: true, current: val === root });
    }
    out.push({ value: '/', label: '全部根' });
    return out;
  }

  open({ query } = {}) {
    const scopes = this.scopes();
    const prev = this.scopeSel.value;
    this.scopeSel.replaceChildren(...scopes.map((s) => h('option', { value: s.value }, s.label)));
    // default: the narrowest context; "everything" only when chosen explicitly
    const def = scopes.length > (this.app.webRoots || []).length + 1 ? scopes[0].value : (scopes.find((s) => s.current) || scopes[0]).value;
    this.scopeSel.value = this.keepScope && scopes.some((s) => s.value === prev) ? prev : def;
    document.body.classList.add('search-open');
    if (query != null) this.input.value = query;
    this.input.focus();
    this.input.select();
    this.fillFilters();
    this.refreshIndex();
  }

  close() {
    this.cancel();
    document.body.classList.remove('search-open');
  }

  onScopeChange() {
    this.keepScope = true;
    this.fillFilters();
    if (this.input.value.trim()) this.run();
  }

  async fillFilters() {
    const scope = this.scopeSel.value;
    try {
      const r = await (await fetch('/api/senders?scope=' + encodeURIComponent(scope))).json();
      if (!r.ok || scope !== this.scopeSel.value) return;
      const keepS = this.senderSel.value;
      const keepT = this.typeSel.value;
      this.senderSel.replaceChildren(h('option', { value: '' }, '所有发送者'), ...r.senders.map((s) => h('option', { value: s.name }, `${s.name}（${s.n.toLocaleString()}）`)));
      this.typeSel.replaceChildren(h('option', { value: '' }, '所有类型'), ...r.types.map((s) => h('option', { value: s.name }, s.name)));
      this.senderSel.value = r.senders.some((s) => s.name === keepS) ? keepS : '';
      this.typeSel.value = r.types.some((s) => s.name === keepT) ? keepT : '';
    } catch {
      /* filters are optional */
    }
  }

  params(extra = {}) {
    const p = new URLSearchParams({ q: this.input.value.trim(), scope: this.scopeSel.value });
    if (this.fromIn.value) p.set('from', this.fromIn.value);
    if (this.toIn.value) p.set('to', this.toIn.value);
    if (this.senderSel.value) p.set('sender', this.senderSel.value);
    if (this.typeSel.value) p.set('type', this.typeSel.value);
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    return p;
  }

  cancel() {
    if (this.ctrl) this.ctrl.abort();
    this.ctrl = null;
    this.cancelBtn.style.display = 'none';
  }

  async run({ more = false } = {}) {
    const q = this.input.value.trim();
    if (!q) return;
    this.cancel();
    if (!more) {
      this.offset = 0;
      this.results.replaceChildren();
      this.lastGroup = null;
      this.count = 0;
    }
    this.moreBtn.style.display = 'none';
    this.bgBtn.style.display = 'none';
    const ctrl = new AbortController();
    this.ctrl = ctrl;
    this.cancelBtn.style.display = '';
    this.statusEl.textContent = '正在搜索…';
    const t0 = performance.now();
    let total = 0;
    let scanTotal = 0;
    let scanned = 0;
    let fromScan = 0;
    try {
      const res = await fetch('/api/search?' + this.params({ offset: String(this.offset) }), { signal: ctrl.signal });
      if (res.status === 401) return (location.href = '/login');
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (!line) continue;
          const m = JSON.parse(line);
          if (m.t === 'meta') this.meta = m;
          else if (m.t === 'hits') {
            if (m.source === 'index') total = m.total;
            else fromScan += m.hits.length;
            this.addHits(m.hits);
          } else if (m.t === 'progress') {
            scanned = m.scanned;
            scanTotal = m.scanTotal;
          } else if (m.t === 'done') {
            scanned = m.scanned || scanned;
            scanTotal = m.scanTotal || scanTotal;
            this.offset += 100;
            this.moreBtn.style.display = m.more ? '' : 'none';
            if (m.suggestJob) this.bgBtn.style.display = '';
            if (m.error === 'EQUERY') toast('这个查询无法执行，换个写法试试', 'warn');
          }
          this.statusEl.textContent = this.summary(total, fromScan, scanned, scanTotal, false);
        }
      }
      this.statusEl.textContent = this.summary(total, fromScan, scanned, scanTotal, true, performance.now() - t0);
      if (!this.results.children.length) this.results.append(h('div.search-empty.muted', null, '没有找到匹配的内容。'));
    } catch (e) {
      if (e.name === 'AbortError') this.statusEl.textContent = `已取消，显示了 ${this.count} 条`;
      else this.statusEl.textContent = '搜索失败：' + e.message;
    } finally {
      if (this.ctrl === ctrl) {
        this.ctrl = null;
        this.cancelBtn.style.display = 'none';
      }
    }
  }

  summary(total, fromScan, scanned, scanTotal, finished, ms) {
    const bits = [];
    bits.push(`索引里找到 ${total > 10000 ? '超过 10,000' : total.toLocaleString()} 条`);
    if (scanTotal) bits.push(`尚未进索引的文件 ${scanned} / ${scanTotal} 个已扫描，找到 ${fromScan} 条`);
    if (finished && ms != null) bits.push(`用时 ${(ms / 1000).toFixed(1)} 秒`);
    if (this.meta && this.meta.index && this.meta.index.checking) bits.push('索引正在更新，部分结果可能不是最新');
    return bits.join(' · ');
  }

  groupKey(hit) {
    const session = hit.kind === 'chat' ? (hit.title || '').split(' · ')[0] || basename(dirname(dirname(hit.path))) : basename(hit.path);
    const day = hit.ts ? hit.ts.slice(0, 10) : '';
    return { key: session + '\0' + day + '\0' + dirname(hit.path), session, day };
  }

  addHits(hits) {
    for (const hit of hits) {
      this.count = (this.count || 0) + 1;
      const g = this.groupKey(hit);
      if (!this.lastGroup || this.lastGroup !== g.key) {
        this.lastGroup = g.key;
        this.results.append(h('div.search-group', { title: dirname(hit.path) }, h('span.search-session', null, g.session), g.day ? h('span.muted', null, g.day) : null));
      }
      const badges = [];
      if (hit.scan) badges.push(h('span.badge', { title: '这个文件还没进索引，结果来自直接扫描' }, '来自扫描'));
      if (hit.stale) badges.push(h('span.badge.warn', { title: '索引正在检查这部分内容' }, '可能不是最新'));
      const item = h(
        'button.search-hit',
        {
          onclick: (e) => this.openHit(hit, e),
          title: hit.path + (hit.anchor ? '#' + hit.anchor : ''),
        },
        h('div.search-hit-head', null, h('span.search-time', null, hit.ts ? hit.ts.slice(11, 16) : ''), h('span.search-sender', null, hit.sender), hit.type && hit.type !== '文本' && hit.type !== '文档' ? h('span.muted', null, hit.type) : null, ...badges),
        h('div.search-snippet', null, marked(hit.text, hit.ranges)),
      );
      this.results.append(item);
    }
  }

  openHit(hit, e) {
    const target = { path: hit.path, anchor: hit.anchor };
    const phone = document.body.classList.contains('phone');
    if (isMessageAnchor(hit.anchor) && !e.shiftKey) {
      if (phone) this.close();
      return this.app.peek.show(target);
    }
    if (phone) this.close();
    if (e.ctrlKey || e.metaKey) return this.app.openNewTab(target);
    if (isMarkdownPath(hit.path)) return this.app.navigate(target);
  }

  async toBackground() {
    const p = Object.fromEntries(this.params());
    const r = await (await fetch('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) })).json();
    if (r.ok) {
      toast('已放到后台：完成后点顶栏的「后台搜索」查看结果，关掉页面也没关系', 'info', 6000);
      this.bgBtn.style.display = 'none';
      this.app.webShell.refreshJobs();
    }
  }

  async showJob(id) {
    const r = await (await fetch('/api/jobs/' + id)).json();
    if (!r.ok) return toast('这个后台搜索已不存在', 'warn');
    this.open({ query: r.job.q });
    this.cancel();
    this.results.replaceChildren();
    this.lastGroup = null;
    this.count = 0;
    this.addHits(r.hits);
    this.statusEl.textContent = `后台全量扫描「${r.job.q}」：${r.job.state === 'done' ? '已完成' : r.job.state === 'running' ? '进行中' : r.job.state}，扫描 ${r.job.scanned.toLocaleString()} / ${r.job.total.toLocaleString()} 个文件，找到 ${r.hits.length.toLocaleString()} 条`;
    this.moreBtn.style.display = 'none';
  }

  async refreshIndex() {
    let s;
    try {
      s = await (await fetch('/api/index')).json();
    } catch {
      return;
    }
    if (!s || s.ok === false) {
      this.indexEl.replaceChildren('搜索索引不可用。');
      return;
    }
    const bits = [`索引里有 ${Number(s.files || 0).toLocaleString()} 个文件`, `最后检查于 ${fmtTime(s.lastCheckEnd)}`];
    if (s.checking) bits.push(`正在检查：${(s.checked || 0).toLocaleString()} / ${(s.total || 0).toLocaleString()}`);
    if (s.pending) bits.push(`${s.pending.toLocaleString()} 个文件等待重建（搜索时直接扫描）`);
    if (s.nextScheduled) bits.push(`下次定时检查 ${fmtTime(s.nextScheduled)}`);
    this.indexEl.replaceChildren(
      h('span', null, bits.join(' · ')),
      h('button.btn.small', { onclick: () => this.recheck() }, '立即重新检查'),
      h('button.btn.small', { onclick: () => this.rebuild() }, '重建索引'),
    );
  }

  async recheck() {
    await fetch('/api/index/recheck', { method: 'POST' });
    toast('已开始检查', 'info');
    setTimeout(() => this.refreshIndex(), 800);
    this.app.webShell.pollIndexSoon();
  }

  async rebuild() {
    const a = await showDialog({ type: 'warning', message: '删掉现有索引，从头重建？', detail: '全部内容要重新读一遍，大的归档需要较长时间；期间搜索结果不完整。', buttons: ['重建', '取消'], cancelId: 1 });
    if (a !== 0) return;
    await fetch('/api/index/rebuild', { method: 'POST' });
    setTimeout(() => this.refreshIndex(), 800);
    this.app.webShell.pollIndexSoon();
  }
}
