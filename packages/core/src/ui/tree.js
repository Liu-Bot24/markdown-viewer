// Folder tree (lazy loaded). Shows folders and Markdown files; other files optionally.
import { h, naturalCompare, isUnder, sameFile, debounce, caps } from './util.js';
import { dirname, basename, pathKey, sepOf, isVirtualPath } from '../shared/paths.js';

export class FolderTree {
  constructor(app, container) {
    this.app = app;
    this.root = null;
    this.selectedDir = null; // folder last clicked in the tree (search scope)
    this.nodes = new Map(); // path key -> { path, isDir, el, childrenEl, loaded, open }
    this.filter = '';
    this.headerPath = h('div.tree-root-name', { title: '' });
    this.filterInput = h('input.tree-filter', {
      type: 'search',
      placeholder: '筛选已展开的项目…',
      oninput: debounce(() => this.applyFilter(this.filterInput.value), 120),
    });
    this.list = h('div.tree-list', { role: 'tree' });
    const openLabel = caps().edition === 'web' ? '打开本机文件夹…' : '打开文件夹…';
    this.empty = h('div.tree-empty', null, h('p', null, '尚未打开文件夹'), h('button.btn', { onclick: () => window.mdv.openDialog('folder') }, openLabel));
    this.upBtn = h('button.icon-btn', { title: '上一级文件夹', onclick: () => this.up() }, '↑');
    container.append(
      h(
        'div.tree-header',
        null,
        this.upBtn,
        this.headerPath,
        h('button.icon-btn', { title: '刷新', onclick: () => this.refresh() }, '⟳'),
        h('button.icon-btn', { title: openLabel, onclick: () => window.mdv.openDialog('folder') }, '…'),
      ),
      this.filterInput,
      this.list,
      this.empty,
    );
  }

  async setRoot(dir, { persist = true } = {}) {
    if (!dir) return;
    if (isVirtualPath(dir)) this.root = dir.replace(/\/+$/, '') || '/';
    else {
      this.root = dir.replace(/\\+$/, '') || dir;
      if (/^[a-zA-Z]:$/.test(this.root)) this.root += '\\';
    }
    const label = (window.mdv.rootLabel && window.mdv.rootLabel(this.root)) || basename(this.root) || caps().treeRootLabel || this.root;
    this.headerPath.textContent = label;
    this.headerPath.title = this.root;
    this.upBtn.disabled = sameFile(dirname(this.root), this.root);
    this.nodes.clear();
    this.list.replaceChildren();
    this.empty.style.display = 'none';
    const node = this.makeNode({ path: this.root, name: this.root, isDir: true }, 0, true);
    this.list.append(node.childrenEl);
    await this.expand(node);
    if (persist) window.mdv.patchState({ rootFolder: this.root });
    if (this.app.activeView) this.reveal(this.app.activeView.path);
  }

  up() {
    if (!this.root) return;
    const parent = dirname(this.root);
    if (parent && !sameFile(parent, this.root)) this.setRoot(parent);
  }

  refresh() {
    if (this.root) this.setRoot(this.root, { persist: false });
  }

  makeNode(ent, depth, isRoot = false) {
    const node = { path: ent.path, isDir: ent.isDir, isMd: ent.isMd, loaded: false, open: false, depth, el: null, childrenEl: null };
    if (!isRoot) {
      const twisty = h('span.twisty', null, ent.isDir ? '▸' : '');
      const label = h('span.tree-label', null, ent.name);
      node.el = h(
        'div.tree-item',
        {
          role: 'treeitem',
          title: ent.path,
          style: { paddingLeft: 8 + depth * 14 + 'px' },
          onclick: (e) => this.onClick(node, e),
          onauxclick: (e) => {
            if (e.button === 1 && !node.isDir) this.app.openEntry(node, { newTab: true });
          },
          oncontextmenu: (e) => {
            e.preventDefault();
            this.app.treeContextMenu(node);
          },
        },
        twisty,
        h('span.tree-icon', null, ent.isDir ? '📁' : ent.isMd ? '📄' : '📎'),
        label,
      );
      node.twisty = twisty;
      if (!ent.isDir && !ent.isMd) node.el.classList.add('other');
    }
    if (ent.isDir) node.childrenEl = h('div.tree-children', { role: 'group' });
    this.nodes.set(pathKey(ent.path), node);
    return node;
  }

