/**
 * Sole owner of the strict `pm2 jlist` stdout parser (issue #8164, consolidating
 * #968, #2991, #5732).
 *
 * `pm2 jlist` always emits a JSON array (`[]` when there are no processes), so
 * an exit-0 read with empty or garbage stdout — no array literal at all — is a
 * FAILED read, not a successful "no processes." Returning `[]` there would
 * reintroduce the absent-vs-empty footgun (AGENTS.md "Sentinel + validate"):
 * a transient PM2 read failure would masquerade as a confident empty process
 * list. Detect a real array literal (tolerating ANSI/log noise before it, e.g.
 * `\x1b[2K`) before trusting the stdout, and return `null` otherwise.
 *
 * Kept dependency-free (no imports) so a package-local consumer that
 * deliberately avoids the server dependency graph — `autofixer/shared.js` — can
 * import this one leaf without dragging anything else in.
 */

/**
 * Locate and slice the JSON array literal out of raw pm2 jlist stdout.
 * Mirrors the detection `parsePm2JlistStdout` already performed to decide a
 * literal is present: '[{' (an array of objects) wins over a bare '[]' when
 * both appear, and a `[31m`-style ANSI code never matches the empty-array regex.
 *
 * @param {string} stdout
 * @returns {string} The JSON array text, or '[]' if no literal was found.
 */
function extractJsonArrayText(stdout) {
  const objectStart = stdout.indexOf('[{');
  const emptyMatch = stdout.match(/\[\](?![0-9])/);
  const start = objectStart >= 0
    ? objectStart
    : emptyMatch
      ? emptyMatch.index
      : -1;
  if (start < 0) return '[]';

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < stdout.length; index += 1) {
    const char = stdout[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '[') {
      depth += 1;
    } else if (char === ']') {
      depth -= 1;
      if (depth === 0) return stdout.slice(start, index + 1);
    }
  }
  return stdout.slice(start);
}

/**
 * Parse the stdout of a `pm2 jlist` invocation into a raw process array, or
 * `null` when the read effectively failed.
 *
 * @param {string} stdout Raw `pm2 jlist` stdout (may carry ANSI noise).
 * @returns {Array|null} The parsed process array (incl. `[]`), or `null` on failure.
 */
export function parsePm2JlistStdout(stdout) {
  const hasArrayLiteral = typeof stdout === 'string' && (stdout.includes('[{') || /\[\](?![0-9])/.test(stdout));
  if (!hasArrayLiteral) return null;

  let parsed;
  try {
    parsed = JSON.parse(extractJsonArrayText(stdout));
  } catch {
    return null;
  }
  return Array.isArray(parsed) ? parsed : null;
}
