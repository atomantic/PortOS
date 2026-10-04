// One table for what each message-account type can deliver and over which
// transport. Account capability, draft `sendVia`, the sender's mismatch guard and
// the privacy email lanes all read this, so "Outlook can send" is declared once.
//
// `email` marks accounts that can deliver to an arbitrary email address. A Teams
// chat reaches a person, not a mailbox, so it is sendable but never an email lane.
export const MESSAGE_ACCOUNT_TRANSPORT = Object.freeze({
  gmail: Object.freeze({ sendVia: 'api', email: true }),
  outlook: Object.freeze({ sendVia: 'playwright', email: true }),
  teams: Object.freeze({ sendVia: 'playwright', email: false })
});

export function sendViaForAccountType(type) {
  return MESSAGE_ACCOUNT_TRANSPORT[type]?.sendVia ?? null;
}

export function accountTypeCanSend(type) {
  return sendViaForAccountType(type) !== null;
}

/**
 * The account an email-shaped workflow (privacy opt-out / update requests) should
 * draft from: enabled, able to send, and able to reach an email address. A
 * provider API transport is preferred over browser automation because it returns
 * a definite result; otherwise the first match in the caller's order wins.
 * Accounts arrive from `listAccounts()` (derived `canSend`), which stays the
 * gate: an account without `canSend: true` is never picked.
 */
export function pickEmailSenderAccount(accounts = []) {
  const eligible = accounts.filter(account =>
    account.enabled !== false && account.canSend === true && MESSAGE_ACCOUNT_TRANSPORT[account.type]?.email === true);
  return eligible.find(account => sendViaForAccountType(account.type) === 'api') ?? eligible[0] ?? null;
}
