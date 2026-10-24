/** Dependency-free source tokens shared by CI planning and test memo analysis. */

const REGEX_PRECEDING_KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'case', 'do', 'else', 'yield', 'await']);

// ---------------------------------------------------------------------------
// Tokenizer: lenient enough for JSX prose, strict enough to find every literal.
// ---------------------------------------------------------------------------

const isIdentStart = (c) => /[A-Za-z_$]/.test(c);
const isIdentPart = (c) => /[\w$]/.test(c);

function regexAllowed(tokens) {
  const prev = tokens.at(-1);
  // A control-condition close starts a statement, where a regex is valid.
  // Ordinary call/group closes still precede division.
  if (prev?.t === 'p' && prev.v === ')') {
    let depth = 0;
    for (let i = tokens.length - 1; i >= 0; i -= 1) {
      if (tokens[i].t !== 'p') continue;
      if (tokens[i].v === ')') depth += 1;
      if (tokens[i].v === '(' && --depth === 0) {
        return tokens[i - 1]?.t === 'id' && ['if', 'while', 'for', 'with', 'switch', 'catch'].includes(tokens[i - 1].v)
          && !(tokens[i - 2]?.t === 'p' && ['.', '?.'].includes(tokens[i - 2].v));
      }
    }
    return false;
  }
  if (!prev) return true;
  if (prev.t === 'p') return ![')', ']', '}', '++', '--'].includes(prev.v);
  if (prev.t === 'id') return REGEX_PRECEDING_KEYWORDS.has(prev.v);
  return false;
}

function unescape(ch) {
  return { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' }[ch] ?? ch ?? '';
}

function readString(src, start) {
  const quote = src[start];
  let text = '';
  for (let i = start + 1; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '\\') { text += unescape(src[i + 1]); i += 1; continue; }
    if (ch === '\n') return null;
    if (ch === quote) return { text, end: i + 1 };
    text += ch;
  }
  return null;
}

function readRegex(src, start) {
  let inClass = false;
  for (let i = start + 1; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '\\') { i += 1; continue; }
    if (ch === '\n') return null;
    if (inClass) { if (ch === ']') inClass = false; continue; }
    if (ch === '[') { inClass = true; continue; }
    if (ch === '/') {
      let end = i + 1;
      while (end < src.length && /[a-z]/.test(src[end])) end += 1;
      return end;
    }
  }
  return null;
}

/**
 * Tokens of `src`: `{ t: 'id'|'p'|'s'|'n'|'re'|'tpl'|'jsx', v, i }`. Strings decode
 * common escapes; a template literal keeps `quasis` and the recursively
 * tokenized `exprs` of its `${}` holes. Comments vanish. A quote with no
 * partner on its line is JSX prose, and a `/` with no closing partner on its
 * line is division, a `/*` with no partner is prose, and a backtick with no
 * partner before EOF is prose. Throws when a template hole never closes; the
 * caller fails closed on a throw.
 */
