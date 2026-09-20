/**
 * Enroll completed manual CoS runs that are still waiting for a rating.
 *
 * This is an input-derived migration: state.json is the input, so the migration
 * is gated on that input and deliberately ships no data.reference seed. It does
 * not scan the historical archive or call a provider; the pending table is only
 * an index that makes the action survive state eviction and restart.
 */

import { existsSync } from 'node:fs';
import { STATE_FILE, loadState } from '../../services/cosState.js';
import { feedbackArchiveDate, isAgentFeedbackEligible } from '../../lib/cosAgentFeedback.js';

export function derivePendingFeedbackRefs(state) {
  return Object.entries(state?.agents || {})
    .map(([agentId, agent]) => ({ agentId: agent?.id || agentId, agent }))
    .filter(({ agentId, agent }) => agentId && isAgentFeedbackEligible(agent))
    .map(({ agentId, agent }) => ({ agentId, archiveDate: feedbackArchiveDate(agent) }));
}

export async function up(client) {
  if (!existsSync(STATE_FILE)) {
    console.log('🧾 CoS feedback refs: state input absent, skipped');
    return;
  }

  const refs = derivePendingFeedbackRefs(await loadState());
  for (const ref of refs) {
    await client.query(
      `INSERT INTO cos_pending_agent_feedback (agent_id, archive_date)
       VALUES ($1, $2)
       ON CONFLICT (agent_id) DO UPDATE SET archive_date = EXCLUDED.archive_date`,
      [ref.agentId, ref.archiveDate],
    );
  }
  console.log(`🧾 CoS feedback refs: enrolled ${refs.length} live run${refs.length === 1 ? '' : 's'}`);
}
