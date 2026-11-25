const ACTIONABLE_SOURCES = ['outlook', 'gmail'];
const MAIL_ACTIONS = ['archive', 'delete'];

export function supportedMessageActions(message, account) {
  return account?.actions ?? (ACTIONABLE_SOURCES.includes(account?.type ?? message.source) ? MAIL_ACTIONS : []);
}
