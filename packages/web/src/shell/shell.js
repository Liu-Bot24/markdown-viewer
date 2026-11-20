// Web-only parts of the window: the "more" menu, keyboard shortcuts, index and
// background-search badges, phone drawers, confirmed overwrite and video fallback.
import { $, h, toast } from '../../../core/src/ui/util.js';
import { basename } from '../../../core/src/shared/paths.js';
import { isLocalPath } from './local.js';
import { encPath, rawUrl } from './mdv-shim.js';
import { SearchPanel } from './search-panel.js';
import { copyText, downloadUrl, showDialog, showMenu } from './ui.js';

const PHONE = window.matchMedia('(max-width: 768px)');

export class WebShell {
  constructor(app, shim, serverState) {
    this.app = app;
    this.shim = shim;
    this.st = serverState;
    app.webShell = this;
    app.webRoots = serverState.roots;
    this.search = new SearchPanel(app, $('#search-panel'));
    this.bindButtons();
    this.bindKeys();
    this.bindPhone();
    this.bindVideoFallback();
    this.indexTimer = null;
    if (serverState.caps.search) this.pollIndex();
    else $('#btn-search').style.display = 'none';
    this.refreshJobs();
    if (!serverState.roots.length) toast('还没有挂载任何目录：在容器设置里把文件夹映射到 /roots/<名称>', 'warn', 10000);
  }

  bindButtons() {
    $('#btn-search').onclick = () => (this.search.isOpen ? this.search.close() : this.search.open());
    $('#btn-more').onclick = (e) => this.moreMenu(e.currentTarget);
    $('#btn-index').onclick = () => this.search.open();
    $('#btn-jobs').onclick = (e) => this.jobsMenu(e.currentTarget);
    $('#btn-prev-file').onclick = () => this.neighbor && this.neighbor.prev && this.app.openPath(this.neighbor.prev);
    $('#btn-next-file').onclick = () => this.neighbor && this.neighbor.next && this.app.openPath(this.neighbor.next);
  }

  /** Previous / next file in the current folder, in the order the tree lists them. */
  async updateNeighbors(view) {
    const p = view && view.kind === 'doc' && view.path;
    this.neighbor = null;
    $('#btn-prev-file').disabled = true;
    $('#btn-next-file').disabled = true;
    if (!p) return;
    const n = await this.shim.neighbors(p);
    if (!this.app.activeView || this.app.activeView.path !== p) return; // moved on meanwhile
    this.neighbor = n;
    $('#btn-prev-file').disabled = !n.prev;
    $('#btn-next-file').disabled = !n.next;
    $('#btn-prev-file').title = n.prev ? '上一个文件：' + basename(n.prev) : '这是文件夹里的第一个文件';
    $('#btn-next-file').title = n.next ? '下一个文件：' + basename(n.next) : '这是文件夹里的最后一个文件';
  }

