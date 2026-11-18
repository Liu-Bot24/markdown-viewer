export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Tiny element builder: h('div.cls#id', {title:'x', onclick}, ...children) */
export function h(spec, props, ...children) {
  const m = /^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i.exec(spec);
  const e = document.createElement((m && m[1]) || 'div');
  if (m && m[2]) {
    for (const part of m[2].match(/[.#][\w-]+/g)) {
      if (part[0] === '.') e.classList.add(part.slice(1));
      else e.id = part.slice(1);
    }
  }
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(e.dataset, v);
      else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
      else if (k in e && k !== 'list' && typeof v !== 'string') e[k] = v;
      else e.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    e.append(c instanceof Node ? c : String(c));
  }
  return e;
}

export function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

export function rafThrottle(fn) {
  let queued = false;
  return (...a) => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn(...a);
    });
  };
}

export function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
export const naturalCompare = (a, b) => collator.compare(a, b);

export { sameFile, isUnder } from '../shared/paths.js';

/**
 * What the platform behind window.mdv can do. The desktop preload sets none of
 * these, so the defaults describe the desktop app.
 */
export function caps() {
  return {
    edition: 'desktop',
    appTabs: true, // tabs inside the app (the web uses browser tabs instead)
    fileManager: true, // reveal in Explorer, open with another program
    download: false,
    copyLink: false,
    exportOnSave: false, // saving writes a copy for the user instead of the file
    forceOverwrite: true, // a conflicting save may be forced after asking
    nativeCloseGuard: false, // closing with unsaved edits: the platform's own prompt
    treeRootLabel: null,
    ...((typeof window !== 'undefined' && window.mdv && window.mdv.caps) || {}),
  };
}

export function nextFrame() {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Keep `el` scrolled into view (block: 'center' | 'start') while images and media
 * around it finish loading and change the layout. Stops on the first user scroll
 * input, or after `ms`. Returns a function that stops it early.
 */
export function pinInView(scroller, content, el, block = 'center', ms = 4000) {
  let raf = 0;
  const realign = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => el.isConnected && el.scrollIntoView({ block }));
  };
  const ro = new ResizeObserver(realign);
  ro.observe(content);
  const events = ['wheel', 'pointerdown', 'touchstart'];
  const stop = () => {
    ro.disconnect();
    cancelAnimationFrame(raf);
    clearTimeout(timer);
    for (const e of events) scroller.removeEventListener(e, stop, true);
    window.removeEventListener('keydown', stop, true);
  };
  for (const e of events) scroller.addEventListener(e, stop, { capture: true, passive: true });
  window.addEventListener('keydown', stop, true); // keyboard scrolling usually has focus elsewhere
  const timer = setTimeout(stop, ms);
  return stop;
}

let toastTimer;
export function toast(msg, kind = 'info', ms = 3500) {
  let t = document.getElementById('toast');
  if (!t) {
    t = h('div#toast');
    document.body.append(t);
  }
  t.textContent = msg;
  t.className = 'show ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), ms);
}
