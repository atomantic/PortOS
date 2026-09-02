/**
 * Text-level primitives shared by the whole-tree source-scan guard suites —
 * `childProcess.guards.test.js`, `timerCallbackConventions.test.js` and
 * `sockets/asyncHandlerGuard.test.js`.
 *
 * Those guards enforce structural rules no runtime test can reach ("every spawn
 * goes through the wrapper", "every await outside the request lifecycle owns its
 * rejection"), so each one reads source as text and each one needs the same
 * three things: literals and comments neutralised, so a rule *described* in
 * prose can neither satisfy nor defeat the scan and a `}` inside a string cannot
 * skew a brace walk; a bracket matcher, so a construct split across lines is
 * captured WHOLE rather than by a fixed character window (a window reads the
 * next statement and attributes it to the current one); and one definition of
 * "this await owns its rejection", so the timer rule and the socket rule cannot
 * drift apart.
 *
 * Lexer-assisted, not an AST pass: a real parser would be more precise, but
 * these guards run over ~1500 files on every `npm test`, and their false
 * positives are loud and one line to fix. The limits are listed on
 * `unguardedAwaits` and in `timerCallbackConventions.test.js`'s header.
 */

/**
 * Blank comment LINES while preserving line count, so a rule can be *described*
 * in a comment without the guard flagging the description as a violation
 * (`cosHealthMonitor.js` explains the pm2 rule using the banned pattern).
 *
 * Line-based, and so weaker than `blankLiterals` — it is the right tool only for
 * a rule matched per line, where every real hit outside the wrapper is a JSDoc
 * `@param {import('child_process').ChildProcess}` line and a false positive is
 * loud and one line to fix.
 * @param {string} src
 * @returns {string[]} one entry per input line, comment lines replaced by ''
 */
export function blankComments(src) {
  return src.split('\n').map((line) => (/^\s*(\/\/|\*|\/\*)/.test(line) ? '' : line));
}

/**
 * True when a `/` at this position opens a regex literal rather than division.
 * A regex can only follow a position where an operand cannot: an operator, an
 * opening bracket, a statement boundary, or the start of the file.
 */
function regexCanStartAfter(prev) {
  return prev === '' || '(,=:[!&|?{};+-*%~^<>'.includes(prev);
}

/**
 * Replace the contents of comments, string/template literals, and regex
 * literals with spaces, preserving LENGTH so every index still maps back to the
 * original source. Everything downstream (bracket walks, `await` matching) then
 * sees code only — and a caller that needs a literal's text (a socket event
 * name, say) can still read it out of the original string at the same offset.
 * @param {string} src
 * @returns {string} same length as `src`
 */
export function blankLiterals(src) {
  const out = src.split('');
  const n = src.length;
  const blank = (i) => { if (i < n && src[i] !== '\n') out[i] = ' '; };
  // Brace depths of the code regions opened by `${` inside template literals,
  // so a nested template resumes correctly at its closing `}`.
  const templateStack = [];
  let inTemplate = false;
  let braceDepth = 0;
  // A `/` starts a regex only where a value cannot precede it. Tracking the last
  // significant character is the standard heuristic and is what keeps a
  // character class like /["']/ from being read as a string opener.
  let prevSignificant = '';
  let i = 0;

  while (i < n) {
    const c = src[i];

    if (inTemplate) {
      if (c === '\\') { blank(i); blank(i + 1); i += 2; continue; }
      if (c === '`') { blank(i); i += 1; inTemplate = false; prevSignificant = '`'; continue; }
      if (c === '$' && src[i + 1] === '{') {
        blank(i); blank(i + 1); i += 2;
        templateStack.push(braceDepth);
        braceDepth = 0;
        inTemplate = false;
        prevSignificant = '{';
        continue;
      }
      blank(i); i += 1; continue;
    }

    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') { blank(i); i += 1; }
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { blank(i); i += 1; }
      blank(i); blank(i + 1); i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      blank(i); i += 1;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') { blank(i); i += 1; }
        blank(i); i += 1;
      }
      blank(i); i += 1;
      prevSignificant = quote;
      continue;
    }
    if (c === '`') { blank(i); i += 1; inTemplate = true; continue; }
    if (c === '/' && regexCanStartAfter(prevSignificant)) {
      blank(i); i += 1;
      let inClass = false;
      while (i < n && src[i] !== '\n') {
        if (src[i] === '\\') { blank(i); blank(i + 1); i += 2; continue; }
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '/' && !inClass) break;
        blank(i); i += 1;
      }
      blank(i); i += 1;
      // Blank the flags too so `gi` can't be read as an identifier.
      while (i < n && /[a-z]/.test(src[i])) { blank(i); i += 1; }
      prevSignificant = ')';
      continue;
    }

    if (c === '{') braceDepth += 1;
    else if (c === '}') {
      if (braceDepth === 0 && templateStack.length > 0) {
        blank(i); i += 1;
        braceDepth = templateStack.pop();
        inTemplate = true;
        continue;
      }
      braceDepth -= 1;
    }
    if (!/\s/.test(c)) prevSignificant = c;
    i += 1;
  }

  return out.join('');
}

/**
 * Index just PAST the bracket matching the `(`, `[` or `{` at `open`, or -1.
 * Assumes `src` has been through `blankLiterals`, so a bracket inside a string
 * or comment cannot unbalance the walk.
 * @param {string} src
 * @param {number} open
 * @returns {number}
 */
