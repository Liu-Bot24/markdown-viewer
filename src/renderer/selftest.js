// Scripted end-to-end checks, driven by the main process (--selftest spec.json).
// Each step returns plain JSON; the main process adds screenshots and the report.
import { sleep, nextFrame } from '../../packages/core/src/ui/util.js';

async function waitFor(fn, timeout = 15000, every = 50) {
  const t0 = performance.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (performance.now() - t0 > timeout) return null;
    await sleep(every);
  }
}

function visibleIn(el, scroller) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  const s = scroller.getBoundingClientRect();
  return r.bottom > s.top && r.top < s.bottom && r.height > 0;
}

async function probeResources(root, limit = 400) {
  // Check that local media URLs resolve through the protocol (no need to scroll them in).
  const urls = new Set();
  for (const n of root.querySelectorAll('img[src^="mdvfile:"], video[src^="mdvfile:"], audio[src^="mdvfile:"], video[poster^="mdvfile:"]')) {
    urls.add(n.getAttribute('src') || n.getAttribute('poster'));
    if (n.getAttribute('poster')) urls.add(n.getAttribute('poster'));
  }
  const list = [...urls].slice(0, limit);
  let ok = 0;
  const missing = [];
  await Promise.all(
    list.map(async (u) => {
      try {
        const r = await fetch(u, { method: 'HEAD' });
        if (r.ok) ok++;
        else missing.push(decodeURIComponent(u));
      } catch {
        missing.push(decodeURIComponent(u));
      }
    }),
  );
  return { total: urls.size, probed: list.length, ok, missing: missing.slice(0, 10) };
}

async function visibleImages(view) {
  await sleep(600);
  const imgs = Array.from(view.article.querySelectorAll('img')).filter((i) => visibleIn(i, view.el));
  await waitFor(() => imgs.every((i) => i.complete), 5000);
  return { visible: imgs.length, loaded: imgs.filter((i) => i.naturalWidth > 0).length, broken: imgs.filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.getAttribute('data-mdv-orig') || i.src).slice(0, 5) };
}

function viewInfo(app) {
  const v = app.activeView;
  if (!v) return null;
  return {
    path: v.path,
    error: v.error,
    meta: v.meta && { ...v.meta, headings: v.meta.headings.length, days: v.meta.days ? v.meta.days.length : 0 },
    scrollTop: Math.round(v.el.scrollTop),
    scrollHeight: v.el.scrollHeight,
    chatView: v.el.classList.contains('chat-view'),
  };
}

function editState(app) {
  const v = app.activeView;
  if (!v) return null;
  const tab = app.activeTab;
  const visible = (el) => !!el && el.getBoundingClientRect().width > 0 && getComputedStyle(el).visibility === 'visible';
  return {
    mode: v.mode,
    dirty: v.dirty,
    tabDirty: !!(tab && tab.el && tab.el.classList.contains('dirty')),
    title: document.title,
    status: document.getElementById('status-right').textContent,
    editorVisible: visible(v.editorHost) && !!v.editor,
    previewVisible: visible(v.el),
    editorWidth: Math.round(v.editorHost.getBoundingClientRect().width),
    previewWidth: Math.round(v.el.getBoundingClientRect().width),
    saveButton: document.getElementById('btn-save').style.display !== 'none',
    text: v.editor ? v.editor.getText().slice(-60) : null,
    preview: v.article.textContent.slice(-60),
    encoding: v.disk && v.disk.encoding,
  };
}

