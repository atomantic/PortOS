// Safe one-line reason for a browser-fidelity refusal. The refusal decision never
// depends on this text; it only names what failed without leaking secrets or
// machine-identifying paths into terminal output that may be pasted into issues.
const MAX_REASON = 200;
const REDACTIONS = [
  [/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{8,}/g, '<token>'],
  [/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 <token>'],
  [/\b([\w.-]*(?:token|secret|password|passwd|api[_-]?key|auth|cookie|credential)[\w.-]*)\s*[=:]\s*\S+/gi, '$1=<redacted>'],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<email>'],
  [/\b[A-Za-z0-9+/_-]{32,}={0,2}/g, '<redacted>'],
  [/[A-Za-z]:\\[^\s'"]+/g, '<path>'],
  [/(?<![\w.:])\/(?:[^\s'"/]+\/)+[^\s'"/]*/g, '<path>'],
];

export function safeFailureReason(error) {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  let text = raw.replace(/[^\x20-\x7E]/g, ' ');
  for (const [pattern, replacement] of REDACTIONS) text = text.replace(pattern, replacement);
  text = text.replace(/\s+/g, ' ').trim().slice(0, MAX_REASON);
  const kind = error instanceof Error && error.name && error.name !== 'Error' ? `${error.name}: ` : '';
  return text ? `${kind}${text}` : '';
}