  async moreMenu(anchor) {
    const app = this.app;
    const v = app.activeView;
    const s = app.settings;
    const onServer = v && !isLocalPath(v.path);
    const canOverwrite = onServer && v.editing && this.st.caps.overwrite && v.disk && this.isWritable(v.path);
    const items = [
      { id: 'search', label: '搜索…', hint: 'Ctrl+K', enabled: this.st.caps.search },
      { type: 'separator' },
      { id: 'open-file', label: '打开本机文件…', hint: 'Ctrl+O' },
      { id: 'open-folder', label: '打开本机文件夹…' },
      { type: 'separator' },
      { id: 'download', label: '下载原文件', enabled: !!onServer },
      { id: 'export', label: '导出副本', hint: 'Ctrl+S', enabled: !!(v && v.editor && v.editing) },
      { id: 'overwrite', label: '覆盖服务器上的原文件…', enabled: !!canOverwrite },
      { id: 'copy-link', label: '复制链接', enabled: !!onServer },
      { type: 'separator' },
      { id: 'chat', label: '聊天视图', checked: !!s.chatView },
      { id: 'inline', label: '内联显示媒体链接', checked: !!s.inlineMedia },
      { id: 'ref-peek', label: '点击消息引用时在侧边预览', checked: s.refClick !== 'jump' },
      { id: 'wide', label: '宽版阅读', checked: s.readingWidth === 'wide' },
      { id: 'all-files', label: '目录树显示全部文件', checked: !!s.showAllFiles },
      { id: 'hide-media', label: '隐藏媒体文件夹', checked: !!s.hideMediaFolders },
      { type: 'separator' },
      { id: 'recheck', label: '立即重新检查索引', enabled: this.st.caps.search },
    ];
    if (this.st.auth === 'on') items.push({ type: 'separator' }, { id: 'logout', label: '退出登录' }, { id: 'logout-all', label: '退出所有设备' });
    items.push({ type: 'separator' }, { id: 'about', label: '关于' });
    const id = await showMenu(items, null, { anchor });
    switch (id) {
      case 'search':
        return this.search.open();
      case 'open-file':
        return this.shim.openDialog('file');
      case 'open-folder':
        return this.shim.openDialog('folder');
      case 'download':
        return downloadUrl(rawUrl(v.path) + '?download=1');
      case 'export':
        return app.saveActive();
      case 'overwrite':
        return this.overwrite(v);
      case 'copy-link':
        return copyText(this.shim.linkFor(v.path, v.target || '')).then((ok) => toast(ok ? '已复制链接' : '无法复制', ok ? 'info' : 'warn'));
      case 'chat':
        return app.toggleChatView();
      case 'inline':
        return app.command('toggle-inline-media');
      case 'ref-peek':
        return app.setSetting({ refClick: s.refClick === 'jump' ? 'peek' : 'jump' });
      case 'wide':
        return app.setSetting({ readingWidth: s.readingWidth === 'wide' ? 'normal' : 'wide' });
      case 'all-files':
        app.setSetting({ showAllFiles: !s.showAllFiles });
        return app.tree.refresh();
      case 'hide-media':
        app.setSetting({ hideMediaFolders: !s.hideMediaFolders });
        return app.tree.refresh();
      case 'recheck':
        return this.search.recheck();
      case 'logout':
      case 'logout-all':
        await fetch('/api/' + id, { method: 'POST' });
        location.href = '/login';
        return;
      case 'about':
        return showDialog({
          title: `MD Viewer Web ${this.st.version}`,
          message: this.st.auth === 'on' ? '已启用登录。' : '未启用登录：能访问这个端口的人都能看到全部内容。',
          detail: [
            '根目录：' + (this.st.roots.map((r) => `${r.name}（${r.writable ? '可写' : '只读'}）`).join('、') || '无'),
            '视频转码：' + ({ hw: '硬件（Quick Sync / VAAPI）', sw: '软件', off: '不可用' }[this.st.caps.transcodeMode] || '不可用'),
            '渲染：markdown-it / KaTeX / Mermaid / highlight.js',
          ].join('\n'),
          buttons: ['确定'],
        });
    }
  }

  isWritable(p) {
    const r = this.st.roots.find((x) => x.name === p.split('/')[1]);
    return !!(r && r.writable);
  }

  /** Overwrite the original on the server: typed sentence, checked again by the server. */
  async overwrite(v) {
    const name = basename(v.path);
    const sentence = `我确认用编辑后的内容覆盖 ${name}`;
    const r = await showDialog({
      type: 'warning',
      title: '覆盖服务器上的原文件',
      message: v.path,
      detail: '原文件会被编辑后的内容替换（旧版本保存在服务器的状态目录里）。如果原文件在你编辑期间被改过，覆盖会被拒绝。',
      input: { label: '请逐字输入下面这句话：', expect: sentence },
      buttons: ['覆盖', '取消'],
      defaultId: 0,
      cancelId: 1,
      danger: true,
    });
    if (!r || r.button !== 0 || r.text !== sentence) return;
    const ok = await v.save({ overwrite: true, confirm: sentence });
    if (ok) toast('已覆盖原文件，索引已更新', 'info', 3000);
  }

