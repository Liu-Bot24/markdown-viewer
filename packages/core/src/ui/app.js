import { $, $$, h, toast, debounce, rafThrottle, fmtSize, isUnder, sameFile, caps } from './util.js';
import { Tabs } from './tabs.js';
import { FolderTree } from './tree.js';
import { Outline } from './outline.js';
import { FindBar } from './find.js';
import { PeekPanel } from './peek.js';
import { Lightbox } from './lightbox.js';
import { mediaKind, isMarkdownPath, fileViewKind, dirname, basename, isVirtualPath, resourceUrlToPath } from '../shared/paths.js';
import { isMessageAnchor } from '../shared/chat.js';

class App {
  constructor(opts = {}) {
    this.opts = opts;
    this.caps = caps();
  }

  async init() {
    const st = await window.mdv.getState();
    this.settings = st.settings;
    this.recent = st.recent;
    this.version = st.version;
    this.isSelftest = st.isSelftest;
    this.docsEl = $('#docs');
    this.welcomeEl = $('#welcome');
    this.tabs = new Tabs(this, $('#tabstrip'));
    this.tree = new FolderTree(this, $('#sidebar'));
    this.outline = new Outline(this, $('#outline'));
    this.find = new FindBar(this, $('#findbar-host'));
    this.peek = new PeekPanel(this, $('#peek'));
    this.lightbox = new Lightbox();
    this.lastNotedRecent = null;
    this.outlineFor = null;

    this.applyLayout();
    this.bindToolbar();
    this.bindDocumentEvents();
    this.bindResizers();
    this.bindDragDrop();
    this.bindIpc();
    this.bindCloseGuard();
    this.renderWelcome();
    this.onViewChanged(null);

    if (st.rootFolder) this.tree.setRoot(st.rootFolder, { persist: false });
    if (this.isSelftest && this.opts.selftest) (await this.opts.selftest()).install(this);
    if (this.opts.afterInit) await this.opts.afterInit(this);
    window.mdv.ready();
    if (!st.hasInitialTargets && st.session && st.session.length) {
      for (const t of st.session) await this.tabs.open({ path: t.path, anchor: '', view: t.view }, { background: true });
      const first = this.tabs.tabs[0];
      if (first) this.tabs.activate(first);
    }
  }

  get activeTab() {
    return this.tabs.active;
  }

  get activeView() {
    return this.tabs.active ? this.tabs.active.view : null;
  }

  // ---------- layout ----------
  applyLayout() {
    const s = this.settings;
    const root = document.documentElement;
    root.style.setProperty('--sidebar-w', s.sidebarWidth + 'px');
    root.style.setProperty('--outline-w', s.outlineWidth + 'px');
    root.style.setProperty('--peek-w', s.peekWidth + 'px');
    root.style.setProperty('--edit-split', String(s.editSplit || 0.5));
    document.body.classList.toggle('no-sidebar', !s.sidebar);
    document.body.classList.toggle('no-outline', !s.outline);
    $('#btn-width').classList.toggle('on', s.readingWidth === 'wide');
    $('#btn-chatview').classList.toggle('on', !!s.chatView);
    for (const { view } of this.tabs.allViews()) view.applyViewSettings();
  }

  /** Docking the peek panel changes the reading width; keep what the user looks at in place. */
  layoutChanged() {
    const open = this.peek.isOpen;
    if (document.body.classList.contains('peek-open') === open) return;
    const v = this.activeView;
    let keep = v && v.article.querySelector('a.mdv-ref-active');
    if (keep) {
      const r = keep.getBoundingClientRect();
      const box = v.el.getBoundingClientRect();
      if (r.bottom < box.top || r.top > box.bottom) keep = null;
    }
    const keepTop = keep ? keep.getBoundingClientRect().top : 0;
    const pos = v && !keep ? v.capture() : null;
    document.body.classList.toggle('peek-open', open);
    if (keep) v.el.scrollTop += keep.getBoundingClientRect().top - keepTop;
    else if (pos) v.restore(pos, { forceRef: true });
  }

  setSetting(patch) {
    Object.assign(this.settings, patch);
    window.mdv.patchState({ settings: patch });
    this.applyLayout();
  }

  learnSelfId(id) {
    const ids = [...new Set([...(this.settings.selfIds || []), id])];
    this.setSetting({ selfIds: ids });
  }

  bindToolbar() {
    $('#btn-back').onclick = () => this.goBack();
    $('#btn-forward').onclick = () => this.goForward();
    $('#btn-open').onclick = () => window.mdv.openDialog('file');
    $('#btn-sidebar').onclick = () => this.setSetting({ sidebar: !this.settings.sidebar });
    $('#btn-outline').onclick = () => this.setSetting({ outline: !this.settings.outline });
    $('#btn-find').onclick = () => this.find.open();
    $('#btn-width').onclick = () => this.setSetting({ readingWidth: this.settings.readingWidth === 'wide' ? 'normal' : 'wide' });
    $('#btn-chatview').onclick = () => this.toggleChatView();
    $('#btn-save').onclick = () => this.saveActive();
    for (const b of $$('#mode-seg button')) b.onclick = () => this.setMode(b.dataset.mode);
  }

