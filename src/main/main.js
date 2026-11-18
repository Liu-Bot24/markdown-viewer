import { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme, clipboard, screen } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs, userArgs } from '../shared/cli.js';
import { resolveHref, isMarkdownPath, basename } from '../../packages/core/src/shared/paths.js';
import { registerPrivilegedSchemes, registerProtocolHandlers } from './protocol.js';
import { StateStore } from './state.js';
import { FileWatchers } from './watcher.js';
import { buildMenu } from './menu.js';
import { hashBytes, writeTextFile } from '../../packages/core/src/node/textfile.js';
import { runSelftest } from './selftest.js';

const APP_ROOT = path.resolve(import.meta.dirname, '..', '..');
const RENDERER_DIR = path.join(APP_ROOT, 'dist', 'renderer');
const PRELOAD = path.join(APP_ROOT, 'src', 'preload', 'preload.cjs');
const MAX_READ_BYTES = 64 * 1024 * 1024;
// Opening these from a document link asks first: they execute code.
const RISKY_EXTS = new Set([
  '.exe', '.bat', '.cmd', '.com', '.ps1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.msi', '.msix', '.scr',
  '.lnk', '.reg', '.hta', '.cpl', '.jar', '.appx', '.appxbundle', '.msixbundle', '.pif', '.psm1', '.sh',
]);

function statKind(p) {
  try {
    const st = fs.statSync(p);
    return st.isFile() ? 'file' : st.isDirectory() ? 'dir' : null;
  } catch {
    return null;
  }
}
const existsAny = (p) => statKind(p) !== null;

const rawArgs = userArgs(process.argv, process.defaultApp);
const initial = parseArgs(rawArgs, process.cwd(), existsAny);
const isSelftest = Boolean(initial.selftest);

// MDV_USER_DATA isolates settings and the single-instance lock (tests, portable use).
if (process.env.MDV_USER_DATA) app.setPath('userData', path.resolve(process.env.MDV_USER_DATA));
else if (isSelftest) app.setPath('userData', path.join(os.tmpdir(), 'mdview-selftest-' + process.pid));

registerPrivilegedSchemes();

let win = null;
let rendererReady = false;
let pending = [];
let store = null;
let watchers = null;

function deliver(parsed) {
  const msg = { targets: parsed.targets, folder: parsed.folder, newTab: parsed.newTab };
  if (process.env.MDV_LOG) console.log('open-targets ' + JSON.stringify(msg));
  if (!msg.targets.length && !msg.folder) return;
  // A directory given as a positional argument becomes the folder tree root.
  msg.targets = msg.targets.filter((t) => {
    if (statKind(t.path) === 'dir') {
      msg.folder = t.path;
      return false;
    }
    return true;
  });
  if (rendererReady && win) win.webContents.send('open-targets', msg);
  else pending.push(msg);
}

function focusWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  // Windows restricts focus stealing; briefly toggling always-on-top reliably raises the window.
  win.setAlwaysOnTop(true);
  win.focus();
  win.setAlwaysOnTop(false);
}

function sendMenu(cmd, arg) {
  if (win) win.webContents.send('menu', cmd, arg);
}

function rebuildMenu() {
  Menu.setApplicationMenu(
    buildMenu({
      recent: store.get().recent,
      settings: store.get().settings,
      send: sendMenu,
      openFileDialog,
      openFolderDialog,
      setTheme,
      zoom: zoomStep,
      clearRecent: () => {
        store.patch({ recent: [] });
        rebuildMenu();
        sendMenu('recent-changed');
      },
      openRecent: (p) => deliver({ targets: [{ path: p, anchor: '' }] }),
      toggleDevTools: () => win && win.webContents.toggleDevTools(),
      isDev: process.defaultApp,
    }),
  );
}

