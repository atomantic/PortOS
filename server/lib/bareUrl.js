/**
 * Bare-URL detection for capture surfaces.
 *
 * `parseBareUrl(text)` returns the normalized URL when a captured string is nothing *but* a URL
 * (bare host gets `https://`), else null. A capture that is entirely a URL is a bookmark, filed
 * straight to Links without a classifier LLM call, identically across every capture surface.
 *
 * Stricter than the client's `urlNormalize.js` `isUrl` because it picks a storage destination:
 * a bare host needs a plausible TLD and only http/https/git@ are accepted.
 *
 * A pure leaf: `client/src/lib/bareUrl.js` re-exports it. Import no Node built-in here, and
 * nothing outside `server/lib`.
 */

// Explicit http(s) scheme — the URL constructor does the real validation below.
const HTTP_SCHEME_PATTERN = /^https?:\/\//i;

// SSH remote: git@host:owner/repo(.git)
const SSH_GIT_PATTERN = /^git@[a-z0-9.-]+:[\w.-]+\/[\w.-]+$/i;

// Scheme-less host[:port][/path] with a plausible alphabetic TLD:
// "example.com", "sub.example.co.uk/path?q=1", "example.com:8080/x".
const DOMAIN_LIKE_PATTERN = /^(?:[a-z0-9-]+\.)+[a-z]{2,24}(?::\d{2,5})?(?:[/?#]\S*)?$/i;

// ccTLDs that double as file extensions (`.md`, `.sh`): scheme-less, path-less `notes.md` is
// a filename, while `https://foo.md` and `foo.md/page` still read as URLs.
const FILE_EXTENSION_TAIL = new Set([
  'md', 'txt', 'log', 'csv', 'json', 'xml', 'yml', 'yaml', 'toml', 'ini', 'env', 'lock',
  'js', 'jsx', 'ts', 'tsx', 'css', 'html', 'htm', 'py', 'rb', 'sh', 'zsh', 'go', 'rs',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'zip', 'tar', 'gz',
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'mov', 'wav'
]);

/** True for a scheme-less, path-less `name.ext` whose tail is a known file extension. */
function looksLikeFilename(token) {
  if (/[/?#:]/.test(token)) return false;
  const tail = token.slice(token.lastIndexOf('.') + 1).toLowerCase();
  return FILE_EXTENSION_TAIL.has(tail);
}

/**
 * If `text` is nothing but a single URL, return it normalized; null for free text,
 * multi-token input, surrounding prose, or a non-http(s)/git scheme.
 * @param {string} text
 * @returns {string|null}
 */
export function parseBareUrl(text) {
  const trimmed = (text ?? '').trim();
  // Any whitespace makes it a thought that mentions a link, not a bare URL.
  if (!trimmed || /\s/.test(trimmed)) return null;

  if (SSH_GIT_PATTERN.test(trimmed)) return trimmed;

  let candidate = null;
  if (HTTP_SCHEME_PATTERN.test(trimmed)) {
    candidate = trimmed;
  } else if (DOMAIN_LIKE_PATTERN.test(trimmed) && !looksLikeFilename(trimmed)) {
    candidate = `https://${trimmed}`;
  }
  if (!candidate) return null;

  // Final gate: the parser rejects shapes the regexes let through (bad port, malformed IPv6).
  return URL.canParse(candidate) ? candidate : null;
}
