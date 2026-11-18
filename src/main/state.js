// Persisted app state (settings, recent files, window bounds) in userData/state.json.

import fs from 'node:fs';
import path from 'node:path';

const DEFAULTS = {
  version: 1,
  settings: {
    theme: 'system', // system | light | dark
    zoom: 1,
    sidebar: true,
    outline: true,
    sidebarWidth: 260,
    outlineWidth: 240,
    peekWidth: 440,
    readingWidth: 'normal', // normal | wide
    inlineMedia: true,
    chatView: true, // archive chat docs open in chat view
    refClick: 'peek', // peek | jump : what a click on a msg-… reference does
    peekContext: 4,
    showAllFiles: false,
    selfIds: [], // WeChat ids treated as "me" in chat view (learned automatically)
    editLayout: 'split', // split | edit : what Ctrl+E switches to from reading
    editSplit: 0.5, // editor share of the width in split layout
  },
  recent: [],
  rootFolder: null,
  window: { width: 1360, height: 900, x: undefined, y: undefined, maximized: false },
  session: [], // [{path, anchor}] of tabs open at last exit
};

export class StateStore {
  constructor(dir) {
    this.file = path.join(dir, 'state.json');
    this.data = structuredClone(DEFAULTS);
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = { ...this.data, ...raw, settings: { ...DEFAULTS.settings, ...(raw.settings || {}) } };
    } catch {
      /* first run or unreadable: defaults */
    }
    this.timer = null;
  }

  get() {
    return this.data;
  }

  patch(partial) {
    if (partial.settings) {
      this.data.settings = { ...this.data.settings, ...partial.settings };
      const { settings, ...rest } = partial;
      Object.assign(this.data, rest);
    } else Object.assign(this.data, partial);
    this.scheduleSave();
    return this.data;
  }

  addRecent(p) {
    const key = p.toLowerCase();
    this.data.recent = [p, ...this.data.recent.filter((r) => r.toLowerCase() !== key)].slice(0, 30);
    this.scheduleSave();
  }

  removeRecent(p) {
    const key = p.toLowerCase();
    this.data.recent = this.data.recent.filter((r) => r.toLowerCase() !== key);
    this.scheduleSave();
  }

  scheduleSave() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.saveNow(), 400);
  }

  saveNow() {
    clearTimeout(this.timer);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('state save failed', e);
    }
  }
}
