// Gmail thread identity shared by live Gmail sync and the Takeout mbox importer
// (#15320). Live sync stores `threadId` as a hash of the Gmail API thread id;
// the importer derives the same key from Takeout's `X-GM-THRID` so it can find
// the row live sync wrote for an email before #15308.
import { createHash } from 'crypto';

const MAX_UINT64 = (1n << 64n) - 1n;

// The `threadId` live Gmail sync stores for a message, from its API thread id.
export function gmailConversationThreadKey(apiThreadId) {
  const id = String(apiThreadId || '');
  return id ? `conv-${createHash('md5').update(id).digest('hex').slice(0, 12)}` : null;
}

// Gmail API thread ids are the lowercase hex form of the decimal 64-bit
// `X-GM-THRID` that IMAP and Takeout expose. BigInt keeps the full 64 bits
// (Number loses precision past 2^53). Anything that is not a decimal uint64
// yields null, so a malformed header matches nothing.
export function gmailApiThreadIdFromThrid(xGmThrid) {
  const value = String(xGmThrid ?? '').trim();
  if (!/^\d{1,20}$/.test(value)) return null;
  const n = BigInt(value);
  return n > 0n && n <= MAX_UINT64 ? n.toString(16) : null;
}
