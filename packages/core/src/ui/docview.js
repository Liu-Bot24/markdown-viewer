// One document: the rendered preview in its own scroll container and, while
// editing, the source editor instead of it or beside it.
import { h, fmtSize, nextFrame, pinInView, rafThrottle, toast, caps } from './util.js';
import { decodeText, renderInto } from './render-client.js';
import { observeMermaid } from './mermaid-loader.js';
import { applySelfId } from '../render/postprocess.js';
import { basename } from '../shared/paths.js';
import { detectEol, eolName } from '../shared/textformat.js';

let viewSeq = 0;

const SAVE_ERRORS = {
  EACCES: '没有写入权限',
  EPERM: '没有写入权限，或文件被设为只读',
  EBUSY: '文件正被其他程序占用',
  ENOSPC: '磁盘空间不足',
  EISDIR: '目标是一个文件夹',
  EREADONLY: '这个目录是只读的',
  EWRITEOFF: '服务器已关闭覆盖原文件',
  ECONFIRM: '确认语句不一致',
  EBADREQ: '请求无效',
  ENET: '无法连接服务器',
};

export class DocView {
  constructor(app, path) {
    this.app = app;
    this.path = path;
    this.id = ++viewSeq;
    this.renderSeq = 0;
    this.meta = null; // { size, mtimeMs, encoding, lines, isChat, headings, days, timing }
    this.error = null;
    this.stale = false;
    this.target = null;
    this.text = null; // content as last read from or written to disk
    this.disk = null; // { hash, mtimeMs, size, encoding, eol, mixedEol }
    this.mode = 'view'; // view | edit | split
    this.editor = null;
    this.savedDoc = null;
    this.dirty = false;
    this.previewStale = false;
    this.lead = 'editor'; // pane whose scrolling drives the other one in split layout
    this.article = h('article.markdown-body');
    this.banner = h('div.doc-banner');
    this.el = h('div.doc-view', { tabindex: '-1' }, this.article);
    this.editorHost = h('div.doc-editor');
    this.splitter = h('div.doc-splitter', { title: '拖动调整宽度' });
    this.root = h('div.doc-root', null, this.banner, h('div.doc-body', null, this.editorHost, this.splitter, this.el));
    this.mermaidIO = null;
    this.watching = false;
    this.lineEls = [];
    this.bindPanes();
    app.docsEl.append(this.root);
  }

  get title() {
    return basename(this.path);
  }

  get editing() {
    return this.mode !== 'view';
  }

  setActive(on) {
    this.root.classList.toggle('active', on);
    this.el.classList.toggle('active', on);
  }

  applyViewSettings() {
    const s = this.app.settings;
    this.el.classList.toggle('chat-view', !!(this.meta && this.meta.isChat && s.chatView));
    this.el.classList.toggle('wide', s.readingWidth === 'wide');
    this.root.classList.toggle('wide', s.readingWidth === 'wide');
    for (const m of ['view', 'edit', 'split']) this.root.classList.toggle('mode-' + m, this.mode === m);
  }

  /** Read the file and render it. ifChanged: skip when the bytes are what we already have. */
  async load({ ifChanged = false } = {}) {
    // Never let the disk version replace unsaved edits (the caller asks the user first).
    if (this.dirty) return this.renderText(this.editor.getText());
    const loadingTimer = setTimeout(() => this.el.classList.add('loading'), 150);
    try {
      const r = await window.mdv.readFile(this.path);
      if (!r.ok) {
        this.error = r.code;
        this.meta = null;
        this.renderError(r);
        return false;
      }
      if (ifChanged && this.meta && this.disk && r.hash === this.disk.hash) return true;
      const { text, encoding } = decodeText(r.bytes);
      const { eol, mixed } = detectEol(text);
      this.text = text;
      this.disk = { hash: r.hash, mtimeMs: r.mtimeMs, size: r.size, encoding, eol, mixedEol: mixed };
      if (this.editor && !this.dirty) {
        this.editor.setText(text);
        this.markSaved();
      }
      const ok = await this.renderText(text);
      if (ok && !this.watching) {
        window.mdv.watch(this.path);
        this.watching = true;
      }
      return ok;
    } finally {
      clearTimeout(loadingTimer);
      this.el.classList.remove('loading');
    }
  }

