// Narrow bridge between the sandboxed renderer and the main process.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (ch, ...args) => ipcRenderer.invoke(ch, ...args);

function on(channel, handler) {
  const fn = (_e, ...args) => handler(...args);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
}

contextBridge.exposeInMainWorld('mdv', {
  getState: () => invoke('state:get'),
  patchState: (partial) => invoke('state:patch', partial),
  addRecent: (p) => invoke('recent:add', p),
  removeRecent: (p) => invoke('recent:remove', p),
  ready: () => ipcRenderer.send('renderer:ready'),

  readFile: (p) => invoke('fs:read', p),
  writeFile: (p, opts) => invoke('fs:write', p, opts),
  stat: (p) => invoke('fs:stat', p),
  listDir: (dir, opts) => invoke('fs:list', dir, opts),
  resolveLink: (baseFile, href) => invoke('link:resolve', baseFile, href),
  watch: (p) => invoke('fs:watch', p),
  unwatch: (p) => invoke('fs:unwatch', p),

  openExternal: (url) => invoke('shell:openExternal', url),
  reveal: (p) => invoke('shell:reveal', p),
  openPath: (p) => invoke('shell:openPath', p),
  openWith: (p) => invoke('shell:openWith', p),
  copyText: (t) => invoke('clipboard:write', t),
  openDialog: (kind) => invoke('dialog:open', kind),
  contextMenu: (items) => invoke('menu:context', items),
  ask: (opts) => invoke('dialog:ask', opts),
  closeWindow: () => invoke('win:close'),
  editNative: (cmd) => invoke('edit:native', cmd),
  zoomStep: (dir) => invoke('zoom:step', dir),
  getZoom: () => invoke('zoom:get'),
  pathForFile: (file) => webUtils.getPathForFile(file),

  onOpenTargets: (h) => on('open-targets', h),
  onMenu: (h) => on('menu', h),
  onFileChanged: (h) => on('file-changed', h),
});
