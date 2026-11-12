/**
 * What earlier attempts at THIS task already landed, for the goal-fidelity review.
 *
 * A retry is judged on its own run-window diff, and `runWindowDiff` deliberately
 * excludes history reachable from the remote default branch. So when attempt 1
 * merges the fix and is then held, attempt 2 starts from a base containing that
 * fix, and its reviewer reports the objective undelivered: agent-c7d0697e merged
 * #14841, and agent-06681280 was held for "no code change addressing the timeout".
 *
 * This supplies evidence and exempts nothing. The reviewer still judges the
 * earlier change against the objective, so an unrelated earlier merge earns no
 * credit. Delivery is proven from git, never from an agent's report or PR URL: a
 * merge commit whose second parent is the captured earlier head. A retry can
 * also continue the SAME retained branch (#15770): when its window starts at the
 * captured earlier head, restore the change from that attempt's server-captured
 * source baseline through the pinned current head. This proves retained source,
 * not merge status; PR completion remains the forge gate's responsibility. No
 * refreshed upstream ref or merge object is needed for that continuation.
 *
 * The change's commit messages travel with it. A root-cause fix need not mention
 * the symptom in its lines: #14841 bounds a research prompt, and only its message
 * says that prompt caused the Antigravity timeout. Replaying qwen3-coder:30b on
 * that case, lines alone could not separate the fix from an unrelated merge; with
 * messages it answered ship 4/4 and rethink 4/4 on two unrelated merges.
 * Messages are agent-authored, so they stay in the untrusted block.
 */

import { execGit } from '../lib/execGit.js';
import { toEpochMs } from '../lib/gitCommitProbe.js';
import { getAgentsWithArchive } from './cosAgentHistory.js';

// Finished runs leave `getAgents()` when live retention expires. Retries normally
// follow within minutes, so a longer gap falls back to the ordinary review rather
// than reading every archive bucket during finalization.
const ARCHIVE_LOOKBACK_DAYS = 3;
const COMMIT_RE = /^[a-f0-9]{40,64}$/;
const TRUNCATED_MARKER = '\n…[earlier delivery truncated]';
const MAX_MESSAGE_CHARS = 2_000;
const MAX_REPORT_CHARS = 6_000;
const boundedText = (text, maxChars) => text.length > maxChars
  ? `${text.slice(0, maxChars - TRUNCATED_MARKER.length)}${TRUNCATED_MARKER}` : text;

async function earlierAttempts(taskId, startedAt) {
  const agents = await getAgentsWithArchive({ endAt: startedAt, lookbackDays: ARCHIVE_LOOKBACK_DAYS });
  const attempts = new Map(agents
    .filter(agent => agent?.taskId === taskId && toEpochMs(agent.startedAt) < startedAt)
    .map(agent => [agent.id, agent]));
  const ordered = [...attempts.values()].sort((a, b) => toEpochMs(a.startedAt) - toEpochMs(b.startedAt));
  const heads = new Map();
  for (const agent of ordered) {
    for (const row of agent.metadata?.completedCheckouts || []) {
      const head = row?.head;
      if (typeof head === 'string' && COMMIT_RE.test(head) && !heads.has(head)) heads.set(head, agent);
    }
  }
  return heads;
}

async function mergedRange(workspacePath, priorHead, head) {
  const merges = await execGit(
    ['rev-list', '--merges', '--ancestry-path', '--reverse', '--parents', `${priorHead}..${head}`],
    workspacePath, { ignoreExitCode: true, timeout: 10_000 },
  ).catch(() => null);
  if (merges?.exitCode !== 0) return null;
  const merge = merges.stdout.split('\n').map(line => line.trim().split(/\s+/))
    .find(([, , secondParent]) => secondParent === priorHead);
  return merge ? `${merge[1]}..${merge[0]}` : null;
}

