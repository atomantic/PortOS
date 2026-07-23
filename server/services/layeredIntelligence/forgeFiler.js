/**
 * Layered Intelligence — GitHub/GitLab forge filer (#2842 split of
 * layeredIntelligence.js). Lists/normalizes forge issues, resolves the
 * implementing PR + closing comment, and files/labels proposals through the
 * forge CLI (injectable `exec`).
 */

import { safeJSONParse } from '../../lib/fileUtils.js';
import { LI_LABEL, LI_BLOCKING_LABEL } from './constants.js';
import { slugMarker, extractSlugFromBody } from './dedup.js';
import { runCli } from './runCli.js';

/**
 * Normalize a forge issue state to `open` / `closed`. GitLab reports `opened`
 * (and `closed`/`locked`); GitHub reports `open`/`closed`. Anything that isn't a
 * recognized closed/locked state is treated as open so dedup + park don't miss a
 * GitLab-`opened` issue. (`merged` never applies to issues.)
 */
export function normalizeIssueState(state) {
  const s = (state || '').toLowerCase();
  if (s === 'closed' || s === 'locked') return 'closed';
  return 'open';
}

/**
 * Normalize a forge issue's labels to a plain `string[]`. gh reports objects
 * (`[{ name, color, … }]`); glab reports bare strings. Anything unrecognized
 * drops out rather than rendering `[object Object]` into the reasoner's prompt.
 */
export function normalizeIssueLabels(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(l => (typeof l === 'string' ? l : l?.name))
    .filter(l => typeof l === 'string' && l.trim())
    .map(l => l.trim());
}

/**
 * Best-effort priority read from an issue's labels — there is no cross-forge
 * priority field, so the common label conventions are matched instead:
 * `priority: high` / `priority/high`, `P0`–`P4`, and a bare
 * `critical|urgent|high|medium|low` (optionally suffixed `-priority`).
 *
 * Returns null when no label looks like a priority. Null means "this issue
 * carries no priority label", NOT "priority zero" — the renderer omits the field
 * entirely rather than inventing a default the tracker never asserted.
 */
export function extractIssuePriority(labels = []) {
  const re = /^(?:priority[:/\s-]+(.+)|p([0-4])|(critical|urgent|high|medium|low)(?:[\s-]priority)?)$/i;
  for (const label of normalizeIssueLabels(labels)) {
    const m = label.match(re);
    if (!m) continue;
    const value = m[1] ?? (m[2] != null ? `p${m[2]}` : m[3]);
    if (typeof value === 'string' && value.trim()) return value.trim().toLowerCase();
  }
  return null;
}

/**
 * List issues on a forge. Defaults to the layered-intelligence set (open +
 * recently closed) for the reasoner + dedup guard; `label`/`state` are
 * parameterized so the plannedWork source (#2698) can reuse the exact same
 * parse/normalize path for the `plan`-labeled committed backlog.
 *
 * Returns `{ ok, issues }` — `ok:false` means the tracker read FAILED (CLI error
 * or unparseable output), which is NOT the same as "no existing issues" (`ok:true,
 * issues:[]`). The handler must NOT file when the read failed, or a transient
 * `gh` blip would defeat dedup and file a duplicate (CLAUDE.md sentinel rule).
 */
export async function listForgeIssues({ cli, cwd, env, label = LI_LABEL, state = 'all', exec = runCli } = {}) {
  // glab lists open issues by default and needs `--all` to widen to every state;
  // gh takes the state explicitly.
  const args = cli === 'glab'
    ? ['issue', 'list', '--label', label, ...(state === 'all' ? ['--all'] : []), '-P', '100', '-F', 'json']
    : ['issue', 'list', '--label', label, '--state', state, '--limit', '100', '--json', 'number,title,body,state,stateReason,closedAt,url,labels,comments,closedByPullRequestsReferences'];
  const { code, stdout } = await exec(cli, args, { cwd, env });
  if (code !== 0) return { ok: false, issues: [] };
  if (!stdout.trim()) return { ok: true, issues: [] };
  const parsed = safeJSONParse(stdout, null, { logError: false });
  if (!Array.isArray(parsed)) return { ok: false, issues: [] };
  return {
    ok: true,
    issues: parsed.map(i => ({
      number: i.number ?? i.iid ?? null,
      title: i.title || '',
      body: i.body || i.description || '',
      state: normalizeIssueState(i.state),
      // GitHub-only: 'completed' | 'not_planned' | 'reopened'. glab omits it, so
      // deriveOutcome falls back to treating any closed issue as merged.
      stateReason: i.stateReason || i.state_reason || null,
      closedAt: i.closedAt || i.closed_at || null,
      // gh reports `url`; glab reports `web_url`. Null when neither is present so
      // the overview's proposal links degrade to a plain count rather than a
      // dead href.
      url: i.url || i.web_url || null,
      labels: normalizeIssueLabels(i.labels),
      // The rejection classifier's last-resort signal (#2748): the prose a human
      // left when declining, for a close with no matching label/close-reason. gh
      // returns `comments` in the same batched list call (no extra fetch); glab's
      // `-F json` omits them, so its rows carry null and fall through to label/
      // stateReason only (tracked in the issue's Remaining).
      closingComment: extractClosingComment(i.comments),
      // The implementing-PR handle (#2748, deliverable 2): gh reports every PR that
      // closes/references this issue in `closedByPullRequestsReferences`. Additive
      // and null-defaulted — glab's `-F json` omits it, so its rows carry null and
      // fall through to the label/comment signals, and the reconciler only reads a
      // PR's state when it holds a number here. Scoped to the issue's own repo (parsed
      // from its url) so a cross-repo closing PR can't resolve to the wrong number.
      implementingPr: extractImplementingPr(i.closedByPullRequestsReferences, repoSlugFromUrl(i.url || i.web_url)),
      slug: extractSlugFromBody(i.body || i.description || '') || extractSlugFromBody(i.title || '')
    }))
  };
}

