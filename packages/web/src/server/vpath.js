// Virtual path validation. Every interface that takes a path goes through here.
// A virtual path is "/<root>/<relative>" with '/' separators, already percent-decoded once.
import fs from 'node:fs';
import path from 'node:path';

export class PathError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

/** Split and check a virtual path; returns its segments (root name first). */
export function splitVirtual(v) {
  if (typeof v !== 'string' || !v.startsWith('/')) throw new PathError('EBADPATH');
  if (v.includes('\0') || v.includes('\\')) throw new PathError('EBADPATH');
  const segs = v.split('/').slice(1);
  if (segs.length && segs[segs.length - 1] === '') segs.pop(); // trailing slash
  for (const s of segs) {
    if (s === '' || s === '.' || s === '..') throw new PathError('EBADPATH');
    if (process.platform === 'win32' && /[:*?"<>|]/.test(s)) throw new PathError('EBADPATH');
  }
  return segs;
}

export function normalizeVirtual(v) {
  const segs = splitVirtual(v);
  return '/' + segs.join('/');
}

function inside(real, rootReal) {
  return real === rootReal || real.startsWith(rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep);
}

async function realOrNull(p) {
  try {
    return await fs.promises.realpath(p);
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;
    throw e;
  }
}

/**
 * Resolve a virtual path to a host path inside its root.
 * Returns { top: true } for "/", or { root, abs, vpath, exists }.
 * mustExist=false allows a missing final segment (its parent must exist inside the root).
 */
export async function resolveVirtual(roots, v, { mustExist = true } = {}) {
  const segs = splitVirtual(v);
  if (!segs.length) return { top: true, vpath: '/' };
  const root = roots.get(segs[0]);
  if (!root) throw new PathError('ENOENT', 404);
  const rel = segs.slice(1);
  const variants = [rel];
  for (const form of ['NFC', 'NFD']) {
    const alt = rel.map((s) => s.normalize(form));
    if (alt.some((s, i) => s !== rel[i]) && !variants.some((x) => x.join('/') === alt.join('/'))) variants.push(alt);
  }
  for (const r of variants) {
    const abs = path.join(root.real, ...r);
    const real = await realOrNull(abs);
    if (real === null) continue;
    if (!inside(real, root.real)) throw new PathError('EOUTSIDE', 403);
    return { root, abs: real, vpath: '/' + [root.name, ...r].join('/'), exists: true };
  }
  if (mustExist) throw new PathError('ENOENT', 404);
  if (!rel.length) throw new PathError('ENOENT', 404);
  const parent = await realOrNull(path.join(root.real, ...rel.slice(0, -1)));
  if (parent === null) throw new PathError('ENOENT', 404);
  if (!inside(parent, root.real)) throw new PathError('EOUTSIDE', 403);
  return { root, abs: path.join(parent, rel[rel.length - 1]), vpath: '/' + [root.name, ...rel].join('/'), exists: false };
}

/** Host path (inside root.real) -> virtual path. */
export function toVirtual(root, abs) {
  const rel = path.relative(root.real, abs);
  if (!rel) return '/' + root.name;
  return '/' + root.name + '/' + rel.split(path.sep).join('/');
}
