// Inline markdown parser — replaces react-markdown

// `![alt](url)` image embeds are matched BEFORE the `[text](url)` link form so
// the leading `!` isn't dropped. A same-origin (`/…`) or http(s) src is allowed;
// anything else (data:, javascript:, etc.) renders as the alt text only.
// Unlike `*emphasis*`, GFM only opens/closes `_emphasis_` at a word boundary, so
// the lookarounds keep intraword underscores (QUALITY_AUDIT_JSON, SOME_ENV_VAR,
// snake_case) literal instead of being consumed as emphasis delimiters.
const INLINE_RE = /(!\[[^\]]*\]\([^)]+\)|`[^`]*`|\*\*[^*]+\*\*|\*[^*]+\*|(?<!\w)_(?!\s)[^_]+(?<!\s)_(?!\w)|\[[^\]]+\]\([^)]+\))/g;

const safeSrc = (url) => (/^(https?:\/\/|\/[^/])/.test(url) ? url : null);

const LINK_CLASS = 'text-port-accent hover:underline';

// Literal text — outside code spans, links, and image syntax — is the ONE place
// an optional `linkifyText` resolver gets to add links of its own. This renderer
// is shared across unrelated domains, so it knows only the segment shape the
// resolver returns; what counts as a reference, and where it points, stays with
// the caller that holds the record (components/cos/tabs/AgentCard.jsx).
function renderText(text, linkifyText, key) {
  const segments = linkifyText ? linkifyText(text) : null;
  // The common case by far: nothing to link. Hand back the bare string so the
  // no-reference path costs exactly what it did before the resolver existed.
  if (!segments || (segments.length === 1 && typeof segments[0] === 'string')) return [text];
  return segments.map((seg, i) => {
    // `safeSrc` for the same reason a markdown link's href gets it: the
    // resolver is supplied by the caller, and a `javascript:`/`data:`
    // destination must not become an anchor just because it arrived through a
    // different door. A rejected destination degrades to the literal text.
    const href = seg?.url ? safeSrc(seg.url) : null;
    if (!seg?.url) return seg;
    return href
      ? <a key={`${key}-${i}`} href={href} className={LINK_CLASS} target="_blank" rel="noopener noreferrer">{seg.ref}</a>
      : seg.ref;
  });
}

function parseInline(text, linkifyText) {
  const parts = [];
  let last = 0;
  let m;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) parts.push(...renderText(text.slice(last, m.index), linkifyText, `t${m.index}`));
    const s = m[0];
    if (s[0] === '!') {
      const im = s.match(/^!\[([^\]]*)\]\(([^)]+)\)/);
      if (im) {
        const src = safeSrc(im[2]);
        parts.push(src
          ? <img key={m.index} src={src} alt={im[1]} loading="lazy"
                 className="max-w-full sm:max-w-md rounded border border-port-border my-2" />
          : <span key={m.index} className="text-gray-500 italic">[{im[1] || 'image'}]</span>);
      }
    } else if (s[0] === '`') {
      parts.push(<code key={m.index} className="bg-port-bg px-1 py-0.5 rounded text-port-accent font-mono text-xs break-all">{s.slice(1, -1)}</code>);
    } else if (s.startsWith('**')) {
      parts.push(<strong key={m.index} className="text-white font-semibold">{renderText(s.slice(2, -2), linkifyText, `b${m.index}`)}</strong>);
    } else if (s[0] === '*' || s[0] === '_') {
      parts.push(<em key={m.index} className="text-gray-300 italic">{renderText(s.slice(1, -1), linkifyText, `i${m.index}`)}</em>);
    } else {
      const lm = s.match(/\[([^\]]+)\]\(([^)]+)\)/);
      if (lm) {
        const href = safeSrc(lm[2]);
        parts.push(href
          ? <a key={m.index} href={href} className={LINK_CLASS} target="_blank" rel="noopener noreferrer">{lm[1]}</a>
          : <span key={m.index} className="text-port-accent">{lm[1]}</span>);
      }
    }
    last = m.index + s.length;
  }
  if (last < text.length) parts.push(...renderText(text.slice(last), linkifyText, `t${last}`));
  return parts;
}