/**
 * Parse an `owner/repo` slug (lower-cased for case-insensitive compare) from a GitHub
 * issue/PR URL — `https://HOST/owner/repo/(issues|pull)/N` — host-agnostic so it works
 * on github.com and Enterprise. Returns null when the shape doesn't match.
 */
export function repoSlugFromUrl(url) {
  if (typeof url !== 'string') return null;
  const m = url.match(/^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/(?:issues|pull)\/\d+/);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

/**
 * The `owner/repo` a `closedByPullRequestsReferences` entry belongs to — from its
 * structured `repository { owner { login }, name }`, falling back to parsing its `url`.
 * Null when neither is present. Lower-cased to match `repoSlugFromUrl`.
 */
function refRepoSlug(ref) {
  const owner = ref?.repository?.owner?.login;
  const name = ref?.repository?.name;
  if (typeof owner === 'string' && typeof name === 'string') return `${owner}/${name}`.toLowerCase();
  return repoSlugFromUrl(ref?.url);
}

/**
 * The number of the PR that implements a proposal, from gh's
 * `closedByPullRequestsReferences` (#2748, deliverable 2). Takes the LAST reference —
 * the most recent PR linked to the issue — and returns its number, or null when there
 * is none (glab, or an issue closed by hand). Pure.
 *
 * `selfRepo` (the issue's own `owner/repo`) scopes the match: the reconciler later runs
 * `gh pr view <number>` in the issue's checkout, so a reference from a DIFFERENT repo
 * (a cross-repo/fork PR that closed the issue) would resolve to the wrong PR number in
 * cwd's repo — or none — and mis-diagnose the rejection. So a ref whose repo is known
 * and differs from `selfRepo` is skipped. When `selfRepo` is unknown or a ref carries
 * no repo, it is accepted (same-repo is the overwhelmingly common case for an LI
 * proposal implemented in its own repo), preserving prior behavior.
 */
export function extractImplementingPr(refs, selfRepo = null) {
  if (!Array.isArray(refs)) return null;
  const self = typeof selfRepo === 'string' ? selfRepo.toLowerCase() : null;
  for (let i = refs.length - 1; i >= 0; i -= 1) {
    const n = refs[i]?.number;
    if (!Number.isInteger(n) || n <= 0) continue;
    const refRepo = refRepoSlug(refs[i]);
    if (self && refRepo && refRepo !== self) continue;
    return n;
  }
  return null;
}

/**
 * Read the merge state + check rollup of an implementing PR (#2748, deliverable 2),
 * so the rejection reconciler can classify `merge-conflict` / `validation-failed`.
 * gh-only (glab carries no PR handle) and bounded by the caller to the small set of
 * non-merged proposals that both hold a PR ref and were left undiagnosed by the free
 * signals — this is the ONE tracker fetch classification adds, and it never runs at
 * boot (only the scheduler-tick reconcile, gated behind `sources.outcomes`).
 * Returns `{ state, mergeStateStatus, statusCheckRollup }`, or null on any failure
 * (a null read simply leaves the proposal on its existing, honest fallback reason).
 */
export async function readImplementingPrState({ cli, cwd, env, number, exec = runCli } = {}) {
  if (cli !== 'gh' || !Number.isInteger(number)) return null;
  const { code, stdout } = await exec(cli, ['pr', 'view', String(number), '--json', 'state,mergeStateStatus,statusCheckRollup'], { cwd, env });
  if (code !== 0 || !stdout.trim()) return null;
  const parsed = safeJSONParse(stdout, null, { logError: false });
  if (!parsed || typeof parsed !== 'object') return null;
  return {
    state: parsed.state ?? null,
    mergeStateStatus: parsed.mergeStateStatus ?? null,
    statusCheckRollup: Array.isArray(parsed.statusCheckRollup) ? parsed.statusCheckRollup : []
  };
}

/**
 * The rationale a human left when closing a proposal, for the rejection classifier
 * (#2748). gh returns issue comments oldest-first; the LAST non-empty one sits
 * closest to the close, so it carries the decline reason in the common case.
 * Returns null for an issue closed with no comment — there is nothing to classify.
 */
export function extractClosingComment(comments) {
  if (!Array.isArray(comments)) return null;
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const body = comments[i]?.body;
    if (typeof body === 'string' && body.trim()) return body;
  }
  return null;
}

