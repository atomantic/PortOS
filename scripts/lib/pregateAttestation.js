/**
 * The wire contract between `scripts/pregate-attest.js` (which posts a commit
 * status after a complete local pregate) and `scripts/ci-test-plan.js` (which
 * reads it back on the pull request and skips the stages it attests to).
 *
 * The status is bound to a TREE hash, not a commit: the receipt hashes the
 * exact working tree pregate validated, and the planner compares it with
 * `<head>^{tree}` — the same "content, not SHA" reasoning as
 * `scripts/verify-ci-status.js`. A description is at most 140 characters
 * (GitHub's limit), which fits every stage name with room to spare.
 *
 * Builtins only: the planner loads this before any dependency install.
 */

/** The commit-status `context` the attestation is posted under. */
export const PREGATE_STATUS_CONTEXT = 'pregate';

/** GitHub truncates a status description past this many characters. */
export const STATUS_DESCRIPTION_MAX_LENGTH = 140;

/**
 * Receipt `suite` names a status may attest to, in the order they are
 * encoded. `scan` is informational (the hidden-content scan runs inside the
 * impact job and is never skipped); every other name maps to a CI job or step
 * the planner can leave out — see `applyAttestation` in scripts/ci-test-plan.js.
 */
export const ATTESTABLE_STAGES = Object.freeze([
  'scan', 'prompt-history', 'lint', 'server', 'client', 'build', 'smoke', 'browser', 'db',
]);

const TREE_RE = /^[0-9a-f]{40}$/;
const ATTESTABLE = new Set(ATTESTABLE_STAGES);

/**
 * The stages a receipt vouches for: every receipt stage of that suite ran and
 * passed, and the suite ran CI's selection for it.
 *
 * A downgraded full plan ran only the always-run guards in the server and
 * client stages (`downgradeFullPlan` in scripts/pregate.js), so those two
 * suites are never attested from such a receipt even though their stages
 * passed; lint runs whole either way. Stages that were skipped, not run,
 * or absent from the receipt are simply not attested — CI keeps running them.
 *
 * @param {object} report - a `.cache/pregate/report.json` receipt
 * @returns {string[]} in ATTESTABLE_STAGES order
 */
export function attestedStagesFromReceipt(report) {
  const stages = Array.isArray(report?.stages) ? report.stages : [];
  const reduced = report?.plan?.downgraded === true ? new Set(['server', 'client']) : new Set();
  return ATTESTABLE_STAGES.filter((suite) => {
    if (reduced.has(suite)) return false;
    const records = stages.filter((stage) => stage?.suite === suite);
    return records.length > 0 && records.every((stage) => stage.status === 'passed');
  });
}

/**
 * The status description for a tree and its attested stages.
 *
 * @param {{tree: string, stages: string[]}} attestation
 * @returns {string}
 */
export function encodeAttestation({ tree, stages }) {
  if (!TREE_RE.test(tree ?? '')) throw new Error('attestation needs a 40-hex tree hash');
  const ordered = ATTESTABLE_STAGES.filter((stage) => stages.includes(stage));
  const unknown = stages.filter((stage) => !ATTESTABLE.has(stage));
  if (unknown.length > 0) throw new Error(`unknown attestation stage(s): ${unknown.join(', ')}`);
  if (ordered.length === 0) throw new Error('attestation needs at least one stage');
  const description = `tree=${tree} stages=${ordered.join(',')}`;
  if (description.length > STATUS_DESCRIPTION_MAX_LENGTH) {
    throw new Error(`attestation description exceeds ${STATUS_DESCRIPTION_MAX_LENGTH} characters`);
  }
  return description;
}

/**
 * The tree and stages a status description claims, or null when it is not an
 * attestation this module wrote: any unknown stage name, a malformed tree, or
 * extra fields make the whole description unreadable rather than partially
 * trusted.
 *
 * @param {string} description
 * @returns {{tree: string, stages: string[]}|null}
 */
