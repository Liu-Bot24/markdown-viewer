// HTML replacements for native menus and message boxes.
import { h } from '../../../core/src/ui/util.js';

let lastPointer = { x: 120, y: 120 };
window.addEventListener('pointerdown', (e) => (lastPointer = { x: e.clientX, y: e.clientY }), true);
window.addEventListener('contextmenu', (e) => (lastPointer = { x: e.clientX, y: e.clientY }), true);

let openMenu = null;

export function closeMenu(value = null) {
  if (!openMenu) return;
  const m = openMenu;
  openMenu = null;
  m.el.remove();
  m.resolve(value);
}

/** items: [{ id, label, enabled, checked } | { type: 'separator' }]. Resolves the chosen id or null. */
export function showMenu(items, at = lastPointer, { anchor = null } = {}) {
  closeMenu(null);
  return new Promise((resolve) => {
    const list = h('div.web-menu', { role: 'menu' });
    for (const it of items) {
      if (it.type === 'separator') {
        if (list.lastChild && !list.lastChild.classList.contains('sep')) list.append(h('div.sep'));
        continue;
      }
      if (it.type === 'heading') {
        list.append(h('div.web-menu-heading', null, it.label));
        continue;
      }
      const enabled = it.enabled !== false;
      list.append(
        h(
          'button.web-menu-item',
          {
            role: 'menuitem',
            disabled: !enabled,
            onclick: (e) => {
              e.stopPropagation();
              closeMenu(it.id);
            },
          },
          h('span.check', null, it.checked ? '✓' : ''),
          h('span.label', null, it.label),
          it.hint ? h('span.hint', null, it.hint) : null,
        ),
      );
    }
    if (list.lastChild && list.lastChild.classList.contains('sep')) list.lastChild.remove();
    const backdrop = h('div.web-menu-backdrop', {
      onpointerdown: (e) => {
        if (e.target === backdrop) closeMenu(null);
      },
      oncontextmenu: (e) => {
        e.preventDefault();
        closeMenu(null);
      },
    });
    backdrop.append(list);
    document.body.append(backdrop);
    openMenu = { el: backdrop, resolve };
    // place inside the viewport
    const r = list.getBoundingClientRect();
    const p = at || lastPointer;
    let x = p.x;
    let y = p.y;
    if (anchor) {
      const a = anchor.getBoundingClientRect();
      x = a.right - r.width;
      y = a.bottom + 4;
    }
    x = Math.max(4, Math.min(x, window.innerWidth - r.width - 4));
    y = Math.max(4, Math.min(y, window.innerHeight - r.height - 4));
    list.style.left = x + 'px';
    list.style.top = y + 'px';
    const first = list.querySelector('.web-menu-item:not([disabled])');
    if (first) first.focus({ preventScroll: true });
    list.addEventListener('keydown', (e) => {
      const btns = [...list.querySelectorAll('.web-menu-item:not([disabled])')];
      const i = btns.indexOf(document.activeElement);
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeMenu(null);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        btns[(i + 1) % btns.length]?.focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        btns[(i - 1 + btns.length) % btns.length]?.focus();
      }
    });
  });
}

/**
 * Modal dialog. opts: { type, title, message, detail, buttons, defaultId, cancelId, input: { label, expect } }.
 * Resolves the index of the chosen button. With `input`, the button at defaultId stays disabled
 * until the typed text equals input.expect exactly.
 */
export function showDialog(opts) {
  return new Promise((resolve) => {
    const buttons = opts.buttons || ['确定'];
    const cancelId = opts.cancelId ?? buttons.length - 1;
    const defaultId = opts.defaultId ?? 0;
    let input = null;
    const btnEls = buttons.map((label, i) =>
      h(
        'button.btn' + (i === defaultId ? '.primary' : '') + (opts.danger && i === defaultId ? '.danger' : ''),
        {
          onclick: () => done(i),
        },
        label,
      ),
    );
    const done = (i) => {
      if (input && i === defaultId && input.value !== opts.input.expect) return;
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(input ? { button: i, text: input.value } : i);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        done(cancelId);
      } else if (e.key === 'Enter' && !(e.target && e.target.tagName === 'TEXTAREA')) {
        e.preventDefault();
        done(defaultId);
      }
    };
    const body = [h('div.dlg-message', null, opts.message || '')];
    if (opts.detail) body.push(h('div.dlg-detail', null, opts.detail));
    if (opts.input) {
      input = h('input.dlg-input', {
        type: 'text',
        autocomplete: 'off',
        spellcheck: 'false',
        placeholder: opts.input.placeholder || '',
        oninput: () => (btnEls[defaultId].disabled = input.value !== opts.input.expect),
      });
      btnEls[defaultId].disabled = true;
      if (opts.input.label) body.push(h('div.dlg-input-label', null, opts.input.label));
      if (opts.input.expect) body.push(h('div.dlg-expect', null, opts.input.expect));
      body.push(input);
    }
    const box = h('div.dlg' + (opts.type ? '.dlg-' + opts.type : ''), { role: 'dialog', 'aria-modal': 'true' }, opts.title ? h('div.dlg-title', null, opts.title) : null, ...body, h('div.dlg-buttons', null, btnEls));
    const overlay = h('div.dlg-overlay', null, box);
    document.body.append(overlay);
    document.addEventListener('keydown', onKey, true);
    (input || btnEls[defaultId]).focus();
  });
}

export function download(name, bytes, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = h('a', { href: url, download: name, style: { display: 'none' } });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export function downloadUrl(url) {
  const a = h('a', { href: url, download: '', style: { display: 'none' } });
  document.body.append(a);
  a.click();
  a.remove();
}

export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(String(text));
      return true;
    }
  } catch {
    /* fall back below */
  }
  const ta = h('textarea', { style: { position: 'fixed', left: '-9999px', top: '0' } });
  ta.value = String(text);
  document.body.append(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}