export function tokenize(src, proseBackticks = new Set()) {
  const out = [];
  let pos = 0;
  const n = src.length;
  // JSX prose has its own lexical context: quotes there cannot start JS
  // strings, but attribute/child expression holes still execute JavaScript.
  // Ambiguous or malformed JSX throws so dependency callers fail closed.
  const scanJsx = (tokens) => {
    const expression = () => {
      tokens.push({ t: 'p', v: '{', i: pos });
      pos += 1;
      scan(tokens, true);
      tokens.push({ t: 'p', v: '}', i: pos - 1 });
    };
    const element = () => {
      const opening = src.slice(pos).match(/^<(?:([A-Za-z][\w:.-]*)|(?=>))/);
      if (!opening) throw new Error('unrecognized JSX opening');
      const name = opening[1] ?? '';
      pos += opening[0].length;
      let opened = false;
      while (pos < n) {
        if (src[pos] === '"' || src[pos] === "'") {
          const quote = src[pos++];
          const end = src.indexOf(quote, pos);
          if (end < 0) throw new Error('unterminated JSX attribute');
          pos = end + 1;
        } else if (src[pos] === '{') expression();
        else if (src.startsWith('/>', pos)) { pos += 2; return; }
        else if (src[pos] === '>') { pos += 1; opened = true; break; }
        else pos += 1;
      }
      if (!opened) throw new Error('unterminated JSX tag');
      while (pos < n) {
        if (src.startsWith('</', pos)) {
          const closing = src.slice(pos).match(/^<\/([A-Za-z][\w:.-]*)?\s*>/);
          if (!closing || (closing[1] ?? '') !== name) throw new Error('unmatched JSX closing');
          pos += closing[0].length;
          return;
        }
        if (src[pos] === '<') element();
        else if (src[pos] === '{') expression();
        else pos += 1;
      }
      throw new Error('unterminated JSX element');
    };
    const start = pos;
    element();
    tokens.push({ t: 'jsx', i: start });
  };
  const scan = (tokens, stopAtBrace) => {
    let depth = 0;
    while (pos < n) {
      const c = src[pos];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v') { pos += 1; continue; }
      if (c === '/' && src[pos + 1] === '/') {
        const end = src.indexOf('\n', pos);
        pos = end === -1 ? n : end;
        continue;
      }
      if (c === '/' && src[pos + 1] === '*') {
        const end = src.indexOf('*/', pos + 2);
        // No partner anywhere: JSX prose such as `/sdapi/v1/*`, not a comment.
        if (end === -1) { tokens.push({ t: 'p', v: c, i: pos }); pos += 1; continue; }
        pos = end + 2;
        continue;
      }
      if (c === '<' && /^<(?:[A-Za-z]|>)/.test(src.slice(pos))
        && (regexAllowed(tokens) || tokens.at(-1)?.v === 'default')) {
        scanJsx(tokens);
        continue;
      }
      if (c === '\'' || c === '"') {
        const value = readString(src, pos);
        if (value === null) { tokens.push({ t: 'p', v: c, i: pos }); pos += 1; continue; }
        tokens.push({ t: 's', v: value.text, i: pos });
        pos = value.end;
        continue;
      }
      if (c === '`' && proseBackticks.has(pos)) { tokens.push({ t: 'p', v: c, i: pos }); pos += 1; continue; }
      if (c === '`') {
        const start = pos;
        pos += 1;
        const quasis = [];
        const exprs = [];
        let quasi = '';
        for (;;) {
          if (pos >= n) throw Object.assign(new Error('unterminated template literal'), { prose: start });
          const ch = src[pos];
          if (ch === '\\') { quasi += unescape(src[pos + 1]); pos += 2; continue; }
          if (ch === '`') { pos += 1; break; }
          if (ch === '$' && src[pos + 1] === '{') {
            quasis.push(quasi);
            quasi = '';
            pos += 2;
            const inner = [];
            scan(inner, true);
            exprs.push(inner);
            continue;
          }
          quasi += ch;
          pos += 1;
        }
        quasis.push(quasi);
        tokens.push({ t: 'tpl', quasis, exprs, i: start });
        continue;
      }
      if (c === '/' && regexAllowed(tokens)) {
        const end = readRegex(src, pos);
        if (end !== null) { tokens.push({ t: 're', v: src.slice(pos, end), i: pos }); pos = end; continue; }
      }
      if (isIdentStart(c)) {
        let end = pos + 1;
        while (end < n && isIdentPart(src[end])) end += 1;
        tokens.push({ t: 'id', v: src.slice(pos, end), i: pos });
        pos = end;
        continue;
      }
      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[pos + 1] || ''))) {
        let end = pos + 1;
        while (end < n && /[\w.]/.test(src[end])) end += 1;
        tokens.push({ t: 'n', v: src.slice(pos, end), i: pos });
        pos = end;
        continue;
      }
      if (stopAtBrace) {
        if (c === '{') depth += 1;
        else if (c === '}') {
          if (depth === 0) { pos += 1; return; }
          depth -= 1;
        }
      }
      const three = src.slice(pos, pos + 3);
      const two = src.slice(pos, pos + 2);
      if (three === '...') { tokens.push({ t: 'p', v: three, i: pos }); pos += 3; continue; }
      if (['=>', '?.', '++', '--'].includes(two)) { tokens.push({ t: 'p', v: two, i: pos }); pos += 2; continue; }
      tokens.push({ t: 'p', v: c, i: pos });
      pos += 1;
    }
    if (stopAtBrace) throw new Error('unterminated template expression');
  };
  try {
    scan(out, false);
  } catch (error) {
    // A backtick with no partner before EOF is JSX prose; rescan with it demoted (bounded).
    if (error.prose === undefined || proseBackticks.size >= 32) throw error;
    return tokenize(src, new Set([...proseBackticks, error.prose]));
  }
  return out;
}

