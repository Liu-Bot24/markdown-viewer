// HTML sanitising with DOMPurify. The DOMPurify instance is injected so the same
// configuration runs in the app (window) and in Node tests (jsdom window).

// Allowed URL schemes in href/src. Adds file:, mdvfile: and Windows drive paths to
// DOMPurify's default list; javascript:, vbscript: and data: (except images) stay out.
const URI_RE =
  /^(?:(?:https?|ftp|mailto|tel|callto|sms|file|mdvfile):|data:image\/(?:png|gif|jpe?g|webp|avif|bmp|svg\+xml);|[a-z]:(?:[\\/]|%5c)|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i;

const FORBID_TAGS = ['style', 'form', 'button', 'textarea', 'select', 'option', 'iframe', 'frame', 'frameset', 'object', 'embed', 'base', 'meta', 'link', 'dialog', 'template', 'portal'];
const FORBID_ATTR = ['autofocus', 'formaction', 'srcdoc', 'ping'];

export function createSanitizer(DOMPurify) {
  DOMPurify.addHook('uponSanitizeElement', (node, data) => {
    if (data.tagName === 'input') {
      const type = (node.getAttribute('type') || '').toLowerCase();
      if (type !== 'checkbox') node.parentNode && node.parentNode.removeChild(node);
    }
  });
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.nodeName === 'INPUT') {
      node.setAttribute('disabled', '');
      node.removeAttribute('name');
    }
    if (node.nodeName === 'A') node.removeAttribute('target');
    if (node.nodeName === 'VIDEO' || node.nodeName === 'AUDIO') {
      node.removeAttribute('autoplay');
      node.setAttribute('controls', '');
      node.setAttribute('preload', 'metadata');
    }
  });

  const config = {
    ALLOWED_URI_REGEXP: URI_RE,
    FORBID_TAGS,
    FORBID_ATTR,
    ADD_ATTR: ['data-line', 'data-lang', 'checked', 'disabled', 'controls', 'poster', 'loop', 'muted', 'playsinline'],
    ADD_TAGS: ['video', 'audio', 'source', 'track'],
    ALLOW_DATA_ATTR: true,
    USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true },
  };

  return {
    /** Sanitize to a DocumentFragment (avoids re-parsing a string). */
    toFragment(html) {
      return DOMPurify.sanitize(html, { ...config, RETURN_DOM_FRAGMENT: true });
    },
    toString(html) {
      return DOMPurify.sanitize(html, config);
    },
  };
}
