/**
 * Token-stream helpers shared by the test memo's evaluator, scope analysis
 * and per-file extraction: bracket matching, expression and list extents,
 * binding patterns and enclosing-opener lookup. Pure.
 */

import { tokenize } from '../sourceTokens.js';
import { BEFORE_GROUPING, OPERAND_KEYWORDS } from './constants.js';

/** The tokens of one module, JSX-aware unless it is TypeScript; throws on unparseable source. */
export const tokenizeModule = (src, fileRel) => tokenize(src, new Set(), { jsx: !/\.[cm]?ts$/.test(fileRel) });

export const OPENERS = { '(': ')', '[': ']', '{': '}' };

/** Matching bracket indexes; an unmatched closer is ignored, an unmatched opener stays undefined. */
export function matchBrackets(tokens) {
  const match = new Array(tokens.length);
  const stack = [];
  tokens.forEach((token, index) => {
    if (token.t !== 'p') return;
    if (OPENERS[token.v]) { stack.push(index); return; }
    if (token.v === ')' || token.v === ']' || token.v === '}') {
      for (let depth = stack.length - 1; depth >= 0; depth -= 1) {
        if (OPENERS[tokens[stack[depth]].v] !== token.v) continue;
        const open = stack[depth];
        stack.length = depth;
        match[open] = index;
        match[index] = open;
        return;
      }
    }
  });
  return match;
}

export const isPunct = (token, ...values) => token?.t === 'p' && values.includes(token.v);
export const isWord = (token, ...values) => token?.t === 'id' && values.includes(token.v);

/** True when the `(` at `open` only groups an expression. */
export const groupsAt = (tokens, open) => {
  const before = tokens[open - 1];
  return isPunct(tokens[open], '(') && !isPunct(before, ')', ']') && before?.t !== 'tpl' && (before?.t !== 'id' || BEFORE_GROUPING.has(before.v));
};

/**
 * True when the tokens from `index` assign: `=`, or a compound operator and
 * `=` (`+=`, `||=`). `==` does not; `<=` is read as one, which only costs a
 * resolution.
 */
export function assignsAt(tokens, index) {
  let at = index;
  while (at < index + 3 && isPunct(tokens[at], '+', '-', '*', '/', '%', '|', '&', '?', '^', '<', '>')) at += 1;
  return isPunct(tokens[at], '=') && !isPunct(tokens[at + 1], '=');
}

/** Every token array of a file with its bracket matches: the top level and each template hole, recursively. */
export function tokenArrays(tokens, match, out = []) {
  out.push({ arr: tokens, m: match });
  for (const token of tokens) if (token.t === 'tpl') for (const inner of token.exprs) tokenArrays(inner, matchBrackets(inner), out);
  return out;
}

/**
 * Index of the token that ends the expression starting at `start`: a
 * top-level `,` `;` or closer, or the first token of the next statement where
 * the semicolon was left out (an operand directly after a complete operand).
 */
export function expressionEnd(tokens, match, start) {
  let bodies = 0; // `function` and `class` expressions whose `{…}` body is still to come
  for (let i = start; i < tokens.length; i += 1) {
    const token = tokens[i];
    const prev = tokens[i - 1];
    const complete = i > start && (prev.t === 'p' ? [')', ']', '}'].includes(prev.v) : !(prev.t === 'id' && OPERAND_KEYWORDS.has(prev.v)));
    if (token.t === 'p') {
      if (OPENERS[token.v]) {
        // `a {` is no expression: a block after a complete operand starts the next statement, unless
        // it is the body of a function or class expression. `a (` and `a [` continue, as they do in JavaScript.
        if (token.v === '{' && complete) {
          if (bodies === 0) return i;
          bodies -= 1;
        }
        if (match[i] === undefined) return tokens.length;
        i = match[i];
      } else if ([',', ';', ')', ']', '}'].includes(token.v)) return i;
      continue;
    }
    if (isWord(token, 'function', 'class')) bodies += 1;
    // A template after an operand is a tagged template, not a new statement.
    if (i === start || token.t === 'tpl' || isWord(token, 'in', 'of', 'instanceof', 'as', 'extends')) continue;
    if (complete) return i;
  }
  return tokens.length;
}

/** Top-level comma-separated `[from, to)` ranges between an opener and its closer; a trailing comma adds none. */
export function listRanges(tokens, match, open) {
  const close = match[open];
  const ranges = [];
  let from = open + 1;
  for (let i = open + 1; i <= close; i += 1) {
    const token = tokens[i];
    if (i < close && token.t === 'p' && OPENERS[token.v] && match[i] !== undefined) { i = match[i]; continue; }
    if (i === close || isPunct(token, ',')) {
      if (from < i || i < close) ranges.push([from, i]);
      from = i + 1;
    }
  }
  return ranges;
}

/**
 * The identifier tokens a parameter list or destructuring pattern binds.
 * Property keys and default values are not bindings: counting one would hide
 * a module-level path constant of that name inside the function.
 */
export function boundNames(tokens, match, from, to, out = []) {
  let i = from;
  while (i < to) {
    let at = i;
    let end = at;
    while (end < to && !isPunct(tokens[end], ',')) end = isPunct(tokens[end], '(', '[', '{') && match[end] !== undefined ? match[end] + 1 : end + 1;
    if (isPunct(tokens[at], '...')) at += 1;
    // `key: target`: the target is what is bound.
    if ((tokens[at]?.t === 'id' || tokens[at]?.t === 's') && isPunct(tokens[at + 1], ':')) at += 2;
    else if (isPunct(tokens[at], '[') && match[at] !== undefined && isPunct(tokens[match[at] + 1], ':')) at = match[at] + 2;
    if (isPunct(tokens[at], '{', '[') && match[at] !== undefined && match[at] < end) boundNames(tokens, match, at + 1, match[at], out);
    else if (tokens[at]?.t === 'id' && at < end) out.push(tokens[at]);
    i = end + 1;
  }
  return out;
}

export function calleeStart(tokens, open) {
  let start = open;
  while (tokens[start - 1]?.t === 'id') {
    start -= 1;
    if (tokens[start - 1]?.t === 'p' && (tokens[start - 1].v === '.' || tokens[start - 1].v === '?.') && tokens[start - 2]?.t === 'id') start -= 1;
    else break;
  }
  if (tokens[start - 1]?.t === 'id' && tokens[start - 1].v === 'new') start -= 1;
  return start;
}

export const calleeName = (tokens, open) => (tokens[open - 1]?.t === 'id' ? tokens[open - 1].v : null);

/** The nearest enclosing opener whose partner lies beyond `index`, or null. */
export function enclosingOpen(tokens, match, index) {
  let depth = 0;
  for (let i = index - 1; i >= 0; i -= 1) {
    const token = tokens[i];
    if (token.t !== 'p') continue;
    if (token.v === ')' || token.v === ']' || token.v === '}') {
      if (match[i] !== undefined) { i = match[i]; continue; }
      depth += 1;
      continue;
    }
    if (OPENERS[token.v]) {
      if (depth > 0) { depth -= 1; continue; }
      return match[i] !== undefined && match[i] > index ? i : null;
    }
  }
  return null;
}