  bindKeys() {
    document.addEventListener('keydown', (e) => {
      const app = this.app;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      const inField = e.target.closest && e.target.closest('input, textarea, select, [contenteditable]') && !e.target.closest('.cm-editor');
      if (mod && !e.shiftKey && k === 'k') {
        e.preventDefault();
        return this.search.open();
      }
      if (e.key === '/' && !mod && !inField && !e.target.closest('.cm-editor')) {
        e.preventDefault();
        return this.search.open();
      }
      if (e.key === 'Escape' && this.search.isOpen && !e.defaultPrevented) {
        e.preventDefault();
        return this.search.close();
      }
      if (inField) return;
      const cmd = (() => {
        if (mod && !e.shiftKey && !e.altKey) return { s: 'save', o: 'open-file', f: 'find', h: 'replace', e: 'toggle-edit', b: 'toggle-sidebar', home: 'scroll-top', end: 'scroll-bottom' }[k];
        if (mod && e.shiftKey && !e.altKey) return { e: 'toggle-split', b: 'toggle-outline', m: 'toggle-chat-view' }[k];
        if (!mod && !e.altKey && e.key === 'F3') return e.shiftKey ? 'find-prev' : 'find-next';
        return null;
      })();
      if (!cmd) return;
      e.preventDefault();
      if (cmd === 'open-file') return this.shim.openDialog('file');
      if (cmd === 'toggle-sidebar' && PHONE.matches) return this.toggleDrawer('left');
      app.command(cmd);
    });
  }

