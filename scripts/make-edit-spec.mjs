// Generate test/selftest/edit.json: editing, saving (encoding and line endings kept
// byte for byte), external changes, unsaved-change guards, large window in dark mode.
// The expected bytes are computed here so the spec stays readable as JSON.
import fs from 'node:fs';
import path from 'node:path';
import iconv from 'iconv-lite';

const root = path.resolve(import.meta.dirname, '..');
const gb = (s) => iconv.encode(s, 'gb18030').toString('base64');
const utf8bom = (s) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(s, 'utf8')]).toString('base64');

const body = (first) =>
  [first, '', '第一段：苹果。', '', '## 第二节', '', '内容', ''].join('\r\n') +
  Array.from({ length: 60 }, (_, i) => `\r\n## 小节 ${i + 1}\r\n\r\n第 ${i + 1} 段正文。\r\n`).join('');
const GB0 = body('# 编辑测试');
const GB1 = GB0.replace('内容', '内容（已修改）');
const GB2 = 'ABC' + GB1;
const EXT1 = GB2.replace('第一段', '外部改动');
const EXT2 = EXT1.replace('第二节', '外部第二次');
const MINE = EXT1 + '\r\n我的修改\r\n';

const BOM0 = '# BOM 文件\n\n一行\n';
const BOM1 = BOM0 + '追加\n';

