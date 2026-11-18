// Content roots: every sub-directory of the roots dir is one root, named after it.
// Virtual paths are "/<root>/<relative path>"; host paths never leave the server.
import fs from 'node:fs';
import path from 'node:path';

const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

export class Roots {
  constructor(cfg) {
    this.cfg = cfg;
    this.list = [];
    this.byName = new Map();
  }

  /** (Re)discover roots. Cheap: one readdir of the roots dir plus a stat per root. */
  async discover() {
    const cfg = this.cfg;
    let names = [];
    try {
      names = (await fs.promises.readdir(cfg.rootsDir, { withFileTypes: true }))
        .filter((d) => !d.name.startsWith('.') && (d.isDirectory() || d.isSymbolicLink()))
        .map((d) => d.name);
    } catch {
      names = [];
    }
    const roots = [];
    for (const name of names) {
      const dir = path.join(cfg.rootsDir, name);
      let real;
      try {
        real = await fs.promises.realpath(dir);
        if (!(await fs.promises.stat(real)).isDirectory()) continue;
      } catch {
        continue;
      }
      const listed = cfg.writableRoots.includes(name);
      // only a root listed as writable is probed with a real write; the others are never written to
      const mountWritable = listed ? await canWrite(real) : await accessWritable(real);
      roots.push({ name, dir, real, mountWritable, writable: !cfg.disableWrite && listed && mountWritable });
    }
    roots.sort((a, b) => collator.compare(a.name, b.name));
    this.list = roots;
    this.byName = new Map(roots.map((r) => [r.name, r]));
    return roots;
  }

  get(name) {
    return this.byName.get(name) || null;
  }

  public() {
    return this.list.map((r) => ({ name: r.name, writable: r.writable, mountWritable: r.mountWritable }));
  }
}

async function accessWritable(dir) {
  try {
    await fs.promises.access(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function canWrite(dir) {
  if (!(await accessWritable(dir))) return false;
  // access() can say yes on a read-only bind mount over some filesystems: probe for real
  const probe = path.join(dir, `.mdv-write-probe-${process.pid}-${Date.now()}`);
  try {
    const fh = await fs.promises.open(probe, 'wx');
    await fh.close();
    await fs.promises.unlink(probe);
    return true;
  } catch {
    return false;
  }
}
