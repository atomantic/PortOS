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
import { mapWithConcurrency } from '../lib/mapWithConcurrency.js';
import { repoApiPath } from '../lib/githubNotificationParse.js';
import {
  AGENT_RULE_KINDS, ASSIST_VERDICTS, KIND_SQL, PINNED_TRIAGE_RULES, REASON_KIND_SQL, REASON_RULE_KINDS, reasonRuledFilter, agentRuleScopeSql, assistAction, decisionFromVerdict, ruleAction, ruleActionScope, selectNotificationProvider, pullRequestAutomationFilter,
} from '../lib/githubNotificationTriage.js';
import { resolveUntrustedContentPolicy } from '../lib/untrustedContent.js';
import { toPgJson } from '../lib/pgJson.js';
import { execGh } from './github.js';
import { getAllProviders } from './provider/providers.js';
import { readSettingsStrict } from './settings.js';
import { runUntrustedContentAnalysis } from './untrustedContent.js';

const GH_TIMEOUT_MS = 20_000;
// Each sort is one screened model call; the rest wait for the next run.
const MAX_SORTS_PER_RUN = 10;
const MAX_ACTIONS_PER_RUN = 50;
// Concurrent gh writes per Assist pass (this module cannot import the shared
// bulk constant from githubNotifications.js, which imports it).
const ASSIST_GH_CONCURRENCY = 5;
// Autopilot includes everything Assist does.
const ASSIST_MODES = new Set(['assist', 'autopilot']);
const ACTIONABLE_DECISIONS = ['handled-by-pr-workflow', 'suggest-mark-read', 'duplicate', 'suggest-done', 'suggest-mute'];
// A skipped sort is retried an hour later (a provider added, a timeout), except
// when the text itself was refused; new activity re-triages either way.
const RETRY_SKIPPED_MS = 60 * 60 * 1000;
// Model calls run on local providers too: keep the overlap small.
const ASSIST_SORT_CONCURRENCY = 3;
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
  const [subject, comment] = await Promise.all([
    readText(account, env, subjectPath, TEXT_JQ),
    commentPath && commentPath !== subjectPath ? readText(account, env, commentPath, COMMENT_JQ) : null,
  ]);
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
  const prActions = pullRequestAutomationFilter(account.mode === 'autopilot' ? account.agentRules : [], 2);
  const { rows } = await query(
    `SELECT * FROM github_notifications WHERE account_id = $1 AND state = 'open' AND NOT suspect
       AND decision = 'needs-you' AND evidence->>'rule' = 'default'
       AND NOT (${prActions.sql})
       AND (NOT (evidence ? 'ai') OR (evidence->'ai'->>'retryAfter')::timestamptz <= NOW())
     ORDER BY gh_updated_at DESC LIMIT ${MAX_SORTS_PER_RUN}`,
    [account.id, ...prActions.params],
  );
  if (!rows.length) return 0;
  const state = await readSettingsStrict();
  const policy = state.corrupt ? null : resolveUntrustedContentPolicy(state.settings.untrustedContent, 'github-notification');
  // A Public account leaves selection to the source policy; only a Private
  // one needs the provider list to enforce its allow-list.
  const providers = account.trust === 'private' ? (await getAllProviders()).providers || [] : [];
  const selection = policy ? selectNotificationProvider({ account, providers, policy }) : { code: 'untrusted-content-policy-invalid' };
  const retryAfterOf = (outcome, decided) => (!decided && !FINAL_SKIPS.has(outcome.skipped) ? new Date(Date.now() + RETRY_SKIPPED_MS).toISOString() : null);
  if (selection.code) {
    // No provider is eligible, so every row gets the identical skip payload: one
    // statement, with the same per-row guard as the model path.
    const outcome = { skipped: selection.code };
    const retryAfter = retryAfterOf(outcome, null);
    if (retryAfter) outcome.retryAfter = retryAfter;
    const { rowCount } = await query(
      `UPDATE github_notifications n SET evidence = n.evidence || jsonb_build_object('rule', n.evidence->>'rule', 'ai', $3::jsonb), updated_at = NOW()
       FROM unnest($2::text[], $4::text[], $5::text[]) AS r(thread_id, decision, evidence)
       WHERE n.account_id = $1 AND n.thread_id = r.thread_id
         AND n.state = 'open' AND n.decision IS NOT DISTINCT FROM r.decision AND n.evidence = r.evidence::jsonb`,
      [account.id, rows.map((row) => row.thread_id), toPgJson(outcome), rows.map((row) => row.decision), rows.map((row) => toPgJson(row.evidence))],
    );
    console.log(`⏭️ ${rowCount} of ${rows.length} GitHub notification(s) left for the operator: ${selection.code}`);
    return 0;
  }
  const applied = await mapWithConcurrency(rows, ASSIST_SORT_CONCURRENCY, (row) => sortAndRecord(account, env, row, selection, retryAfterOf));
  return applied.filter(Boolean).length;
}

