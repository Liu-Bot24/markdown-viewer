import { Menu, app } from 'electron';

export function buildMenu(ctx) {
  const { send, settings } = ctx;
  const recent = ctx.recent.slice(0, 15).map((p) => ({ label: p.replace(/&/g, '&&'), click: () => ctx.openRecent(p) }));
  const theme = settings.theme || 'system';

  const template = [
    {
      label: '文件(&F)',
      submenu: [
        { label: '打开文件…', accelerator: 'CmdOrCtrl+O', click: () => ctx.openFileDialog() },
        { label: '打开文件夹…', accelerator: 'CmdOrCtrl+Shift+O', click: () => ctx.openFolderDialog() },
        {
          label: '最近打开',
          submenu: recent.length
            ? [...recent, { type: 'separator' }, { label: '清除列表', click: () => ctx.clearRecent() }]
            : [{ label: '（无）', enabled: false }],
        },
        { type: 'separator' },
        { label: '保存', accelerator: 'CmdOrCtrl+S', click: () => send('save') },
        { type: 'separator' },
        { label: '重新载入', accelerator: 'F5', click: () => send('reload') },
        { label: '关闭标签页', accelerator: 'CmdOrCtrl+W', click: () => send('close-tab') },
        { label: '重新打开关闭的标签页', accelerator: 'CmdOrCtrl+Shift+T', click: () => send('reopen-tab') },
        { type: 'separator' },
        { label: '复制文件路径', accelerator: 'CmdOrCtrl+Shift+C', click: () => send('copy-path') },
        { label: '在资源管理器中显示', accelerator: 'CmdOrCtrl+Shift+R', click: () => send('reveal') },
        { label: '用默认程序打开', click: () => send('open-default') },
        { label: '用其他程序打开…', click: () => send('open-with') },
        { type: 'separator' },
        { label: '退出', role: 'quit' },
      ],
    },
    {
      label: '编辑(&E)',
      submenu: [
        // The editor handles these keys itself; the menu only shows them.
        { label: '撤销', accelerator: 'CmdOrCtrl+Z', registerAccelerator: false, click: () => send('undo') },
        { label: '重做', accelerator: 'CmdOrCtrl+Y', registerAccelerator: false, click: () => send('redo') },
        { type: 'separator' },
        { label: '剪切', role: 'cut' },
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '全选', click: () => send('select-all') },
        { type: 'separator' },
        { label: '查找…', accelerator: 'CmdOrCtrl+F', click: () => send('find') },
        { label: '查找下一个', accelerator: 'F3', click: () => send('find-next') },
        { label: '查找上一个', accelerator: 'Shift+F3', click: () => send('find-prev') },
        { label: '替换…', accelerator: 'CmdOrCtrl+H', click: () => send('replace') },
        { type: 'separator' },
        { label: '编辑 / 阅读', accelerator: 'CmdOrCtrl+E', click: () => send('toggle-edit') },
        { label: '并排预览', accelerator: 'CmdOrCtrl+Shift+E', click: () => send('toggle-split') },
      ],
    },
    {
      label: '视图(&V)',
      submenu: [
        { label: '文件夹目录', type: 'checkbox', checked: settings.sidebar, accelerator: 'CmdOrCtrl+B', click: () => send('toggle-sidebar') },
        { label: '大纲', type: 'checkbox', checked: settings.outline, accelerator: 'CmdOrCtrl+Shift+B', click: () => send('toggle-outline') },
        { label: '宽版阅读', type: 'checkbox', checked: settings.readingWidth === 'wide', accelerator: 'CmdOrCtrl+Shift+W', click: () => send('toggle-width') },
        { type: 'separator' },
        { label: '聊天视图', type: 'checkbox', checked: settings.chatView, accelerator: 'CmdOrCtrl+Shift+M', click: () => send('toggle-chat-view') },
        { label: '内联显示媒体链接', type: 'checkbox', checked: settings.inlineMedia, click: () => send('toggle-inline-media') },
        {
          label: '点击消息引用时',
          submenu: [
            { label: '在侧边预览', type: 'radio', checked: settings.refClick !== 'jump', click: () => send('set-ref-click', 'peek') },
            { label: '直接跳转', type: 'radio', checked: settings.refClick === 'jump', click: () => send('set-ref-click', 'jump') },
          ],
        },
        { type: 'separator' },
        {
          label: '主题',
          submenu: [
            { label: '跟随系统', type: 'radio', checked: theme === 'system', click: () => ctx.setTheme('system') },
            { label: '浅色', type: 'radio', checked: theme === 'light', click: () => ctx.setTheme('light') },
            { label: '深色', type: 'radio', checked: theme === 'dark', click: () => ctx.setTheme('dark') },
          ],
        },
        { label: '放大', accelerator: 'CmdOrCtrl+=', click: () => ctx.zoom(1) },
        { label: '放大', accelerator: 'CmdOrCtrl+Plus', visible: false, click: () => ctx.zoom(1) },
        { label: '缩小', accelerator: 'CmdOrCtrl+-', click: () => ctx.zoom(-1) },
        { label: '实际大小', accelerator: 'CmdOrCtrl+0', click: () => ctx.zoom(0) },
        { type: 'separator' },
        { label: '全屏', role: 'togglefullscreen' },
      ],
    },
    {
      label: '转到(&G)',
      submenu: [
        { label: '后退', accelerator: 'Alt+Left', click: () => send('back') },
        { label: '前进', accelerator: 'Alt+Right', click: () => send('forward') },
        { type: 'separator' },
        { label: '下一个标签页', accelerator: 'CmdOrCtrl+Tab', click: () => send('next-tab') },
        { label: '上一个标签页', accelerator: 'CmdOrCtrl+Shift+Tab', click: () => send('prev-tab') },
        { type: 'separator' },
        { label: '文档开头', accelerator: 'CmdOrCtrl+Home', click: () => send('scroll-top') },
        { label: '文档末尾', accelerator: 'CmdOrCtrl+End', click: () => send('scroll-bottom') },
      ],
    },
    {
      label: '帮助(&H)',
      submenu: [
        { label: '开发者工具', accelerator: 'CmdOrCtrl+Shift+I', click: () => ctx.toggleDevTools() },
        { type: 'separator' },
        { label: `关于 MD Viewer ${app.getVersion()}`, click: () => send('about') },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}
