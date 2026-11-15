// What a CoS agent LIST response may carry.
//
// `toAgentListItem` / `toAgentListItems` drop the transcript and bound `metadata.taskDescription` to
// `AGENT_LIST_DESCRIPTION_CHARS` (2000, on a clause boundary via `textUtils.clampToCharLimit`),
// stamping `taskDescriptionTruncated` + the original `taskDescriptionLength` so the UI can hydrate the
// rest from `GET /api/cos/agents/:id`. That one field was 68% of the Agents tab payload — p50 is 75
// characters but a pasted-prompt description runs past 50 KB, and `GET /api/cos/agents` sits on the
// first-paint critical path of every `/cos/*` tab and re-reads every 30s. Applied at the ROUTE layer
// only: `getAgents`/`getAgentsByDate` also feed the weekly digest and CoS reports, which need the
// whole text.
//
// CoS HTTP list responses and websocket agent rows carry bounded previews.
// Descriptions can contain pasted prompts; legacy task/simplify summaries can
// contain entire transcripts. Details remain available from GET /agents/:id
// when the reader expands a card or opens Resume/Relaunch. Project only at the
// transport boundary: reports and other service callers need the full records.
import { clampToCharLimit } from './textUtils.js';

export const AGENT_LIST_DESCRIPTION_CHARS = 2000;

/**
 * Project one agent record into its list shape: no transcript, and a bounded
 * description and summaries that say when they were clipped.
 */
export function toAgentListItem(agent) {
  const { output, ...rest } = agent;
  if (!rest.metadata) return rest;
  const metadata = { ...rest.metadata };
  for (const field of ['taskDescription', 'taskSummary', 'simplifySummary']) {
    const { text, truncated } = clampToCharLimit(metadata[field], AGENT_LIST_DESCRIPTION_CHARS);
    if (truncated) {
      metadata[field] = text;
      metadata[`${field}Truncated`] = true;
    }
  }
  return { ...rest, metadata };
}

export const toAgentListItems = (agents) => agents.map(toAgentListItem);