  // ---------- editing ----------
  /** Ask with a native dialog; returns the index of the chosen button. */
  ask(opts) {
    if (this.testAnswers) {
      // selftest: scripted answers instead of a blocking dialog
      this.asked.push(opts.message);
      return Promise.resolve(this.testAnswers.length ? this.testAnswers.shift() : opts.cancelId ?? opts.buttons.length - 1);
    }
    return window.mdv.ask(opts);
  }

  /** Unsaved edits in `view`: save, discard or cancel. Resolves true when it is fine to move on. */
  async confirmDiscard(view) {
    const a = await this.ask({
      type: 'warning',
      message: `“${view.title}”有未保存的修改。`,
      detail: '不保存的话，这些修改会丢失。',
      buttons: ['保存', '不保存', '取消'],
      defaultId: 0,
      cancelId: 2,
    });
    if (a === 0) return view.save();
    if (a === 1) {
      await view.revert();
      return true;
    }
    return false;
  }

  dirtyViews() {
    return this.tabs.allViews().map((x) => x.view).filter((v) => v.dirty);
  }

  async setMode(mode, view = this.activeView) {
    if (!view) return;
    if (mode !== 'view' && mode !== this.settings.editLayout) this.setSetting({ editLayout: mode });
    await view.setMode(mode);
  }

  toggleEdit() {
    const v = this.activeView;
    if (v) return this.setMode(v.editing ? 'view' : this.settings.editLayout === 'edit' ? 'edit' : 'split', v);
  }

  toggleSplit() {
    const v = this.activeView;
    if (v) return this.setMode(v.mode === 'split' ? 'edit' : 'split', v);
  }

  async saveActive() {
    const v = this.activeView;
    if (!v) return false;
    if (!v.editor) return true;
    const ok = await v.save();
    if (ok && v.lastSave && v.lastSave.exported) toast('已导出副本：' + v.lastSave.name, 'info', 3000);
    else if (ok) toast('已保存', 'info', 1200);
    return ok;
  }

  async discardAndReload(view) {
    view.setDirty(false);
    await view.reload();
    this.onViewChanged(this.tabs.tabs.find((t) => t.view === view) || null);
  }

  onDirtyChanged(view) {
    this.tabs.renderStrip();
    if (view === this.activeView) this.renderChrome(view);
  }

  onSaved(view) {
    if (view === this.activeView) this.renderChrome(view);
  }

  onModeChanged(view) {
    if (view === this.activeView) {
      this.renderChrome(view);
      this.outline.setView(view);
      if (this.find.isOpen && view.mode === 'edit') this.find.close();
    }
  }

  onViewRendered(view) {
    const tab = this.tabs.tabs.find((t) => t.view === view);
    if (tab) this.onViewChanged(tab);
  }

  onCursor = rafThrottle((view) => {
    if (view === this.activeView) this.renderStatus(view);
  });

  /** Mode switch, save button, title and status for the active document. */
  renderChrome(view) {
    const editable = !!(view && view.kind === 'doc' && view.meta && !view.error);
    $('#mode-seg').style.display = editable || (view && view.editing) ? '' : 'none';
    for (const b of $$('#mode-seg button')) b.classList.toggle('on', !!view && view.mode === b.dataset.mode);
    $('#btn-save').style.display = view && view.dirty ? '' : 'none';
    document.title = view ? `${view.dirty ? '● ' : ''}${view.title} - MD Viewer` : 'MD Viewer';
    this.renderStatus(view);
  }

  /** Closing the window with unsaved edits asks first (the window is closed again afterwards). */
  bindCloseGuard() {
    window.addEventListener('beforeunload', (e) => {
      if (this.closeApproved || !this.dirtyViews().length) return;
      e.preventDefault();
      e.returnValue = false;
      if (this.caps.nativeCloseGuard) return; // the browser asks by itself
      if (this.closing) return;
      this.closing = true;
      setTimeout(() => this.confirmClose().finally(() => (this.closing = false)), 0);
    });
  }

  async confirmClose() {
    const dirty = this.dirtyViews();
    if (!dirty.length) return;
    const one = dirty.length === 1;
    const a = await this.ask({
      type: 'warning',
      message: one ? `“${dirty[0].title}”有未保存的修改。` : `${dirty.length} 个文件有未保存的修改。`,
      detail: (one ? '' : dirty.map((v) => v.title).join('\n') + '\n\n') + '关闭窗口前要保存吗？',
      buttons: [one ? '保存' : '全部保存', '不保存', '取消'],
      defaultId: 0,
      cancelId: 2,
    });
    if (a === 2) return;
    if (a === 0) for (const v of dirty) if (!(await v.save())) return;
    this.closeApproved = true;
    window.mdv.closeWindow();
  }

  toggleChatView() {
    const v = this.activeView;
    const pos = v ? v.capture() : null;
    this.setSetting({ chatView: !this.settings.chatView });
    if (v && pos) v.restore(pos, { forceRef: true });
    if (this.peek.isOpen) this.peek.render(true);
    this.find.setView(v);
  }

