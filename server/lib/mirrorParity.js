/**
 * Shared source-comparison helpers for server↔client "mirror" parity tests.
 *
 * Several client modules are byte-for-byte mirrors of an authoritative server
 * module (see the "server mirrors" section of client/src/lib/README.md). Each
 * mirror is pinned by a `<name>.mirror.test.js` that extracts the mirrored
 * declarations from both files and diffs them with comments stripped, so
 * per-side commentary can diverge but logic cannot.
 *
 * Every such test needs the same two primitives, and hand-rolling them per
 * mirror means a bug in the brace-walker has to be found and fixed once per
 * copy — copies that had already drifted (one handled `async function`, the
 * other counted brackets) before this was extracted.
 *
 * Deliberately pure — no `vitest` import — so the server/lib barrel does not
 * pull a test framework into production. Callers own the assertions.
 */

/**
 * Strip single-line (`//`) and block (`/* … *\/`) comments, then collapse all
 * whitespace runs to a single space.
 *
 * This is what lets the two sides carry different commentary — only code
 * survives the normalization.
 */
export function stripCommentsAndNormalize(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract a top-level declaration by name — `function` / `async function` /
 * `const` (including `Object.freeze(…)` and array/object literal bodies).
 *
 * Walks from the declaration to the first opening delimiter and returns the
 * slice through its match, tracking `{}`, `()` and `[]` together. Returns the
 * declaration text, or `null` when the name is absent.
 */
export function extractDeclaration(src, name) {
  const startRe = new RegExp(`(?:export\\s+)?(?:async\\s+function|function|const)\\s+${name}[\\s=(]`);
  const match = startRe.exec(src);
  if (!match) return null;

  const start = match.index;
  let depth = 0;
  let foundOpen = false;

  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{' || ch === '(' || ch === '[') {
      depth++;
      foundOpen = true;
    } else if (ch === '}' || ch === ')' || ch === ']') {
      depth--;
      if (foundOpen && depth === 0) return src.slice(start, i + 1);
    }
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