export function install(app) {
  let lastScrollBefore = null;
  let lastRef = null;
  let outlineMark = null;
  const steps = {
    async open({ path, anchor = '' }) {
      const t0 = performance.now();
      await app.openTargets({ targets: [{ path, anchor }], newTab: true });
      await waitFor(() => app.activeView && (app.activeView.meta || app.activeView.error));
      await nextFrame();
      const v = app.activeView;
      const res = { openMs: Math.round(performance.now() - t0), view: viewInfo(app) };
      if (anchor) {
        const el = v.findAnchor(anchor);
        const block = el && (el.closest('section.mdv-msg') || el);
        res.anchorFound = !!el;
        res.anchorVisible = visibleIn(block, v.el);
        res.anchorHighlighted = !!(block && block.classList.contains('mdv-target'));
      }
      return res;
    },

    async navigate({ path, anchor = '' }) {
      await app.navigate({ path, anchor });
      await waitFor(() => app.activeView && app.activeView.path.toLowerCase() === path.toLowerCase() && (app.activeView.meta || app.activeView.error));
      await nextFrame();
      const v = app.activeView;
      const el = anchor ? v.findAnchor(anchor) : null;
      return { view: viewInfo(app), anchorFound: !!el, anchorVisible: visibleIn(el && (el.closest('section.mdv-msg') || el), v.el) };
    },

    async scrollTo({ fraction = null, selector = null, index = 0 }) {
      const v = app.activeView;
      v.stopPin(); // stands in for the user's wheel input
      if (selector) {
        const el = v.article.querySelectorAll(selector)[index];
        if (el) el.scrollIntoView({ block: 'center' });
      } else if (fraction != null) v.el.scrollTop = (v.el.scrollHeight - v.el.clientHeight) * fraction;
      await nextFrame();
      await nextFrame();
      return { scrollTop: Math.round(v.el.scrollTop) };
    },

    /** Click the Nth reference link, wait for the peek panel. */
    async clickRef({ index = 0, selector = 'a.mdv-ref', timeout = 8000, settle = 1200 }) {
      const v = app.activeView;
      const all = v.article.querySelectorAll(selector);
      if (index === 'mid') index = all.length >> 1;
      else if (index < 0) index += all.length; // negative: count from the end
      const a = all[index];
      if (!a) return { error: 'no ref link' };
      a.scrollIntoView({ block: 'center' });
      await nextFrame();
      const before = Math.round(v.el.scrollTop);
      lastScrollBefore = before;
      lastRef = { selector, index, offset: a.getBoundingClientRect().top - v.el.getBoundingClientRect().top };
      const href = a.getAttribute('href');
      const anchor = decodeURIComponent(href.slice(href.lastIndexOf('#') + 1));
      const toastEl = document.getElementById('toast');
      if (toastEl) {
        toastEl.textContent = '';
        toastEl.className = '';
      }
      const shown = app.peek.shownCount || 0;
      a.click();
      await waitFor(() => (app.peek.shownCount || 0) > shown || (toastEl || document.getElementById('toast') || {}).textContent, timeout);
      const sec = document.querySelector(`#peek.open .peek-body section.mdv-target[data-msg-id="${CSS.escape(anchor)}"]`);
      if (sec) await sleep(settle); // images in neighbouring messages load and shift the layout
      const peekTitle = document.querySelector('.peek-title').textContent;
      const peekSub = document.querySelector('.peek-sub').textContent;
      return {
        href: decodeURIComponent(href),
        scrollTopBefore: before,
        peekOpen: document.querySelector('#peek').classList.contains('open'),
        targetShown: !!sec,
        targetVisible: sec ? visibleIn(sec, document.querySelector('.peek-scroll')) : false,
        messagesInPeek: document.querySelectorAll('.peek-body section.mdv-msg').length,
        peekTitle,
        peekSub,
        toast: (document.getElementById('toast') || {}).textContent || '',
      };
    },

    async peekOpenHere() {
      const tab = app.activeTab;
      const target = app.peek.target;
      document.querySelector('.peek-actions .btn.primary').click();
      await waitFor(() => tab.view && target && tab.view.path.toLowerCase() === target.path.toLowerCase() && tab.view.meta && tab.view.target === target.anchor, 15000);
      await nextFrame();
      await nextFrame();
      const v = tab.view;
      const el = v.findAnchor(target.anchor);
      const block = el && el.closest('section.mdv-msg');
      return {
        view: viewInfo(app),
        targetAnchor: target.anchor,
        anchorVisible: visibleIn(block, v.el),
        highlighted: !!(block && block.classList.contains('mdv-target')),
        historyLength: tab.entries.length,
      };
    },

    async back() {
      const tab = app.activeTab;
      await app.tabs.back();
      await nextFrame();
      await nextFrame();
      const v = app.activeView;
      const now = Math.round(v.el.scrollTop);
      // The clicked reference should be back where it was on screen.
      let refVisible = null;
      let refOffsetDelta = null;
      if (lastRef) {
        const a = v.article.querySelectorAll(lastRef.selector)[lastRef.index];
        refVisible = visibleIn(a, v.el);
        if (a) refOffsetDelta = Math.round(Math.abs(a.getBoundingClientRect().top - v.el.getBoundingClientRect().top - lastRef.offset));
      }
      return { view: viewInfo(app), historyIndex: tab.index, scrollDelta: lastScrollBefore == null ? null : Math.abs(now - lastScrollBefore), refVisible, refOffsetDelta };
    },

    async find({ query }) {
      app.find.open();
      app.find.input.value = query;
      app.find.run();
      await nextFrame();
      return { matches: app.find.matches.length, current: app.find.current, count: app.find.count.textContent };
    },

    closeFind() {
      app.find.close();
      return {};
    },

    async media() {
      const v = app.activeView;
      const res = await probeResources(v.article);
      return {
        inlineImages: v.article.querySelectorAll('.mdv-media-image').length,
        inlineVideos: v.article.querySelectorAll('.mdv-media-video').length,
        inlineAudios: v.article.querySelectorAll('.mdv-media-audio').length,
        probe: res,
        visibleImages: await visibleImages(v),
      };
    },

    async visibleImages() {
      return visibleImages(app.activeView);
    },

    async setChatView({ on }) {
      if (!!app.settings.chatView !== !!on) app.toggleChatView();
      await nextFrame();
      return { chatView: app.activeView && app.activeView.el.classList.contains('chat-view') };
    },

    async setSettings({ settings }) {
      app.setSetting(settings);
      await nextFrame();
      return { ok: true };
    },

    closePeek() {
      if (app.peek.isOpen) app.peek.close();
      return {};
    },

    async closeAllTabs() {
      for (const t of [...app.tabs.tabs]) await app.tabs.close(t);
      await nextFrame();
      return {};
    },

    async scrollPerf({ steps = 40 }) {
      // Scroll through the document and measure frame times.
      const v = app.activeView;
      v.stopPin();
      const max = v.el.scrollHeight - v.el.clientHeight;
      const times = [];
      for (let i = 0; i <= steps; i++) {
        const t0 = performance.now();
        v.el.scrollTop = (max * i) / steps;
        await nextFrame();
        times.push(performance.now() - t0);
      }
      times.sort((a, b) => a - b);
      return { frames: times.length, medianMs: Math.round(times[times.length >> 1]), p95Ms: Math.round(times[Math.floor(times.length * 0.95)]), maxMs: Math.round(times[times.length - 1]) };
    },

    async reloadKeepsPosition() {
      const v = app.activeView;
      const before = v.capture();
      await v.reload();
      await nextFrame();
      const after = v.capture();
      const samePlace = JSON.stringify(before.ref) === JSON.stringify(after.ref) && Math.abs(before.offset - after.offset) <= 2;
      return { before: before.ref, after: after.ref, offsetBefore: Math.round(before.offset), offsetAfter: Math.round(after.offset), samePlace };
    },

    /** Wait until the active tab shows `path` (and `anchor`, if given), e.g. after a CLI hand-off. */
    async waitTarget({ path, anchor = '', timeout = 20000 }) {
      const v = await waitFor(() => {
        const view = app.activeView;
        return view && view.meta && view.path.toLowerCase() === path.toLowerCase() && (!anchor || view.target === anchor) ? view : null;
      }, timeout);
      if (!v) return { found: false, view: viewInfo(app), tabs: app.tabs.tabs.length };
      await nextFrame();
      const el = anchor ? v.findAnchor(anchor) : null;
      return { found: true, tabs: app.tabs.tabs.length, anchorVisible: anchor ? visibleIn(el && (el.closest('section.mdv-msg') || el), v.el) : null };
    },

    /** Switch the active document to view | edit | split. */
    async mode({ mode }) {
      await app.setMode(mode);
      await nextFrame();
      return editState(app);
    },

    /** Change the editor text the way typing does (a user transaction). */
    async edit({ insert = '', at = 'end', replace = null, with: by = '' }) {
      const ed = app.activeView.editor;
      const doc = ed.view.state.doc.toString();
      let change;
      if (replace != null) {
        const i = doc.indexOf(replace);
        if (i < 0) return { error: 'text to replace not found: ' + replace };
        change = { from: i, to: i + replace.length, insert: by };
      } else {
        const pos = at === 'start' ? 0 : doc.length;
        change = { from: pos, insert };
      }
      ed.view.dispatch({ changes: change, userEvent: 'input.type' });
      await nextFrame();
      return editState(app);
    },

    /** Put focus in the editor (real key events then go to it). */
    async focusEditor({ line = null }) {
      const ed = app.activeView.editor;
      if (line != null) ed.gotoLine(line);
      ed.focus();
      await nextFrame();
      return { focused: ed.hasFocus() };
    },

    async save() {
      const ok = await app.saveActive();
      await nextFrame();
      return { saved: ok, ...editState(app) };
    },

    /** Scripted answers for the next confirmation dialogs (button indexes). */
    answer({ responses = [] }) {
      app.testAnswers = [...responses];
      app.asked = [];
      return {};
    },

    asked() {
      return { asked: app.asked || [], pending: (app.testAnswers || []).length };
    },

    /** Scripted picks (item labels) for the next context menus, in order. */
    menuPick({ labels = [] }) {
      app.testMenus = labels.length ? [...labels] : null;
      app.menusShown = [];
      return {};
    },

    /** Labels of the context menus shown since menuPick. */
    menusShown() {
      return { shown: (app.menusShown || []).map((m) => m.join('|')), pending: (app.testMenus || []).length };
    },

    async closeTab() {
      const closed = await app.tabs.close(app.activeTab);
      await nextFrame();
      return { closed, tabs: app.tabs.tabs.length, asked: app.asked || [] };
    },

    async navigateAway({ path }) {
      const before = app.activeView.path;
      await app.navigate({ path, anchor: '' });
      await waitFor(() => app.activeView && app.activeView.meta, 5000);
      return { left: app.activeView.path !== before, path: app.activeView.path, asked: app.asked || [], ...editState(app) };
    },

    editState({ find = null }) {
      const v = app.activeView;
      return { ...editState(app), previewHas: find == null ? null : v.article.textContent.includes(find) };
    },

    exists({ selector }) {
      return { count: document.querySelectorAll(selector).length };
    },

    /** Wait until the active document's editor shows text containing `includes`. */
    async waitEditorText({ includes, timeout = 8000 }) {
      const ok = await waitFor(() => {
        const ed = app.activeView && app.activeView.editor;
        return ed && ed.getText().includes(includes);
      }, timeout);
      return { found: !!ok, ...editState(app) };
    },

    /** Wait for the external-change banner of a document with unsaved edits. */
    async waitBanner({ includes, timeout = 8000 }) {
      const ok = await waitFor(() => app.activeView.banner.textContent.includes(includes), timeout);
      return { found: !!ok, banner: app.activeView.banner.textContent };
    },

    /** The preview top and the editor top show the same source line (split layout). */
    async syncCheck({ line }) {
      const v = app.activeView;
      v.lead = 'editor';
      v.editor.scrollToLine(line);
      await sleep(200);
      return { editorTop: Math.round(v.editor.topLine()), previewTop: Math.round(v.previewTopLine()) };
    },

    renderSeq() {
      const v = app.activeView;
      return { renderSeq: v ? v.renderSeq : -1 };
    },

    /** Wait for the active document to re-render (file watcher). */
    async waitRender({ after, timeout = 10000 }) {
      const v = app.activeView;
      const ok = await waitFor(() => v.renderSeq > after, timeout);
      return { rerendered: !!ok, renderSeq: v.renderSeq, text: v.article.textContent.slice(-80) };
    },

    /** Size and computed display of the first element matching `selector` in the active document. */
    rect({ selector }) {
      const n = app.activeView.article.querySelector(selector);
      if (!n) return { found: false };
      const r = n.getBoundingClientRect();
      const cs = getComputedStyle(n);
      return { found: true, width: Math.round(r.width), height: Math.round(r.height), display: cs.display, visibility: cs.visibility, opacity: cs.opacity };
    },

    /** The active folder page or file view, and the viewer's stepping state. */
    fvState() {
      const v = app.activeView;
      const lb = app.lightbox;
      const out = {
        kind: v && v.kind,
        path: v && v.path,
        target: v && v.kind === 'doc' ? v.target || '' : null,
        title: document.title,
        status: document.getElementById('status-right').textContent,
        toast: (() => { const t = document.getElementById('toast'); return t && t.classList.contains('show') ? t.textContent : ''; })(),
        lb: { open: lb.isOpen, count: lb.counter.textContent, caption: lb.caption.textContent, locate: !!lb.locateBtn && !lb.locateBtn.hidden && lb.locateBtn.offsetParent !== null },
        // folder tree: names of the expanded folders and of the highlighted item
        tree: {
          open: [...app.tree.nodes.values()].filter((n) => n.open && n.el).map((n) => n.el.querySelector('.tree-label').textContent).join(','),
          current: (() => { const c = document.querySelector('.tree-item.current .tree-label'); return c ? c.textContent : ''; })(),
        },
        tabs: app.tabs.tabs.length,
      };
      if (v && v.kind === 'folder') {
        const imgs = [...v.body.querySelectorAll('img')];
        Object.assign(out, {
          layout: v.layout,
          total: v.total,
          items: v.items.length,
          cols: v.cols,
          cells: v.cells.size,
          chips: [...v.head.querySelectorAll('.fv-chip')].map((b) => b.textContent).join(','),
          years: [...v.head.querySelectorAll('.fv-year')].map((b) => b.textContent).join(','),
          names: [...v.body.querySelectorAll('.fv-name')].map((n) => n.textContent).join('|'),
          transcripts: [...v.body.querySelectorAll('.fv-transcript')].map((t) => t.textContent).join('|'),
          imgs: imgs.length,
          imgsLoaded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length,
          playing: !!(v.player && !v.player.paused),
          bodyWidth: Math.round(v.body.getBoundingClientRect().width),
          // list rows: the narrowest file name, and how many rows still show a date and a size
          nameMinWidth: (() => { const w = [...v.body.querySelectorAll('.fv-row .fv-name')].map((n) => n.getBoundingClientRect().width); return w.length ? Math.round(Math.min(...w)) : null; })(),
          datesShown: [...v.body.querySelectorAll('.fv-row .fv-date')].filter((d) => d.offsetWidth > 0).length,
          sizesShown: [...v.body.querySelectorAll('.fv-row .fv-size')].filter((d) => d.offsetWidth > 0).length,
          paneWidth: Math.round(v.el.clientWidth),
        });
      }
      if (v && v.kind === 'file') {
        const frame = v.article.querySelector('iframe');
        Object.assign(out, { text: v.article.textContent.slice(0, 80), frame: !!frame, sandbox: frame ? frame.getAttribute('sandbox') : null, modeSeg: document.getElementById('mode-seg').style.display });
      }
      return out;
    },

    /** Wait until the active view is a `kind` view that finished loading. */
    async fvWait({ kind, timeout = 10000, settle = 600 }) {
      await waitFor(() => {
        const v = app.activeView;
        return v && v.kind === kind && (v.listed || v.info || v.meta || v.error);
      }, timeout);
      await sleep(settle);
      return steps.fvState();
    },

    /** Open the lightbox on a local image without going through a document. */
    async lbOpen({ path, timeout = 10000 }) {
      app.lightbox.open({ kind: 'image', path });
      const ok = await waitFor(() => app.lightbox.img && app.lightbox.img.complete && app.lightbox.img.naturalWidth > 0, timeout);
      return { loaded: !!ok, ...steps.lbState({}) };
    },

    /** Lightbox state; with x, y also the image point (fractions) under that window point. */
    lbState({ x = null, y = null }) {
      const lb = app.lightbox;
      const st = lb.stage.getBoundingClientRect();
      const out = { open: lb.isOpen, zoomed: lb.zoomed, scrollLeft: Math.round(lb.stage.scrollLeft), scrollTop: Math.round(lb.stage.scrollTop) };
      if (!lb.img) return out;
      const r = lb.img.getBoundingClientRect();
      Object.assign(out, {
        natural: [lb.img.naturalWidth, lb.img.naturalHeight],
        imgWidth: Math.round(r.width),
        imgHeight: Math.round(r.height),
        fits: r.left >= st.left - 1 && r.top >= st.top - 1 && r.right <= st.left + lb.stage.clientWidth + 1 && r.bottom <= st.top + lb.stage.clientHeight + 1,
      });
      if (x != null) Object.assign(out, { fx: +((x - r.left) / r.width).toFixed(4), fy: +((y - r.top) / r.height).toFixed(4) });
      return out;
    },

    /** Scroll the lightbox to each end: are all four image edges reachable? Restores the scroll. */
    async lbReach() {
      const lb = app.lightbox;
      const s = lb.stage;
      const keep = [s.scrollLeft, s.scrollTop];
      const st = () => s.getBoundingClientRect();
      const im = () => lb.img.getBoundingClientRect();
      s.scrollTo(0, 0);
      await sleep(50);
      const topLeft = im().left >= st().left - 1 && im().top >= st().top - 1;
      s.scrollTo(s.scrollWidth, s.scrollHeight);
      await sleep(50);
      const bottomRight = im().right <= st().left + s.clientWidth + 1 && im().bottom <= st().top + s.clientHeight + 1;
      s.scrollTo(keep[0], keep[1]);
      await sleep(50);
      return { topLeft, bottomRight, scrollable: s.scrollWidth > s.clientWidth || s.scrollHeight > s.clientHeight };
    },

    /** Drive the outline panel like a user (buttons, twisties, filter) and report what it shows. */
    async outline({ action = 'state', text = null, query = '' }) {
      const o = app.outline;
      const twisties = () => [...o.inner.querySelectorAll('.outline-twisty[title]')];
      if (action === 'collapseAll') o.collapseBtn.click();
      else if (action === 'expandAll') o.expandBtn.click();
      else if (action === 'toggle') {
        const k = o.shown.findIndex((x) => x.it.text === text);
        if (k < 0) return { error: 'no visible row ' + text };
        o.scroller.scrollTop = Math.max(0, k * 26 - 100);
        o.paint(true);
        const row = [...o.inner.children].find((r) => r.querySelector('.outline-text').textContent === text);
        const tw = row && row.querySelector('.outline-twisty[title]');
        if (!tw) return { error: 'no twisty on ' + text };
        tw.click();
      } else if (action === 'filter') {
        o.filterInput.value = query;
        o.filterInput.dispatchEvent(new Event('input'));
        await sleep(250);
      } else if (action === 'go') {
        o.go(o.items.findIndex((it) => it.text === text));
        await sleep(300);
      } else if (action === 'mark') outlineMark = app.activeView.el.scrollTop;
      await nextFrame();
      const v = app.activeView;
      const activeRow = o.inner.querySelector('.outline-item.active .outline-text');
      return {
        items: o.items.length,
        rows: o.shown.length,
        first: o.shown.slice(0, 6).map((x) => x.it.text),
        folded: [...o.collapsed].map((i) => o.items[i].text),
        active: o.activeIndex >= 0 ? o.items[o.activeIndex].text : null,
        activeRow: activeRow ? activeRow.textContent : null,
        twisties: twisties().length,
        buttonsShown: o.collapseBtn.style.display !== 'none',
        collapseDisabled: o.collapseBtn.disabled,
        expandDisabled: o.expandBtn.disabled,
        docScrollMoved: outlineMark == null || !v ? null : Math.round(Math.abs(v.el.scrollTop - outlineMark)),
      };
    },

    wait({ ms = 300 }) {
      return sleep(ms).then(() => ({}));
    },

    state() {
      return { view: viewInfo(app), tabs: app.tabs.tabs.length, visibility: document.visibilityState };
    },
  };

  window.__mdvTest = {
    async step(step) {
      const fn = steps[step.do];
      if (!fn) return { error: 'unknown step ' + step.do };
      try {
        return await fn(step);
      } catch (e) {
        return { error: String((e && e.stack) || e) };
      }
    },
  };
}
