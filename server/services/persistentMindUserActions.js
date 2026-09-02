/**
 * Deterministic "recent user actions" section for the Persistent Mind turn
 * prompt (#5595, epic #5593).
 *
 * The mind's wake context is identity + trajectory + visibility; none of it says
 * what the OPERATOR just did in the app. This module reads the last 24 hours of
 * the machine-local operator-action ledger (services/userActions.js) and renders
 * it as a compact, bounded section — counts by type first, then the newest
 * summaries — so the mind can notice repetition worth automating without any
 * tool call. Deeper lookbacks go through the `user-actions.query` tool, which is
 * gated on the `readPortos` grant; this snippet is always included because it is
 * bounded and built only from fields the recorder already redacted and clamped
 * (type / actor / target / summary — never payload values).
 *
 * No LLM call, no new grant: an empty ledger renders NOTHING (the section is
 * omitted entirely rather than adding "none" noise to every wake).
 */

import { scrubSecretTokens } from '../lib/secretText.js';
import { listUserActions } from './userActions.js';
import { detectIdleLeftoverBranches, formatLeftoverBranchSnippet } from './userActionDetectors.js';

export const USER_ACTIONS_SNIPPET_WINDOW_MS = 24 * 60 * 60 * 1000;
export const USER_ACTIONS_SNIPPET_MAX_CHARS = 1500;
export const USER_ACTIONS_SNIPPET_MAX_SUMMARIES = 20;
// Enough for accurate counts on a busy day without paging the whole table.
const SNIPPET_FETCH_LIMIT = 200;
// Types whose `target` names a CLASS of action (a scheduled task type) rather
// than one record's id — the only targets worth a per-target count line.
const CLASS_TARGET_TYPES = new Set(['cos.schedule.trigger']);

// Every string this module renders passes through here: one line, clamped, and
// scrubbed of credential-shaped VALUES — the ledger's record-time redaction is
// key-based, so a token pasted into a task description survives it by value.
const oneLine = (value, max) => {
  const text = scrubSecretTokens(String(value ?? '')).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
};

/**
 * Render the section from already-fetched ledger events (newest first). Pure —
 * exported for focused tests. Returns '' when there is nothing to show.
 *
 * Deliberately reads ONLY type/actor/target/summary: payload values (even
 * post-redaction) never reach the wake prompt from here.
 */
export function buildPersistentMindUserActionsPrompt(events) {
  const rows = (Array.isArray(events) ? events : [])
    .filter((event) => event && typeof event === 'object' && event.type);
  if (rows.length === 0) return '';

  const counts = new Map();
  for (const event of rows) {
    // Group by target only where the target is a CLASS (the task type of a
    // schedule trigger). Everywhere else it is a record id — grouping on those
    // yields one `1×` line per event, which floods the char budget with
    // signal-free ids and evicts the summaries that carry the actual pattern.
    const target = CLASS_TARGET_TYPES.has(event.type) && event.target ? ` (${oneLine(event.target, 60)})` : '';
    const label = `${oneLine(event.type, 60)}${target} actor=${oneLine(event.actor || 'user', 20)}`;
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  const countLines = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => `- ${count}× ${label}`);

  const summaryLines = rows
    .slice(0, USER_ACTIONS_SNIPPET_MAX_SUMMARIES)
    .map((event) => `- ${oneLine(event.summary || event.type, 240)}`);

  const header = '# Recent user actions (last 24h)';
  // Hold the ~1.5k budget by dropping trailing summary lines first, then count
  // lines; the "Last N" header is composed after trimming so it never overstates.
  const compose = () => [
    header,
    ...countLines,
    ...(summaryLines.length > 0 ? [`Last ${summaryLines.length}, newest first:`, ...summaryLines] : []),
  ].join('\n');
  let out = compose();
  while (out.length > USER_ACTIONS_SNIPPET_MAX_CHARS && summaryLines.length > 0) {
    summaryLines.pop();
    out = compose();
  }
  while (out.length > USER_ACTIONS_SNIPPET_MAX_CHARS && countLines.length > 1) {
    countLines.pop();
    out = compose();
  }
  return out;
}

/**
 * Read the last 24h of the ledger and render the section. A ledger read failing
 * must never sink a mind turn (this runs outside the Express request
 * lifecycle), so a failure logs once and renders as "no section".
 */
export async function readPersistentMindUserActionsPrompt({ now = Date.now() } = {}) {
  const [events, findings] = await Promise.all([
    listUserActions({
      from: new Date(now - USER_ACTIONS_SNIPPET_WINDOW_MS).toISOString(),
      limit: SNIPPET_FETCH_LIMIT,
    }).catch((error) => {
      console.error(`❌ Persistent mind user-action snippet read failed: ${error.message}`);
      return [];
    }),
    detectIdleLeftoverBranches().catch((error) => {
      console.error(`❌ Persistent mind leftover-branch detector failed: ${error.message}`);
      return [];
    }),
  ]);
  const eventsSection = buildPersistentMindUserActionsPrompt(events);
  const detectorLines = formatLeftoverBranchSnippet(findings);
  if (!eventsSection && !detectorLines) return '';
  if (!eventsSection) return `# Recent user actions (last 24h)\n${detectorLines}`;
  return detectorLines ? `${eventsSection}\n${detectorLines}` : eventsSection;
}
