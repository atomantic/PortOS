// Safe one-line reason for a browser-fidelity refusal. The refusal decision never
// depends on this text; it only names what failed without leaking secrets or
// machine-identifying paths into terminal output that may be pasted into issues.
const MAX_REASON = 200;
// Only built-in error classes are named; a custom name is untrusted text.
const KNOWN_ERROR_NAMES = new Set(['TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'AbortError', 'TimeoutError']);
const REDACTIONS = [
  [/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{8,}/g, '<token>'],
  [/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 <token>'],
  [/\b([\w.-]*(?:token|secret|password|passwd|api[_-]?key|auth|cookie|credential)[\w.-]*)\s*[=:]\s*(?:"[^"]*"|'[^']*'|\S+)/gi, '$1=<redacted>'],
  [/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '<ip>'],
  [/\b(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}\b/gi, '<ip>'],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<email>'],
  [/\b[A-Za-z0-9+/_-]{32,}={0,2}/g, '<redacted>'],
  [/[A-Za-z]:\\[^\s'"]+/g, '<path>'],
  [/(?<![\w.:])\/(?:[^\s'"/]+\/)+[^\s'"/]*/g, '<path>'],
];

export function safeFailureReason(error) {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  let text = raw.replace(/[^\x20-\x7E]/g, ' ');
  for (const [pattern, replacement] of REDACTIONS) text = text.replace(pattern, replacement);
  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const kind = error instanceof Error && KNOWN_ERROR_NAMES.has(error.name) ? `${error.name}: ` : '';
  return `${kind}${text}`.slice(0, MAX_REASON);
}
