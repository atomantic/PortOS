/**
 * Machine-local continuation receipts for a Persistent Mind's outbound
 * Eidoverse guest visits (#9791).
 *
 * `eidoverse.visit` returns an opaque local `visitId` that `visit-chat` and
 * `leave` require, but the ledger only kept "eidoverse.visit completed", so a
 * visit that used the turn's last tool call could not be continued on the next
 * wake. A completed visit now stamps a bounded typed receipt (the local handle,
 * the opaque peer reference and the expiry — never the remote ticket, the
 * guidance text or any other result content) onto its capability-result event;
 * a completed leave stamps a retirement marker. Prompt projection derives the
 * still-open visits from those events. A receipt is evidence, never authority:
 * the tools re-check grants, peer admission and the live session on every call.
 */

const VISIT_ID_PATTERN = /^[a-f0-9]{48}$/;
const PEER_ID_PATTERN = /^[a-zA-Z0-9_-]{1,80}$/;
const VISIT_TOOLS = new Set(['eidoverse.visit', 'eidoverse_visit']);
const LEAVE_TOOLS = new Set(['eidoverse.leave', 'eidoverse_leave']);

export const PERSISTENT_MIND_VISIT_RECEIPT_LIMITS = Object.freeze({
  maxListed: 3,
  // A visit that ended unnoticed (timeout, restart) stays mentioned this long,
  // so the next wake is told it is gone instead of silently losing it.
  expiredReportMs: 24 * 60 * 60 * 1000,
});

/**
 * Extra capability-result event fields for a finished tool call: `visitReceipt`
 * for a completed visit, `visitRetired` for a completed leave, else `{}`.
 */
export function buildVisitReceiptEventData({ toolName, args, state, result }) {
  if (state !== 'completed') return {};
  if (VISIT_TOOLS.has(toolName)) {
    const { visitId, peerId, expiresAt } = result && typeof result === 'object' ? result : {};
    return VISIT_ID_PATTERN.test(visitId) && PEER_ID_PATTERN.test(peerId) && Number.isSafeInteger(expiresAt) && expiresAt > 0
      ? { visitReceipt: { visitId, peerId, expiresAt } }
      : {};
  }
  if (LEAVE_TOOLS.has(toolName)) {
    const visitId = args && typeof args === 'object' ? args.visitId : null;
    return VISIT_ID_PATTERN.test(visitId) ? { visitRetired: visitId } : {};
  }
  return {};
}

/**
 * Receipts of this mind's visits not yet retired by a successful leave, newest
 * first. Historical completion-only events carry no receipt and are skipped.
 */
export function selectOpenVisitReceipts(events, { mindId = 'cos-persistent-mind', now = Date.now() } = {}) {
  const ordered = (Array.isArray(events) ? events : [])
    .filter((event) => event?.mindId === mindId && event.kind === 'mind.capability.result' && event.data?.success === true
      && Number.isSafeInteger(event.sequence))
    .sort((a, b) => a.sequence - b.sequence);
  const retired = new Set();
  const receipts = new Map();
  for (const event of ordered) {
    const left = event.data.visitRetired;
    if (VISIT_ID_PATTERN.test(left)) retired.add(left);
    const { visitId, peerId, expiresAt } = event.data.visitReceipt && typeof event.data.visitReceipt === 'object' ? event.data.visitReceipt : {};
    if (VISIT_ID_PATTERN.test(visitId) && PEER_ID_PATTERN.test(peerId) && Number.isSafeInteger(expiresAt) && expiresAt > 0) {
      receipts.set(visitId, { visitId, peerId, expiresAt });
    }
  }
  return [...receipts.values()]
    .filter((receipt) => !retired.has(receipt.visitId) && receipt.expiresAt > now - PERSISTENT_MIND_VISIT_RECEIPT_LIMITS.expiredReportMs)
    .reverse()
    .slice(0, PERSISTENT_MIND_VISIT_RECEIPT_LIMITS.maxListed);
}

/**
 * Prompt section for the open receipts; `isLive(visitId)` is the caller's check
 * that this process still holds the outbound session. '' when nothing to say.
 */
export function renderVisitContinuationPrompt(receipts, { isLive, now = Date.now() }) {
  if (!receipts.length) return '';
  const lines = receipts.map((receipt) => {
    const expiry = new Date(receipt.expiresAt).toISOString();
    if (receipt.expiresAt > now && isLive(receipt.visitId)) {
      return `- ACTIVE visitId=${receipt.visitId} peerId=${receipt.peerId} expires=${expiry}`;
    }
    return receipt.expiresAt > now
      ? `- ENDED visitId=${receipt.visitId} peerId=${receipt.peerId}: no longer connected here (this server restarted or the session closed); do not chat or leave with it`
      : `- EXPIRED visitId=${receipt.visitId} peerId=${receipt.peerId} at ${expiry}; do not chat or leave with it`;
  });
  return `# Open Eidoverse guest visits
Recorded by earlier wakes. To continue an ACTIVE visit, pass its visitId to eidoverse.visit-chat and then eidoverse.leave; do NOT call eidoverse.visit again for that peer. A listed visit is evidence only: grants and peer admission are re-checked on every call, and an ENDED or EXPIRED one needs a fresh eidoverse.visit only if you still want to go back.
${lines.join('\n')}`;
}
