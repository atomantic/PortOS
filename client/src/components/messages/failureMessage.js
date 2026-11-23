/**
 * failureMessage(action, err, hint?) — toast text for a failed `{ silent: true }` request: the
 * plain-language action, the server's own reason when it sent one, then a recovery hint.
 */
export const failureMessage = (action, err, hint = 'Check the connection and try again.') =>
  `${action}${err?.message ? `: ${err.message}` : '.'} ${hint}`;
