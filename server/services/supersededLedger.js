/**
 * Superseded-branch verdict ledger (#3842).
 *
 * `branch-reconcile` can never converge on a SUPERSEDED branch. The verdict is
 * correct — merging the branch would regress shipped work — but nothing acts on
 * it: the branch is left untouched by design, and the deterministic cleanup in
 * `cleanupMerged()` only reaps what git can see as merged. Work that landed on
 * the default branch under different file and function names is never `isMerged`,
 * so the branch stays ABANDONED_WIP, stays actionable, and the next recheck pays
 * a full coordinator run to re-derive the identical verdict. Two branches in this
 * install were analyzed sixteen times that way.
 *
 * The scheduler's `parkPerpetual()` already notices the actionable SET is
 * unchanged — but it caches only *that*, never *what was concluded*. This module
 * caches the conclusion.
 *
 * The ledger is per-install runtime state (`data/cos/branch-reconcile-verdicts.json`,
 * gitignored) — verdicts are facts about THIS clone's local branches, so there is
 * nothing to seed, migrate, or federate. Every read fails OPEN: a missing,
 * unreadable, or malformed ledger yields no entries, which restores the old
 * re-analyze-everything behavior rather than silently hiding a branch.
 *
 * Caching the verdict removes the cost of re-analysis; it does not retire the
 * branch. `reapSupersededBranches` (branchReconcile.js) does that, gated on a
 * recoverable backup written by `supersededBackup.js` — a superseded branch's
 * uncommitted work is redundant, not worthless, so it is preserved before the
 * worktree is removed. What reaches `formatSupersededForPrompt` is therefore not
 * the whole superseded set but the leftovers the reap could not take this cycle.
 */

import { PATHS, tryReadFile, safeJSONParse, atomicWrite } from '../lib/fileUtils.js';
import { join } from 'node:path';
import { isAgentScratchPath } from '../lib/agentScratchPaths.js';

export const LEDGER_VERSION = 1;

/** Absolute path to an install's verdict ledger. */
export const ledgerPath = (cosDir = PATHS.cos) => join(cosDir, 'branch-reconcile-verdicts.json');

/** Order-independent set equality over two path lists. Pure. */
export const sameSet = (a = [], b = []) => {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const left = new Set(a);
  return b.every((x) => left.has(x)) && left.size === new Set(b).size;
};

/**
 * Read the ledger. Never throws and never partially trusts a malformed file —
 * an unparseable ledger is treated as no ledger (fail open → re-analyze).
 * @param {string} [cosDir]
 * @returns {Promise<object[]>} verdict entries (possibly empty)
 */
export async function readVerdictLedger(cosDir = PATHS.cos) {
  const raw = await tryReadFile(ledgerPath(cosDir));
  if (raw === null) return [];
  const parsed = safeJSONParse(raw, null);
  const entries = Array.isArray(parsed) ? parsed : parsed?.entries;
  return Array.isArray(entries) ? entries.filter((e) => e && typeof e.branch === 'string') : [];
}

/**
 * Persist the ledger, replacing any existing entry for the same branch.
 * @param {object[]} entries
 * @param {string} [cosDir]
 */
export async function writeVerdictLedger(entries, cosDir = PATHS.cos) {
  await atomicWrite(ledgerPath(cosDir), { version: LEDGER_VERSION, entries });
  return entries;
}

/**
 * Record (or refresh) one branch's verdict. Last write wins per (repo, branch) —
 * one ledger serves every managed app, and a branch name alone does not identify
 * a branch across them.
 * @param {object} entry - at minimum { branch, repoPath, verdict, tip }
 * @param {string} [cosDir]
 */
export async function recordVerdict(entry, cosDir = PATHS.cos) {
  const existing = await readVerdictLedger(cosDir);
  const isSame = (e) => e.branch === entry.branch && e.repoPath === entry.repoPath;
  return writeVerdictLedger(
    [...existing.filter((e) => !isSame(e)), { decidedAt: new Date().toISOString(), ...entry }],
    cosDir
  );
}