const RE_STRUCTURAL = /^(#{1,6} |```|---+$|> |[-*+] |\d+\. )/;
const RE_TABLE_SEP = /^[\s|:-]+$/;

const H_STYLES = [
  'text-base font-bold text-white mt-3 mb-1',
  'text-sm font-bold text-white mt-3 mb-1',
  'text-xs font-semibold text-port-accent mt-2 mb-1',
  'text-xs font-semibold text-gray-300 mt-2 mb-0.5',
  'text-xs font-semibold text-gray-300 mt-2 mb-0.5',
  'text-xs font-semibold text-gray-300 mt-2 mb-0.5',
];

function parseBlocks(md, baseLevel, linkifyText) {
  const lines = (md || '').split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (line.startsWith('```')) {
      let end = i + 1;
      while (end < lines.length && !lines[end].startsWith('```')) end++;
      const code = lines.slice(i + 1, end).join('\n');
      blocks.push(<pre key={i} className="my-1 overflow-x-auto"><code className="block bg-port-bg rounded p-2 my-1 text-xs font-mono text-port-accent overflow-x-auto whitespace-pre-wrap break-all">{code}</code></pre>);
      i = end + 1; continue;
    }

    // Heading — clamped into a band below the host card's own heading so
    // embedded markdown never outranks the page outline (#7264). H_STYLES stays
    // indexed by the source `#` count: only the tag name shifts, never the look.
    const hm = line.match(/^(#{1,6})\s+(.*)/);
    if (hm) {
      const Tag = `h${Math.min(6, baseLevel + hm[1].length - 1)}`;
      blocks.push(<Tag key={i} className={H_STYLES[hm[1].length - 1]}>{parseInline(hm[2], linkifyText)}</Tag>);
      i++; continue;
    }

    // Horizontal rule
    if (/^---+$/.test(line.trim())) {
      blocks.push(<hr key={i} className="border-port-border my-2" />);
      i++; continue;
    }

    // Blockquote
    if (line.startsWith('> ')) {
      const bqLines = [];
      while (i < lines.length && lines[i].startsWith('> ')) { bqLines.push(lines[i].slice(2)); i++; }
      blocks.push(<blockquote key={`bq${i}`} className="border-l-2 border-port-accent/50 pl-2 my-1 text-gray-400 italic">{bqLines.map((l, j) => <p key={j} className="text-xs text-gray-300 my-0.5">{parseInline(l, linkifyText)}</p>)}</blockquote>);
      continue;
    }

    // Unordered list
    if (/^[-*+] /.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*+] /.test(lines[i])) { items.push(lines[i].replace(/^[-*+] /, '')); i++; }
      blocks.push(<ul key={`ul${i}`} className="my-0.5 pl-4 space-y-0.5">{items.map((it, j) => <li key={j} className="text-xs text-gray-300 list-disc">{parseInline(it, linkifyText)}</li>)}</ul>);
      continue;
    }

    // Ordered list
    if (/^\d+\. /.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\. /.test(lines[i])) { items.push(lines[i].replace(/^\d+\. /, '')); i++; }
      blocks.push(<ol key={`ol${i}`} className="my-0.5 pl-4 space-y-0.5 list-decimal">{items.map((it, j) => <li key={j} className="text-xs text-gray-300">{parseInline(it, linkifyText)}</li>)}</ol>);
      continue;
    }

    // Table: header row followed by separator
    const isTableStart = line.includes('|') && RE_TABLE_SEP.test(lines[i + 1] || '');
    if (isTableStart) {
      const headers = line.split('|').map(c => c.trim()).filter(Boolean);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|')) { rows.push(lines[i].split('|').map(c => c.trim()).filter(Boolean)); i++; }
      blocks.push(
        <div key={`tbl${i}`} className="overflow-x-auto my-1">
          <table className="text-xs border-collapse w-full">
            <thead className="border-b border-port-border"><tr className="border-b border-port-border/50">{headers.map((h, j) => <th key={j} className="text-left px-2 py-1 text-gray-400 font-medium">{parseInline(h, linkifyText)}</th>)}</tr></thead>
            <tbody>{rows.map((row, j) => <tr key={j} className="border-b border-port-border/50">{row.map((cell, k) => <td key={k} className="px-2 py-1 text-gray-300">{parseInline(cell, linkifyText)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      );
      continue;
    }

    // Empty line
    if (!line.trim()) { i++; continue; }

    // Paragraph: collect consecutive non-structural lines (pipes without table separators are normal text)
    const para = [];
    while (i < lines.length && lines[i].trim() && !RE_STRUCTURAL.test(lines[i])) {
      if (lines[i].includes('|') && RE_TABLE_SEP.test(lines[i + 1] || '')) break;
      para.push(lines[i]); i++;
    }
    if (para.length) blocks.push(<p key={`p${i}`} className="text-xs text-gray-300 my-0.5">{parseInline(para.join(' '), linkifyText)}</p>);
    if (para.length === 0) i++; // skip unconsumed line to prevent infinite loop
  }

  return blocks;
}

// `linkifyText(text) => Array<string | { ref, url }>` optionally turns spans of
// literal text into links — how a CoS run card resolves the bare `#7640` an
// agent wrote in its summary against that run's own tracker. Omit it and the
// text renders exactly as before.
export default function MarkdownOutput({ content, baseLevel = 3, linkifyText = null }) {
  return (
    <div className="markdown-output min-w-0 overflow-hidden break-words">
      {parseBlocks(content, baseLevel, linkifyText)}
    </div>
  );
}
