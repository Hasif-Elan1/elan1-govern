import { useMemo, useSyncExternalStore } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { yaml as yamlLanguage } from '@codemirror/lang-yaml';
import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { linter, lintGutter, type Diagnostic } from '@codemirror/lint';
import { tags as t } from '@lezer/highlight';
import { parseDocument } from 'yaml';

/** Follows the console theme (document.documentElement.dataset.theme). */
export function useDarkTheme() {
  return useSyncExternalStore(
    (cb) => {
      const mo = new MutationObserver(cb);
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      return () => mo.disconnect();
    },
    () => document.documentElement.dataset.theme === 'dark',
  );
}

const v = (name: string, a?: number) => (a === undefined ? `rgb(var(--${name}))` : `rgb(var(--${name}) / ${a})`);

/** Brand theme built on the colour tokens, so light and dark swap with the console. Square, hairline, Plex Mono. */
const brandTheme = (dark: boolean) =>
  EditorView.theme(
    {
      '&': { backgroundColor: v('surface'), color: v('fg'), fontSize: '12.5px', height: '100%' },
      '.cm-scroller': { fontFamily: '"IBM Plex Mono", ui-monospace, monospace', lineHeight: '1.7' },
      '.cm-content': { caretColor: v('fg'), padding: '10px 0' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: v('fg'), borderLeftWidth: '2px' },
      '&.cm-focused': { outline: 'none' },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: `${v('accent', 0.22)} !important` },
      '.cm-gutters': { backgroundColor: v('sunken', 0.7), color: v('subtle'), borderRight: `1px solid ${v('line')}` },
      '.cm-activeLine': { backgroundColor: v('sunken', 0.45) },
      '.cm-activeLineGutter': { backgroundColor: v('sunken'), color: v('fg') },
      '.cm-foldPlaceholder': { backgroundColor: v('sunken'), border: `1px solid ${v('line')}`, color: v('muted'), borderRadius: '0' },
      '.cm-tooltip': { backgroundColor: v('surface'), border: `1px solid ${v('line')}`, color: v('fg'), borderRadius: '0' },
      '.cm-tooltip-lint': { fontFamily: '"IBM Plex Sans", sans-serif', fontSize: '12.5px' },
      '.cm-diagnostic-error': { borderLeft: `3px solid ${v('bad')}` },
      '.cm-diagnostic-warning': { borderLeft: `3px solid ${v('held')}` },
      '.cm-lintRange-error': { backgroundImage: 'none', textDecoration: `underline wavy ${v('bad')}`, textUnderlineOffset: '3px' },
      '.cm-panels': { backgroundColor: v('sunken'), color: v('fg') },
      '.cm-searchMatch': { backgroundColor: v('held-bg'), outline: `1px solid ${v('held', 0.5)}` },
      '.cm-matchingBracket': { backgroundColor: v('sunken'), outline: `1px solid ${v('line-strong', 0.5)}` },
    },
    { dark },
  );

const brandHighlight = HighlightStyle.define([
  { tag: [t.propertyName, t.definition(t.propertyName)], color: v('fg'), fontWeight: '500' },
  { tag: [t.string, t.special(t.string)], color: v('accent-fg') },
  { tag: [t.number, t.integer, t.float], color: v('info-fg') },
  { tag: [t.bool, t.null, t.keyword, t.atom], color: v('held-fg') },
  { tag: [t.content, t.attributeValue], color: v('fg') },
  { tag: [t.comment, t.lineComment], color: v('subtle'), fontStyle: 'italic' },
  { tag: [t.punctuation, t.separator, t.squareBracket, t.brace, t.operator], color: v('muted') },
  { tag: [t.meta, t.labelName, t.typeName], color: v('muted') },
]);

const yamlLint = linter((view) => {
  const text = view.state.doc.toString();
  const doc = parseDocument(text);
  const out: Diagnostic[] = [];
  for (const e of [...doc.errors, ...doc.warnings]) {
    const from = Math.min(e.pos[0], text.length);
    const to = Math.min(Math.max(e.pos[1], from + 1), text.length);
    out.push({ from, to: Math.max(to, from), severity: doc.errors.includes(e) ? 'error' : 'warning', message: e.message.split('\n')[0] });
  }
  return out;
}, { delay: 400 });

export function YamlEditor({ value, onChange, readOnly, minHeight = '420px', maxHeight = '70vh', label }: { value: string; onChange?: (v: string) => void; readOnly?: boolean; minHeight?: string; maxHeight?: string; label: string }) {
  const dark = useDarkTheme();
  const theme = useMemo(() => brandTheme(dark), [dark]);
  const extensions = useMemo(() => [yamlLanguage(), syntaxHighlighting(brandHighlight), yamlLint, lintGutter(), EditorView.contentAttributes.of({ 'aria-label': label })], [label]);
  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      readOnly={readOnly}
      editable={!readOnly}
      theme={theme}
      extensions={extensions}
      minHeight={minHeight}
      maxHeight={maxHeight}
      basicSetup={{ foldGutter: true, highlightActiveLine: !readOnly, highlightActiveLineGutter: !readOnly, autocompletion: false, searchKeymap: true }}
    />
  );
}