/**
 * Is a recorded verdict still trustworthy for the branch as it stands NOW? Pure.
 *
 * Three things can make a verdict stale, and each maps to a real way the
 * judgment could change:
 *   - the branch moved (`tip`) or its uncommitted change set moved (`dirtyPaths`)
 *     — an ABANDONED_WIP branch's whole deliverable is its dirty tree, so a tip
 *     SHA alone would not notice someone editing the worktree;
 *   - the collision set changed — the branch now touches files the judgment was
 *     never made against;
 *   - a commit recorded as the replacement is no longer reachable from the
 *     default branch (a revert), so what superseded the branch is gone.
 *
 * Note what is deliberately NOT a staleness signal: the CONTENT of a collision
 * path changing on the default branch. `package-lock.json` is a collision path
 * on essentially every long-lived branch and is rewritten by every merge, so
 * content-hash invalidation would expire every entry within minutes and cache
 * nothing. Continued churn in a file the default branch already solved makes
 * supersession *more* certain, not less; a revert is the case that actually
 * undoes it, and `replacedBy` reachability catches that directly.
 *
 * @param {object} entry - a ledger entry
 * @param {object} branch - the live reconcile entry { branch, tip, collisionPaths, dirtyPaths }
 * @param {{ replacedByPresent?: boolean, repoPath?: string }} [ctx] - resolved reachability of
 *   `entry.replacedBy`, and the repo being reconciled
 * @returns {boolean}
 */
export function isVerdictFresh(entry, branch, { replacedByPresent = true, repoPath = null } = {}) {
  if (!entry || entry.verdict !== 'SUPERSEDED') return false;
  if (!entry.branch || entry.branch !== branch?.branch) return false;
  // One ledger serves every managed app, and branch names are not unique across
  // repos — `feature/x` in two apps is two different branches. An entry that
  // doesn't name the repo it was decided in is not allowed to speak for any of them.
  if (!entry.repoPath || entry.repoPath !== repoPath) return false;
  // A verdict with no recorded replacement can't be re-verified cheaply, so it
  // is not allowed to suppress analysis — the evidence IS the cache key.
  if (!Array.isArray(entry.replacedBy) || entry.replacedBy.length === 0) return false;
  if (!replacedByPresent) return false;
  if (!entry.tip || entry.tip !== branch.tip) return false;
  if (!sameSet(entry.collisionPaths, branch.collisionPaths)) return false;
  return sameDirtyPaths(entry.dirtyPaths, branch.dirtyPaths);
}

/**
 * Do a ledger entry's recorded dirty paths still describe the branch's live ones?
 *
 * Subtracts PortOS's own runtime scratch from BOTH sides. A verdict recorded
 * before `classifyWorktreeDirt` learned to subtract that scratch lists it among
 * its dirty paths while the live side no longer does; comparing raw would expire
 * every such entry and re-pay the coordinator analysis the ledger exists to
 * avoid. Nothing else changes — a live list never contains scratch.
 *
 * Exported because `reapSupersededBranches` re-checks the same pairing before it
 * deletes anything: comparing raw there would pass the partition and then hold
 * the branch forever as "verdict-does-not-match-branch", which is the accumulation
 * this whole path exists to end.
 *
 * @param {string[]} recorded
 * @param {string[]} live
 * @returns {boolean}
 */
export const sameDirtyPaths = (recorded = [], live = []) => sameSet(
  (recorded || []).filter((path) => !isAgentScratchPath(path)),
  (live || []).filter((path) => !isAgentScratchPath(path))
);

