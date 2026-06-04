import { useMemo, useState } from 'react';
import { Check, Code2, Copy, Eye } from 'lucide-react';
import MarkdownOutput from '../cos/MarkdownOutput';
import { copyToClipboard } from '../../lib/clipboard';

// Languages whose fenced blocks can be rendered as a live preview. `htm`/`xml`/
// `svg` round out the common ways a model labels markup it expects to render.
const HTML_LANGS = new Set(['html', 'htm', 'xml', 'svg']);
// Content sniff for the common case where a model emits a bare ``` fence (or no
// fence at all) but the body is obviously a renderable document/fragment.
const HTML_SNIFF = /<!doctype html|<html[\s>]|<body[\s>]|<svg[\s>]|<head[\s>]|<div[\s>]|<p[\s>]/i;

function isHtmlLike(lang, code) {
  if (HTML_LANGS.has(lang)) return true;
  if (lang && lang !== 'markup') return false; // an explicit non-HTML language wins
  return HTML_SNIFF.test(code);
}

// Split raw model output into ordered segments of fenced code blocks and the
// plain text (markdown) between them. A fence opens on a line starting with ```
// and closes on the next such line; an UNclosed fence (still streaming) consumes
// the rest as code so live output renders sensibly until the closing fence lands.
export function parseSegments(text) {
  const lines = (text || '').split('\n');
  const segments = [];
  let textRun = [];
  const flushText = () => {
    // Drop whitespace-only runs (e.g. the blank line between two code fences) —
    // they'd render as an empty markdown block and only add vertical noise.
    if (textRun.length && textRun.join('\n').trim()) {
      segments.push({ type: 'text', content: textRun.join('\n') });
    }
    textRun = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      flushText();
      const lang = line.slice(3).trim().toLowerCase().split(/\s+/)[0] || '';
      let end = i + 1;
      while (end < lines.length && !lines[end].startsWith('```')) end++;
      const code = lines.slice(i + 1, end).join('\n');
      segments.push({ type: 'code', lang, code, closed: end < lines.length });
      i = end + 1; // skip the closing fence (or run off the end if unterminated)
      continue;
    }
    textRun.push(line);
    i++;
  }
  flushText();
  return segments;
}

function CopyButton({ value, label = 'Copied' }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { copyToClipboard(value, label); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
      className="flex items-center gap-1 text-[11px] text-gray-400 hover:text-white"
      title="Copy code"
    >
      {copied ? <Check size={12} className="text-port-success" /> : <Copy size={12} />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function CodeBlock({ lang, code, closed }) {
  const htmlPreviewable = useMemo(() => isHtmlLike(lang, code), [lang, code]);
  // 'code' | 'preview' — only meaningful when htmlPreviewable. Default to code so
  // the user opts in to running model-generated markup.
  const [view, setView] = useState('code');
  const showPreview = htmlPreviewable && view === 'preview';

  return (
    <div className="my-2 border border-port-border rounded-lg overflow-hidden bg-port-bg">
      <div className="flex items-center justify-between gap-2 px-2 py-1 border-b border-port-border bg-port-card/60">
        <span className="text-[11px] font-mono text-gray-500 truncate">
          {lang || 'code'}{!closed && <span className="text-port-warning"> · streaming…</span>}
        </span>
        <div className="flex items-center gap-3 shrink-0">
          {htmlPreviewable && (
            <div className="flex items-center rounded-md border border-port-border overflow-hidden">
              <button
                onClick={() => setView('code')}
                className={`flex items-center gap-1 px-2 py-0.5 text-[11px] ${view === 'code' ? 'bg-port-accent/20 text-port-accent' : 'text-gray-400 hover:text-white'}`}
              >
                <Code2 size={11} /> Code
              </button>
              <button
                onClick={() => setView('preview')}
                className={`flex items-center gap-1 px-2 py-0.5 text-[11px] ${view === 'preview' ? 'bg-port-accent/20 text-port-accent' : 'text-gray-400 hover:text-white'}`}
              >
                <Eye size={11} /> Preview
              </button>
            </div>
          )}
          <CopyButton value={code} label="Copied code" />
        </div>
      </div>
      {showPreview ? (
        // Minimal sandbox: allow-scripts so the markup's JS runs, allow-forms so
        // demo forms submit within the frame. Deliberately omit allow-same-origin
        // (can't reach this page's DOM/cookies/storage), allow-popups (no
        // window.open spam), and allow-modals (no blocking alert/prompt loops the
        // user can only escape by closing the tab) — none are needed to render a
        // page, and all widen the nuisance surface of untrusted model output.
        <iframe
          title="HTML preview"
          sandbox="allow-scripts allow-forms"
          srcDoc={code}
          className="w-full h-72 md:h-96 bg-white"
        />
      ) : (
        <pre className="overflow-x-auto p-2 text-xs font-mono text-port-accent whitespace-pre-wrap break-words">
          {code}
        </pre>
      )}
    </div>
  );
}

// Renders model output: markdown for prose, with each fenced code block in its
// own panel. HTML-like blocks get a Code/Preview toggle that runs the markup in
// a sandboxed iframe — so "generate an HTML page" output is viewable inline.
export default function PlaygroundOutput({ text }) {
  const segments = useMemo(() => parseSegments(text), [text]);
  return (
    <div className="text-sm text-gray-200 leading-relaxed min-w-0">
      {segments.map((seg, idx) => (
        seg.type === 'code'
          ? <CodeBlock key={idx} lang={seg.lang} code={seg.code} closed={seg.closed} />
          : <MarkdownOutput key={idx} content={seg.content} />
      ))}
    </div>
  );
}
