/**
 * Superseded-branch verdict ledger (#3842): caches the conclusion that a branch
 * is SUPERSEDED so `branch-reconcile` doesn't pay a full coordinator run to
 * re-derive it. Work that landed on the default branch under different names is
 * never `isMerged`, so the branch otherwise stays actionable forever.
 *
 * Per-install runtime state (`data/cos/branch-reconcile-verdicts.json`,
 * gitignored): nothing to seed, migrate, or federate. Every read fails OPEN: a
 * missing or malformed ledger yields no entries, i.e. re-analyze everything
 * rather than silently hiding a branch.
 *
 * Caching does not retire the branch; `reapSupersededBranches` (branchReconcile.js)
 * does, for clean worktrees only. `formatSupersededForPrompt` therefore renders
 * just the leftovers the reap could not take this cycle.
 */

import { PATHS, tryReadFile, safeJSONParse, atomicWrite } from '../lib/fileUtils.js';
import { join, resolve } from 'node:path';
import { createKeyCachedQueue } from '../lib/createKeyCachedQueue.js';
import { isAgentScratchPath } from '../lib/agent/agentScratchPaths.js';

export const LEDGER_VERSION = 1;

/** Absolute path to an install's verdict ledger. */
export const ledgerPath = (cosDir = PATHS.cos) => join(cosDir, 'branch-reconcile-verdicts.json');

/** Order-independent set equality over two path lists. Pure. */
export const sameSet = (a = [], b = []) => {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const left = new Set(a);
  return b.every((x) => left.has(x)) && left.size === new Set(b).size;
};

// Every recorded collision path still collides. Extra live paths are allowed.
// Absent lists default to empty, as `sameSet` treats them.
const coversCollisions = (live = [], recorded = []) => Array.isArray(live) && Array.isArray(recorded)
  && recorded.every((path) => live.includes(path));

/** Read the ledger. Never throws; an unparseable ledger is no ledger (fail open). */
export async function readVerdictLedger(cosDir = PATHS.cos) {
  const raw = await tryReadFile(ledgerPath(cosDir));
  if (raw === null) return [];
  const parsed = safeJSONParse(raw, null);
  const entries = Array.isArray(parsed) ? parsed : parsed?.entries;
  return Array.isArray(entries) ? entries.filter((e) => e && typeof e.branch === 'string') : [];
}

const queueLedgerWrite = createKeyCachedQueue();

async function persistLedger(entries, cosDir) {
  await atomicWrite(ledgerPath(cosDir), { version: LEDGER_VERSION, entries });
  return entries;
}

/** Persist the full entry list. */
export function writeVerdictLedger(entries, cosDir = PATHS.cos) {
  cosDir = resolve(cosDir);
  return queueLedgerWrite(cosDir, () => persistLedger(entries, cosDir));
}

/**
 * Record (or refresh) one branch's verdict. Last write wins per (repo, branch) —
 * one ledger serves every managed app, and a branch name alone does not identify
 * a branch across them. `entry` needs at minimum { branch, repoPath, verdict, tip }.
 */
export function recordVerdict(entry, cosDir = PATHS.cos) {
  cosDir = resolve(cosDir);
  return queueLedgerWrite(cosDir, async () => {
    const existing = await readVerdictLedger(cosDir);
    const isSame = (e) => e.branch === entry.branch && e.repoPath === entry.repoPath;
    return persistLedger([
      ...existing.filter((e) => !isSame(e)),
      { decidedAt: new Date().toISOString(), ...entry },
    ], cosDir);
  });
}

/**
 * Is a recorded verdict still trustworthy for the branch as it stands NOW? Pure.
 *
 * Stale when:
 *   - the branch moved (`tip`) or its uncommitted change set moved (`dirtyPaths`)
 *     — an ABANDONED_WIP branch's deliverable is its dirty tree;
 *   - a recorded collision path stopped colliding (a revert shows up this way);
 *   - a recorded `replacedBy` commit is no longer reachable from the default branch.
 *
 * Deliberately NOT staleness signals: collision-path CONTENT changing (lockfiles
 * churn on every merge and would expire everything; churn makes supersession
 * more certain) and a GROWING collision set (with `tip` and dirty set pinned the
 * branch's own changes can't move).
 *
 * `branch` is the live reconcile entry { branch, tip, collisionPaths, dirtyPaths };
 * `replacedByPresent` is the caller-resolved reachability of `entry.replacedBy`.
 */
export function isVerdictFresh(entry, branch, { replacedByPresent = true, repoPath = null } = {}) {
  if (!entry || entry.verdict !== 'SUPERSEDED') return false;
  if (!entry.branch || entry.branch !== branch?.branch) return false;
  // Branch names are not unique across managed repos; an entry must name its repo.
  if (!entry.repoPath || entry.repoPath !== repoPath) return false;
  // No recorded replacement means it can't be re-verified; evidence is the cache key.
  if (!Array.isArray(entry.replacedBy) || entry.replacedBy.length === 0) return false;
  if (!replacedByPresent) return false;
  if (!entry.tip || entry.tip !== branch.tip) return false;
  if (!coversCollisions(branch.collisionPaths, entry.collisionPaths)) return false;
  return sameDirtyPaths(entry.dirtyPaths, branch.dirtyPaths);
}

