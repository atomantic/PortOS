/**
 * Assist mode for the GitHub notifications inbox (#12872). Runs after triage,
 * only for an account the operator switched to Assist or Autopilot, so no model is called
 * before that choice.
 *
 * Two steps:
 * 1. Threads the rule table left with you (rule `default`) have their text
 *    screened and sorted by a tool-free model into a fixed enum. Anything else
 *    is discarded and the thread stays with you. The verdict only sets a
 *    decision; it never changes trust or signals.
 * 2. `assistAction` picks the one GitHub write each decision allows, and the
 *    caller's `act` applies it with an automation event the operator can undo.
 */
import { z } from 'zod';
import { query, withTransaction } from '../lib/db.js';
import { safeJSONParse } from '../lib/fileUtils.js';
import { repoApiPath } from '../lib/githubNotificationParse.js';
import { ASSIST_VERDICTS, assistAction, ciActivityAction, decisionFromVerdict, selectNotificationProvider } from '../lib/githubNotificationTriage.js';
import { resolveUntrustedContentPolicy } from '../lib/untrustedContent.js';
import { toPgJson } from '../lib/pgJson.js';
import { execGh } from './github.js';
import { getAllProviders } from './providers.js';
import { readSettingsStrict } from './settings.js';
import { runUntrustedContentAnalysis } from './untrustedContent.js';

const GH_TIMEOUT_MS = 20_000;
// Each sort is one screened model call; the rest wait for the next run.
const MAX_SORTS_PER_RUN = 10;
const MAX_ACTIONS_PER_RUN = 50;
// Autopilot includes everything Assist does.
const ASSIST_MODES = new Set(['assist', 'autopilot']);
const ACTIONABLE_DECISIONS = ['handled-by-pr-workflow', 'suggest-mark-read', 'duplicate', 'suggest-done', 'suggest-mute'];
// A skipped sort is retried an hour later (a provider added, a timeout), except
// when the text itself was refused; new activity re-triages either way.
const RETRY_SKIPPED_MS = 60 * 60 * 1000;
const FINAL_SKIPS = new Set(['untrusted-content-blocked', 'untrusted-content-too-large']);

const SORT_PROMPT = `Sort one GitHub notification for its recipient's inbox. Answer "surface" when the recipient should read or act on it, "done" when it is purely informational and needs nothing from them, or "suggest-mute" when it is recurring noise from a thread they do not need to follow. When unsure, answer "surface". Return ONLY a JSON object: {"verdict":"surface|done|suggest-mute"}.`;
const sortSchema = z.object({ verdict: z.enum(ASSIST_VERDICTS) }).strict();

const TEXT_JQ = '{title: (.title // ""), body: (.body // "")}';
const COMMENT_JQ = '{author: (.user.login // ""), body: (.body // "")}';

async function readText(account, env, path, jq) {
  if (!path) return null;
  const out = await execGh(['api', '--hostname', account.host, '--method', 'GET', path, '--jq', jq], GH_TIMEOUT_MS, { env }).catch(() => null);
  return safeJSONParse(out, null, { logError: false });
}

/** The evidence a model sees: the thread's own text, never anything it links to. */
async function threadContent(account, env, row) {
  const subjectPath = repoApiPath(row.subject_api_url, account.host);
  const commentPath = repoApiPath(row.latest_comment_api_url, account.host);
  const subject = await readText(account, env, subjectPath, TEXT_JQ);
  const comment = commentPath && commentPath !== subjectPath ? await readText(account, env, commentPath, COMMENT_JQ) : null;
  return JSON.stringify({
    repo: row.repo_full_name,
    reason: row.reason,
    type: row.subject_type,
    title: row.subject_title,
    body: subject?.body || '',
    latestComment: comment ? { author: comment.author, body: comment.body } : null,
  });
}

async function sortThread(account, env, row, selection) {
  if (selection.code) return { skipped: selection.code };
  const result = await runUntrustedContentAnalysis({
    provider: selection.provider || undefined,
    model: selection.model || undefined,
    source: 'github-notification',
    content: await threadContent(account, env, row),
    prompt: SORT_PROMPT,
    responseSchema: sortSchema,
  });
  if (!result.ok) return { skipped: result.code || 'untrusted-content-failed' };
  return { verdict: result.value.verdict };
}