  bindResizers() {
    for (const r of $$('.resizer')) {
      const which = r.dataset.for;
      r.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        r.setPointerCapture(e.pointerId);
        const startX = e.clientX;
        const key = which + 'Width';
        const start = this.settings[key];
        const sign = which === 'sidebar' ? 1 : -1;
        const move = (ev) => {
          const w = Math.max(160, Math.min(900, start + sign * (ev.clientX - startX)));
          this.settings[key] = w;
          document.documentElement.style.setProperty(`--${which}-w`, w + 'px');
        };
        const up = () => {
          r.removeEventListener('pointermove', move);
          r.removeEventListener('pointerup', up);
          window.mdv.patchState({ settings: { [key]: this.settings[key] } });
        };
        r.addEventListener('pointermove', move);
        r.addEventListener('pointerup', up);
      });
    }
  }

  // ---------- navigation ----------
  /** Back/forward: through the platform's history when it keeps one (the browser). */
  goBack() {
    if (window.mdv.historyBack) return window.mdv.historyBack();
    return this.tabs.back();
  }

  goForward() {
    if (window.mdv.historyForward) return window.mdv.historyForward();
    return this.tabs.forward();
  }

  /** A second place to show target: an app tab, or a new browser window on the web. */
  openNewTab(target, opts) {
    if (this.caps.appTabs) return this.tabs.open(target, opts);
    if (window.mdv.openInNewWindow && window.mdv.openInNewWindow(target)) return;
    return this.navigate(target);
  }

  navigate(target) {
    if (this.activeTab) return this.tabs.go(this.activeTab, target);
    return this.tabs.open(target);
  }

  /** Open a path from the tree / welcome list. */
  openPath(path, { newTab = false } = {}) {
    if (!newTab) {
      const t = this.tabs.findByPath(path);
      if (t) return this.tabs.activate(t);
      if (this.activeTab) return this.navigate({ path, anchor: '' });
      return this.tabs.open({ path, anchor: '' });
    }
    return this.openNewTab({ path, anchor: '' });
  }

  /** The folder page for dir: in this tab, or a new one. */
  openFolder(dir, { newTab = false } = {}) {
    // one spelling per folder: no trailing separator (a link written as "图片/" has one), except a root
    const path = String(dir).replace(isVirtualPath(dir) ? /\/+$/ : /\\+$/, '') || '/';
    const target = { path: /^[a-zA-Z]:$/.test(path) ? path + '\\' : path, anchor: '', view: 'folder' };
    if (newTab) return this.openNewTab(target);
    return this.navigate(target);
  }

  /**
   * Open a listing entry or a link target that is not a folder: Markdown as a document,
   * pictures, video and audio in the viewer, text files and web pages read-only in the
   * app, anything else with the platform (the default program; on the web a download).
   */
  openEntry(e, { newTab = false } = {}) {
    if (e.isDir) return this.openFolder(e.path, { newTab });
    if (isMarkdownPath(e.path)) return newTab ? this.openNewTab({ path: e.path, anchor: '' }) : this.navigate({ path: e.path, anchor: '' });
    const media = mediaKind(e.path);
    if (media) return this.lightbox.open({ kind: media, path: e.path });
    if (fileViewKind(e.path)) {
      const target = { path: e.path, anchor: '', view: 'file' };
      return newTab ? this.openNewTab(target) : this.navigate(target);
    }
    return window.mdv.openPath(e.path);
  }

  async openTargets(msg) {
    if (msg.folder) {
      await this.tree.setRoot(msg.folder);
      if (!this.settings.sidebar) this.setSetting({ sidebar: true });
    }
    for (const t of msg.targets) {
      const existing = msg.newTab ? null : this.tabs.findByPath(t.path, t.view);
      if (existing) {
        this.tabs.activate(existing);
        if (t.anchor) await this.tabs.go(existing, { path: existing.view.path, anchor: t.anchor });
      } else await this.tabs.open({ path: t.path, anchor: t.anchor || '', view: t.view });
    }
  }

  noteRecent(path) {
    if (this.lastNotedRecent && sameFile(this.lastNotedRecent, path)) return;
    this.lastNotedRecent = path;
    window.mdv.addRecent(path).then((r) => {
      this.recent = r;
      if (!this.tabs.tabs.length) this.renderWelcome();
    });
  }

  saveSession = debounce(() => {
    if (this.isSelftest) return;
    const session = this.tabs.tabs.filter((t) => t.view).map((t) => (t.view.kind === 'doc' ? { path: t.view.path } : { path: t.view.path, view: t.view.kind }));
    window.mdv.patchState({ session });
  }, 500);

  onViewChanged(tab) {
    if (tab && tab !== this.tabs.active) return;
    const view = tab ? tab.view : null;
    const hasTabs = this.tabs.tabs.length > 0;
    this.welcomeEl.style.display = hasTabs ? 'none' : '';
    if (!hasTabs) this.renderWelcome();
    $('#btn-back').disabled = !this.tabs.canBack();
    $('#btn-forward').disabled = !this.tabs.canForward();
    $('#btn-chatview').style.display = view && view.meta && view.meta.isChat && view.mode !== 'edit' ? '' : 'none';
    this.renderBreadcrumb(view);
    this.renderChrome(view);
    const key = view ? view.id + ':' + view.renderSeq : null;
    if (key !== this.outlineFor) {
      this.outlineFor = key;
      this.outline.setView(view);
      this.find.setView(view);
    }
    if (view) {
      if (view.kind === 'folder' && sameFile(view.path, this.tree.root)) this.tree.reveal(view.path);
      else if (!this.tree.root || !isUnder(view.path, this.tree.root)) this.tree.setRoot(view.kind === 'folder' ? view.path : dirname(view.path));
      else this.tree.reveal(view.path);
      if (document.activeElement === document.body) (view.mode !== 'view' && view.editor ? view.editor : view.el).focus({ preventScroll: true });
    }
    if (window.mdv.viewChanged) window.mdv.viewChanged(view, tab);
  }

  renderBreadcrumb(view) {
    const bc = $('#breadcrumb');
    if (!view) return bc.replaceChildren();
    const items = [];
    const crumbs = this.crumbsOf(view.path);
    crumbs.forEach((c, i) => {
      if (i) items.push(h('span.sep', null, '›'));
      items.push(
        i === crumbs.length - 1
          ? h('span.crumb.last', { title: view.path }, c.label)
          : h('span.crumb', { title: '在目录树中打开 ' + c.dir, onclick: () => this.tree.setRoot(c.dir) }, c.label),
      );
    });
    bc.replaceChildren(...items);
    bc.scrollLeft = bc.scrollWidth;
  }

  /** Breadcrumb parts of a path: [{ label, dir }], the last one being the file. */
  crumbsOf(path) {
    if (window.mdv.crumbs) return window.mdv.crumbs(path);
    let acc = '';
    if (isVirtualPath(path)) {
      return path
        .split('/')
        .filter(Boolean)
        .map((p) => ({ label: p, dir: (acc += '/' + p) }));
    }
    return path.split('\\').map((p, i) => {
      acc = i === 0 ? p : acc + '\\' + p;
      return { label: p, dir: i === 0 ? acc + '\\' : acc };
    });
  }

  renderStatus(view) {
    const left = $('#status-left');
    const right = $('#status-right');
    if (!view) {
      left.textContent = '';
      right.textContent = `MD Viewer ${this.version}`;
      return;
    }
    left.textContent = view.path;
    if (view.statusBits) {
      right.textContent = view.statusBits().join(' · ');
      return;
    }
    const m = view.meta;
    if (!m) {
      right.textContent = view.error ? '无法打开' : '载入中…';
      return;
    }
    const bits = [];
    if (view.dirty) bits.push('未保存');
    if (view.editing && view.editor) {
      const c = view.editor.cursor();
      bits.push(`第 ${c.line.toLocaleString()} 行，第 ${c.col} 列`);
    }
    bits.push(m.encoding, m.eol, fmtSize(m.size), `${m.lines.toLocaleString()} 行`);
    if (m.isChat) bits.push(`${m.messages.toLocaleString()} 条消息`);
    if (m.refs) bits.push(`${m.refs.toLocaleString()} 条引用`);
    bits.push(`渲染 ${m.timing.total} ms`);
    right.textContent = bits.join(' · ');
  }

  // ---------- document events ----------
  basePathFor(el) {
    const p = el.closest('[data-path]');
    if (p) return p.dataset.path;
    return this.activeView ? this.activeView.path : null;
  }

  bindDocumentEvents() {
    document.addEventListener('click', (e) => {
      const copy = e.target.closest('.mdv-copy');
      if (copy) {
        e.preventDefault();
        const pre = copy.closest('pre');
        const code = pre && pre.querySelector('code');
        window.mdv.copyText(code ? code.textContent : '');
        toast('已复制代码');
        return;
      }
      const a = e.target.closest('.markdown-body a[href]');
      if (a) {
        e.preventDefault();
        this.onLinkClick(e, a);
        return;
      }
      const img = e.target.closest('.markdown-body img');
      if (img && !img.closest('a') && !img.classList.contains('mdv-broken')) {
        const box = img.closest('.mdv-media');
        this.lightbox.open({ kind: 'image', src: img.currentSrc || img.src, path: box ? box.dataset.path : this.imagePath(img) });
      }
    });
    document.addEventListener('auxclick', (e) => {
      if (e.button !== 1) return;
      const a = e.target.closest('.markdown-body a[href]');
      if (a) {
        e.preventDefault();
        this.onLinkClick(e, a, { newTab: true });
      }
    });
    if (!window.mdv.historyBack) {
      // in a browser its own back/forward buttons drive the history
      document.addEventListener('mousedown', (e) => {
        if (e.button === 3 || e.button === 4) e.preventDefault();
      });
      document.addEventListener('mouseup', (e) => {
        if (e.button === 3) this.tabs.back();
        if (e.button === 4) this.tabs.forward();
      });
    }
    document.addEventListener('contextmenu', (e) => {
      if (e.target.closest('input, textarea')) return;
      if (e.target.closest('.cm-editor')) {
        e.preventDefault();
        this.editorContextMenu();
        return;
      }
      if (e.target.closest('.markdown-body, #docs')) {
        e.preventDefault();
        this.docContextMenu(e);
      }
    });
    document.addEventListener('mouseover', (e) => {
      const a = e.target.closest('.markdown-body a[href]');
      if (a) $('#status-left').textContent = a.title || a.getAttribute('href');
    });
    document.addEventListener('mouseout', (e) => {
      if (e.target.closest('.markdown-body a[href]')) this.renderStatus(this.activeView);
    });
    // media failing to load: mark it instead of showing a broken icon
    document.addEventListener(
      'error',
      (e) => {
        const t = e.target;
        if (t.tagName === 'IMG' && t.closest('.markdown-body')) {
          t.classList.add('mdv-broken');
          t.title = '无法加载：' + (t.getAttribute('data-mdv-orig') || t.getAttribute('src'));
          const box = t.closest('.mdv-media');
          if (box) box.classList.add('missing');
        } else if ((t.tagName === 'VIDEO' || t.tagName === 'AUDIO') && t.closest('.mdv-media')) {
          t.closest('.mdv-media').classList.add('missing');
        }
      },
      true,
    );
    const onScroll = rafThrottle(() => this.outline.updateActive());
    this.docsEl.addEventListener(
      'scroll',
      (e) => {
        if (this.activeView && e.target === this.activeView.el) onScroll();
      },
      true,
    );
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (e.defaultPrevented) return; // the editor's search panel took it
        if (this.lightbox.isOpen) this.lightbox.close();
        else if (this.find.isOpen) this.find.close();
        else if (this.peek.isOpen) this.peek.close();
        else return;
        e.preventDefault(); // one Esc closes one thing
        return;
      }
      const inField = e.target.closest && e.target.closest('input, textarea, [contenteditable]');
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'a' && !inField) {
        e.preventDefault();
        this.selectAll();
      }
      if (!window.mdv.historyBack && e.key === 'BrowserBack') this.tabs.back();
      if (!window.mdv.historyBack && e.key === 'BrowserForward') this.tabs.forward();
    });
  }

  imagePath(img) {
    const orig = img.getAttribute('data-mdv-orig');
    if (!orig) return null;
    return resourceUrlToPath(img.getAttribute('src') || '');
  }

  selectAll() {
    const v = this.activeView;
    if (!v) return;
    const r = document.createRange();
    r.selectNodeContents(v.article);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }

  async onLinkClick(e, a, { newTab = false } = {}) {
    const href = a.getAttribute('href');
    const kind = a.getAttribute('data-mdv-kind');
    const base = this.basePathFor(a);
    const inPeek = !!a.closest('#peek');
    if (kind === 'anchor') {
      const anchor = href.slice(1);
      if (inPeek) {
        const el = a.closest('.peek-body').querySelector('#' + CSS.escape(decodeURIComponent(anchor)));
        if (el) return el.scrollIntoView({ block: 'center' });
        return this.navigate({ path: base, anchor: decodeURIComponent(anchor) });
      }
      if (this.activeView) return this.tabs.go(this.activeTab, { path: this.activeView.path, anchor: decodeURIComponent(anchor) });
      return;
    }
    if (kind === 'external') return window.mdv.openExternal(href);
    if (kind !== 'local') return;
    const r = await window.mdv.resolveLink(base, href);
    if (r.kind !== 'local') return;
    if (!r.exists) return toast('文件不存在：' + r.path, 'warn', 5000);
    if (r.isDir) {
      if (inPeek) this.peek.close();
      return this.openFolder(r.path, { newTab: newTab || e.ctrlKey });
    }
    if (isMarkdownPath(r.path)) {
      const target = { path: r.path, anchor: r.anchor };
      if (newTab || e.ctrlKey) return this.openNewTab(target, { background: e.ctrlKey && !e.shiftKey });
      if (isMessageAnchor(r.anchor) && this.settings.refClick !== 'jump' && !e.shiftKey && !inPeek) {
        for (const old of $$('.mdv-ref-active')) old.classList.remove('mdv-ref-active');
        a.classList.add('mdv-ref-active');
        return this.peek.show(target);
      }
      if (inPeek) this.peek.close();
      return this.navigate(target);
    }
    if (inPeek && fileViewKind(r.path)) this.peek.close();
    return this.openEntry({ path: r.path, isDir: false }, { newTab: newTab || e.ctrlKey });
  }

  // ---------- context menus ----------
  async docContextMenu(e) {
    const a = e.target.closest('a[href]');
    const img = e.target.closest('img');
    const sel = window.getSelection().toString();
    const v = this.activeView;
    const items = [];
    if (sel) items.push({ id: 'copy', label: '复制' });
    let link = null;
    if (a) {
      const kind = a.getAttribute('data-mdv-kind');
      if (kind === 'local') link = await window.mdv.resolveLink(this.basePathFor(a), a.getAttribute('href'));
      items.push({ id: 'link-open', label: '打开链接' });
      if (link && link.exists && isMarkdownPath(link.path)) items.push({ id: 'link-tab', label: this.caps.appTabs ? '在新标签页打开' : '在新窗口打开' });
      items.push({ id: 'link-copy', label: kind === 'local' ? '复制链接目标路径' : '复制链接地址' });
      if (link && link.exists && this.caps.fileManager) items.push({ id: 'link-reveal', label: '在资源管理器中显示目标' });
      items.push({ type: 'separator' });
    }
    if (img) {
      items.push({ id: 'img-open', label: '查看图片' });
      items.push({ id: 'img-copy', label: '复制图片地址' });
      items.push({ type: 'separator' });
    }
    items.push({ id: 'select-all', label: '全选正文' });
    if (v) {
      items.push({ type: 'separator' });
      items.push({ id: 'copy-path', label: '复制文件路径' });
      if (this.caps.copyLink && window.mdv.linkFor && window.mdv.linkFor(v.path)) items.push({ id: 'copy-link', label: '复制链接' });
      if (this.caps.fileManager) {
        items.push({ id: 'reveal', label: '在资源管理器中显示' });
        items.push({ id: 'open-default', label: '用默认程序打开' });
        items.push({ id: 'open-with', label: '用其他程序打开…' });
      }
      if (this.caps.download) items.push({ id: 'download', label: '下载原文件' });
    }
    const id = await window.mdv.contextMenu(items);
    if (!id) return;
    const imgPath = img ? this.imagePath(img) || (img.closest('.mdv-media') && img.closest('.mdv-media').dataset.path) : null;
    switch (id) {
      case 'copy':
        window.mdv.copyText(sel);
        break;
      case 'link-open':
        this.onLinkClick({ ctrlKey: false, shiftKey: false }, a);
        break;
      case 'link-tab':
        this.openNewTab({ path: link.path, anchor: link.anchor });
        break;
      case 'link-copy':
        window.mdv.copyText(link ? link.path + (link.anchor ? '#' + link.anchor : '') : a.href);
        break;
      case 'link-reveal':
        window.mdv.reveal(link.path);
        break;
      case 'img-open':
        this.lightbox.open({ kind: 'image', src: img.currentSrc || img.src, path: imgPath });
        break;
      case 'img-copy':
        window.mdv.copyText(imgPath || img.getAttribute('data-mdv-orig') || img.src);
        break;
      default:
        this.command(id);
    }
  }

  async editorContextMenu() {
    const v = this.activeView;
    if (!v || !v.editor) return;
    const hasSel = !v.editor.view.state.selection.main.empty;
    const id = await window.mdv.contextMenu([
      { id: 'undo', label: '撤销' },
      { id: 'redo', label: '重做' },
      { type: 'separator' },
      { id: 'cut', label: '剪切', enabled: hasSel },
      { id: 'copy', label: '复制', enabled: hasSel },
      { id: 'paste', label: '粘贴' },
      { id: 'selectAll', label: '全选' },
      { type: 'separator' },
      { id: 'find', label: '查找和替换…' },
      { type: 'separator' },
      { id: 'save', label: '保存', enabled: v.dirty },
    ]);
    if (!id) return;
    v.editor.focus();
    if (id === 'cut' || id === 'copy' || id === 'paste') window.mdv.editNative(id);
    else if (id === 'save') this.saveActive();
    else v.editor.run(id);
  }

  async tabContextMenu(tab) {
    const id = await window.mdv.contextMenu([
      { id: 'close', label: '关闭' },
      { id: 'close-others', label: '关闭其他标签页', enabled: this.tabs.tabs.length > 1 },
      { type: 'separator' },
      { id: 'copy-path', label: '复制文件路径' },
      ...(this.caps.fileManager ? [{ id: 'reveal', label: '在资源管理器中显示' }] : []),
    ]);
    if (id === 'close') this.tabs.close(tab);
    if (id === 'close-others') {
      for (const t of [...this.tabs.tabs]) if (t !== tab && !(await this.tabs.close(t))) break;
    }
    if (id === 'copy-path' && tab.view) window.mdv.copyText(tab.view.path);
    if (id === 'reveal' && tab.view) window.mdv.reveal(tab.view.path);
  }

  async treeContextMenu(node) {
    const fm = this.caps.fileManager;
    const linkView = node.isDir ? 'folder' : node.isMd ? undefined : fileViewKind(node.path) ? 'file' : null;
    const link = this.caps.copyLink && window.mdv.linkFor && linkView !== null ? window.mdv.linkFor(node.path, '', linkView) : null;
    const items = node.isDir
      ? [
          { id: 'folder', label: '在正文中打开' },
          { id: 'folder-tab', label: this.caps.appTabs ? '在新标签页打开' : '在新窗口打开' },
          { id: 'root', label: '设为目录树根' },
          ...(fm ? [{ id: 'reveal', label: '在资源管理器中打开' }] : []),
          { id: 'copy', label: '复制路径' },
          ...(link ? [{ id: 'link', label: '复制链接' }] : []),
        ]
      : [
          { id: 'open', label: '打开' },
          { id: 'tab', label: this.caps.appTabs ? '在新标签页打开' : '在新窗口打开', enabled: node.isMd || !!fileViewKind(node.path) },
          { type: 'separator' },
          { id: 'copy', label: '复制路径' },
          ...(link ? [{ id: 'link', label: '复制链接' }] : []),
          ...(fm
            ? [
                { id: 'reveal', label: '在资源管理器中显示' },
                { id: 'default', label: '用默认程序打开' },
                { id: 'with', label: '用其他程序打开…' },
              ]
            : []),
          ...(this.caps.download ? [{ id: 'download', label: '下载' }] : []),
        ];
    const id = await window.mdv.contextMenu(items);
    if (id === 'link') window.mdv.copyText(link).then(() => toast('已复制链接'));
    if (id === 'download') window.mdv.downloadPath(node.path);
    if (id === 'root') this.tree.setRoot(node.path);
    if (id === 'folder' || id === 'folder-tab') this.openFolder(node.path, { newTab: id === 'folder-tab' });
    if (id === 'open') this.openEntry(node);
    if (id === 'tab') this.openEntry(node, { newTab: true });
    if (id === 'copy') window.mdv.copyText(node.path);
    if (id === 'reveal') node.isDir ? window.mdv.openPath(node.path) : window.mdv.reveal(node.path);
    if (id === 'default') window.mdv.openPath(node.path);
    if (id === 'with') window.mdv.openWith(node.path);
  }

  // ---------- commands (menu + context menu) ----------
  /** The active document's editor, when it is open and should receive editing commands. */
  get commandEditor() {
    const v = this.activeView;
    if (!v || !v.editor || !v.editing) return null;
    return v.mode === 'edit' || v.editor.hasFocus() ? v.editor : null;
  }

  async command(cmd, arg) {
    const v = this.activeView;
    const ed = this.commandEditor;
    switch (cmd) {
      case 'reload':
        if (!v) break;
        if (v.dirty) {
          const a = await this.ask({ type: 'warning', message: `放弃对“${v.title}”的修改，重新载入磁盘上的版本？`, buttons: ['重新载入', '取消'], cancelId: 1 });
          if (a !== 0) break;
          v.setDirty(false);
        }
        v.reload().then(() => this.onViewChanged(this.activeTab));
        break;
      case 'save':
        this.saveActive();
        break;
      case 'toggle-edit':
        this.toggleEdit();
        break;
      case 'toggle-split':
        this.toggleSplit();
        break;
      case 'undo':
      case 'redo':
        if (v && v.editor && v.editing) v.editor.run(cmd);
        break;
      case 'replace':
        if (!v) break;
        if (!v.editing) await this.toggleEdit();
        if (v.editor && v.editing) v.editor.run('find');
        break;
      case 'close-tab':
        if (this.activeTab) this.tabs.close(this.activeTab);
        break;
      case 'reopen-tab':
        this.tabs.reopenClosed();
        break;
      case 'next-tab':
        this.tabs.cycle(1);
        break;
      case 'prev-tab':
        this.tabs.cycle(-1);
        break;
      case 'back':
        this.goBack();
        break;
      case 'forward':
        this.goForward();
        break;
      case 'copy-link':
        if (v && window.mdv.linkFor) window.mdv.copyText(window.mdv.linkFor(v.path, '', v.kind === 'doc' ? undefined : v.kind)).then(() => toast('已复制链接'));
        break;
      case 'download':
        if (v && window.mdv.downloadPath) window.mdv.downloadPath(v.path);
        break;
      case 'copy-path':
        if (v) window.mdv.copyText(v.path).then(() => toast('已复制路径'));
        break;
      case 'reveal':
        if (v) window.mdv.reveal(v.path);
        break;
      case 'open-default':
        if (v) window.mdv.openPath(v.path);
        break;
      case 'open-with':
        if (v) window.mdv.openWith(v.path);
        break;
      case 'select-all':
        if (ed) ed.run('selectAll');
        else this.selectAll();
        break;
      case 'find':
        if (ed) ed.run('find');
        else this.find.open();
        break;
      case 'find-next':
        if (ed) ed.run('findNext');
        else this.find.isOpen ? this.find.step(1) : this.find.open();
        break;
      case 'find-prev':
        if (ed) ed.run('findPrev');
        else this.find.isOpen ? this.find.step(-1) : this.find.open();
        break;
      case 'toggle-sidebar':
        this.setSetting({ sidebar: !this.settings.sidebar });
        break;
      case 'toggle-outline':
        this.setSetting({ outline: !this.settings.outline });
        break;
      case 'toggle-width':
        this.setSetting({ readingWidth: this.settings.readingWidth === 'wide' ? 'normal' : 'wide' });
        break;
      case 'toggle-chat-view':
        this.toggleChatView();
        break;
      case 'toggle-inline-media':
        this.setSetting({ inlineMedia: !this.settings.inlineMedia });
        for (const { view } of this.tabs.allViews()) view.stale = true;
        if (v) v.reload().then(() => this.onViewChanged(this.activeTab));
        break;
      case 'set-ref-click':
        this.setSetting({ refClick: arg });
        break;
      case 'scroll-top':
        if (ed) ed.run('docStart');
        else if (v) {
          v.stopPin();
          v.el.scrollTop = 0;
        }
        break;
      case 'scroll-bottom':
        if (ed) ed.run('docEnd');
        else if (v) {
          v.stopPin();
          v.el.scrollTop = v.el.scrollHeight;
        }
        break;
      case 'recent-changed':
        window.mdv.getState().then((s) => {
          this.recent = s.recent;
          this.renderWelcome();
        });
        break;
      case 'zoom-changed':
        toast(`缩放 ${Math.round(arg * 100)}%`, 'info', 1200);
        break;
      case 'about':
        toast(`MD Viewer ${this.version} · markdown-it / KaTeX / Mermaid / highlight.js`, 'info', 5000);
        break;
    }
  }

  bindIpc() {
    window.mdv.onOpenTargets((msg) => this.openTargets(msg));
    window.mdv.onMenu((cmd, arg) => this.command(cmd, arg));
    window.mdv.onFileChanged(({ path, type }) => {
      for (const { tab, view } of this.tabs.allViews()) {
        if (!sameFile(view.path, path)) continue;
        if (view.dirty) {
          // Our own save also lands here: only a real change on disk is news.
          window.mdv.readFile(view.path).then((r) => {
            if (view.dirty && (!r.ok || r.hash !== view.disk.hash)) view.noteExternalChange(r.ok ? 'change' : 'unlink');
          });
          continue;
        }
        if (type === 'unlink') {
          view.banner.replaceChildren(h('div.banner-warn', null, '文件已被删除或移动，显示的是最后一次读取的内容。'));
          if (view.disk) view.disk.gone = true;
          continue;
        }
        if (tab === this.activeTab && view === tab.view) {
          const seq = view.renderSeq;
          view.reload({ ifChanged: true }).then(() => {
            this.onViewChanged(tab);
            if (view.editing && view.renderSeq !== seq) toast('文件已在外部修改，已载入新内容', 'info', 2500);
          });
        } else view.stale = true;
      }
    });
  }

  bindDragDrop() {
    const overlay = $('#drop-overlay');
    let depth = 0;
    window.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer.types.includes('Files')) return;
      depth++;
      overlay.classList.add('show');
    });
    window.addEventListener('dragleave', () => {
      if (--depth <= 0) {
        depth = 0;
        overlay.classList.remove('show');
      }
    });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', async (e) => {
      e.preventDefault();
      depth = 0;
      overlay.classList.remove('show');
      const paths = Array.from(e.dataTransfer.files).map((f) => window.mdv.pathForFile(f)).filter(Boolean);
      for (const p of paths) {
        const st = await window.mdv.stat(p);
        if (st.ok && st.isDir) await this.tree.setRoot(p);
        else if (st.ok) await this.tabs.open({ path: p, anchor: '' });
      }
    });
  }

  renderWelcome() {
    const recent = (this.recent || []).slice(0, 12);
    this.welcomeEl.replaceChildren(
      h(
        'div.welcome-inner',
        null,
        h('h1', null, 'MD Viewer'),
        this.caps.edition === 'web'
          ? h('p.muted', null, '从左侧目录打开文件，或者打开这台设备上的 Markdown 文件：')
          : h('p.muted', null, '拖入 Markdown 文件或文件夹，或者：'),
        this.caps.edition === 'web'
          ? h(
              'div.welcome-actions',
              null,
              h('button.btn.primary', { onclick: () => window.mdv.openDialog('file') }, '打开本机文件… (Ctrl+O)'),
              h('button.btn', { onclick: () => window.mdv.openDialog('folder') }, '打开本机文件夹…'),
            )
          : h(
              'div.welcome-actions',
              null,
              h('button.btn.primary', { onclick: () => window.mdv.openDialog('file') }, '打开文件… (Ctrl+O)'),
              h('button.btn', { onclick: () => window.mdv.openDialog('folder') }, '打开文件夹… (Ctrl+Shift+O)'),
            ),
        recent.length ? h('h3', null, '最近打开') : null,
        recent.length
          ? h(
              'ul.recent-list',
              null,
              recent.map((p) =>
                h(
                  'li',
                  null,
                  h('a.recent-item', { href: '#', title: p, onclick: (e) => (e.preventDefault(), this.openPath(p)) }, h('span.recent-name', null, basename(p)), h('span.recent-dir.muted', null, dirname(p))),
                  h(
                    'button.icon-btn.small',
                    {
                      title: '从列表中移除',
                      onclick: async () => {
                        this.recent = await window.mdv.removeRecent(p);
                        this.renderWelcome();
                      },
                    },
                    '×',
                  ),
                ),
              ),
            )
          : null,
      ),
    );
  }
}

/**
 * Start the app on the page. opts.beforeInit(app) / opts.afterInit(app): platform
 * hooks around init; opts.selftest(): loads the desktop self-test module.
 */
export async function startApp(opts = {}) {
  const app = new App(opts);
  window.__mdvApp = app;
  try {
    if (opts.beforeInit) await opts.beforeInit(app);
    await app.init();
  } catch (e) {
    console.error(e);
    document.body.append(h('pre.fatal', null, String(e && e.stack)));
  }
  return app;
}