// Returns true when a verdict was applied to the row.
async function sortAndRecord(account, env, row, selection, retryAfterOf) {
  const outcome = await sortThread(account, env, row, selection).catch((error) => {
    console.error(`❌ Assist could not sort GitHub notification ${row.thread_id}: ${error.message}`);
    return { skipped: 'untrusted-content-failed' };
  });
  const decided = outcome.verdict ? decisionFromVerdict(outcome.verdict) : null;
  const retryAfter = retryAfterOf(outcome, decided);
  if (retryAfter) outcome.retryAfter = retryAfter;
  // The model call took seconds: record the verdict only on the row it read.
  // An operator hand-off, learned decision or fresh triage meanwhile wins.
  const wrote = await withTransaction(async (client) => {
    const { rowCount } = await client.query(
      `UPDATE github_notifications SET decision = COALESCE($3, decision),
         evidence = evidence || jsonb_build_object('rule', COALESCE($4, evidence->>'rule'), 'ai', $5::jsonb), updated_at = NOW()
       WHERE account_id = $1 AND thread_id = $2
         AND state = 'open' AND decision IS NOT DISTINCT FROM $6 AND evidence = $7::jsonb`,
      [account.id, row.thread_id, decided?.decision ?? null, decided?.rule ?? null, toPgJson(outcome), row.decision, toPgJson(row.evidence)],
    );
    if (rowCount && decided) {
      await client.query(
        `INSERT INTO github_notification_events (account_id, thread_id, actor, kind, detail) VALUES ($1, $2, 'automation', 'triaged', $3::jsonb)`,
        [account.id, row.thread_id, toPgJson({ decision: decided.decision, rule: decided.rule, mode: account.mode })],
      );
    }
    return rowCount > 0;
  });
  if (!wrote) console.log(`⏭️ GitHub notification ${row.thread_id} changed while Assist sorted it; its verdict was dropped`);
  else if (!decided) console.log(`⏭️ GitHub notification ${row.thread_id} left for the operator: ${outcome.skipped}`);
  return wrote && Boolean(decided);
}

async function stillAsRead(accountId, row) {
  const { rowCount } = await query(
    `SELECT 1 FROM github_notifications WHERE account_id = $1 AND thread_id = $2 AND state = 'open'
       AND decision IS NOT DISTINCT FROM $3`,
    [accountId, row.thread_id, row.decision],
  );
  return rowCount > 0;
}

/**
 * Sort and act for one account in Assist mode. `act(threadId, action, detail)`
 * applies a GitHub write and records it as an automation event; a fourth
 * argument carries `applyNotificationAction` options (the `evidencePatch`).
 */
export async function assistAccountNotifications(account, env, { act }) {
  if (!ASSIST_MODES.has(account.mode)) return { sorted: 0, acted: 0 };
  const sorted = await sortUndecided(account, env);
  // Rows a done/mute automation rule (or the built-in CI rule) covers, scoped
  // exactly as `ruleAction` matches them, so a repo whose rule leaves its
  // threads never takes a slot. Pinned decisions are never a rule's to change.
  // A reason-kind rule wins over the subject kind's, so the subject clauses
  // skip rows one covers; the reason clauses are the done/mute ones.
  const scopes = [...AGENT_RULE_KINDS, ...REASON_RULE_KINDS].map((kind) => ruleActionScope(account, kind));
  const clause = (expr, kind, index) => `(${expr} = '${kind}' AND ${agentRuleScopeSql(4 + index * 3)})`;
  const reasonRuled = reasonRuledFilter(account.agentRules, 4 + scopes.length * 3);
  const subjectSql = AGENT_RULE_KINDS.map((kind, index) => clause(KIND_SQL, kind, index)).join(' OR ');
  const reasonSql = REASON_RULE_KINDS.map((kind, index) => clause(REASON_KIND_SQL, kind, AGENT_RULE_KINDS.length + index)).join(' OR ');
  const ruleSql = `((${subjectSql}) AND NOT ${reasonRuled.sql}) OR ${reasonSql}`;
  const prActions = pullRequestAutomationFilter(account.mode === 'autopilot' ? account.agentRules : [], 4 + scopes.length * 3 + reasonRuled.params.length);
  const { rows } = await query(
    `SELECT thread_id, decision, trust, suspect, state, reason, subject_type, repo_full_name, evidence, evidence->>'rule' AS rule FROM github_notifications
     WHERE account_id = $1 AND state = 'open' AND NOT suspect AND NOT (evidence ? 'assisted')
       AND decision IS DISTINCT FROM 'handed-off'
       AND NOT (COALESCE(evidence->>'subjectState', '') NOT IN ('closed', 'merged') AND (${prActions.sql}))
       AND (decision = ANY($2::text[])
         OR (reason <> 'security_alert' AND NOT (COALESCE(evidence->>'rule', '') = ANY($3::text[])) AND (${ruleSql})))
     ORDER BY gh_updated_at DESC LIMIT ${MAX_ACTIONS_PER_RUN}`,
    [account.id, ACTIONABLE_DECISIONS, PINNED_TRIAGE_RULES, ...scopes.flatMap(({ all, except, only }) => [all, except, only]), ...reasonRuled.params, ...prActions.params],
  );
  const outcomes = await mapWithConcurrency(rows, ASSIST_GH_CONCURRENCY, async (row) => {
    // An automation rule is the operator's own choice, so it needs no trusted
    // actor; `leave` and `agent` fall back to the fixed table (a closed thread
    // is still done).
    const action = ruleAction({ account, row }) || (ACTIONABLE_DECISIONS.includes(row.decision) ? assistAction(row) : null);
    if (!action) return false;
    // The batch was read before earlier GitHub writes in this loop; an operator
    // hand-off or manual decision since then must not be marked done over.
    if (!(await stillAsRead(account.id, row))) return false;
    // `assisted` marks the thread once per activity (a re-triage on new
    // activity rebuilds the evidence), written in the action's own transaction.
    return act(row.thread_id, action, { decision: row.decision, rule: row.rule }, { evidencePatch: { assisted: true } })
      .then(() => true)
      .catch((error) => {
        console.error(`❌ Assist could not ${action} GitHub notification ${row.thread_id} for ${account.host}: ${error.message}`);
        return false;
      });
  });
  const acted = outcomes.filter(Boolean).length;
  return { sorted, acted };
}
