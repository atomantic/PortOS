import { Fragment, useMemo } from 'react';

// proseTokenizer — finds character / setting / object name occurrences in a
// paragraph and wraps them in styled spans.
//
// Algorithm: leftmost-longest greedy match.
//   1. Flatten characters/settings/objects into a list of {term, kind, refId, label}
//      entries. Drop terms < 3 chars to avoid pronoun spam ("It", "An").
//   2. For each entry, find every case-insensitive occurrence in the paragraph
//      via a sliding indexOf.
//   3. Validate word boundaries (the char immediately before start and at end
//      must NOT be part of [A-Za-z0-9']) — kills "Mira" matching inside "miracle".
//   4. Sort candidates by [start asc, length desc]; sweep left→right, dropping
//      any whose start < cursor (i.e. overlapping with a previously-kept,
//      longer match).
//   5. Splice the paragraph into [text, span, text, span, ...] React nodes.

const WORD = /[A-Za-z0-9']/;

const TOKEN_CLASS = {
  char: {
    dark: 'text-port-accent border-b border-dotted border-port-accent/40 hover:bg-port-accent/10 cursor-pointer transition-colors',
    light: 'text-purple-700 border-b border-dotted border-purple-700/50 hover:bg-purple-200/30 cursor-pointer transition-colors',
  },
  place: {
    dark: 'text-blue-400 border-b border-dotted border-blue-400/40 hover:bg-blue-500/10 cursor-pointer transition-colors',
    light: 'text-blue-700 border-b border-dotted border-blue-700/50 hover:bg-blue-200/30 cursor-pointer transition-colors',
  },
  object: {
    dark: 'text-amber-400 border-b border-dotted border-amber-400/40 hover:bg-amber-500/10 cursor-pointer transition-colors',
    light: 'text-amber-700 border-b border-dotted border-amber-700/50 hover:bg-amber-200/30 cursor-pointer transition-colors',
  },
};

export function buildTokenIndex({ characters = [], settings = [], objects = [] } = {}) {
  const entries = [];
  const push = (kind, refId, label, term) => {
    if (!term || typeof term !== 'string') return;
    const t = term.trim();
    if (t.length < 3) return;
    entries.push({ kind, refId, label, term: t, lower: t.toLowerCase() });
  };
  for (const c of characters) {
    if (!c?.id) continue;
    push('char', c.id, c.name || '', c.name);
    for (const a of c.aliases || []) push('char', c.id, c.name || a, a);
  }
  for (const s of settings) {
    if (!s?.id) continue;
    const label = s.name || s.slugline || '';
    if (s.name) push('place', s.id, label, s.name);
    if (s.slugline && s.slugline !== s.name) push('place', s.id, label, s.slugline);
  }
  for (const o of objects) {
    if (!o?.id) continue;
    push('object', o.id, o.name || '', o.name);
    for (const a of o.aliases || []) push('object', o.id, o.name || a, a);
  }
  return entries;
}

export function tokenizeParagraph(text, entries) {
  if (!text || !entries?.length) return [];
  const lower = text.toLowerCase();
  const candidates = [];
  for (const e of entries) {
    let from = 0;
    while (from <= lower.length - e.lower.length) {
      const idx = lower.indexOf(e.lower, from);
      if (idx < 0) break;
      const end = idx + e.lower.length;
      const before = idx === 0 ? '' : text[idx - 1];
      const after = end >= text.length ? '' : text[end];
      if (!WORD.test(before) && !WORD.test(after)) {
        candidates.push({ start: idx, end, kind: e.kind, refId: e.refId, label: e.label });
      }
      from = idx + 1;
    }
  }
  if (!candidates.length) return [];
  candidates.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const out = [];
  let cursor = 0;
  for (const c of candidates) {
    if (c.start < cursor) continue;
    out.push(c);
    cursor = c.end;
  }
  return out;
}

export function renderTokenized(text, {
  entries = null,
  characters = [],
  settings = [],
  objects = [],
  hotRef = null,
  onTokenEnter,
  onTokenLeave,
  onTokenClick,
  light = false,
} = {}) {
  // Prefer the caller's pre-built index (paid once per bibles change). Fall
  // back to building per-call when only raw bible arrays are passed — handy
  // for ad-hoc renders, but not what ProseReader does.
  const idx = entries || buildTokenIndex({ characters, settings, objects });
  const annotations = tokenizeParagraph(text, idx);
  if (!annotations.length) return <Fragment>{text}</Fragment>;
  const out = [];
  let pos = 0;
  for (let i = 0; i < annotations.length; i += 1) {
    const a = annotations[i];
    if (a.start > pos) out.push(<Fragment key={`t${i}-pre`}>{text.slice(pos, a.start)}</Fragment>);
    const tone = light ? 'light' : 'dark';
    const baseClass = TOKEN_CLASS[a.kind][tone] || '';
    const isHot = hotRef && hotRef.refId === a.refId && hotRef.kind === a.kind;
    const hotClass = isHot ? (light ? 'bg-port-accent/20' : 'bg-port-accent/15') : '';
    out.push(
      // Inline interactive token: rendered as a focusable span with role=button
      // (a real <button> would break inline text flow / paragraph wrapping in
      // some browsers). Keyboard users can Tab to it and press Enter/Space to
      // open the popover (same effect as a click), and Escape closes it via
      // the existing window-level handler in ProseTokenPopover.
      <span
        key={`t${i}`}
        data-wr-token={a.kind}
        data-wr-ref={a.refId}
        role="button"
        tabIndex={0}
        aria-label={`${a.kind === 'char' ? 'Character' : a.kind === 'place' ? 'Setting' : 'Object'}: ${a.label}`}
        className={`${baseClass} ${hotClass} px-px rounded-sm cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-port-accent focus-visible:ring-offset-1`}
        onMouseEnter={(ev) => onTokenEnter?.({ kind: a.kind, refId: a.refId, label: a.label, anchor: ev.currentTarget })}
        onMouseLeave={() => onTokenLeave?.()}
        onFocus={(ev) => onTokenEnter?.({ kind: a.kind, refId: a.refId, label: a.label, anchor: ev.currentTarget })}
        onBlur={() => onTokenLeave?.()}
        onClick={(ev) => {
          ev.stopPropagation();
          onTokenClick?.({ kind: a.kind, refId: a.refId, label: a.label, anchor: ev.currentTarget });
        }}
        onKeyDown={(ev) => {
          if (ev.key !== 'Enter' && ev.key !== ' ') return;
          ev.preventDefault();
          ev.stopPropagation();
          onTokenClick?.({ kind: a.kind, refId: a.refId, label: a.label, anchor: ev.currentTarget });
        }}
      >
        {text.slice(a.start, a.end)}
      </span>
    );
    pos = a.end;
  }
  if (pos < text.length) out.push(<Fragment key="tail">{text.slice(pos)}</Fragment>);
  return <Fragment>{out}</Fragment>;
}

// Convenience hook: memoize the entries so paragraphs don't rebuild the index
// on every render. Pair with paragraph-level useMemo for the annotation pass.
export function useTokenEntries({ characters, settings, objects }) {
  return useMemo(() => buildTokenIndex({ characters, settings, objects }), [characters, settings, objects]);
}
