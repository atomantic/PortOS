/**
 * Open-issue listing for a managed app's Issues tab.
 *
 * Distinct from `workItems.js`, which answers "what could `/do:next` CLAIM?" —
 * that list is deliberately narrowed (assigned / blocked / in-flight / decomposed-epic
 * issues are filtered out) and carries only `{ ref, title }`. The Issues tab
 * shows the tracker as it actually is: EVERY open issue, with the labels,
 * assignees, and body the user reads before deciding to claim one.
 *
 * Forge-agnostic. The origin→forge classification is `resolveRepoForgeTarget`
 * (shared with the issue reconciler) so "which repo do we query" has exactly one
 * definition: github.* → `gh`, gitlab.* → `glab`, anything else → null. JIRA is
 * NOT handled here — JIRA-tracked apps have their own tab with the sprint board.
 *
 * Crucially the tab lists ONLY the tracker a claim would actually run against
 * (see `listAppIssues`), so the Claim button can never queue a run against a
 * tracker other than the one the user is looking at.
 *
 * Sentinel discipline (AGENTS.md): "couldn't ask the forge" never collapses into
 * "there are no issues". A failed probe returns `issues: []` WITH
 * `transient: true`, a `reason`, and the `headline`/`remedy` that describe it, so
 * the UI says "couldn't load" instead of the lie "no open issues" — and says WHY
 * without guessing, since the classifier is the only thing that knows.
 */

import { execGh, ensureForgeReachable } from './github.js';
import { execGlabJson } from './gitlab.js';
import { resolveAppForgeTarget } from '../lib/workTracker.js';
import { safeJSONParse } from '../lib/fileUtils.js';

// Single-user repos never realistically exceed this; `glab` caps a page at 100.
const GH_LIST_LIMIT = 200;
const GL_PER_PAGE = 100;

// Issue bodies are rendered in an expandable panel, not a full markdown reader —
// cap what we ship so a novel-length issue can't bloat the payload.
const BODY_MAX_CHARS = 8000;

const truncateBody = (body) => {
  const text = typeof body === 'string' ? body : '';
  return text.length > BODY_MAX_CHARS ? `${text.slice(0, BODY_MAX_CHARS)}\n\n…(truncated)` : text;
};

/**
 * Normalize a raw `gh issue list --json` row into the common issue shape.
 * GitHub labels carry a hex `color` with no `#`; the UI needs it prefixed.
 *
 * `gh` has no scalar comment-count field — its `comments` field is the full
 * comment array — so the count is derived here and the bodies are dropped
 * rather than shipped to a UI that only renders a number.
 */
function normalizeGithubIssue(issue) {
  return {
    number: issue.number,
    title: issue.title || '',
    body: truncateBody(issue.body),
    url: issue.url || '',
    labels: Array.isArray(issue.labels)
      ? issue.labels.filter(Boolean).map((l) => ({
        name: l.name || '',
        color: l.color ? `#${String(l.color).replace(/^#/, '')}` : null,
        description: l.description || '',
      })).filter((l) => l.name)
      : [],
    assignees: Array.isArray(issue.assignees)
      ? issue.assignees.map((a) => a?.login).filter(Boolean)
      : [],
    author: issue.author?.login || null,
    milestone: issue.milestone?.title || null,
    updatedAt: issue.updatedAt || null,
    commentCount: Array.isArray(issue.comments) ? issue.comments.length : 0,
  };
}

/**
 * Normalize a raw `glab issue list --output json` row. GitLab keys the number on
 * `iid` and assignees/author on `username`. Labels are plain strings on current
 * `glab`, but the object form is tolerated too — the JSON label shape has varied
 * across glab versions, and a silently-dropped label list is worse than an
 * unused branch. GitLab counts discussion in `user_notes_count` (system notes
 * excluded), which is already the scalar the UI wants.
 */
function normalizeGitlabIssue(issue) {
  return {
    number: issue.iid,
    title: issue.title || '',
    body: truncateBody(issue.description),
    url: issue.web_url || '',
    labels: Array.isArray(issue.labels)
      ? issue.labels
        .map((l) => (typeof l === 'string' ? { name: l, color: null, description: '' }
          : { name: l?.name || '', color: l?.color || null, description: l?.description || '' }))
        .filter((l) => l.name)
      : [],
    assignees: Array.isArray(issue.assignees)
      ? issue.assignees.map((a) => a?.username).filter(Boolean)
      : [],
    author: issue.author?.username || null,
    milestone: issue.milestone?.title || null,
    updatedAt: issue.updated_at || null,
    commentCount: Number.isFinite(issue.user_notes_count) ? issue.user_notes_count : 0,
  };
}

/**
 * Classify an ANSWERED row list. The absent-vs-empty split is the whole point —
 * a CLI that answered with zero rows is the definitive `no-open-issues`, never
 * conflated with a read we couldn't make.
 */
function toIssueResult(rows, normalize) {
  return { issues: rows.map(normalize), reason: rows.length ? 'ok' : 'no-open-issues', transient: false };
}

/**
 * Open issues from GitHub. `repoSpec` is the host-qualified `HOST/OWNER/REPO`
 * selector so enterprise repos resolve correctly and a fork+upstream checkout
 * stays deterministic. The reachability probe runs first: without it an
 * unreachable `gh` returns an empty page that reads as "no open issues".
 */