export function parseAttestation(description) {
  const match = /^tree=([0-9a-f]{40}) stages=([a-z,-]+)$/.exec(String(description ?? '').trim());
  if (!match) return null;
  const stages = match[2].split(',');
  if (stages.length === 0 || stages.some((stage) => !ATTESTABLE.has(stage))) return null;
  if (new Set(stages).size !== stages.length) return null;
  return { tree: match[1], stages: ATTESTABLE_STAGES.filter((stage) => stages.includes(stage)) };
}

/**
 * Parse an `owner/repo` out of a git remote URL — the SSH and HTTPS shapes
 * `server/lib/gitRemote.js#parseGitRemoteUrl` accepts, without that module's
 * ssh-alias resolution (the API host is always github.com here) or its
 * import closure. Null for anything that is not exactly two path segments.
 *
 * @param {string} url
 * @returns {{host: string, owner: string, repo: string}|null}
 */
export function parseRemoteRepository(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  const trimmed = url.trim().replace(/\/$/, '');
  const stripGit = (value) => value.replace(/\.git$/i, '');
  const stripPort = (host) => host.replace(/:\d+$/, '');
  const scp = /^[a-zA-Z0-9._-]+@([^:]+):(?:\d+\/)?([^/]+)\/([^/]+)$/.exec(trimmed);
  if (scp) return { host: stripPort(scp[1]), owner: scp[2], repo: stripGit(scp[3]) };
  const urlStyle = /^[a-zA-Z]+:\/\/(?:[^@/]+@)?([^/]+)\/([^/]+)\/([^/]+)$/.exec(trimmed);
  if (urlStyle) return { host: stripPort(urlStyle[1]), owner: urlStyle[2], repo: stripGit(urlStyle[3]) };
  return null;
}

/**
 * The newest usable attestation among a commit's statuses, or null with the
 * reason none qualifies.
 *
 * Trust rests on three facts, each checked here: only a repository writer can
 * create a status on this repository (a fork's `pull_request` token is
 * read-only); the status was created by the repository owner; and the tree it
 * names is the tree of the head being tested. "Newest" is by `created_at`, so
 * a re-run of pregate-attest after a fix supersedes an older attestation on
 * the same commit.
 *
 * @param {Array<object>} statuses - `/repos/{repo}/commits/{sha}/statuses` rows
 * @param {{owner: string, headTree: string}} expected
 * @returns {{attestation: {tree: string, stages: string[], creator: string, createdAt: string}|null, reason: string}}
 */
export function selectAttestation(statuses, { owner, headTree }) {
  if (!Array.isArray(statuses)) return { attestation: null, reason: 'statuses unreadable' };
  const candidates = statuses
    .filter((status) => status?.context === PREGATE_STATUS_CONTEXT && status?.state === 'success')
    .sort((a, b) => String(b?.created_at ?? '').localeCompare(String(a?.created_at ?? '')));
  if (candidates.length === 0) return { attestation: null, reason: `no successful "${PREGATE_STATUS_CONTEXT}" status on the head` };
  const newest = candidates[0];
  const creator = newest?.creator?.login;
  if (!owner || creator !== owner) {
    return { attestation: null, reason: `newest pregate status was created by ${creator ? `"${creator}"` : 'an unknown actor'}, not the repository owner` };
  }
  const parsed = parseAttestation(newest.description);
  if (!parsed) return { attestation: null, reason: 'newest pregate status has an unreadable description' };
  if (!TREE_RE.test(headTree ?? '') || parsed.tree !== headTree) {
    return { attestation: null, reason: `attested tree ${parsed.tree.slice(0, 12)} is not the head tree ${String(headTree ?? '').slice(0, 12) || '(unknown)'}` };
  }
  return { attestation: { ...parsed, creator, createdAt: String(newest.created_at ?? '') }, reason: `attested by ${creator} at ${newest.created_at}` };
}
