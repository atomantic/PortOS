// Mail provider diagnostics can contain subjects, addresses, bodies and credentials.
// Never include free text, stacks or arbitrary provider codes in operational logs.
const SAFE_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT',
  'ABORT_ERR', 'SEND_FAILED', 'GMAIL_SEND_FAILED', 'GMAIL_NOT_CONFIGURED'
]);

export function messageLogError(error) {
  const code = SAFE_CODES.has(error?.code) ? error.code : 'MAIL_OPERATION_FAILED';
  const status = error?.response?.status ?? error?.status;
  return Number.isInteger(status) && status >= 400 && status <= 599
    ? `${code} HTTP ${status}`
    : code;
}
