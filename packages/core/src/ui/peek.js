// Side panel that previews a referenced chat message with a few messages around it.
import { h, sameFile, nextFrame, pinInView, caps } from './util.js';
import { decodeText, renderInto } from './render-client.js';
import { extractMessageWindow } from '../shared/chat.js';
import { basename, dirname, pathKey } from '../shared/paths.js';
import { applySelfId } from '../render/postprocess.js';

const cache = new Map(); // lower path -> { mtimeMs, text }

async function readText(path) {
  const st = await window.mdv.stat(path);
  if (!st.ok) return { ok: false, code: st.code };
  const k = pathKey(path);
  const c = cache.get(k);
  if (c && c.mtimeMs === st.mtimeMs) return { ok: true, text: c.text };
  const r = await window.mdv.readFile(path);
  if (!r.ok) return r;
  const { text } = decodeText(r.bytes);
  cache.set(k, { mtimeMs: r.mtimeMs, text });
  if (cache.size > 8) cache.delete(cache.keys().next().value);
  return { ok: true, text };
}

export class PeekPanel {
  constructor(app, container) {
    this.app = app;
    this.container = container;
    this.target = null;
    this.before = 0;
    this.after = 0;
    this.title = h('div.peek-title');
    this.sub = h('div.peek-sub.muted');
    this.body = h('article.markdown-body.peek-body');
    this.moreBefore = h('button.btn.small.peek-more', { onclick: () => this.extend(-1) }, '显示更早的消息');
    this.moreAfter = h('button.btn.small.peek-more', { onclick: () => this.extend(1) }, '显示更多消息');
    this.scroller = h('div.peek-scroll', null, this.moreBefore, this.body, this.moreAfter);
    container.append(
      h(
        'div.peek-header',
        null,
        h('div.peek-heading', null, this.title, this.sub),
        h(
          'div.peek-actions',
          null,
          h('button.btn.primary.small', { title: '在当前标签页打开原文并定位（可用“后退”返回）', onclick: () => this.openHere() }, '打开原文'),
          caps().appTabs
            ? h('button.btn.small', { title: '在新标签页打开原文并定位', onclick: () => this.openNewTab() }, '新标签')
            : h('button.btn.small', { title: '在新窗口打开原文并定位', onclick: () => this.openNewTab() }, '新窗口'),
          h('button.icon-btn', { title: '关闭 (Esc)', onclick: () => this.close() }, '×'),
        ),
      ),
      this.scroller,
    );
  }

  get isOpen() {
    return this.container.classList.contains('open');
  }

  async show(target) {
    const ctxN = this.app.settings.peekContext || 4;
    if (!this.target || !sameFile(this.target.path, target.path) || this.target.anchor !== target.anchor) {
      this.before = ctxN;
      this.after = ctxN;
    }
    this.target = target;
    this.container.classList.add('open');
    this.app.layoutChanged();
    this.title.textContent = '正在载入…';
    this.sub.textContent = target.path;
    await this.render(true);
    this.shownCount = (this.shownCount || 0) + 1;
  }

  async render(scrollToTarget) {
    const t = this.target;
    const r = await readText(t.path);
    if (t !== this.target) return;
    this.body.dataset.path = t.path;
    this.scroller.dataset.path = t.path;
    if (!r.ok) {
      this.title.textContent = r.code === 'ENOENT' ? '目标文件不存在' : '无法读取目标文件';
      this.sub.textContent = t.path;
      this.body.replaceChildren();
      this.moreBefore.style.display = this.moreAfter.style.display = 'none';
      return;
    }
    const w = extractMessageWindow(r.text, t.anchor, this.before, this.after);
    const session = (w.title || '').split(' · ')[0] || basename(dirname(dirname(t.path)));
    this.title.textContent = session || basename(t.path);
    this.title.title = w.title || '';
    if (!w.found) {
      this.sub.textContent = `${basename(t.path)} 中没有 #${t.anchor}`;
      this.body.replaceChildren(h('p.muted', null, '目标消息不存在，文件可能已经改动。可以打开原文查看。'));
      this.moreBefore.style.display = this.moreAfter.style.display = 'none';
      return;
    }
    this.sub.textContent = `${basename(t.path)} · 第 ${w.index + 1} / ${w.count} 条`;
    const isChatView = this.app.settings.chatView;
    this.scroller.classList.toggle('chat-view', isChatView);
    const res = await renderInto(this.body, w.markdown, {
      filePath: t.path,
      inlineMedia: this.app.settings.inlineMedia,
      selfIds: new Set(this.app.settings.selfIds || []),
      chunk: false,
      sessionName: session,
    });
    if (t !== this.target) return;
    const learned = res.pp.chat && res.pp.chat.selfCandidate;
    if (learned && !(this.app.settings.selfIds || []).includes(learned)) {
      applySelfId(this.body, learned);
      this.app.learnSelfId(learned);
    }
    this.moreBefore.style.display = w.hasBefore ? '' : 'none';
    this.moreAfter.style.display = w.hasAfter ? '' : 'none';
    const sec = this.body.querySelector(`section.mdv-msg[data-msg-id="${CSS.escape(t.anchor)}"]`);
    if (sec) {
      sec.classList.add('mdv-target');
      if (scrollToTarget) {
        await nextFrame();
        sec.scrollIntoView({ block: 'center' });
        if (this.unpin) this.unpin();
        this.unpin = pinInView(this.scroller, this.body, sec, 'center');
      }
    }
  }

  async extend(dir) {
    if (this.unpin) this.unpin();
    const anchorSec = this.body.querySelector(dir < 0 ? 'section.mdv-msg' : 'section.mdv-msg:last-of-type');
    const keepTop = anchorSec ? anchorSec.getBoundingClientRect().top : 0;
    if (dir < 0) this.before += 10;
    else this.after += 10;
    await this.render(false);
    if (dir < 0 && anchorSec) {
      const again = this.body.querySelector(`section.mdv-msg[data-msg-id="${CSS.escape(anchorSec.dataset.msgId)}"]`);
      if (again) this.scroller.scrollTop += again.getBoundingClientRect().top - keepTop;
    }
  }

  openHere() {
    if (!this.target) return;
    const t = this.target;
    this.close();
    this.app.navigate({ path: t.path, anchor: t.anchor });
  }

  openNewTab() {
    if (!this.target) return;
    const t = this.target;
    this.app.openNewTab({ path: t.path, anchor: t.anchor });
  }

  close() {
    if (this.unpin) this.unpin();
    this.container.classList.remove('open');
    this.target = null;
    this.body.replaceChildren();
    this.app.layoutChanged();
  }
}