/**
 * Split the in-flight set into branches still worth analyzing and branches whose
 * SUPERSEDED verdict is cached and still fresh. Pure — reachability of each
 * entry's `replacedBy` commits is resolved by the caller and passed in.
 *
 * @param {object[]} inFlight
 * @param {object[]} entries - ledger entries
 * @param {(entry:object) => boolean} [replacedByPresent] - predicate per entry
 * @param {{ repoPath?: string }} [ctx] - the repo being reconciled; entries decided
 *   in a different repo never apply (branch names are not unique across apps)
 * @returns {{ actionable: object[], superseded: object[] }} `superseded` entries are
 *   the live branch objects annotated with `{ verdict }` from the ledger
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
 * @param {object[]} superseded - partitionSuperseded()'s `superseded`
 * @returns {string}
 */
export function formatSupersededForPrompt(superseded) {
  if (!superseded?.length) return '';
  const lines = [
    `## Already verified SUPERSEDED — reap held back (${superseded.length}) — DO NOT ANALYZE`,
    '',
    'Each branch below was analyzed by an earlier run and confirmed superseded: the default branch already solves its problem, so merging it would REGRESS shipped work. The verdict is cached and still valid (branch tip, uncommitted change set, and collision paths all unchanged; the replacing commits are still on the default branch). PortOS reaps a verified-superseded branch itself, after backing it up — these are the ones this cycle could NOT take, because something still holds them: a locked worktree, a live CoS agent, a claim tree inside its idle window, or a tip that moved after the verdict was recorded. Do not read these worktrees, do not re-derive the verdict, do not commit, rebase, resolve, or merge anything on them. Report them; the next cycle reaps whatever has since been released.',
    ''
  ];
  for (const b of superseded) {
    const v = b.verdict || {};
    lines.push(`### \`${b.branch}\` — SUPERSEDED${v.decidedAt ? ` (verdict recorded ${v.decidedAt})` : ''}`);
    if (v.was) lines.push(`- Was: ${v.was}`);
    if (v.replacedBy?.length) lines.push(`- Replaced on the default branch by: ${v.replacedBy.map((s) => `\`${s}\``).join(', ')}${v.replacedByNote ? ` — ${v.replacedByNote}` : ''}`);
    if (v.backupPatch) lines.push(`- Uncommitted work backed up at: \`${v.backupPatch}\``);
    if (b.worktreePath) {
      lines.push(`- Worktree still on disk: \`${b.worktreePath}\` — PortOS reaps it once its hold lifts. Do NOT run the removal yourself.`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * The instruction appended to the supersession gate so a coordinator that REACHES
 * a SUPERSEDED verdict writes it down. Without this the analysis is paid for and
 * then thrown away, which is the whole defect in #3842.
 * @param {string} [file]
 * @returns {string}
 */
export const recordVerdictInstruction = (file = 'data/cos/branch-reconcile-verdicts.json') => [
  `If you conclude SUPERSEDED, RECORD IT so no future run pays to re-derive it: read \`${file}\` (a JSON \`{ "version": 1, "entries": [...] }\`; treat a missing or unparseable file as \`{ "version": 1, "entries": [] }\`), replace any entry with the same \`branch\` AND \`repoPath\`, and write it back.`,
  'The entry must be: `{ "branch": "<full branch name>", "repoPath": "<absolute path of the repo being reconciled>", "verdict": "SUPERSEDED", "tip": "<full SHA of `git rev-parse <branch>`>", "dirtyPaths": [<every path `git status --porcelain` reports in its worktree, exactly as reconcile listed them>], "collisionPaths": [<the collision list given to you above, verbatim>], "replacedBy": ["<full SHA on the default branch that replaced it>", ...], "replacedByNote": "<one line naming the file and what replaced it>", "was": "<one line: what the branch was trying to do>", "decidedAt": "<ISO 8601 UTC>" }`.',
  '`repoPath` and `replacedBy` are both mandatory: one ledger serves every managed app so a bare branch name identifies nothing, and the replacing commits are the evidence the cache re-checks. An entry missing either is ignored. If you cannot name a replacing commit, you have not actually confirmed supersession; keep analyzing.'
].join(' ');
