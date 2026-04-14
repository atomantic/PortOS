// Inline markdown parser — replaces react-markdown

const INLINE_RE = /(`[^`]*`|\*\*[^*]+\*\*|\*[^*]+\*|_[^_]+_|\[[^\]]+\]\([^)]+\))/g;

function parseInline(text) {
  const parts = [];
  let last = 0;
  let m;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const s = m[0];
    if (s[0] === '`') {
      parts.push(<code key={m.index} className="bg-port-bg px-1 py-0.5 rounded text-cyan-400 font-mono text-xs break-all">{s.slice(1, -1)}</code>);
    } else if (s.startsWith('**')) {
      parts.push(<strong key={m.index} className="text-white font-semibold">{s.slice(2, -2)}</strong>);
    } else if (s[0] === '*' || s[0] === '_') {
      parts.push(<em key={m.index} className="text-gray-300 italic">{s.slice(1, -1)}</em>);
    } else {
      const lm = s.match(/\[([^\]]+)\]\(([^)]+)\)/);
      if (lm) {
        const href = lm[2];
        const safeHref = /^(https?:\/\/|\/[^/])/.test(href) ? href : null;
        parts.push(safeHref
          ? <a key={m.index} href={safeHref} className="text-port-accent hover:underline" target="_blank" rel="noopener noreferrer">{lm[1]}</a>
          : <span key={m.index} className="text-port-accent">{lm[1]}</span>);
      }
    }
    last = m.index + s.length;
  }
  if (last < text.length) parts.push(text.slice(last));
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

function parseBlocks(md) {
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
      blocks.push(<pre key={i} className="my-1 overflow-x-auto"><code className="block bg-port-bg rounded p-2 my-1 text-xs font-mono text-cyan-400 overflow-x-auto whitespace-pre-wrap break-all">{code}</code></pre>);
      i = end + 1; continue;
    }

    // Heading
    const hm = line.match(/^(#{1,6})\s+(.*)/);
    if (hm) {
      const Tag = `h${hm[1].length}`;
      blocks.push(<Tag key={i} className={H_STYLES[hm[1].length - 1]}>{parseInline(hm[2])}</Tag>);
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
      blocks.push(<blockquote key={`bq${i}`} className="border-l-2 border-port-accent/50 pl-2 my-1 text-gray-400 italic">{bqLines.map((l, j) => <p key={j} className="text-xs text-gray-300 my-0.5">{parseInline(l)}</p>)}</blockquote>);
      continue;
    }

    // Unordered list
    if (/^[-*+] /.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*+] /.test(lines[i])) { items.push(lines[i].replace(/^[-*+] /, '')); i++; }
      blocks.push(<ul key={`ul${i}`} className="my-0.5 pl-4 space-y-0.5">{items.map((it, j) => <li key={j} className="text-xs text-gray-300 list-disc">{parseInline(it)}</li>)}</ul>);
      continue;
    }

    // Ordered list
    if (/^\d+\. /.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\. /.test(lines[i])) { items.push(lines[i].replace(/^\d+\. /, '')); i++; }
      blocks.push(<ol key={`ol${i}`} className="my-0.5 pl-4 space-y-0.5 list-decimal">{items.map((it, j) => <li key={j} className="text-xs text-gray-300">{parseInline(it)}</li>)}</ol>);
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
            <thead className="border-b border-port-border"><tr className="border-b border-port-border/50">{headers.map((h, j) => <th key={j} className="text-left px-2 py-1 text-gray-400 font-medium">{parseInline(h)}</th>)}</tr></thead>
            <tbody>{rows.map((row, j) => <tr key={j} className="border-b border-port-border/50">{row.map((cell, k) => <td key={k} className="px-2 py-1 text-gray-300">{parseInline(cell)}</td>)}</tr>)}</tbody>
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
    if (para.length) blocks.push(<p key={`p${i}`} className="text-xs text-gray-300 my-0.5">{parseInline(para.join(' '))}</p>);
    if (para.length === 0) i++; // skip unconsumed line to prevent infinite loop
  }

  return blocks;
}

export default function MarkdownOutput({ content }) {
  return (
    <div className="markdown-output min-w-0 overflow-hidden break-words">
      {parseBlocks(content)}
    </div>
  );
}