const steps = [
  { name: 'theme-light', do: 'setTheme', theme: 'light' },
  { name: 'write-gb', do: 'writeFile', path: '${tmp}\\edit\\gb.md', base64: gb(GB0) },
  { name: 'write-other', do: 'writeFile', path: '${tmp}\\edit\\other.md', content: '# 另一个文件\n' },
  { name: 'write-bom', do: 'writeFile', path: '${tmp}\\edit\\bom.md', base64: utf8bom(BOM0) },
  { name: 'open-gb', do: 'open', path: '${tmp}\\edit\\gb.md', expect: { 'view.meta.encoding': 'GB18030', 'view.meta.eol': 'CRLF' } },
  { name: 'split', do: 'mode', mode: 'split', expect: { mode: 'split', editorVisible: true, previewVisible: true, dirty: false }, screenshot: true },
  { name: 'edit-dirty', do: 'edit', replace: '内容', with: '内容（已修改）', expect: { dirty: true, tabDirty: true, saveButton: true, title: { includes: '●' }, status: { includes: '未保存' } } },
  { name: 'live-preview', do: 'wait', ms: 900 },
  { name: 'live-preview-check', do: 'editState', find: '内容（已修改）', expect: { previewHas: true } },
  { name: 'save', do: 'save', expect: { saved: true, dirty: false, tabDirty: false, saveButton: false } },
  { name: 'saved-bytes', do: 'readFile', path: '${tmp}\\edit\\gb.md', expect: { base64: gb(GB1) } },

  { name: 'focus-editor', do: 'focusEditor', line: 0, expect: { focused: true } },
  { name: 'type-keys', do: 'keys', keys: ['A', 'B', 'C'] },
  { name: 'typed', do: 'editState', expect: { dirty: true, title: { includes: '●' } } },
  { name: 'ctrl-s', do: 'keys', keys: ['Control+S'], settle: 800 },
  { name: 'ctrl-s-saved', do: 'editState', expect: { dirty: false } },
  { name: 'ctrl-s-bytes', do: 'readFile', path: '${tmp}\\edit\\gb.md', expect: { base64: gb(GB2) } },
  { name: 'ctrl-f-editor-search', do: 'keys', keys: ['Control+F'] },
  { name: 'editor-search-open', do: 'exists', selector: '.doc-root.active .cm-search', expect: { count: 1 }, screenshot: true },
  { name: 'escape-search', do: 'keys', keys: ['Escape'] },

  { name: 'external-clean', do: 'writeFile', path: '${tmp}\\edit\\gb.md', base64: gb(EXT1) },
  { name: 'external-clean-loaded', do: 'waitEditorText', includes: '外部改动', expect: { found: true, dirty: false } },
  { name: 'edit-before-conflict', do: 'edit', insert: '\n我的修改\n', expect: { dirty: true } },
  { name: 'external-dirty', do: 'writeFile', path: '${tmp}\\edit\\gb.md', base64: gb(EXT2) },
  { name: 'external-dirty-banner', do: 'waitBanner', includes: '已在外部被修改', expect: { found: true }, screenshot: true },
  { name: 'edits-kept', do: 'editState', expect: { dirty: true, text: { includes: '我的修改' } } },
  { name: 'conflict-cancel-answer', do: 'answer', responses: [1] },
  { name: 'conflict-cancel', do: 'save', expect: { saved: false, dirty: true } },
  { name: 'conflict-asked', do: 'asked', expect: { 'asked.0': { includes: '在你编辑期间被其他程序修改过' } } },
  { name: 'conflict-untouched', do: 'readFile', path: '${tmp}\\edit\\gb.md', expect: { base64: gb(EXT2) } },
  { name: 'conflict-overwrite-answer', do: 'answer', responses: [0] },
  { name: 'conflict-overwrite', do: 'save', expect: { saved: true, dirty: false } },
  { name: 'overwritten-bytes', do: 'readFile', path: '${tmp}\\edit\\gb.md', expect: { base64: gb(MINE) } },

  { name: 'leave-edit', do: 'edit', insert: 'Z', expect: { dirty: true } },
  { name: 'leave-cancel-answer', do: 'answer', responses: [2] },
  { name: 'leave-cancel', do: 'navigateAway', path: '${tmp}\\edit\\other.md', expect: { left: false, dirty: true, 'asked.0': { includes: '未保存的修改' } } },
  { name: 'leave-discard-answer', do: 'answer', responses: [1] },
  { name: 'leave-discard', do: 'navigateAway', path: '${tmp}\\edit\\other.md', expect: { left: true } },
  { name: 'discarded-bytes', do: 'readFile', path: '${tmp}\\edit\\gb.md', expect: { base64: gb(MINE) } },

  { name: 'open-bom', do: 'open', path: '${tmp}\\edit\\bom.md', expect: { 'view.meta.encoding': 'UTF-8 BOM', 'view.meta.eol': 'LF' } },
  { name: 'bom-edit-mode', do: 'mode', mode: 'edit', expect: { mode: 'edit', editorVisible: true, previewVisible: false } },
  { name: 'bom-edit', do: 'edit', insert: '追加\n', expect: { dirty: true } },
  { name: 'close-cancel-answer', do: 'answer', responses: [2] },
  { name: 'close-tab-cancel', do: 'closeTab', expect: { closed: false } },
  { name: 'close-save-answer', do: 'answer', responses: [0] },
  { name: 'close-tab-save', do: 'closeTab', expect: { closed: true } },
  { name: 'bom-bytes', do: 'readFile', path: '${tmp}\\edit\\bom.md', expect: { base64: utf8bom(BOM1) } },
  { name: 'view-mode-still-reads', do: 'open', path: '${fixtures}\\gfm\\02-gfm.md', expect: { 'view.error': null } },
  { name: 'view-mode-default', do: 'editState', expect: { mode: 'view', editorVisible: false, previewVisible: true } },

  { name: 'theme-dark', do: 'setTheme', theme: 'dark', expect: { dark: true } },
  { name: 'wide-window', do: 'windowSize', width: 2400, height: 1300, expect: { cssWidth: { min: 2300 } } },
  { name: 'wide-report', do: 'open', path: '${fixtures}\\wechat\\聊天记录月报\\2026-09\\月报_2026-09.md', expect: { 'view.meta.refs': 13 } },
  { name: 'wide-split', do: 'mode', mode: 'split', expect: { mode: 'split', editorWidth: { min: 900 }, previewWidth: { min: 900 } }, screenshot: true },
  { name: 'wide-edit', do: 'mode', mode: 'edit', expect: { mode: 'edit', previewVisible: false }, screenshot: true },
  { name: 'wide-view', do: 'mode', mode: 'view', expect: { mode: 'view', editorVisible: false, previewVisible: true, dirty: false } },
  { name: 'theme-light-wide', do: 'setTheme', theme: 'light' },
  { name: 'wide-split-light', do: 'mode', mode: 'split', expect: { mode: 'split' }, screenshot: true },
  { name: 'wide-view-again', do: 'mode', mode: 'view' },
  { name: 'sync-open', do: 'open', path: '${tmp}\\edit\\gb.md' },
  { name: 'sync-split', do: 'mode', mode: 'split' },
  { name: 'sync-editor-drives-preview', do: 'syncCheck', line: 120, expect: { editorTop: { min: 119, max: 121 }, previewTop: { min: 117, max: 123 } }, screenshot: true },

  { name: 'close-window-setup', do: 'open', path: '${tmp}\\edit\\other.md' },
  { name: 'close-window-edit-mode', do: 'mode', mode: 'split' },
  { name: 'close-window-edit', do: 'edit', insert: '未保存\n', expect: { dirty: true } },
  { name: 'close-window-answer', do: 'answer', responses: [2] },
  { name: 'close-window-cancel', do: 'closeWindow', expect: { stillOpen: true } },
  { name: 'close-window-asked', do: 'asked', expect: { 'asked.0': { includes: '未保存的修改' } } },
];

const spec = { outDir: 'test/output/selftest-edit', steps };
fs.writeFileSync(path.join(root, 'test', 'selftest', 'edit.json'), JSON.stringify(spec, null, 1) + '\n');
console.log(`edit spec: ${steps.length} steps`);