async function fetchGithubIssues(repoSpec, apiHost) {
  const forge = await ensureForgeReachable('app-issues', { hostname: apiHost });
  if (!forge.ok) {
    return { issues: [], reason: `gh-${forge.status}`, transient: true, remedy: forge.remedy || null };
  }
  // execGh REJECTS on failure; normalize to null so the parse below is the only
  // guard.
  const raw = await execGh([
    'issue', 'list', '--repo', repoSpec, '--state', 'open',
    '--limit', String(GH_LIST_LIMIT),
    '--json', 'number,title,body,labels,assignees,author,milestone,url,updatedAt,comments',
  ]).catch((err) => {
    console.error(`❌ app-issues: gh issue list failed for ${repoSpec}: ${err.message}`);
    return null;
  });
  const rows = safeJSONParse(raw, null);
  if (!Array.isArray(rows)) {
    return {
      issues: [], reason: 'fetch-failed', transient: true,
      headline: 'Couldn\'t read GitHub\'s issue list',
      remedy: 'run `gh issue list` in the repo to see what gh reports',
    };
  }
  return toIssueResult(rows, normalizeGithubIssue);
}

/**
 * Open issues from GitLab. `glab` resolves the project from the origin remote in
 * its working directory, so every call runs in `repoPath`.
 *
 * glab's two failure modes get two different sentences, because they send the
 * user to two different places: `cli-failed` really can be an unauthenticated or
 * unreachable CLI, while `not-json` means glab answered fine and only its output
 * flags moved. Collapsing the latter into the reachability framing is what told
 * an authenticated user to "retry once the CLI is authenticated".
 */
async function fetchGitlabIssues(repoPath) {
  // `glab issue list` defaults to OPEN issues.
  const { rows, reason } = await execGlabJson(['issue', 'list', '--per-page', String(GL_PER_PAGE)], repoPath);
  if (rows) return toIssueResult(rows, normalizeGitlabIssue);
  if (reason === 'not-json') {
    return {
      issues: [], reason: 'glab-output-not-json', transient: true,
      headline: "Reached GitLab, but couldn't read its answer",
      remedy: 'update `glab` — its JSON output flag moved (check `glab issue list --help`)',
    };
  }
  return {
    issues: [], reason: 'fetch-failed', transient: true,
    headline: "Couldn't reach GitLab",
    remedy: 'check `glab auth status` and that `glab` is installed and can reach the host',
  };
}

/**
 * List the open issues on the forge this app's work actually lives on.
 *
 * The listed tracker MUST be the one a claim would run against, so this gates on
 * the app's RESOLVED work tracker (`resolveAppWorkTracker`) — not on the git
 * origin alone. `workTracker` is user-settable, and `resolveWorkTracker`
 * short-circuits on an explicit value before consulting the host: an app with a
 * GitHub origin but `workTracker: 'jira'` claims JIRA tickets, so listing its
 * GitHub issues here would offer a Claim button that queues `claim-issue-jira`
 * against a ticket key that doesn't exist. Same resolver as
 * `buildClaimWorkTask`, so the list and the claim agree by construction.
 *
 * The forge-target probe needs the RESOLVED tracker first (see
 * `resolveRepoForgeTarget`'s `preferredForge`, which lets an explicitly-pinned
 * github/gitlab tracker reach a self-hosted forge whose hostname doesn't spell
 * out "github."/"gitlab."), so both reads run through the composed
 * `resolveAppForgeTarget` rather than being threaded by hand here — the same
 * helper `issueReconcile.js` uses, so the tab and the zombie scan can't drift on
 * which forge a pinned custom-host app resolves to. It resolves the target even
 * for a plan/jira tracker (one extra origin read); the tracker gate below still
 * refuses to list anything for those, since a claim wouldn't touch it.
 *
 * @param {object} app - managed app record (needs `repoPath`, `workTracker`)
 * @returns {Promise<{forge:'github'|'gitlab'|null, tracker:string|null, fullName:string|null, issues:object[], reason:string, transient:boolean, headline:string|null, remedy:string|null}>}
 */
export async function listAppIssues(app) {
  const base = { forge: null, tracker: null, fullName: null, issues: [], transient: false, headline: null, remedy: null };
  if (!app?.repoPath) return { ...base, reason: 'no-repo-path' };

  const { tracker, target } = await resolveAppForgeTarget(app);

  // PLAN.md / JIRA apps have no forge issue list — and, more importantly, no
  // claim this tab could honestly offer.
  if (tracker !== 'github' && tracker !== 'gitlab') return { ...base, tracker, reason: 'tracker-not-a-forge' };

  if (!target) return { ...base, tracker, reason: 'unsupported-forge' };
  // Explicitly tracking one forge from the other's remote: we can't query the
  // configured tracker (no selector for it) and must not silently list the
  // other one, since that is not what a claim would touch.
  if (target.forge !== tracker) return { ...base, tracker, reason: 'tracker-forge-mismatch' };

  const result = tracker === 'github'
    ? await fetchGithubIssues(target.repoSpec, target.apiHost)
    : await fetchGitlabIssues(app.repoPath);

  return {
    forge: target.forge,
    tracker,
    fullName: target.fullName,
    issues: result.issues,
    reason: result.reason,
    transient: result.transient,
    // Headline + remedy ride WITH the reason, so the sentence and the state it
    // describes cannot drift apart across the HTTP boundary (mirrors
    // github.js#ghRemedy). The client renders them; it never re-derives them.
    headline: result.headline || null,
    remedy: result.remedy || null,
  };
}