async function openFileDialog() {
  const r = await dialog.showOpenDialog(win, {
    title: '打开 Markdown 文件',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd', 'mkdn', 'mdwn'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  if (!r.canceled) deliver({ targets: r.filePaths.map((p) => ({ path: p, anchor: '' })) });
}

async function openFolderDialog() {
  const r = await dialog.showOpenDialog(win, { title: '打开文件夹', properties: ['openDirectory'] });
  if (!r.canceled && r.filePaths[0]) deliver({ targets: [], folder: r.filePaths[0] });
}

function setTheme(theme) {
  nativeTheme.themeSource = theme;
  store.patch({ settings: { theme } });
  rebuildMenu();
}

const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
function zoomStep(dir) {
  if (!win) return;
  let z = win.webContents.getZoomFactor();
  if (dir === 0) z = 1;
  else {
    const i = ZOOM_STEPS.findIndex((s) => s >= z - 0.001);
    const cur = i === -1 ? ZOOM_STEPS.length - 1 : i;
    z = ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, cur + dir))];
  }
  win.webContents.setZoomFactor(z);
  store.patch({ settings: { zoom: z } });
  sendMenu('zoom-changed', z);
}

function createWindow() {
  const st = store.get();
  const wb = st.window || {};
  let bounds = { width: wb.width || 1360, height: wb.height || 900 };
  if (Number.isFinite(wb.x) && Number.isFinite(wb.y)) {
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return wb.x < a.x + a.width - 100 && wb.x + bounds.width > a.x + 100 && wb.y >= a.y - 20 && wb.y < a.y + a.height - 100;
    });
    if (visible) bounds = { ...bounds, x: wb.x, y: wb.y };
  }
  if (isSelftest) bounds = { width: 1440, height: 920 };

  win = new BrowserWindow({
    ...bounds,
    minWidth: 640,
    minHeight: 400,
    show: false,
    title: 'MD Viewer',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1f22' : '#ffffff',
    icon: path.join(APP_ROOT, 'assets', 'icon.png'),
    webPreferences: {
      preload: PRELOAD,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      zoomFactor: st.settings.zoom || 1,
      // a covered or minimized self-test window would otherwise get no animation frames and stall its steps
      backgroundThrottling: !isSelftest,
    },
  });
  if (wb.maximized && !isSelftest) win.maximize();

  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('mdvapp://')) e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('zoom-changed', (_e, dir) => zoomStep(dir === 'in' ? 1 : -1));
  win.webContents.on('did-finish-load', () => win.webContents.setZoomFactor(store.get().settings.zoom || 1));
  win.once('ready-to-show', () => win.show());

  const saveBounds = () => {
    if (!win || isSelftest) return;
    const maximized = win.isMaximized();
    const b = maximized ? win.getNormalBounds() : win.getBounds();
    store.patch({ window: { ...b, maximized } });
  };
  win.on('resize', saveBounds);
  win.on('move', saveBounds);
  win.on('closed', () => {
    win = null;
    rendererReady = false;
  });

  win.loadURL('mdvapp://app/index.html' + (isSelftest ? '?selftest=1' : ''));
}

