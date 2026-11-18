// Source editor for a document: CodeMirror 6 with Markdown highlighting. Loaded on
// first use, so reading-only sessions never pay for it.
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor, highlightSpecialChars, rectangularSelection } from '@codemirror/view';
import { EditorState, Transaction } from '@codemirror/state';
import { history, historyKeymap, defaultKeymap, indentWithTab, undo, redo, selectAll, cursorDocStart, cursorDocEnd } from '@codemirror/commands';
import { search, searchKeymap, highlightSelectionMatches, openSearchPanel, findNext, findPrevious } from '@codemirror/search';
import { syntaxHighlighting, indentOnInput, bracketMatching } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { classHighlighter } from '@lezer/highlight';

const PHRASES = {
  Find: '查找',
  Replace: '替换',
  next: '下一个',
  previous: '上一个',
  all: '全部',
  'match case': '区分大小写',
  'by word': '全字匹配',
  regexp: '正则表达式',
  replace: '替换',
  'replace all': '全部替换',
  close: '关闭',
  'current match': '当前匹配',
  'replaced $ matches': '已替换 $ 处',
  'replaced match on line $': '已替换第 $ 行的匹配',
  'on line': '行',
  'Go to line': '跳到行',
  go: '跳转',
  'Control character': '控制字符',
};

const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--bg)', color: 'var(--fg)' },
  '.cm-scroller': { fontFamily: 'var(--mono)', fontSize: '14px', lineHeight: '1.65' },
  '.cm-content': { padding: '16px 0 40vh', caretColor: 'var(--fg)' },
  '.cm-line': { padding: '0 24px 0 10px' },
  '.cm-gutters': { backgroundColor: 'var(--bg)', color: 'var(--fg-muted)', border: 'none', paddingLeft: '8px' },
  '.cm-activeLine': { backgroundColor: 'var(--editor-active-line)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--fg)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--fg)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--editor-selection)',
  },
  '.cm-selectionMatch': { backgroundColor: 'var(--editor-match)' },
  '.cm-searchMatch': { backgroundColor: 'var(--find)', outline: 'none' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--find-current)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-panels': { backgroundColor: 'var(--bg-pane)', color: 'var(--fg)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border-soft)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--border-soft)' },
});

/**
 * hooks: { onChange(view), onCursor(view), onFocus() }
 */
export function createEditor(parent, text, hooks = {}) {
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: text,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        dropCursor(),
        rectangularSelection(),
        indentOnInput(),
        bracketMatching(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        search({ top: true }),
        markdown({ base: markdownLanguage }),
        syntaxHighlighting(classHighlighter),
        EditorView.lineWrapping,
        EditorState.phrases.of(PHRASES),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
        theme,
        EditorView.contentAttributes.of({ spellcheck: 'false', 'aria-label': 'Markdown 源文本' }),
        EditorView.domEventHandlers({
          // Dropped files open as documents (the window's drop handler) instead of being pasted in.
          drop: (e) => !!(e.dataTransfer && e.dataTransfer.files.length),
          focus: () => {
            if (hooks.onFocus) hooks.onFocus();
            return false;
          },
        }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged && hooks.onChange) hooks.onChange(u.view);
          if ((u.docChanged || u.selectionSet) && hooks.onCursor) hooks.onCursor(u.view);
        }),
      ],
    }),
  });

  return {
    view,
    get doc() {
      return view.state.doc;
    },
    get scroller() {
      return view.scrollDOM;
    },
    hasFocus: () => view.hasFocus,
    focus: () => view.focus(),
    getText: (eol = '\n') => view.state.doc.sliceString(0, view.state.doc.length, eol),

    /** Replace the content (external reload or revert), keeping the cursor and scroll near where they were. */
    setText(next) {
      const cur = view.state.doc.toString();
      next = next.replace(/\r\n?/g, '\n');
      if (cur === next) return;
      let start = 0;
      const max = Math.min(cur.length, next.length);
      while (start < max && cur.charCodeAt(start) === next.charCodeAt(start)) start++;
      let endCur = cur.length;
      let endNext = next.length;
      while (endCur > start && endNext > start && cur.charCodeAt(endCur - 1) === next.charCodeAt(endNext - 1)) {
        endCur--;
        endNext--;
      }
      view.dispatch({
        changes: { from: start, to: endCur, insert: next.slice(start, endNext) },
        annotations: Transaction.addToHistory.of(false),
      });
    },

    cursor() {
      const pos = view.state.selection.main.head;
      const line = view.state.doc.lineAt(pos);
      return { line: line.number, col: pos - line.from + 1 };
    },

    /** 0-based source line at the top of the editor viewport, with a fractional part. */
    topLine() {
      const top = view.scrollDOM.getBoundingClientRect().top - view.documentTop;
      const block = view.lineBlockAtHeight(Math.max(0, top));
      const line = view.state.doc.lineAt(block.from).number - 1;
      const frac = block.height > 0 ? Math.min(1, Math.max(0, (top - block.top) / block.height)) : 0;
      return line + frac;
    },

    /** Scroll so that 0-based `line` (fractional allowed) is at the top. */
    scrollToLine(line) {
      const doc = view.state.doc;
      const n = Math.max(1, Math.min(doc.lines, Math.floor(line) + 1));
      const block = view.lineBlockAt(doc.line(n).from);
      const frac = Math.max(0, line - Math.floor(line));
      view.scrollDOM.scrollTop += view.documentTop + block.top + frac * block.height - view.scrollDOM.getBoundingClientRect().top;
    },

    /** Put the cursor at the start of 0-based `line` without scrolling. */
    setCursorLine(line) {
      const doc = view.state.doc;
      const n = Math.max(1, Math.min(doc.lines, line + 1));
      view.dispatch({ selection: { anchor: doc.line(n).from } });
    },

    /** Put the cursor at the start of 0-based `line` and show it. */
    gotoLine(line) {
      const doc = view.state.doc;
      const n = Math.max(1, Math.min(doc.lines, line + 1));
      const pos = doc.line(n).from;
      view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 24 }) });
    },

    run(cmd) {
      const map = { undo, redo, selectAll, docStart: cursorDocStart, docEnd: cursorDocEnd, find: openSearchPanel, findNext, findPrev: findPrevious };
      const fn = map[cmd];
      if (fn) fn(view);
      if (cmd === 'find' || cmd === 'findNext' || cmd === 'findPrev') return;
      view.focus();
    },

    destroy: () => view.destroy(),
  };
}