  onClick(node, e) {
    if (node.isDir) {
      // a click expands the folder and opens it in the reading pane; clicking the folder already
      // shown collapses it; the arrow only expands or collapses; Ctrl+click opens a new tab
      this.selectedDir = node.path;
      const v = this.app.activeView;
      const shown = v && v.kind === 'folder' && sameFile(v.path, node.path);
      if (e.target.closest('.twisty')) node.open ? this.collapse(node) : this.expand(node);
      else if (e.ctrlKey) this.app.openFolder(node.path, { newTab: true });
      else if (!node.open) {
        this.expand(node);
        if (!shown) this.app.openFolder(node.path);
      } else if (shown) this.collapse(node);
      else this.app.openFolder(node.path);
    } else if (node.isMd) this.app.openPath(node.path, { newTab: e.ctrlKey });
    else this.app.openEntry(node, { newTab: e.ctrlKey });
  }

  async expand(node) {
    if (!node.isDir) return;
    node.open = true;
    if (node.twisty) node.twisty.textContent = '▾';
    if (node.el) node.el.after(node.childrenEl);
    node.childrenEl.style.display = '';
    if (!node.loaded) {
      node.loaded = true;
      await this.loadChildren(node, 0);
    }
  }

  /** One listing page; a platform that pages long folders reports `more`. */
  async loadChildren(node, offset) {
    const depth = node.el ? node.depth + 1 : 0;
    const r = await window.mdv.listDir(node.path, { all: this.app.settings.showAllFiles, offset });
    const ents = r.paged ? r.entries : r.entries.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : naturalCompare(a.name, b.name)));
    const frag = document.createDocumentFragment();
    for (const ent of ents) frag.append(this.makeNode(ent, depth).el);
    if (!ents.length && !offset) frag.append(h('div.tree-item.muted', { style: { paddingLeft: 22 + depth * 14 + 'px' } }, r.ok === false ? '（无法读取）' : '（空）'));
    if (r.more) {
      const shown = offset + ents.length;
      const more = h(
        'div.tree-item.tree-more',
        {
          style: { paddingLeft: 22 + depth * 14 + 'px' },
          onclick: async () => {
            more.remove();
            await this.loadChildren(node, shown);
          },
        },
        `显示更多（已显示 ${shown.toLocaleString()} / ${r.total.toLocaleString()}）`,
      );
      frag.append(more);
    }
    if (offset) node.childrenEl.append(frag);
    else node.childrenEl.replaceChildren(frag);
    if (this.filter) this.applyFilter(this.filter);
  }

  collapse(node) {
    node.open = false;
    if (node.twisty) node.twisty.textContent = '▸';
    node.childrenEl.style.display = 'none';
  }

  /** Expand folders down to `path` and highlight it. */
  async reveal(path) {
    for (const el of this.list.querySelectorAll('.tree-item.current')) el.classList.remove('current');
    if (!this.root || !isUnder(path, this.root)) return;
    const sep = sepOf(this.root);
    const base = this.root.endsWith(sep) ? this.root.slice(0, -1) : this.root;
    const rel = path.slice(base.length + 1).split(sep);
    let cur = base;
    for (let i = 0; i < rel.length - 1; i++) {
      cur += sep + rel[i];
      const n = this.nodes.get(pathKey(cur));
      if (!n) return;
      if (!n.open) await this.expand(n);
    }
    const leaf = this.nodes.get(pathKey(path));
    if (leaf && leaf.el) {
      leaf.el.classList.add('current');
      leaf.el.scrollIntoView({ block: 'nearest' });
    }
  }

  applyFilter(q) {
    this.filter = q.trim().toLowerCase();
    for (const n of this.nodes.values()) {
      if (!n.el) continue;
      const hit = !this.filter || basename(n.path).toLowerCase().includes(this.filter);
      n.el.classList.toggle('filtered-out', !hit && !n.isDir);
      n.el.classList.toggle('dim', !hit && n.isDir);
    }
  }
}
