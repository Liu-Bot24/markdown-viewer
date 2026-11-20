// One URL per document (/view/<root>/<path>#anchor) and browser history as the
// back/forward history: the app's own per-tab history is kept in step with it.
import { isLocalPath } from './local.js';
import { pathFromLocation, viewUrl } from './mdv-shim.js';

export function installRouter(app, shim) {
  let index = -1; // tab history index the browser entry corresponds to
  let fromPop = 0;

  const urlFor = (view, tab) => {
    if (!view || isLocalPath(view.path)) return '/';
    const e = tab.entries[tab.index];
    return viewUrl(view.path, e && e.anchor, view.kind);
  };

  shim.viewChanged = (view, tab) => {
    if (!tab || tab !== app.tabs.active) {
      if (!view) history.replaceState({ i: -1 }, '', '/');
      return;
    }
    const url = urlFor(view, tab);
    const here = location.pathname + location.search + location.hash;
    if (fromPop) {
      index = tab.index;
      if (url !== here) history.replaceState({ i: tab.index }, '', url);
      return;
    }
    if (tab.index > index && index !== -1) history.pushState({ i: tab.index }, '', url);
    else if (url !== here || (history.state && history.state.i !== tab.index)) history.replaceState({ i: tab.index }, '', url);
    index = tab.index;
  };

  shim.historyBack = () => history.back();
  shim.historyForward = () => history.forward();

  window.addEventListener('popstate', async (e) => {
    const tab = app.tabs.active;
    const want = e.state && Number.isInteger(e.state.i) ? e.state.i : null;
    if (!tab || want === null) {
      // an entry from before the app took over (or a hand-edited URL): open what it names
      const t = pathFromLocation();
      if (t) app.navigate(t);
      return;
    }
    fromPop++;
    try {
      while (tab.index > want && tab.index > 0) {
        const before = tab.index;
        await app.tabs.back(tab);
        if (tab.index === before) break; // kept by an unsaved-changes prompt
      }
      while (tab.index < want && tab.index < tab.entries.length - 1) {
        const before = tab.index;
        await app.tabs.forward(tab);
        if (tab.index === before) break;
      }
      if (tab.index !== want) history.replaceState({ i: tab.index }, '', urlFor(tab.view, tab));
    } finally {
      fromPop--;
      index = tab.index;
    }
  });
}