/**
 * List OPEN blocking-labeled issues for the app (park check). Returns
 * `{ ok, issues }` with the same failed-vs-empty distinction as listForgeIssues.
 */
export async function listBlockingIssues({ cli, cwd, env, exec = runCli } = {}) {
  const args = cli === 'glab'
    ? ['issue', 'list', '--label', LI_BLOCKING_LABEL, '-P', '100', '-F', 'json']
    : ['issue', 'list', '--label', LI_BLOCKING_LABEL, '--state', 'open', '--limit', '100', '--json', 'number,title,state'];
  const { code, stdout } = await exec(cli, args, { cwd, env });
  if (code !== 0) return { ok: false, issues: [] };
  if (!stdout.trim()) return { ok: true, issues: [] };
  const parsed = safeJSONParse(stdout, null, { logError: false });
  if (!Array.isArray(parsed)) return { ok: false, issues: [] };
  return {
    ok: true,
    issues: parsed.map(i => ({
      number: i.number ?? i.iid ?? null,
      title: i.title || '',
      state: normalizeIssueState(i.state)
    }))
  };
}

/**
 * Ensure the layered-intelligence labels exist before the first `issue create`
 * (gh/glab both fail creating an issue with a non-existent label). Idempotent —
 * `--force` (gh) / re-create (glab) is a no-op when the label already exists.
 */
export async function ensureForgeLabels({ cli, cwd, env, exec = runCli } = {}) {
  const labels = [
    { name: LI_LABEL, color: '1d76db', desc: 'Filed by the Layered Intelligence loop' },
    { name: LI_BLOCKING_LABEL, color: 'b60205', desc: 'Layered Intelligence loop is paused on this issue' }
  ];
  for (const l of labels) {
    if (cli === 'glab') {
      await exec(cli, ['label', 'create', '--name', l.name, '--color', `#${l.color}`, '--description', l.desc], { cwd, env });
    } else {
      await exec(cli, ['label', 'create', l.name, '--color', l.color, '--description', l.desc, '--force'], { cwd, env });
    }
  }
}

/**
 * File ONE proposal issue on a forge (gh/glab). Ensures labels first, embeds the
 * slug marker in the body, and returns `{ success, number, url }`. The issue
 * number is parsed from the created URL's trailing digits.
 */
export async function fileProposalToForge({ cli, cwd, env, title, body, slug, exec = runCli } = {}) {
  await ensureForgeLabels({ cli, cwd, env, exec });
  const fullBody = `${body}\n\n${slugMarker(slug)}`;
  const args = cli === 'glab'
    ? ['issue', 'create', '--title', title, '--description', fullBody, '--label', LI_LABEL]
    : ['issue', 'create', '--title', title, '--body', fullBody, '--label', LI_LABEL];
  const { code, stdout, stderr } = await exec(cli, args, { cwd, env });
  if (code !== 0) return { success: false, error: stderr || `${cli} exited with code ${code}` };
  const urlMatch = stdout.trim().match(/(https?:\/\/\S+)/);
  const url = urlMatch ? urlMatch[1] : stdout.trim();
  const numMatch = url.match(/(\d+)\s*$/);
  return { success: true, number: numMatch ? Number(numMatch[1]) : null, url };
}

/** Apply the blocking label to an existing issue (pause). Returns `{ success }`. */
export async function applyBlockingLabel({ cli, cwd, env, number, exec = runCli } = {}) {
  if (!Number.isInteger(number)) return { success: false, error: 'no issue number' };
  const args = cli === 'glab'
    ? ['issue', 'update', String(number), '--label', LI_BLOCKING_LABEL]
    : ['issue', 'edit', String(number), '--add-label', LI_BLOCKING_LABEL];
  const { code, stderr } = await exec(cli, args, { cwd, env });
  return code === 0 ? { success: true } : { success: false, error: stderr };
}
