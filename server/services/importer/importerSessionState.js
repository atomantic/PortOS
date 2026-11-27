/** Checks stored importer progress against the issues that currently exist in the series. */

import { listIssuesForSeries } from '../pipeline/issues.js';
import { getImportSession, SESSION_STATUS } from '../importerSessions.js';

/**
 * The recorded progress of this manuscript's import into this series (#9943),
 * or null when there is none worth honoring. A `committed` session only counts
 * while at least one issue it created still exists: a user who deleted the
 * imported issues and re-imports the same text is starting over, and treating
 * that as a replay would silently create nothing.
 *
 * An unfinished session with an issue plan (#10762) is checked against the
 * series: when every planned issue exists, the import finished and only its
 * receipt was lost, so it reads as `committed` with `receiptPending` set.
 * Otherwise `liveIssueIds` names the planned issues that already exist.
 */
export async function resolveImportSession(importId, seriesId) {
  const session = await getImportSession(importId);
  if (!session || session.seriesId !== seriesId) return null;
  if (session.status === SESSION_STATUS.ARC_PERSISTED && !session.plan) return session;
  const live = new Set((await listIssuesForSeries(seriesId, { withHistory: false })).map((issue) => issue.id));
  if (session.status === SESSION_STATUS.COMMITTED) {
    return session.createdIssueIds.some((id) => live.has(id)) ? session : null;
  }
  const planIds = session.plan.items.map((item) => item.issueId);
  if (planIds.every((id) => live.has(id))) {
    return {
      ...session,
      status: SESSION_STATUS.COMMITTED,
      createdIssueIds: planIds,
      remappedIssues: session.plan.remappedIssues,
      receiptPending: true,
    };
  }
  return { ...session, liveIssueIds: planIds.filter((id) => live.has(id)) };
}