export function matchBracket(src, open) {
  const pairs = { '(': ')', '[': ']', '{': '}' };
  const close = pairs[src[open]];
  if (!close) return -1;
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === src[open]) depth += 1;
    else if (src[i] === close) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * Parse the function expression starting at `from` in `blanked` (already through
 * `blankLiterals`), bounded by `limit`. Handles `async`, `function`, and both
 * arrow spellings — parenthesized and bare-identifier parameters.
 *
 * The parameter list is skipped as a UNIT rather than searching for the first
 * `{`, because `async (payload = {}) => {` — the shape half of `sockets/voice.js`
 * uses — puts an object literal in a default value before the body ever opens.
 *
 * A concise arrow body (`async () => save()`) has no braces; everything up to
 * `limit` is taken as the body, so an `await` in it is still seen.
 * @param {string} blanked
 * @param {number} from
 * @param {number} limit - exclusive upper bound (the enclosing call's `)`)
 * @returns {{isAsync: boolean, start: number, text: string}|null} null when the
 *   argument is not a function expression (an identifier reference, say)
 */
export function parseCallbackAt(blanked, from, limit) {
  let i = from;
  const skipSpace = () => { while (i < limit && /\s/.test(blanked[i])) i += 1; };
  skipSpace();

  const isAsync = /^async[\s(]/.test(blanked.slice(i, limit));
  if (isAsync) { i += 'async'.length; skipSpace(); }

  if (blanked.startsWith('function', i)) {
    i += 'function'.length;
    skipSpace();
    // Optional name.
    while (i < limit && /[\w$]/.test(blanked[i])) i += 1;
    skipSpace();
    // Parameter list. Only the `function` spelling reaches this — an arrow's
    // params are consumed below, and skipping a second `(` after its `=>` would
    // step straight over a parenthesized concise body (`async () => (await f())`),
    // hiding every await in it.
    if (blanked[i] === '(') i = matchBracket(blanked, i);
    if (i === -1) return null;
    skipSpace();
  } else {
    // Arrow: parenthesized params, or a single bare identifier.
    if (blanked[i] === '(') i = matchBracket(blanked, i);
    else while (i < limit && /[\w$]/.test(blanked[i])) i += 1;
    if (i === -1) return null;
    skipSpace();
    if (!blanked.startsWith('=>', i)) return null;
    i += 2;
    skipSpace();
  }

  if (blanked[i] === '{') {
    const end = matchBracket(blanked, i);
    if (end === -1) return null;
    return { isAsync, start: i, text: blanked.slice(i, end) };
  }
  return { isAsync, start: i, text: blanked.slice(i, limit) };
}

/**
 * `[start, end)` spans of every `try { … }` block in `body` that actually has a
 * `catch` clause. A `try … finally` with no `catch` runs its cleanup and then
 * re-throws, so it does NOT own the rejection — counting it would let the exact
 * bug these guards exist for through.
 */
function tryBlockSpans(body) {
  const spans = [];
  for (const match of body.matchAll(/\btry\s*\{/g)) {
    const open = body.indexOf('{', match.index);
    const end = matchBracket(body, open);
    // Comments between `}` and `catch` are already blanked to spaces.
    if (end !== -1 && /^\s*catch\b/.test(body.slice(end))) spans.push([open, end]);
  }
  return spans;
}

/**
 * The member/call chain awaited at `start` — e.g. for
 * `await pm2.restart(name)\n  .catch(err => …)` it returns the whole thing,
 * newline continuation included, so a trailing `.catch(` is visible.
 */
function awaitedChain(body, start) {
  let i = start;
  while (i < body.length && /\s/.test(body[i])) i += 1;
  const begin = i;
  while (i < body.length) {
    const c = body[i];
    if (/[\w$.?]/.test(c)) { i += 1; continue; }
    if (c === '(' || c === '[') {
      const end = matchBracket(body, i);
      if (end === -1) break;
      i = end;
      continue;
    }
    if (/\s/.test(c)) {
      // Only a `.` continuation may follow whitespace; anything else ends the chain.
      let j = i;
      while (j < body.length && /\s/.test(body[j])) j += 1;
      if (body[j] === '.') { i = j; continue; }
      break;
    }
    break;
  }
  return body.slice(begin, i);
}

/**
 * True when the LAST link of an awaited chain is `.catch(…)`. It has to be the
 * last one: `await work().catch(recover).then(rethrow)` handles a rejection from
 * `work()` and then hands the awaited promise straight back to `then`, so the
 * chain as a whole can still reject.
 */
function chainEndsInCatch(chain) {
  const at = chain.lastIndexOf('.catch');
  if (at === -1) return false;
  let i = at + '.catch'.length;
  while (i < chain.length && /\s/.test(chain[i])) i += 1;
  if (chain[i] !== '(') return false;
  const end = matchBracket(chain, i);
  return end !== -1 && chain.slice(end).trim() === '';
}

/**
 * Awaits in `body` (already through `blankLiterals`) that neither sit inside a
 * `try`/`catch` nor end in `.catch(…)`. Returns the offending chain text for
 * each, so a failure message points at the expression rather than at a line
 * number that rebases away.
 *
 * Deliberately lexical rather than scope-aware: an `await` inside a nested
 * `async` callback declared within the body is attributed to the body. That
 * errs toward flagging — a fire-and-forget inner async callback has the same
 * ownerless-rejection problem — but it means the fix may belong on the inner
 * function. An await guarded by a helper the body calls, rather than by its own
 * `try`, also reads as unguarded.
 * @param {string} body
 * @returns {string[]}
 */
export function unguardedAwaits(body) {
  const spans = tryBlockSpans(body);
  const offenders = [];
  for (const match of body.matchAll(/\bawait\b/g)) {
    if (spans.some(([from, to]) => match.index > from && match.index < to)) continue;
    const chain = awaitedChain(body, match.index + match[0].length);
    if (chainEndsInCatch(chain)) continue;
    offenders.push(`await ${chain.replace(/\s+/g, ' ').trim()}`);
  }
  return offenders;
}
