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