/**
 * Do a ledger entry's recorded dirty paths still describe the branch's live ones?
 *
 * Subtracts PortOS's own runtime scratch from BOTH sides, since older verdicts
 * list scratch the live side no longer reports. Exported because
 * `reapSupersededBranches` re-checks the same pairing before deleting; comparing
 * raw there would hold the branch forever as "verdict-does-not-match-branch".
 */
export const sameDirtyPaths = (recorded = [], live = []) => sameSet(
  (recorded || []).filter((path) => !isAgentScratchPath(path)),
  (live || []).filter((path) => !isAgentScratchPath(path))
);

/**
 * Split the in-flight set into branches still worth analyzing and branches whose
 * SUPERSEDED verdict is cached and still fresh. Pure — the caller resolves
 * `replacedByPresent(entry)`; entries from a different `repoPath` never apply.
 * `superseded` items are the live branch objects annotated with `{ verdict }`.
 */
export function partitionSuperseded(inFlight, entries, replacedByPresent = () => true, { repoPath = null } = {}) {
  const byBranch = new Map((entries || []).filter((e) => e.repoPath === repoPath).map((e) => [e.branch, e]));
  const actionable = [];
  const superseded = [];
  for (const b of inFlight || []) {
    const entry = byBranch.get(b.branch);
    if (entry && isVerdictFresh(entry, b, { replacedByPresent: replacedByPresent(entry), repoPath })) {
      superseded.push({ ...b, verdict: entry });
    } else {
      actionable.push(b);
    }
  }
  return { actionable, superseded };
}

/**
 * Render the still-standing superseded set for the coordinator prompt. These
 * branches are NOT work — they are named so the coordinator doesn't re-discover
 * them, and so a held-back reap is visible rather than silent.
 */
export function formatSupersededForPrompt(superseded) {
  if (!superseded?.length) return '';
  const lines = [
    `## Already verified SUPERSEDED — reap held back (${superseded.length}) — DO NOT ANALYZE`,
    '',
    'Each branch below was analyzed by an earlier run and confirmed superseded: the default branch already solves its problem, so merging it would REGRESS shipped work. The verdict is cached and still valid (branch tip and uncommitted change set unchanged, every recorded collision path still colliding; the replacing commits are still on the default branch). PortOS reaps a verified-superseded branch itself, after backing it up — these are the ones this cycle could NOT take, because something still holds them: a locked worktree, a live CoS agent, a worktree outside PortOS\'s managed roots that has not yet sat idle for an hour, or a tip that moved after the verdict was recorded. Each one names its hold below. Do not read these worktrees, do not re-derive the verdict, do not commit, rebase, resolve, or merge anything on them. Report them; the next cycle reaps whatever has since been released.',
    ''
  ];
  for (const b of superseded) {
    const v = b.verdict || {};
    lines.push(`### \`${b.branch}\` — SUPERSEDED${v.decidedAt ? ` (verdict recorded ${v.decidedAt})` : ''}`);
    if (v.was) lines.push(`- Was: ${v.was}`);
    if (v.replacedBy?.length) lines.push(`- Replaced on the default branch by: ${v.replacedBy.map((s) => `\`${s}\``).join(', ')}${v.replacedByNote ? ` — ${v.replacedByNote}` : ''}`);
    if (b.worktreePath) {
      lines.push(`- Worktree still on disk: \`${b.worktreePath}\` — PortOS reaps it once its hold lifts. Do NOT run the removal yourself.`);
    }
    if (b.holdReason) lines.push(`- Held this cycle by: \`${b.holdReason}\`${b.holdRetryAt ? ` — lifts at ${b.holdRetryAt}` : ''}`);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * The instruction appended to the supersession gate so a coordinator that REACHES
 * a SUPERSEDED verdict writes it down instead of discarding the analysis.
 */
export const recordVerdictInstruction = (file = 'data/cos/branch-reconcile-verdicts.json') => [
  `If you conclude SUPERSEDED, RECORD IT so no future run pays to re-derive it: read \`${file}\` (a JSON \`{ "version": 1, "entries": [...] }\`; treat a missing or unparseable file as \`{ "version": 1, "entries": [] }\`), replace any entry with the same \`branch\` AND \`repoPath\`, and write it back.`,
  'The entry must be: `{ "branch": "<full branch name>", "repoPath": "<absolute path of the repo being reconciled>", "verdict": "SUPERSEDED", "tip": "<full SHA of `git rev-parse <branch>`>", "dirtyPaths": [<every path `git status --porcelain` reports in its worktree, exactly as reconcile listed them>], "collisionPaths": [<the collision list given to you above, verbatim>], "replacedBy": ["<full SHA on the default branch that replaced it>", ...], "replacedByNote": "<one line naming the file and what replaced it>", "was": "<one line: what the branch was trying to do>", "decidedAt": "<ISO 8601 UTC>" }`.',
  '`repoPath` and `replacedBy` are both mandatory: one ledger serves every managed app so a bare branch name identifies nothing, and the replacing commits are the evidence the cache re-checks. An entry missing either is ignored. If you cannot name a replacing commit, you have not actually confirmed supersession; keep analyzing.'
].join(' ');