function registerIpc() {
  ipcMain.handle('state:get', () => {
    const st = store.get();
    return {
      settings: st.settings,
      recent: st.recent,
      rootFolder: st.rootFolder,
      session: isSelftest ? [] : st.session,
      version: app.getVersion(),
      isSelftest,
      hasInitialTargets: pending.length > 0,
      homeDir: os.homedir(),
    };
  });
  ipcMain.handle('state:patch', (_e, partial) => {
    const before = store.get().settings;
    store.patch(partial);
    if (partial.settings && partial.settings.theme && partial.settings.theme !== before.theme) {
      nativeTheme.themeSource = partial.settings.theme;
    }
    if (partial.settings) rebuildMenu();
    return true;
  });
  ipcMain.handle('recent:add', (_e, p) => {
    store.addRecent(p);
    app.addRecentDocument(p);
    rebuildMenu();
    return store.get().recent;
  });
  ipcMain.handle('recent:remove', (_e, p) => {
    store.removeRecent(p);
    rebuildMenu();
    return store.get().recent;
  });
  ipcMain.on('renderer:ready', () => {
    rendererReady = true;
    const q = pending;
    pending = [];
    for (const m of q) win.webContents.send('open-targets', m);
  });

  ipcMain.handle('fs:read', async (_e, p) => {
    try {
      const st = await fs.promises.stat(p);
      if (st.isDirectory()) return { ok: false, code: 'EISDIR' };
      if (st.size > MAX_READ_BYTES) return { ok: false, code: 'ETOOBIG', size: st.size };
      const bytes = await fs.promises.readFile(p);
      return { ok: true, bytes, mtimeMs: st.mtimeMs, size: st.size, hash: hashBytes(bytes) };
    } catch (e) {
      return { ok: false, code: e.code || 'EIO', message: String(e.message || e) };
    }
  });
  ipcMain.handle('fs:stat', async (_e, p) => {
    try {
      const st = await fs.promises.stat(p);
      return { ok: true, isFile: st.isFile(), isDir: st.isDirectory(), size: st.size, mtimeMs: st.mtimeMs };
    } catch (e) {
      return { ok: false, code: e.code || 'EIO' };
    }
  });
  ipcMain.handle('fs:list', async (_e, dir, opts = {}) => {
    try {
      const ents = await fs.promises.readdir(dir, { withFileTypes: true });
      const out = [];
      for (const d of ents) {
        if (d.name.startsWith('.') && d.name !== '.') continue;
        const full = path.join(dir, d.name);
        let isDir = d.isDirectory();
        if (d.isSymbolicLink()) isDir = statKind(full) === 'dir';
        const isMd = !isDir && isMarkdownPath(d.name);
        if (!isDir && !isMd && !opts.all) continue;
        out.push({ name: d.name, path: full, isDir, isMd });
      }
      return { ok: true, entries: out };
    } catch (e) {
      return { ok: false, code: e.code || 'EIO', entries: [] };
    }
  });
  ipcMain.handle('fs:write', (_e, p, opts) => writeTextFile(p, opts));
  ipcMain.handle('link:resolve', (_e, baseFile, href) => resolveLinkTarget(baseFile, href));
  ipcMain.handle('fs:watch', (_e, p) => watchers.add(p));
  ipcMain.handle('fs:unwatch', (_e, p) => watchers.remove(p));

  ipcMain.handle('shell:openExternal', (_e, url) => {
    if (/^(https?:|mailto:)/i.test(url)) return shell.openExternal(url);
    return false;
  });
  ipcMain.handle('shell:reveal', (_e, p) => {
    shell.showItemInFolder(p);
    return true;
  });
  ipcMain.handle('shell:openPath', async (_e, p) => {
    const ext = path.extname(p).toLowerCase();
    if (RISKY_EXTS.has(ext)) {
      const r = await dialog.showMessageBox(win, {
        type: 'warning',
        buttons: ['在资源管理器中显示', '仍然打开', '取消'],
        defaultId: 0,
        cancelId: 2,
        title: '可执行文件',
        message: `“${basename(p)}”是可执行或脚本文件。`,
        detail: '直接打开会运行它。建议先在资源管理器中查看。',
      });
      if (r.response === 0) shell.showItemInFolder(p);
      if (r.response !== 1) return '';
    }
    return shell.openPath(p);
  });
  ipcMain.handle('shell:openWith', (_e, p) => {
    // Windows "Open with" chooser.
    spawn('rundll32.exe', ['shell32.dll,OpenAs_RunDLL', p], { detached: true, stdio: 'ignore' }).unref();
    return true;
  });
  ipcMain.handle('clipboard:write', (_e, text) => {
    clipboard.writeText(String(text));
    return true;
  });
  ipcMain.handle('dialog:open', async (_e, kind) => {
    if (kind === 'folder') await openFolderDialog();
    else await openFileDialog();
    return true;
  });
  ipcMain.handle('menu:context', (_e, items) => {
    return new Promise((resolve) => {
      let chosen = null;
      const build = (list) =>
        list.map((it) =>
          it.type === 'separator'
            ? { type: 'separator' }
            : {
                label: it.label,
                enabled: it.enabled !== false,
                click: () => {
                  chosen = it.id;
                },
              },
        );
      const menu = Menu.buildFromTemplate(build(items));
      menu.popup({ window: win, callback: () => setTimeout(() => resolve(chosen), 0) });
    });
  });
  ipcMain.handle('dialog:ask', async (_e, opts) => {
    const r = await dialog.showMessageBox(win, {
      type: opts.type || 'question',
      title: opts.title || 'MD Viewer',
      message: opts.message,
      detail: opts.detail,
      buttons: opts.buttons,
      defaultId: opts.defaultId ?? 0,
      cancelId: opts.cancelId ?? opts.buttons.length - 1,
      noLink: true,
    });
    return r.response;
  });
  // The renderer closes the window itself once unsaved documents are dealt with.
  ipcMain.handle('win:close', () => {
    if (win) win.close();
    return true;
  });
  ipcMain.handle('edit:native', (_e, cmd) => {
    if (win && ['cut', 'copy', 'paste'].includes(cmd)) win.webContents[cmd]();
    return true;
  });
  ipcMain.handle('zoom:step', (_e, dir) => zoomStep(dir));
  ipcMain.handle('zoom:get', () => (win ? win.webContents.getZoomFactor() : 1));
}