  /** Render `text` into the preview. Overlapping requests collapse into one more render. */
  renderText(text) {
    if (this.rendering) {
      this.nextText = text;
      return this.rendering;
    }
    this.rendering = this.doRender(text).finally(() => {
      this.rendering = null;
      if (this.nextText != null) {
        const t = this.nextText;
        this.nextText = null;
        this.renderText(t);
      }
    });
    return this.rendering;
  }

  async doRender(text) {
    const app = this.app;
    try {
      const res = await renderInto(this.article, text, {
        filePath: this.path,
        inlineMedia: app.settings.inlineMedia,
        selfIds: new Set(app.settings.selfIds || []),
      });
      this.error = null;
      this.stale = false;
      this.previewStale = false;
      this.renderSeq++;
      let lines = 1;
      for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) lines++;
      this.meta = {
        size: this.disk ? this.disk.size : text.length,
        mtimeMs: this.disk ? this.disk.mtimeMs : 0,
        encoding: this.disk ? this.disk.encoding : 'UTF-8',
        eol: this.disk ? eolName(this.disk.eol) + (this.disk.mixedEol ? '（混合）' : '') : '',
        lines,
        isChat: res.isChat,
        headings: res.headings,
        days: res.pp.chat ? res.pp.chat.days : null,
        messages: res.pp.chat ? res.pp.chat.messages : 0,
        refs: res.pp.refs,
        media: res.pp.media,
        chunks: res.pp.chunks,
        timing: { ...res.timing, stages: res.pp.stages },
      };
      if (!this.dirty && !this.disk?.gone) this.banner.replaceChildren();
      if (this.mermaidIO) this.mermaidIO.disconnect();
      this.mermaidIO = observeMermaid(this.el, res.pp.mermaid);
      const learned = res.pp.chat && res.pp.chat.selfCandidate;
      if (learned && !(app.settings.selfIds || []).includes(learned)) {
        applySelfId(this.article, learned);
        app.learnSelfId(learned);
      }
      this.indexLines();
      this.applyViewSettings();
      return true;
    } catch (e) {
      this.error = 'ERENDER';
      this.renderError({ code: 'ERENDER', message: String(e && e.message) });
      return false;
    }
  }

  renderError(r) {
    const msgs = {
      ENOENT: '文件不存在',
      EISDIR: '这是一个文件夹',
      ETOOBIG: `文件过大（${fmtSize(r.size || 0)}），超过 64 MB 的上限`,
      EACCES: '没有读取权限',
      EPERM: '没有读取权限',
      ERENDER: '渲染失败',
    };
    this.article.replaceChildren(
      h(
        'div.doc-error',
        null,
        h('h2', null, msgs[r.code] || '无法打开文件'),
        h('p', null, h('code', null, this.path)),
        r.message ? h('p.muted', null, r.message) : null,
      ),
    );
    this.lineEls = [];
    this.applyViewSettings();
  }

  /** Re-render after an on-disk change, keeping the reading position. */
  async reload(opts) {
    const pos = this.capture();
    const ok = await this.load(opts);
    if (ok) {
      await this.restore(pos, { forceRef: true });
      if (this.target) this.markTarget(this.findAnchor(this.target), false);
    }
    return ok;
  }

  // ---------- editing ----------

  async ensureEditor() {
    if (this.editor) return;
    const { createEditor } = await import('./editor.js');
    if (this.editor) return;
    this.editor = createEditor(this.editorHost, this.text ?? '', {
      onChange: () => this.onEditorChange(),
      onCursor: () => this.app.onCursor(this),
      onFocus: () => (this.lead = 'editor'),
    });
    this.savedDoc = this.editor.doc;
    const sync = rafThrottle(() => {
      if (this.mode === 'split' && this.lead === 'editor') this.scrollPreviewToLine(this.editor.topLine());
    });
    this.editor.scroller.addEventListener('scroll', sync, { passive: true });
  }

  /** Switch between reading, editing and side-by-side; keeps the place in the document. */
  async setMode(mode) {
    if (mode === this.mode) return true;
    if (mode !== 'view' && (this.error || !this.meta || this.text == null)) {
      toast('这个文件没有成功打开，无法编辑', 'warn');
      return false;
    }
    const prev = this.mode;
    const line = prev === 'view' ? this.previewTopLine() : this.editor.topLine();
    if (mode !== 'view') await this.ensureEditor();
    this.mode = mode;
    this.applyViewSettings();
    if (mode !== 'edit' && this.previewStale) await this.renderText(this.editor.getText());
    await nextFrame();
    if (mode !== 'view') {
      this.editor.view.requestMeasure();
      if (prev === 'view') {
        this.editor.scrollToLine(line);
        this.editor.setCursorLine(Math.ceil(line));
        this.editor.focus();
      }
    }
    if (mode !== 'edit' && prev !== 'view') this.scrollPreviewToLine(line);
    if (mode === 'view') this.el.focus({ preventScroll: true });
    this.app.onModeChanged(this);
    return true;
  }

  onEditorChange() {
    const doc = this.editor.doc;
    this.setDirty(doc.length !== this.savedDoc.length || !doc.eq(this.savedDoc));
    if (this.mode === 'split') this.schedulePreview();
    else this.previewStale = true;
  }

  schedulePreview() {
    clearTimeout(this.previewTimer);
    const last = this.meta ? this.meta.timing.total : 50;
    this.previewTimer = setTimeout(async () => {
      if (this.mode !== 'split') {
        this.previewStale = true;
        return;
      }
      await this.renderText(this.editor.getText());
      if (this.mode === 'split') this.scrollPreviewToLine(this.editor.topLine());
      this.app.onViewRendered(this);
    }, Math.min(1500, Math.max(250, last * 2)));
  }

  markSaved() {
    this.savedDoc = this.editor.doc;
    this.setDirty(false);
  }

  setDirty(dirty) {
    if (dirty === this.dirty) return;
    this.dirty = dirty;
    this.app.onDirtyChanged(this);
  }

  /** Throw away unsaved edits and show the file as last read. */
  async revert() {
    if (!this.editor) return;
    this.editor.setText(this.text ?? '');
    this.markSaved();
    this.stale = true; // the disk may have moved on: read it again when shown next
    if (this.disk && this.disk.changed) this.banner.replaceChildren();
    await this.renderText(this.text ?? '');
  }

  /** The file changed on disk while there are unsaved edits: say so, keep the edits. */
  noteExternalChange(type) {
    if (!this.disk) return;
    if (type === 'unlink') this.disk.gone = true;
    else this.disk.changed = true;
    const msg = type === 'unlink' ? '文件已在外部被删除或移动。你的修改还在，保存时会在原位置重新创建文件。' : '文件已在外部被修改。你的修改还没有保存。';
    const actions =
      type === 'unlink'
        ? []
        : [
            h('button.btn.small', { onclick: () => this.app.discardAndReload(this) }, '载入磁盘上的版本（放弃我的修改）'),
            h('button.btn.small', { onclick: () => this.banner.replaceChildren() }, '保留我的修改'),
          ];
    this.banner.replaceChildren(h('div.banner-warn', null, h('span', null, msg), ...actions));
  }

  /**
   * Save the editor content in the file's own encoding and line endings. Resolves true when saved.
   * Where saving exports a copy (web), the file itself is written only with extra.overwrite.
   */
  async save(extra = {}) {
    if (!this.editor || !this.disk) return true;
    const can = caps();
    const overwrite = !can.exportOnSave || !!extra.overwrite;
    if (overwrite && !extra.overwrite && !this.dirty && !this.disk.gone) return true;
    if (!overwrite && !this.dirty) return true;
    const opts = { encoding: this.disk.encoding, expectHash: this.disk.hash, allowConflict: false, allowLossy: false, ...extra };
    const ask = (o) => this.app.ask({ type: 'warning', cancelId: 1, ...o });
    this.lastSave = null;
    for (;;) {
      const doc = this.editor.doc;
      const text = this.editor.getText(this.disk.eol);
      const r = await window.mdv.writeFile(this.path, { ...opts, text });
      if (r.ok && r.exported) {
        // a copy went to the user; the file itself is unchanged
        this.lastSave = r;
        this.savedDoc = doc;
        this.setDirty(!doc.eq(this.editor.doc));
        this.app.onSaved(this);
        return true;
      }
      if (r.ok) {
        this.lastSave = r;
        const wasMixed = this.disk.mixedEol;
        this.text = text;
        this.disk = { ...this.disk, hash: r.hash, mtimeMs: r.mtimeMs, size: r.size, encoding: opts.encoding, mixedEol: false, changed: false, gone: false };
        this.savedDoc = doc;
        this.setDirty(!doc.eq(this.editor.doc)); // typing may have continued during the write
        this.banner.replaceChildren();
        if (this.meta) {
          this.meta.size = r.size;
          this.meta.encoding = opts.encoding;
          this.meta.eol = eolName(this.disk.eol);
        }
        if (this.previewStale && this.mode === 'view') await this.renderText(this.editor.getText());
        this.app.onSaved(this);
        if (wasMixed) toast(`原文件混用了几种换行符，已统一为 ${eolName(this.disk.eol)}`, 'info', 5000);
        return true;
      }
      const name = `“${this.title}”`;
      let a;
      if (r.code === 'ECANCEL') return false;
      if (!can.forceOverwrite && (r.code === 'ECONFLICT' || r.code === 'EGONE')) {
        await this.app.ask({
          type: 'warning',
          message: r.code === 'EGONE' ? `${name}已被删除或移动，不能覆盖。` : `${name}在你编辑期间被修改过，不能覆盖。`,
          detail: '你的修改还在编辑器里。可以先导出副本，再重新载入文件。',
          buttons: ['确定'],
          cancelId: 0,
        });
        return false;
      }
      switch (r.code) {
        case 'ECONFLICT':
          a = await ask({ message: `${name}在你编辑期间被其他程序修改过。`, detail: '覆盖会丢掉那边的修改。取消后，可以先把需要的内容复制出来，再载入磁盘上的版本。', buttons: ['覆盖', '取消'] });
          if (a !== 0) return false;
          opts.allowConflict = true;
          continue;
        case 'EGONE':
          a = await ask({ message: `${name}已被删除或移动。`, detail: `保存会在原位置重新创建它：\n${this.path}`, buttons: ['保存', '取消'] });
          if (a !== 0) return false;
          opts.allowConflict = true;
          continue;
        case 'ELOSSY_ORIG':
          a = await ask({ message: `${name}里有无法按 ${opts.encoding} 识别的字节。`, detail: '保存后，这些字节会变成替换字符（�）。', buttons: ['仍然保存', '取消'] });
          if (a !== 0) return false;
          opts.allowLossy = true;
          continue;
        case 'ELOSSY':
          a = await ask({ message: `当前内容里有 ${opts.encoding} 无法表示的字符。`, detail: '改用 UTF-8 保存会改变文件的编码。', buttons: ['改用 UTF-8 保存', '取消'] });
          if (a !== 0) return false;
          opts.encoding = 'UTF-8';
          opts.allowLossy = true;
          continue;
        default:
          await this.app.ask({ type: 'error', message: `无法保存${name}：${SAVE_ERRORS[r.code] || r.code}`, detail: r.message || this.path, buttons: ['确定'], cancelId: 0 });
          return false;
      }
    }
  }

  // ---------- scroll sync between source lines and the preview ----------

  bindPanes() {
    const lead = (who) => () => (this.lead = who);
    for (const ev of ['pointerenter', 'pointerdown', 'wheel', 'focusin']) {
      this.editorHost.addEventListener(ev, lead('editor'), { passive: true });
      this.el.addEventListener(ev, lead('preview'), { passive: true });
    }
    const sync = rafThrottle(() => {
      if (this.mode === 'split' && this.lead === 'preview' && this.editor) this.editor.scrollToLine(this.previewTopLine());
    });
    this.el.addEventListener('scroll', sync, { passive: true });
    this.splitter.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.splitter.setPointerCapture(e.pointerId);
      const box = this.splitter.parentElement.getBoundingClientRect();
      const move = (ev) => {
        const f = Math.max(0.2, Math.min(0.8, (ev.clientX - box.left) / box.width));
        this.app.settings.editSplit = f;
        document.documentElement.style.setProperty('--edit-split', String(f));
      };
      const up = () => {
        this.splitter.removeEventListener('pointermove', move);
        this.splitter.removeEventListener('pointerup', up);
        window.mdv.patchState({ settings: { editSplit: this.app.settings.editSplit } });
      };
      this.splitter.addEventListener('pointermove', move);
      this.splitter.addEventListener('pointerup', up);
    });
  }

  /** Source-line markers of the rendered blocks, in document order. */
  indexLines() {
    const out = [];
    let last = -1;
    for (const el of this.article.querySelectorAll('[data-line]')) {
      const line = Number(el.getAttribute('data-line'));
      if (line > last) {
        out.push({ line, el });
        last = line;
      }
    }
    this.lineEls = out;
  }

  previewY(el) {
    return el.getBoundingClientRect().top - this.el.getBoundingClientRect().top + this.el.scrollTop;
  }

  /** 0-based source line (fractional) shown at the top of the preview. */
  previewTopLine() {
    const items = this.lineEls;
    const total = this.meta ? this.meta.lines : 1;
    const maxScroll = Math.max(1, this.el.scrollHeight - this.el.clientHeight);
    if (!items.length) return (this.el.scrollTop / maxScroll) * total;
    const y = this.el.scrollTop;
    let lo = 0;
    let hi = items.length - 1;
    let i = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.previewY(items[mid].el) <= y + 1) {
        i = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (i < 0) return 0;
    const a = items[i];
    const b = items[i + 1];
    const pa = this.previewY(a.el);
    const pb = b ? this.previewY(b.el) : this.el.scrollHeight;
    const lb = b ? b.line : total;
    return a.line + (pb > pa ? Math.min(1, (y - pa) / (pb - pa)) : 0) * (lb - a.line);
  }

  scrollPreviewToLine(line) {
    this.stopPin();
    const items = this.lineEls;
    const total = this.meta ? this.meta.lines : 1;
    if (!items.length) {
      this.el.scrollTop = (line / Math.max(1, total)) * (this.el.scrollHeight - this.el.clientHeight);
      return;
    }
    let lo = 0;
    let hi = items.length - 1;
    let i = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (items[mid].line <= line) {
        i = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (i < 0) {
      this.el.scrollTop = 0;
      return;
    }
    const a = items[i];
    const b = items[i + 1];
    const pa = this.previewY(a.el);
    const pb = b ? this.previewY(b.el) : this.el.scrollHeight;
    const lb = b ? b.line : total;
    // A little above the block, so its first line is not cut off.
    this.el.scrollTop = Math.max(0, pa + (lb > a.line ? (line - a.line) / (lb - a.line) : 0) * (pb - pa) - 8);
  }

  // ---------- anchors and positions ----------

  findAnchor(anchor) {
    if (!anchor) return null;
    const a = this.article;
    const tryIds = [anchor];
    try {
      const dec = decodeURIComponent(anchor);
      if (dec !== anchor) tryIds.push(dec);
    } catch {
      /* keep raw */
    }
    for (const id of tryIds) {
      const byId = a.querySelector('#' + CSS.escape(id));
      if (byId) return byId;
      const byName = a.querySelector(`[name="${CSS.escape(id)}"]`);
      if (byName) return byName;
    }
    // GitHub slugs are lowercase with spaces as '-': accept a loosely written anchor.
    const loose = tryIds[tryIds.length - 1].trim().toLowerCase().replace(/\s+/g, '-');
    return a.querySelector('#' + CSS.escape(loose));
  }

  /** Scroll to an anchor; returns true when found. */
  async scrollToAnchor(anchor, { highlight = true } = {}) {
    const el = this.findAnchor(anchor);
    if (!el) return false;
    const block = el.closest('section.mdv-msg') || el;
    const center = !!el.closest('section.mdv-msg');
    block.scrollIntoView({ block: center ? 'center' : 'start' });
    // Chunks above may lay out late (content-visibility); settle and re-align once.
    await nextFrame();
    await nextFrame();
    block.scrollIntoView({ block: center ? 'center' : 'start' });
    this.stopPin();
    this.unpin = pinInView(this.el, this.article, block, center ? 'center' : 'start');
    if (highlight) {
      this.target = anchor;
      this.markTarget(el, true);
    }
    if (this.mode === 'edit' && this.editor) this.editor.scrollToLine(this.previewTopLine());
    return true;
  }

  markTarget(el, flash) {
    for (const old of this.article.querySelectorAll('.mdv-target')) old.classList.remove('mdv-target', 'mdv-flash');
    if (!el) return;
    let block = el.closest('section.mdv-msg');
    if (!block) {
      block = el;
      // an empty <a id> marks the element that follows it
      if (el.tagName === 'A' && !el.textContent.trim()) {
        const p = el.parentElement;
        block = (p && p !== this.article && p.textContent.trim() === '' ? p.nextElementSibling : el.nextElementSibling) || p || el;
      }
    }
    block.classList.add('mdv-target');
    if (flash) {
      block.classList.remove('mdv-flash');
      void block.offsetWidth;
      block.classList.add('mdv-flash');
    }
  }

  /** First block visible at the top of the viewport, plus its offset. */
  capture() {
    const top = this.el.getBoundingClientRect().top;
    const pos = { scrollTop: this.el.scrollTop, renderSeq: this.renderSeq, ref: null, offset: 0 };
    if (!this.meta) return pos;
    const x = this.el.getBoundingClientRect().left + Math.min(200, this.el.clientWidth / 2);
    let probe = document.elementFromPoint(x, top + 8);
    if (!probe || !this.el.contains(probe)) return pos;
    const block = probe.closest('section.mdv-msg, [data-line]');
    if (!block) return pos;
    pos.offset = block.getBoundingClientRect().top - top;
    pos.ref = block.matches('section.mdv-msg') ? { msg: block.getAttribute('data-msg-id') } : { line: block.getAttribute('data-line') };
    return pos;
  }

  /** Release the anchor pin set by scrollToAnchor (call before any programmatic scroll). */
  stopPin() {
    if (this.unpin) this.unpin();
    this.unpin = null;
  }

  async restore(pos, { forceRef = false } = {}) {
    if (!pos) return;
    this.stopPin();
    if (!forceRef && pos.renderSeq === this.renderSeq) {
      this.el.scrollTop = pos.scrollTop;
      return;
    }
    let el = null;
    if (pos.ref && pos.ref.msg) el = this.article.querySelector(`section.mdv-msg[data-msg-id="${CSS.escape(pos.ref.msg)}"]`);
    else if (pos.ref && pos.ref.line != null) {
      el = this.article.querySelector(`[data-line="${CSS.escape(pos.ref.line)}"]`);
      if (!el) {
        // the block moved: take the nearest following line marker
        const want = Number(pos.ref.line);
        el = Array.from(this.article.querySelectorAll('[data-line]')).find((n) => Number(n.getAttribute('data-line')) >= want) || null;
      }
    }
    if (!el) {
      this.el.scrollTop = pos.scrollTop;
      return;
    }
    for (let i = 0; i < 2; i++) {
      el.scrollIntoView({ block: 'start' });
      this.el.scrollTop -= pos.offset;
      await nextFrame();
    }
  }

  destroy() {
    this.stopPin();
    clearTimeout(this.previewTimer);
    if (this.mermaidIO) this.mermaidIO.disconnect();
    if (this.editor) this.editor.destroy();
    if (this.watching) window.mdv.unwatch(this.path);
    this.root.remove();
  }
}