/** Static `import`/`export … from` specifiers, from tokens (comments and strings cannot fake one). */
export function staticEdges(tokens, match) {
  const specs = [];
  const isDotted = (i) => tokens[i - 1]?.t === 'p' && (tokens[i - 1].v === '.' || tokens[i - 1].v === '?.');
  const fromSpec = (i) => {
    for (let j = i; j < tokens.length - 1; j += 1) {
      if (tokens[j].t === 'p' && tokens[j].v === ';') return null;
      if (tokens[j].t === 'id' && tokens[j].v === 'from' && tokens[j + 1].t === 's') return tokens[j + 1].v;
    }
    return null;
  };
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.t !== 'id' || isDotted(i)) continue;
    const next = tokens[i + 1];
    if (token.v === 'import') {
      if (!next || (next.t === 'p' && next.v === '(') || (next.t === 'p' && next.v === '.')) continue;
      if (next.t === 's') { specs.push(next.v); continue; }
      const spec = fromSpec(i + 1);
      if (spec !== null) specs.push(spec);
      continue;
    }
    if (token.v === 'export' && next?.t === 'p' && (next.v === '*' || next.v === '{')) {
      const after = next.v === '{' ? (match[i + 1] ?? i + 1) + 1 : i + 2;
      const spec = fromSpec(after);
      if (spec !== null) specs.push(spec);
    }
  }
  return specs;
}

/** Static and deferred ES imports, including executable template expressions. */
export function moduleImports(src) {
  const tokens = tokenize(src);
  const statics = [];
  const deferred = [];
  let computed = false;
  const scan = (stream) => {
    // Static declarations do not nest inside an expression; their braces only
    // delimit the import/export list, so no general bracket table is needed.
    const match = [];
    const stack = [];
    stream.forEach((token, i) => {
      if (token.t !== 'p') return;
      if (token.v === '{') stack.push(i);
      if (token.v === '}' && stack.length) match[stack.pop()] = i;
    });
    statics.push(...staticEdges(stream, match));
    for (let i = 0; i < stream.length; i += 1) {
      const token = stream[i];
      if (token.t === 'tpl') {
        token.exprs.forEach(scan);
        continue;
      }
      if (token.t !== 'id' || token.v !== 'import' || stream[i + 1]?.v !== '(') continue;
      if (stream[i - 1]?.t === 'p' && ['.', '?.'].includes(stream[i - 1].v)) continue;
      const arg = stream[i + 2];
      const end = stream[i + 3];
      const literal = arg?.t === 's' ? arg.v
        : arg?.t === 'tpl' && arg.exprs.length === 0 ? arg.quasis[0] : null;
      if (literal === null || end?.t !== 'p' || ![')', ','].includes(end.v)) computed = true;
      else deferred.push(literal);
    }
  };
  scan(tokens);
  return { statics, deferred, computed };
}