/** Resolve a document link to an existing file, trying each '#' split in turn. */
async function resolveLinkTarget(baseFile, href) {
  const r = resolveHref(href, baseFile);
  if (r.kind !== 'local') return r;
  // A file wins over a directory: "…/#/聊天记录/x.md#msg-1" must not stop at the folder "…/".
  for (const c of r.candidates) {
    if (statKind(c.path) === 'file') return { kind: 'local', path: c.path, anchor: c.anchor, exists: true, isDir: false };
  }
  for (const c of [...r.candidates].reverse()) {
    if (statKind(c.path) === 'dir') return { kind: 'local', path: c.path, anchor: c.anchor, exists: true, isDir: true };
  }
  const c = r.candidates[0];
  return { kind: 'local', path: c.path, anchor: c.anchor, exists: false, isDir: false };
}

function main() {
  {
    const gotLock = app.requestSingleInstanceLock({ args: rawArgs, cwd: process.cwd() });
    if (!gotLock) {
      app.quit();
      return;
    }
    app.on('second-instance', (_e, argv, cwd, data) => {
      const args = data && Array.isArray(data.args) ? data.args : userArgs(argv, process.defaultApp);
      deliver(parseArgs(args, (data && data.cwd) || cwd, existsAny));
      focusWindow();
    });
  }

  app.whenReady().then(() => {
    store = new StateStore(app.getPath('userData'));
    nativeTheme.themeSource = isSelftest ? 'system' : store.get().settings.theme || 'system';
    watchers = new FileWatchers((p, type) => {
      if (win) win.webContents.send('file-changed', { path: p, type });
    });
    if (process.platform === 'win32') app.setAppUserModelId('local.mdview');
    registerProtocolHandlers(RENDERER_DIR);
    registerIpc();
    rebuildMenu();
    createWindow();
    deliver(initial);
    if (isSelftest) runSelftest(win, initial.selftest, APP_ROOT).catch((e) => {
      console.error(e);
      app.exit(2);
    });
  });

  app.on('window-all-closed', () => {
    if (watchers) watchers.clear();
    if (store) store.saveNow();
    app.quit();
  });
  app.on('before-quit', () => store && store.saveNow());
}

main();
