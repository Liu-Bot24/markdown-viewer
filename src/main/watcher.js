// Reference-counted file watchers. Editors often save by replace/rename, so we
// use chokidar (handles atomic saves) and debounce change bursts.

import { watch } from 'chokidar';

export class FileWatchers {
  constructor(onChange) {
    this.onChange = onChange;
    this.entries = new Map(); // key -> { watcher, count, timer }
  }

  key(p) {
    return p.toLowerCase();
  }

  add(p) {
    const k = this.key(p);
    const e = this.entries.get(k);
    if (e) {
      e.count++;
      return;
    }
    const watcher = watch(p, {
      ignoreInitial: true,
      atomic: 200,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    });
    const entry = { watcher, count: 1, timer: null };
    const fire = (type) => {
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => this.onChange(p, type), 120);
    };
    watcher.on('change', () => fire('change'));
    watcher.on('add', () => fire('change'));
    watcher.on('unlink', () => fire('unlink'));
    watcher.on('error', () => {});
    this.entries.set(k, entry);
  }

  remove(p) {
    const k = this.key(p);
    const e = this.entries.get(k);
    if (!e) return;
    if (--e.count <= 0) {
      clearTimeout(e.timer);
      e.watcher.close().catch(() => {});
      this.entries.delete(k);
    }
  }

  clear() {
    for (const e of this.entries.values()) e.watcher.close().catch(() => {});
    this.entries.clear();
  }
}
