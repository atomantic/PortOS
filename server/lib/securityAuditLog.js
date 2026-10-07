/**
 * One-line audit trail for security-relevant events — who/what/where, no secrets.
 *
 * PortOS holds host-control authority, so a sign-in, a password change, a
 * revoked session, or a refused host-control call must leave a line an operator
 * can find later in `pm2 logs`. Refusals go to `console.warn` (a deliberate
 * refusal); successes stay on `console.log`.
 *
 * Field values are flattened to one line and truncated: a request path, Host
 * header, or label is caller-controlled, and an embedded newline would forge a
 * second log line.
 */

const MAX_VALUE_LENGTH = 120;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

const formatValue = (value) => {
  const flat = String(value).replace(CONTROL_CHARS, ' ').trim();
  const clipped = flat.length > MAX_VALUE_LENGTH ? `${flat.slice(0, MAX_VALUE_LENGTH)}…` : flat;
  return /[\s="]/.test(clipped) ? JSON.stringify(clipped) : clipped;
};

/**
 * @param {string} event - Dotted event name, e.g. `login.failed`
 * @param {{ refused?: boolean } & Record<string, unknown>} [fields] - `refused: true`
 *   logs through `console.warn`; null/undefined fields are omitted.
 * @returns {string} the emitted line (handy for assertions)
 */
export function logSecurityEvent(event, { refused = false, ...fields } = {}) {
  const detail = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${formatValue(value)}`)
    .join(' ');
  const line = `${refused ? '⛔' : '🔐'} Security [${event}]${detail ? ` ${detail}` : ''}`;
  (refused ? console.warn : console.log)(line);
  return line;
}