async function sortUndecided(account, env) {
  const { rows } = await query(
    `SELECT * FROM github_notifications WHERE account_id = $1 AND state = 'open' AND NOT suspect
       AND decision = 'needs-you' AND evidence->>'rule' = 'default'
       AND (NOT (evidence ? 'ai') OR (evidence->'ai'->>'retryAfter')::timestamptz <= NOW())
     ORDER BY gh_updated_at DESC LIMIT ${MAX_SORTS_PER_RUN}`,
    [account.id],
  );
  if (!rows.length) return 0;
  const state = await readSettingsStrict();
  const policy = state.corrupt ? null : resolveUntrustedContentPolicy(state.settings.untrustedContent, 'github-notification');
  // A Public account leaves selection to the source policy; only a Private
  // one needs the provider list to enforce its allow-list.
  const providers = account.trust === 'private' ? (await getAllProviders()).providers || [] : [];
  const selection = policy ? selectNotificationProvider({ account, providers, policy }) : { code: 'untrusted-content-policy-invalid' };
  let sorted = 0;
  for (const row of rows) {
    const outcome = await sortThread(account, env, row, selection).catch((error) => {
      console.error(`❌ Assist could not sort GitHub notification ${row.thread_id}: ${error.message}`);
      return { skipped: 'untrusted-content-failed' };
    });
    const decided = outcome.verdict ? decisionFromVerdict(outcome.verdict) : null;
    if (!decided && !FINAL_SKIPS.has(outcome.skipped)) outcome.retryAfter = new Date(Date.now() + RETRY_SKIPPED_MS).toISOString();
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE github_notifications SET decision = COALESCE($3, decision),
           evidence = evidence || jsonb_build_object('rule', COALESCE($4, evidence->>'rule'), 'ai', $5::jsonb), updated_at = NOW()
         WHERE account_id = $1 AND thread_id = $2`,
        [account.id, row.thread_id, decided?.decision ?? null, decided?.rule ?? null, toPgJson(outcome)],
      );
      if (decided) {
        await client.query(
          `INSERT INTO github_notification_events (account_id, thread_id, actor, kind, detail) VALUES ($1, $2, 'automation', 'triaged', $3::jsonb)`,
          [account.id, row.thread_id, toPgJson({ decision: decided.decision, rule: decided.rule, mode: account.mode })],
        );
      }
    });
    if (decided) sorted += 1;
    else console.log(`⏭️ GitHub notification ${row.thread_id} left for the operator: ${outcome.skipped}`);
  }
  return sorted;
}

/**
 * Sort and act for one account in Assist mode. `act(threadId, action, detail)`
 * applies a GitHub write and records it as an automation event.
 */
export async function assistAccountNotifications(account, env, { act }) {
  if (!ASSIST_MODES.has(account.mode)) return { sorted: 0, acted: 0 };
  const sorted = await sortUndecided(account, env);
  const { rows } = await query(
    `SELECT thread_id, decision, trust, suspect, state, reason, subject_type, repo_full_name, evidence->>'rule' AS rule FROM github_notifications
     WHERE account_id = $1 AND state = 'open' AND NOT suspect AND NOT (evidence ? 'assisted')
       AND (decision = ANY($2::text[]) OR reason = 'ci_activity' OR subject_type = 'CheckSuite')
     ORDER BY gh_updated_at DESC LIMIT ${MAX_ACTIONS_PER_RUN}`,
    [account.id, ACTIONABLE_DECISIONS],
  );
  let acted = 0;
  for (const row of rows) {
    // A CI rule is the operator's own choice, so it needs no trusted actor;
    // `leave` falls back to the fixed table (a closed run is still done).
    // A thread an agent holds is the agent's to finish: its completion marks it done.
    const ciAction = row.decision === 'handed-off' ? null : ciActivityAction({ account, row });
    const action = (ciAction && ciAction !== 'leave' ? ciAction : null) || (ACTIONABLE_DECISIONS.includes(row.decision) ? assistAction(row) : null);
    if (!action) continue;
    const ok = await act(row.thread_id, action, { decision: row.decision, rule: row.rule })
      .then(() => true)
      .catch((error) => {
        console.error(`❌ Assist could not ${action} GitHub notification ${row.thread_id} for ${account.host}: ${error.message}`);
        return false;
      });
    if (!ok) continue;
    acted += 1;
    // Once per activity: a re-triage on new activity rebuilds the evidence.
    await query(`UPDATE github_notifications SET evidence = evidence || '{"assisted":true}'::jsonb WHERE account_id = $1 AND thread_id = $2`, [account.id, row.thread_id]);
  }
  return { sorted, acted };
}
