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
 * merge commit whose second parent is the head PortOS captured when that attempt
 * finished, on the ancestry of the head under review. A squash or rebase merge
 * leaves no such commit and gets the ordinary review.
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
import { getAgents } from './cosAgentLifecycle.js';
import { getAgentsByDate } from './cosAgentIndex.js';

// Finished runs leave `getAgents()` when live retention expires. Retries normally
// follow within minutes, so a longer gap falls back to the ordinary review rather
// than reading every archive bucket during finalization.
const ARCHIVE_LOOKBACK_DAYS = 3;
const DAY_MS = 86_400_000;
const COMMIT_RE = /^[a-f0-9]{40,64}$/;
const TRUNCATED_MARKER = '\n…[earlier delivery truncated]';
const MAX_MESSAGE_CHARS = 2_000;

async function earlierAttemptHeads(taskId, startedAt) {
  const days = Array.from({ length: ARCHIVE_LOOKBACK_DAYS }, (_, back) =>
    new Date(startedAt - back * DAY_MS).toISOString().slice(0, 10));
  const lists = await Promise.all([
    getAgents().catch(() => []),
    ...days.map(day => getAgentsByDate(day, { repairSummaries: false }).catch(() => [])),
  ]);
  // A record can be resident and archived at once.
  const attempts = new Map(lists.flat()
    .filter(agent => agent?.taskId === taskId && toEpochMs(agent.startedAt) < startedAt)
    .map(agent => [agent.id, agent]));
  const ordered = [...attempts.values()].sort((a, b) => toEpochMs(a.startedAt) - toEpochMs(b.startedAt));
  return [...new Set(ordered.flatMap(agent => (agent.metadata?.completedCheckouts || []).map(row => row?.head)))]
    .filter(head => typeof head === 'string' && COMMIT_RE.test(head));
}

async function mergedChange(workspacePath, priorHead, head) {
  const merges = await execGit(
    ['rev-list', '--merges', '--ancestry-path', '--reverse', '--parents', `${priorHead}..${head}`],
    workspacePath, { ignoreExitCode: true, timeout: 10_000 },
  ).catch(() => null);
  if (merges?.exitCode !== 0) return null;
  const merge = merges.stdout.split('\n').map(line => line.trim().split(/\s+/))
    .find(([, , secondParent]) => secondParent === priorHead);
  if (!merge) return null;
  const range = `${merge[1]}..${merge[0]}`;
  const [diff, log] = await Promise.all([
    execGit(['diff', '--no-color', '--no-ext-diff', range], workspacePath, { ignoreExitCode: true, timeout: 30_000 }),
    execGit(['log', '--format=%B', range], workspacePath, { ignoreExitCode: true, timeout: 10_000 }),
  ]).catch(() => []);
  if (diff?.exitCode !== 0 || !diff.stdout.trim()) return null;
  const messages = log?.exitCode === 0 ? log.stdout.trim().slice(0, MAX_MESSAGE_CHARS) : '';
  const header = messages
    ? `# Commit messages of the merged change\n${messages.split('\n').map(line => `# ${line}`).join('\n')}\n`
    : '';
  return `${header}${diff.stdout.trim()}`;
}

/**
 * @param {Object} options
 * @param {string} options.taskId
 * @param {string} options.workspacePath
 * @param {string} options.head - the pinned commit under review
 * @param {number} options.startedAt - this run's start, epoch ms
 * @param {number} options.maxChars - room left in the reviewer's budget. This
 *   run's own diff is never displaced, so an earlier change takes only what remains.
 * @returns {Promise<{diff: string, heads: string[]}|null>} oldest first, or `null`
 *   when no earlier attempt's merge is provable.
 */
export async function priorTaskDelivery({ taskId, workspacePath, head, startedAt, maxChars }) {
  if (!taskId || !workspacePath || !head || !Number.isFinite(startedAt)) return null;
  const parts = [];
  const heads = [];
  let remaining = maxChars;
  for (const priorHead of await earlierAttemptHeads(taskId, startedAt)) {
    if (remaining <= TRUNCATED_MARKER.length) break;
    const change = await mergedChange(workspacePath, priorHead, head);
    if (!change) continue;
    const part = change.length > remaining
      ? `${change.slice(0, remaining - TRUNCATED_MARKER.length)}${TRUNCATED_MARKER}`
      : change;
    parts.push(part);
    heads.push(priorHead);
    remaining -= part.length + 1;
  }
  return parts.length ? { diff: parts.join('\n'), heads } : null;
}