async function retainedRange({ workspacePath, priorHead, head, base, agent }) {
  if (base !== priorHead || head === priorHead) return null;
  const sourceBase = agent.metadata?.primaryCheckoutBaseline?.head;
  if (!COMMIT_RE.test(sourceBase || '') || sourceBase === priorHead) return null;
  const branch = await execGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], workspacePath,
    { ignoreExitCode: true, timeout: 10_000 }).catch(() => null);
  if (branch?.exitCode !== 0 || !agent.metadata?.completedCheckouts?.some(row =>
    row?.head === priorHead && row.branch === branch.stdout.trim())) return null;
  const ancestry = await Promise.all([
    execGit(['merge-base', '--is-ancestor', sourceBase, priorHead], workspacePath,
      { ignoreExitCode: true, timeout: 10_000 }).catch(() => null),
    execGit(['merge-base', '--is-ancestor', priorHead, head], workspacePath,
      { ignoreExitCode: true, timeout: 10_000 }).catch(() => null),
  ]);
  // Net current source prevents credit for an earlier update the retry reverted.
  return ancestry.every(result => result?.exitCode === 0) ? `${sourceBase}..${head}` : null;
}

async function deliveryChange(workspacePath, range) {
  const [diff, log] = await Promise.all([
    execGit(['diff', '--no-color', '--no-ext-diff', range], workspacePath, { ignoreExitCode: true, timeout: 30_000 }),
    execGit(['log', '--format=%B', range], workspacePath, { ignoreExitCode: true, timeout: 10_000 }),
  ]).catch(() => []);
  if (diff?.exitCode !== 0 || !diff.stdout.trim()) return null;
  const messages = log?.exitCode === 0 ? log.stdout.trim().slice(0, MAX_MESSAGE_CHARS) : '';
  const header = messages
    ? `# Commit messages of the earlier/retained change\n${messages.split('\n').map(line => `# ${line}`).join('\n')}\n`
    : '';
  return `${header}${diff.stdout.trim()}`;
}

/**
 * @param {Object} options
 * @param {string} options.taskId
 * @param {string} options.workspacePath
 * @param {string} options.head - the pinned commit under review
 * @param {string} options.base - the current run-window comparison base
 * @param {number} options.startedAt - this run's start, epoch ms
 * @param {boolean} [options.includeExecutionReport] - dependency audits also
 *   deliver inventories/scans outside git. Carry the earlier agent's report as
 *   untrusted claims, never as independent proof or a replacement for the diff.
 * @param {number} options.maxChars - room left in the reviewer's budget. This
 *   run's own diff is never displaced, so an earlier change takes only what remains.
 * @returns {Promise<{diff: string, heads: string[]}|null>} oldest first, or `null`
 *   when neither an earlier merge nor the same retained branch is provable.
 */
export async function priorTaskDelivery({ taskId, workspacePath, head, base, startedAt, maxChars, includeExecutionReport = false }) {
  if (!taskId || !workspacePath || !head || !Number.isFinite(startedAt)) return null;
  const parts = [];
  const heads = [];
  const seenRanges = new Set();
  let remaining = maxChars;
  for (const [priorHead, agent] of await earlierAttempts(taskId, startedAt)) {
    if (remaining <= TRUNCATED_MARKER.length) break;
    const range = await mergedRange(workspacePath, priorHead, head)
      || await retainedRange({ workspacePath, priorHead, head, base, agent });
    if (!range || seenRanges.has(range)) continue;
    const change = await deliveryChange(workspacePath, range);
    if (!change) continue;
    seenRanges.add(range);
    // Source changes take priority. A report may only consume room left over.
    const reportBudget = Math.min(MAX_REPORT_CHARS, remaining - change.length);
    const report = includeExecutionReport && reportBudget > TRUNCATED_MARKER.length
      && typeof agent.metadata?.taskSummary === 'string'
      ? boundedText(`\n# Earlier attempt execution report (${agent.id}, head ${priorHead})\n# Agent-authored claims; command execution is not independently established. Earlier delivery status is historical.\n${agent.metadata.taskSummary}`, reportBudget) : '';
    const part = `${boundedText(change, remaining)}${report}`;
    parts.push(part);
    heads.push(priorHead);
    remaining -= part.length + 1;
  }
  return parts.length ? { diff: parts.join('\n'), heads } : null;
}
