// Full-window viewer for images and videos opened from a document.
// Images open fitted to the window; a click zooms to actual size around the clicked
// point and another click fits again. A zoomed image pans by dragging or scrolling.
// A click on the dark area around the media closes the viewer, like × and Esc.
import { h, caps } from './util.js';
import { toLocalResourceUrl, basename, hasPathHooks } from '../shared/paths.js';

const DRAG_PX = 4; // pointer travel beyond this is a drag, not a click

export class Lightbox {
  constructor() {
    this.stage = h('div.lb-stage');
    this.caption = h('div.lb-caption');
    this.bar = h(
      'div.lb-bar',
      null,
      this.caption,
      ...(caps().fileManager
        ? [
            h('button.btn.small', { onclick: () => this.path && window.mdv.openPath(this.path) }, '用默认程序打开'),
            h('button.btn.small', { onclick: () => this.path && window.mdv.reveal(this.path) }, '在资源管理器中显示'),
          ]
        : caps().download
          ? [h('button.btn.small', { onclick: () => this.path && window.mdv.downloadPath(this.path) }, '下载原文件')]
          : []),
      h('button.icon-btn', { title: '关闭 (Esc)', onclick: () => this.close() }, '×'),
    );
    this.path = null;
    this.img = null;
    this.press = null; // the current pointer press: where it started and whether it became a drag
    this.el = h('div.lightbox', null, this.bar, this.stage);
    this.el.addEventListener('pointerdown', (e) => this.onDown(e));
    this.el.addEventListener('pointermove', (e) => this.onMove(e));
    this.el.addEventListener('pointerup', (e) => this.onUp(e));
    this.el.addEventListener('pointercancel', () => this.endPress());
    document.body.append(this.el);
  }

  get isOpen() {
    return this.el.classList.contains('open');
  }

  get zoomed() {
    return !!(this.img && this.img.classList.contains('actual'));
  }

  /** src: a loadable URL; path: local path when known. */
  open({ kind, src, path }) {
    this.path = path || null;
    this.caption.textContent = path ? basename(path) : src;
    this.caption.title = path || src;
    // the web shows reduced previews in documents: the viewer loads the original
    const url = (hasPathHooks() && path && toLocalResourceUrl(path, { full: true })) || src || toLocalResourceUrl(path);
    let media;
    this.img = null;
    if (kind === 'video') media = h('video', { src: url, controls: true, autoplay: true });
    else if (kind === 'audio') media = h('audio', { src: url, controls: true, autoplay: true });
    else {
      media = h('img', { src: url, alt: '', draggable: 'false', title: '点击放大' });
      media.addEventListener('error', () => media.replaceWith(h('div.lb-error', null, '图片无法加载：', path || src)));
      this.img = media;
    }
    this.stage.replaceChildren(media);
    this.stage.scrollTo(0, 0);
    this.el.classList.add('open');
  }

  close() {
    this.endPress();
    this.el.classList.remove('open');
    this.stage.replaceChildren();
    this.img = null;
  }

  /** Dark area: the stage and bar themselves, not the media, buttons or the stage's scrollbars. */
  isBackdrop(e) {
    const t = e.target;
    if (t === this.stage) {
      const r = this.stage.getBoundingClientRect();
      return e.clientX - r.left < this.stage.clientWidth && e.clientY - r.top < this.stage.clientHeight;
    }
    return t === this.el || t === this.bar || t === this.caption;
  }

  onDown(e) {
    if (e.button !== 0) return;
    const onImg = !!this.img && e.target === this.img;
    if (!onImg && !this.isBackdrop(e)) return;
    this.press = { x: e.clientX, y: e.clientY, left: this.stage.scrollLeft, top: this.stage.scrollTop, onImg, dragged: false, id: e.pointerId };
    if (onImg) {
      e.preventDefault(); // no text selection or native image drag while panning
      if (this.zoomed) this.el.setPointerCapture(e.pointerId);
    }
  }

  onMove(e) {
    const p = this.press;
    if (!p || e.pointerId !== p.id) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    if (!p.dragged && Math.hypot(dx, dy) > DRAG_PX) p.dragged = true;
    if (p.dragged && p.onImg && this.zoomed) {
      this.img.classList.add('panning');
      this.stage.scrollLeft = p.left - dx;
      this.stage.scrollTop = p.top - dy;
    }
  }

  onUp(e) {
    const p = this.press;
    if (!p || e.pointerId !== p.id) return;
    this.endPress();
    if (p.dragged) return;
    // a captured pointer reports the overlay as target, so the press decides what was clicked
    if (p.onImg) this.toggleZoom(e.clientX, e.clientY);
    else if (this.isBackdrop(e)) this.close();
  }

  endPress() {
    const p = this.press;
    this.press = null;
    if (p && this.el.hasPointerCapture && this.el.hasPointerCapture(p.id)) this.el.releasePointerCapture(p.id);
    if (this.img) this.img.classList.remove('panning');
  }

  /** Fit <-> actual size. Zooming in keeps the image point under (x, y) where it is. */
  toggleZoom(x, y) {
    const img = this.img;
    if (!img) return;
    if (this.zoomed) {
      img.classList.remove('actual');
      img.title = '点击放大';
      this.stage.scrollTo(0, 0);
      return;
    }
    const before = img.getBoundingClientRect();
    const fx = before.width ? (x - before.left) / before.width : 0.5;
    const fy = before.height ? (y - before.top) / before.height : 0.5;
    img.classList.add('actual');
    img.title = '点击还原，拖动查看';
    const after = img.getBoundingClientRect();
    this.stage.scrollLeft += after.left + fx * after.width - x;
    this.stage.scrollTop += after.top + fy * after.height - y;
  }
}
