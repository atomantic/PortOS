/**
 * Shared source-comparison helpers for server↔client "mirror" parity tests: each `<name>.mirror.test.js` extracts
 * the mirrored declarations from both files and diffs them with comments stripped.
 *
 * Use only when the two sides cannot be one pure `server/lib` leaf (see "One pure module, one definition" in
 * client/src/lib/README.md). Pure, no `vitest` import; callers own the assertions.
 */

/** Strip `//` and block comments, then collapse whitespace runs, so only code is compared. */
export function stripCommentsAndNormalize(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Index of the delimiter matching the opener at `openIdx`, or -1 if unbalanced.
 * Counts `{}`, `()` and `[]` together — good enough for the declarations we
 * mirror, and the parity diff is textual anyway.
 */
function matchDelimiter(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    else if (ch === '}' || ch === ')' || ch === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Extract a top-level declaration by name — `function` / `async function` /
 * `const` (regex literal, array/object initializer, `Object.freeze(…)`, arrow
 * function). Returns the declaration text, or `null` when the name is absent
 * or its source is unbalanced.
 *
 * A function is walked to the matching brace of its BODY and a const to its terminating `;`: walking to
 * the first return to depth 0 would stop at the parameter list's `)` (letting a gutted body pass) or at a
 * regex's non-capturing group.
 */
export function extractDeclaration(src, name) {
  const startRe = new RegExp(`(?:export\\s+)?(?:async\\s+function|function|const)\\s+${name}[\\s=(]`);
  const match = startRe.exec(src);
  if (!match) return null;

  const start = match.index;

  if (/(?:async\s+)?function\s/.test(match[0])) {
    // Skip the parameter list, then return through the body's matching brace.
    const parenOpen = src.indexOf('(', start);
    if (parenOpen === -1) return null;
    const parenClose = matchDelimiter(src, parenOpen);
    if (parenClose === -1) return null;
    const braceOpen = src.indexOf('{', parenClose);
    if (braceOpen === -1) return null;
    const braceClose = matchDelimiter(src, braceOpen);
    return braceClose === -1 ? null : src.slice(start, braceClose + 1);
  }

  // Caveat: a `;` inside a top-level string/regex literal ends the slice early; every mirrored
  // `const` must be semicolon-terminated.
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    else if (ch === '}' || ch === ')' || ch === ']') depth--;
    else if (ch === ';' && depth === 0) return src.slice(start, i + 1);
  }
  return null;
}

/**
 * Compare one named declaration across two sources.
 *
 * Returns `{ serverDecl, clientDecl, serverNorm, clientNorm, match }` —
 * `*Decl` are null when absent, so a caller can tell "missing" apart from
 * "present but diverged" and assert each with its own message.
 */
export function compareDeclaration(serverSrc, clientSrc, name) {
  const serverDecl = extractDeclaration(serverSrc, name);
  const clientDecl = extractDeclaration(clientSrc, name);
  const serverNorm = serverDecl == null ? null : stripCommentsAndNormalize(serverDecl);
  const clientNorm = clientDecl == null ? null : stripCommentsAndNormalize(clientDecl);
  return {
    serverDecl,
    clientDecl,
    serverNorm,
    clientNorm,
    match: serverNorm != null && serverNorm === clientNorm,
  };
}
