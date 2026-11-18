// Command-line contract (stable, documented in README):
//   mdview.exe [<path>[#anchor] ...] [--anchor <id>] [--new-tab] [--folder <dir>]
// - <path> may be absolute, relative to the caller's cwd, or a file:/// URL.
// - "#anchor" is split off only when the full string is not itself an existing file,
//   so paths containing '#' (e.g. a contact folder named "#") keep working.
// - --anchor applies to the last <path> and avoids any '#' ambiguity.

import { hashSplitCandidates, fileHrefToPath, isAbsoluteWinPath, toWin } from '../../packages/core/src/shared/paths.js';

function joinWin(cwd, p) {
  if (isAbsoluteWinPath(p)) return toWin(p);
  const parts = toWin(cwd).replace(/\\+$/, '').split('\\');
  for (const seg of toWin(p).split('\\')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length > 1) parts.pop();
    } else parts.push(seg);
  }
  return parts.join('\\');
}

function decodeAnchor(a) {
  try {
    return decodeURIComponent(a);
  } catch {
    return a;
  }
}

/**
 * Resolve one positional argument to { path, anchor }.
 * exists(path) -> boolean is injected so this stays testable.
 */
export function resolveTarget(arg, cwd, exists) {
  let raw = String(arg).trim().replace(/^"(.*)"$/, '$1');
  if (/^file:/i.test(raw)) {
    for (const c of hashSplitCandidates(raw)) {
      let p;
      try {
        p = fileHrefToPath(new URL(c.path.replace(/#/g, '%23')));
      } catch {
        continue;
      }
      if (exists(p)) return { path: p, anchor: decodeAnchor(c.anchor) };
    }
    const first = hashSplitCandidates(raw)[0];
    try {
      return { path: fileHrefToPath(new URL(first.path)), anchor: decodeAnchor(first.anchor), missing: true };
    } catch {
      return { path: raw, anchor: '', missing: true };
    }
  }
  const whole = joinWin(cwd, raw);
  if (exists(whole)) return { path: whole, anchor: '' };
  // Prefer the LAST '#' as separator: anchors never contain '#', paths may.
  const cands = hashSplitCandidates(raw).slice(0, -1).reverse();
  for (const c of cands) {
    const p = joinWin(cwd, c.path);
    if (exists(p)) return { path: p, anchor: decodeAnchor(c.anchor) };
  }
  if (cands.length) {
    const c = cands[0];
    return { path: joinWin(cwd, c.path), anchor: decodeAnchor(c.anchor), missing: true };
  }
  return { path: whole, anchor: '', missing: true };
}

/**
 * Parse user arguments (already stripped of the executable / app path).
 * Unknown "--switches" (Chromium adds some) are ignored.
 */
export function parseArgs(args, cwd, exists) {
  const out = { targets: [], folder: null, newTab: false, selftest: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--anchor' && i + 1 < args.length) {
      const id = args[++i].replace(/^#/, '');
      if (out.targets.length) out.targets[out.targets.length - 1].anchor = id;
      continue;
    }
    if (a.startsWith('--anchor=')) {
      const id = a.slice(9).replace(/^#/, '');
      if (out.targets.length) out.targets[out.targets.length - 1].anchor = id;
      continue;
    }
    if (a === '--folder' && i + 1 < args.length) {
      out.folder = joinWin(cwd, args[++i]);
      continue;
    }
    if (a === '--new-tab') {
      out.newTab = true;
      continue;
    }
    if (a === '--selftest' && i + 1 < args.length) {
      out.selftest = joinWin(cwd, args[++i]);
      continue;
    }
    if (a.startsWith('-')) continue;
    out.targets.push(resolveTarget(a, cwd, exists));
  }
  return out;
}

/** Strip the executable (and, in development, the app directory) from process.argv. */
export function userArgs(argv, isDefaultApp) {
  const rest = argv.slice(1);
  if (isDefaultApp) {
    // electron.exe [chromium switches] <appPath> [user args]
    const idx = rest.findIndex((a) => !a.startsWith('-'));
    return idx === -1 ? [] : rest.slice(idx + 1);
  }
  return rest;
}