  // ---------- phone layout ----------
  bindPhone() {
    const apply = () => {
      document.body.classList.remove('drawers-ready');
      document.body.classList.toggle('phone', PHONE.matches);
      requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.add('drawers-ready')));
      if (!PHONE.matches) this.closeDrawers();
      const v = this.app.activeView;
      if (PHONE.matches && v && v.mode === 'split') this.app.setMode('edit', v);
    };
    PHONE.addEventListener('change', apply);
    apply();
    // the sidebar and outline buttons open drawers on a phone
    for (const [id, side] of [
      ['#btn-sidebar', 'left'],
      ['#btn-outline', 'right'],
    ]) {
      $(id).addEventListener(
        'click',
        (e) => {
          if (!PHONE.matches) return;
          e.stopImmediatePropagation();
          this.toggleDrawer(side);
        },
        true,
      );
    }
    $('#drawer-scrim').onclick = () => this.closeDrawers();
    $('#outline').addEventListener('click', (e) => {
      if (PHONE.matches && e.target.closest('.outline-item, a, button[data-line], li')) setTimeout(() => this.closeDrawers(), 50);
    });
  }

  toggleDrawer(side) {
    const cls = 'drawer-' + side;
    const on = !document.body.classList.contains(cls);
    this.closeDrawers();
    document.body.classList.toggle(cls, on);
  }

  closeDrawers() {
    document.body.classList.remove('drawer-left', 'drawer-right');
  }

  /** Called on every document change. */
  onView(view) {
    if (PHONE.matches) this.closeDrawers();
    $('#web-title').textContent = view ? view.title : '';
    this.updateNeighbors(view);
    if (PHONE.matches && view && view.mode === 'split') this.app.setMode('edit', view);
  }

  // ---------- video the browser cannot decode ----------
  bindVideoFallback() {
    const tryTranscode = (video) => {
      if (video.dataset.mdvTranscode) return this.videoFailed(video);
      const path = this.shim.resourcePathOf(video.currentSrc || video.getAttribute('src') || '');
      if (!path || isLocalPath(path)) return this.videoFailed(video);
      if (!this.st.caps.transcode) return this.videoFailed(video, path);
      video.dataset.mdvTranscode = '1';
      const box = video.closest('.mdv-media, .lb-stage');
      if (box) box.classList.remove('missing');
      const text = h('span', null, '这个视频的编码浏览器不能直接播放。');
      const note = h('div.mdv-transcoding', null, text);
      video.after(note);
      // converting costs the server real work: only for a video someone is about to watch
      const start = (play) => {
        text.textContent = '正在转换格式，完成后开始播放…';
        const done = () => note.remove();
        video.src = '/video' + encPath(path);
        video.load();
        // listen once the error that brought us here has finished dispatching, or it would remove the note at once
        setTimeout(() => {
          video.addEventListener('loadeddata', () => (done(), play && video.play().catch(() => {})), { once: true });
          video.addEventListener('error', done, { once: true });
          if (video.readyState >= 2 || video.error) done();
        }, 0);
      };
      if (video.closest('.lb-stage')) return start(true); // opened in the viewer to be watched
      const btn = h('button.btn.small', { onclick: () => (btn.remove(), start(true)) }, '转换后播放');
      note.append(btn);
    };
    document.addEventListener(
      'error',
      (e) => {
        const t = e.target;
        if (t && t.tagName === 'VIDEO' && !t.closest('.fv')) tryTranscode(t); // folder thumbnails just show an icon
      },
      true,
    );
    // some browsers "play" HEVC as audio only: no picture size at all
    document.addEventListener(
      'loadedmetadata',
      (e) => {
        const t = e.target;
        if (t && t.tagName === 'VIDEO' && t.videoWidth === 0 && !t.dataset.mdvTranscode && !t.closest('.fv')) tryTranscode(t);
      },
      true,
    );
  }

  videoFailed(video, path) {
    const p = path || this.shim.resourcePathOf(video.getAttribute('src') || '');
    if (video.dataset.mdvFailed) return;
    video.dataset.mdvFailed = '1';
    const box = video.closest('.mdv-media, .lb-stage');
    if (box) box.classList.add('missing');
    const why = video.dataset.mdvTranscode ? '这个视频没能转换成浏览器能播放的格式。' : '此视频的编码当前浏览器无法播放。';
    const msg = h('div.mdv-video-failed', null, h('span', null, why), p && !isLocalPath(p) ? h('a.btn.small', { href: rawUrl(p) + '?download=1', download: '' }, '下载视频') : null);
    video.after(msg);
  }

  // ---------- index and background badges ----------
  pollIndexSoon() {
    clearTimeout(this.indexTimer);
    this.indexTimer = setTimeout(() => this.pollIndex(), 1000);
  }

  async pollIndex() {
    clearTimeout(this.indexTimer);
    let s = null;
    if (document.visibilityState === 'visible') {
      try {
        s = await (await fetch('/api/index')).json();
      } catch {
        s = null;
      }
    }
    const b = $('#btn-index');
    if (s && s.checking) {
      b.style.display = '';
      b.textContent = s.built ? `索引更新中：已检查 ${(s.checked || 0).toLocaleString()} / ${(s.total || 0).toLocaleString()}` : `正在建索引：${(s.checked || 0).toLocaleString()} / ${(s.total || 0).toLocaleString()}`;
      b.title = '点开搜索面板查看索引状态';
    } else b.style.display = 'none';
    if (this.search.isOpen) this.search.refreshIndex();
    this.indexTimer = setTimeout(() => this.pollIndex(), s && s.checking ? 3000 : 60000);
  }

  async refreshJobs() {
    if (!this.st.caps.search) return;
    let r;
    try {
      r = await (await fetch('/api/jobs')).json();
    } catch {
      return;
    }
    this.jobs = (r && r.jobs) || [];
    const b = $('#btn-jobs');
    const running = this.jobs.filter((j) => j.state === 'running' || j.state === 'queued').length;
    b.style.display = this.jobs.length ? '' : 'none';
    b.textContent = running ? `后台搜索进行中（${running}）` : `后台搜索（${this.jobs.length}）`;
    clearTimeout(this.jobsTimer);
    if (running) this.jobsTimer = setTimeout(() => this.refreshJobs(), 5000);
  }

  async jobsMenu(anchor) {
    await this.refreshJobs();
    const items = this.jobs.map((j) => ({ id: 'show:' + j.id, label: `「${j.q}」 · ${j.state === 'done' ? `找到 ${j.found} 条` : j.state === 'running' ? `${j.scanned} / ${j.total || '?'}` : j.state}` }));
    if (items.length) items.push({ type: 'separator' }, ...this.jobs.map((j) => ({ id: 'del:' + j.id, label: `删除「${j.q}」` })));
    const id = await showMenu(items.length ? items : [{ id: null, label: '没有后台搜索', enabled: false }], null, { anchor });
    if (!id) return;
    const [op, jid] = id.split(':');
    if (op === 'show') this.search.showJob(jid);
    if (op === 'del') {
      await fetch('/api/jobs/' + jid, { method: 'DELETE' });
      this.refreshJobs();
    }
  }
}
