// Normalize recipient addresses using the browser message delivery format.

const EMAIL_RE = /^[^\s<>@,;"]+@[^\s<>@,;"]+\.[^\s<>@,;"]+$/;

/** `Alice <alice@example.com>` / `alice@example.com` → lowercase address, else null. */
export function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const angle = value.match(/<([^<>]+)>\s*$/);
  const candidate = (angle ? angle[1] : value).trim().toLowerCase();
  return EMAIL_RE.test(candidate) ? candidate : null;
}
