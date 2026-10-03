/** Prompt section that lets a wake resume a still-open outbound Eidoverse visit (#9791). */
import { readPersistentMindHistory } from './agentRunEventLog.js';
import { isEidoverseVisitLive } from './eidoverseTravel.js';
import { selectOpenVisitReceipts, renderVisitContinuationPrompt } from '../lib/persistentMindVisitReceipts.js';
import { PERSISTENT_MIND_ID } from '../lib/persistentMindTrajectory.js';

/** '' unless the visit grant is on and a recorded visit is still worth mentioning. */
export async function readPersistentMindVisitContinuationPrompt({ capabilities, mindId = PERSISTENT_MIND_ID, now = Date.now() } = {}) {
  if (capabilities?.visitEidoversePeers !== true) return '';
  const receipts = selectOpenVisitReceipts(await readPersistentMindHistory(mindId), { mindId, now });
  return renderVisitContinuationPrompt(receipts, { isLive: isEidoverseVisitLive, now });
}
