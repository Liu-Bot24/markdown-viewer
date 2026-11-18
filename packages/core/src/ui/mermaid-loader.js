// Lazily load Mermaid and render diagrams as they scroll into view.
let mermaidPromise = null;
let counter = 0;

function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => {
      const mermaid = m.default;
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default',
        fontFamily: 'inherit',
      });
      return mermaid;
    });
  }
  return mermaidPromise;
}

async function renderOne(pre) {
  if (pre.dataset.mdvDone) return;
  pre.dataset.mdvDone = '1';
  const src = pre.textContent;
  try {
    const mermaid = await loadMermaid();
    const { svg } = await mermaid.render('mdv-mermaid-' + ++counter, src);
    const box = document.createElement('div');
    box.className = 'mdv-mermaid-svg';
    box.innerHTML = svg; // mermaid output under securityLevel "strict"
    box.dataset.source = src;
    pre.replaceWith(box);
  } catch (e) {
    pre.classList.add('mdv-mermaid-error');
    pre.setAttribute('data-error', String((e && e.message) || e).split('\n')[0]);
    // mermaid leaves an error element in <body> on failure
    document.querySelectorAll('body > [id^="dmdv-mermaid-"]').forEach((n) => n.remove());
  }
}

export function observeMermaid(scroller, blocks) {
  if (!blocks.length) return null;
  const io = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (en.isIntersecting) {
          io.unobserve(en.target);
          renderOne(en.target);
        }
      }
    },
    { root: scroller, rootMargin: '600px 0px' },
  );
  blocks.forEach((b) => io.observe(b));
  return io;
}
