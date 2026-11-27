// Defines how email replies keep the provider's conversation subject.

const normalizeReplySubject = subject => String(subject || '').replace(/^(?:\s*re:\s*)+/i, '').trim();

export const unfoldEmailHeader = value => value.replace(/\r?\n[ \t]+/g, ' ').trim();

export function matchesReplySubject(draftSubject, originalSubject) {
  return !draftSubject || normalizeReplySubject(draftSubject) === normalizeReplySubject(originalSubject);
}

export const REPLY_SUBJECT_MISMATCH_MESSAGE = 'A reply must keep the original conversation subject. Restore the original subject or send a new email.';
