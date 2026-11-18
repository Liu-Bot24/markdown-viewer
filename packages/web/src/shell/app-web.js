// Web edition entry: install window.mdv over HTTP, then start the shared app.
import { createShim } from './mdv-shim.js';
import { installRouter } from './router.js';
import { WebShell } from './shell.js';
import { startApp } from '../../../core/src/ui/app.js';

async function boot() {
  const res = await fetch('/api/state', { credentials: 'same-origin' });
  if (res.status === 401) {
    location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search + location.hash);
    return;
  }
  const st = await res.json();
  const shim = createShim(st);
  window.mdv = shim;
  let shell = null;
  const viewChanged = (view) => shell && shell.onView(view);
  await startApp({
    beforeInit(app) {
      installRouter(app, shim);
      const route = shim.viewChanged;
      shim.viewChanged = (view, tab) => {
        route(view, tab);
        viewChanged(view);
      };
    },
    afterInit(app) {
      shell = new WebShell(app, shim, st);
    },
  });
}

boot().catch((e) => {
  console.error(e);
  const pre = document.createElement('pre');
  pre.className = 'fatal';
  pre.textContent = '无法启动：' + (e && e.message);
  document.body.append(pre);
});
