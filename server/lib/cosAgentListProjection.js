// What a CoS agent LIST response is allowed to carry.
//
// The Agents tab renders every card from two list reads — `GET /api/cos/agents`
// (state-resident runs, on the first-paint critical path of EVERY /cos/* tab and
// re-read by the 30s poll) and `GET /api/cos/agents/history/:date` (one archived
// date bucket). Both used to ship each agent's `metadata.taskDescription` whole,
// and that one field is the payload: measured over a real install's five most
// recent buckets it was 1.7 MB of a 2.35 MB response — 68% — while the state
// listing alone was 570 KB for 56 runs. The distribution is why: p50 is 75
// characters and p75 is 447, but the tail runs past 50 KB, because a CoS task
// description can be a whole pasted prompt. A handful of records pay for
// everyone, on every poll, over whatever link the user is on.
//
// The card never shows that text in full anyway — it renders through
// `CollapsibleText`, clamped to a few lines until the reader asks for more. So
// the listing carries a preview and stamps `taskDescriptionTruncated`; the
// client hydrates the full text from `GET /api/cos/agents/:id` at the two places
// it actually matters (expanding the description, and opening Resume/Relaunch,
// which build a new task prompt out of it).
//
// The cap is deliberately generous rather than tight. At 2000 characters over
// 90% of records are untouched, so the tab's client-side search and the
// task-type classifier behind the duration estimate keep seeing whole
// descriptions for every normal run, and the response still shrinks by ~65%.
//
// This is a ROUTE projection, not a service one: `getAgents` / `getAgentsByDate`
// also feed the weekly digest and CoS reports, which need the whole text.
import { clampToCharLimit } from './textUtils.js';

export const AGENT_LIST_DESCRIPTION_CHARS = 2000;

/**
 * Project one agent record into its list shape: no transcript, and a bounded
 * task description that says so when it was clipped.
 */
export function toAgentListItem(agent) {
  const { output, ...rest } = agent;
  const description = rest.metadata?.taskDescription;
  const { text, truncated } = clampToCharLimit(description, AGENT_LIST_DESCRIPTION_CHARS);
  if (!truncated) return rest;
  return {
    ...rest,
    metadata: {
      ...rest.metadata,
      taskDescription: text,
      taskDescriptionTruncated: true
    }
  };
}

export const toAgentListItems = (agents) => agents.map(toAgentListItem);
