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
import { execGlab, execGlabJson } from './gitlab.js';
import { resolveForgeExecOptions } from './forgeExecOptions.js';
import { resolveAppForgeTarget } from '../lib/workTracker.js';
import { safeJSONParse } from '../lib/fileUtils.js';
import { CONTRIBUTOR_LABELS } from '../lib/dispatchLabels.js';
import { withGlabJson } from '../lib/glabArgs.js';
import { ServerError, boundedErrorMessage } from '../lib/errorHandler.js';
import { forgeIssueCreateArgs, forgeLabelCreateArgs, parseCreatedForgeIssue } from '../lib/forgeIssueCli.js';
import { scrubHomePath } from '../lib/homePath.js';
import { scrubSecretTokens } from '../lib/secretText.js';

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
 * Forge label colors arrive bare (`d73a4a`) or `#`-prefixed (`#d73a4a`);
 * the UI needs the `#rrggbb` form `chipColors`/`parseColor` accepts.
 */
const normalizeLabelColor = (color) => (
  color ? `#${String(color).replace(/^#/, '')}` : null
);

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
        color: normalizeLabelColor(l.color),
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
 *
 * String labels carry no color of their own — they are joined against the
 * name-keyed map built from `glab label list` (see `buildGitlabLabelMap`), so
 * the tab renders forge colors instead of the neutral fallback. A label absent
 * from the map keeps `color: null` and renders neutral, exactly as before.
 */
function normalizeGitlabIssue(issue, labelMap = null) {
  return {
    number: issue.iid,
    title: issue.title || '',
    body: truncateBody(issue.description),
    url: issue.web_url || '',
    labels: Array.isArray(issue.labels)
      ? issue.labels
        .map((l) => {
          if (typeof l === 'string') {
            const known = labelMap?.get(l);
            return known ? { name: l, ...known } : { name: l, color: null, description: '' };
          }
          return { name: l?.name || '', color: normalizeLabelColor(l?.color), description: l?.description || '' };
        })
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
 * Build the name-keyed `{ color, description }` map `normalizeGitlabIssue`
 * joins string labels against, from a `glab label list` row list. GitLab
 * colors use the same `#rrggbb` form GitHub normalizes to, so they go through
 * the same prefixing. First row wins on duplicate names.
 */
function buildGitlabLabelMap(labelRows) {
  const map = new Map();
  for (const row of labelRows) {
    const name = row?.name;
    if (!name || map.has(name)) continue;
    map.set(name, { color: normalizeLabelColor(row?.color), description: row?.description || '' });
  }
  return map;
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
async function fetchGithubIssues(repoSpec, apiHost, { repoPath = null, forgeAccount = null } = {}) {
  const { cwd, env, customEnv } = await resolveForgeExecOptions(repoPath, { forgeAccount });

  const forge = await ensureForgeReachable('app-issues', {
    hostname: apiHost,
    ...(customEnv ? { env: customEnv } : {}),
  });
  if (!forge.ok) {
    return { issues: [], reason: `gh-${forge.status}`, transient: true, remedy: forge.remedy || null };
  }
  // execGh REJECTS on failure; normalize to null so the parse below is the only
  // guard.
  const raw = await execGh([
    'issue', 'list', '--repo', repoSpec, '--state', 'open',
    '--limit', String(GH_LIST_LIMIT),
    '--json', 'number,title,body,labels,assignees,author,milestone,url,updatedAt,comments',
  ], undefined, { cwd, env }).catch((err) => {
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
  if (!rows) {
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
  // Best-effort color enrichment, same cwd the issue list resolved its project
  // from (so enterprise/custom-host repos get it too — no hostname gating).
  // A failed lookup must never become a whole-tab failure: unknown labels keep
  // `color: null` and the issue list is returned untouched.
  const labelLookup = await execGlabJson(['label', 'list', '--per-page', String(GL_PER_PAGE)], repoPath);
  const labelMap = labelLookup.rows ? buildGitlabLabelMap(labelLookup.rows) : null;
  return toIssueResult(rows, (issue) => normalizeGitlabIssue(issue, labelMap));
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
    ? await fetchGithubIssues(target.repoSpec, target.apiHost, { repoPath: app.repoPath, forgeAccount: app.forgeAccount })
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

/** Release contributor invitations before a manual targeted claim can be queued. */
export async function prepareAppIssueClaim(app, issueNumber, tracker) {
  const { tracker: resolvedTracker, target } = await resolveAppForgeTarget(app);
  if (!target || resolvedTracker !== tracker || target.forge !== tracker) {
    throw new ServerError('Could not resolve the issue tracker for this claim', { status: 400, code: 'CLAIM_TRACKER_MISMATCH' });
  }
  const { cwd, env } = await resolveForgeExecOptions(
    tracker === 'github' ? app?.repoPath : null,
    { forgeAccount: app?.forgeAccount }
  );

  const readLabels = async () => {
    const raw = tracker === 'github'
      ? await execGh(['issue', 'view', issueNumber, '--repo', target.repoSpec, '--json', 'labels'], undefined, { cwd, env })
      : await execGlab(withGlabJson(['issue', 'view', issueNumber]), app.repoPath, undefined, { rejectOnError: true });
    const issue = safeJSONParse(raw, null);
    if (!Array.isArray(issue?.labels) || issue.labels.some(label => typeof label !== 'string' && typeof label?.name !== 'string')) {
      throw new ServerError('Could not read issue labels before claiming', { status: 502, code: 'CLAIM_LABELS_UNAVAILABLE' });
    }
    return issue.labels.map(label => typeof label === 'string' ? label : label.name)
      .filter(name => CONTRIBUTOR_LABELS.includes(name.toLowerCase()));
  };
  const labels = await readLabels();
  if (!labels.length) return;
  if (tracker === 'github') {
    await execGh(['issue', 'edit', issueNumber, '--repo', target.repoSpec,
      ...labels.flatMap(label => ['--remove-label', label])], undefined, { cwd, env });
  } else {
    await execGlab(['issue', 'update', issueNumber, '--unlabel', labels.join(',')], app.repoPath, undefined, { rejectOnError: true });
  }
  if ((await readLabels()).length) {
    throw new ServerError('Contributor labels remain on the issue; claim was not queued', { status: 502, code: 'CLAIM_LABELS_REMAIN' });
  }
}

/**
 * The last thing that happens to a title/body before any filer's issue reaches
 * a forge. A filed issue is world-readable the moment it lands, so the strip
 * has to be enforced mechanically rather than trusted to each caller's own
 * copy (#7687 — three filers had re-implemented this, and only two called it).
 * `scrubHomePath` collapses the running user's home prefix (which embeds the OS
 * username in `/Users/<name>/…`); `scrubSecretTokens` replaces credential-shaped
 * substrings. Neither is a content filter — deciding whether a sentence names a
 * private record is not mechanically decidable, so that stays a prompt
 * instruction for the callers that reach an LLM. Both helpers pass a non-string
 * through untouched.
 *
 * Exported (not just used internally by `fileForgeIssue`) because a filer that
 * needs to scrub text for a NON-forge tracker in the same request — JIRA,
 * today — still needs one shared definition to call.
 */
export const scrubForgeIssueText = (value) => scrubSecretTokens(scrubHomePath(value));

/**
 * Refuse to proceed against an unreachable GitHub forge, in the `{ ok, error }`
 * shape every filer already returns on refusal. GitLab has no equivalently
 * cheap reachability probe (`ensureForgeReachable` is gh-specific), so a
 * non-`gh` cli is always reported reachable. One definition instead of the
 * two near-duplicate inline blocks `persistentMindIssueCapability.js` and
 * `goalFidelityFollowUp.js` each carried (#7687). `forgeFiler.js`'s callers
 * don't currently resolve a hostname to pass in, so this doesn't by itself
 * close that filer's reachability gap — tracked in #7695.
 */
export async function probeForgeReachability({ cli, hostname, env = null, label }) {
  if (cli !== 'gh' || !hostname) return { ok: true };
  const forge = await ensureForgeReachable(label, { hostname, env });
  if (forge.ok) return { ok: true };
  return { ok: false, error: `GitHub is not reachable (${forge.status}); ${forge.remedy || 'check `gh auth status`'}` };
}

/**
 * Adapt `execGh`/`execGlab` (this module's own spawn primitives) to the
 * `(cli, args, { cwd, env }) => { code, stdout, stderr }` shape the Layered
 * Intelligence loop's `runCli` already uses and never rejects — so
 * `fileForgeIssue` reads one result shape regardless of which CLI answered,
 * and a caller that already has an injectable exec (`runCli`, or a test
 * double shaped like it) can pass it straight through instead.
 */
async function execForgeIssueCli(cli, args, { cwd, env } = {}) {
  const run = cli === 'glab'
    ? execGlab(args, cwd, undefined, { env, rejectOnError: true })
    : execGh(args, undefined, { cwd, env });
  return run.then(
    (stdout) => ({ code: 0, stdout: stdout || '', stderr: '' }),
    (error) => ({ code: 1, stdout: '', stderr: error?.message || String(error) }),
  );
}

/**
 * Create every label an issue is about to carry, before the issue itself.
 * Both CLIs 422 the whole `issue create` on an undefined label, so this always
 * runs first. One label-failure policy for every filer (#7687) — including
 * `applyBlockingLabel`'s own label-only path in `forgeFiler.js`, which delegates
 * here rather than re-running its own "already exists" check: an "already
 * exists" reply is expected and fine (label creation is otherwise idempotent),
 * anything else aborts the file — a permission or auth problem should surface
 * now rather than let the caller proceed to a create that is doomed anyway (or,
 * worse, silently ships without the label a caller assumed would exist).
 * Returns the first hard-failure message, or `null` when every label is ready.
 */
export async function ensureForgeIssueLabels({ cli, exec, cwd, env, repo = null, labels }) {
  const results = await Promise.all(labels.map(async (spec) => {
    const { code, stdout, stderr } = await exec(cli, forgeLabelCreateArgs(cli, spec, { repo }), { cwd, env });
    if (code === 0) return null;
    if (/already exists/i.test(`${stderr || ''}\n${stdout || ''}`)) return null;
    return boundedErrorMessage(new Error(stderr || `${cli} label create failed for "${spec.name}"`), `Could not create label "${spec.name}"`);
  }));
  return results.find(Boolean) || null;
}

/**
 * File one issue on a forge — the exec half every filer needs (#7687): probe
 * reachability, ensure each label exists, create the issue, and parse its
 * number/url back out — scrubbing the title/body by construction rather than
 * trusting each caller to remember to.
 *
 * Primitive-first on purpose rather than `{ app, target }`: `forgeFiler.js`
 * (the Layered Intelligence loop) never resolved either shape — it only ever
 * had `cli`/`cwd`/`env` and its own injectable `exec` — so this accepts what
 * every caller already has instead of forcing one caller's resolution shape
 * onto the other two. `persistentMindIssueCapability.js` and
 * `goalFidelityFollowUp.js` keep their own early reachability probe (via the
 * same `probeForgeReachability` this uses) ahead of their pre-file duplicate
 * check — an unreachable forge should short-circuit before that read, not
 * after — so they omit `hostname` here to avoid probing twice.
 *
 * @param {object} args
 * @param {'gh'|'glab'} args.cli
 * @param {string} [args.cwd] - spawn cwd/env context for `gh` (irrelevant once `repo` is set)
 * @param {object} [args.env]
 * @param {string|null} [args.repo] - `gh --repo` selector; unused for `glab`, which resolves from cwd
 * @param {string|null} [args.repoPath] - repo checkout root `glab` must run in; falls back to `cwd`
 * @param {string|null} [args.hostname] - github API host to probe; omit to skip the probe (already done, or non-github)
 * @param {string} args.title
 * @param {string} args.body
 * @param {{name:string, color:string, description:string}[]} [args.labels] - applied to the issue AND created first
 * @param {(cli:string, args:string[], opts:object) => Promise<{code:number, stdout:string, stderr:string}>} [args.exec]
 * @returns {Promise<{ok:true, number:number|null, url:string}|{ok:false, error:string}>}
 */
export async function fileForgeIssue({
  cli, cwd = undefined, env = undefined, repo = null, repoPath = null,
  hostname = null, title, body, labels = [], exec = execForgeIssueCli,
} = {}) {
  const probe = await probeForgeReachability({ cli, hostname, env, label: 'file-forge-issue' });
  if (!probe.ok) return { ok: false, error: probe.error };

  const execCwd = cli === 'glab' ? (repoPath ?? cwd) : cwd;
  const labelError = await ensureForgeIssueLabels({ cli, exec, cwd: execCwd, env, repo, labels });
  if (labelError) return { ok: false, error: labelError };

  const args = forgeIssueCreateArgs(cli, {
    title: scrubForgeIssueText(title),
    body: scrubForgeIssueText(body),
    labels: labels.map((spec) => spec.name),
    repo: cli === 'glab' ? null : repo,
  });
  const { code, stdout, stderr } = await exec(cli, args, { cwd: execCwd, env });
  if (code !== 0) {
    return { ok: false, error: boundedErrorMessage(new Error(stderr || `${cli} exited with code ${code}`), 'Issue creation failed') };
  }
  return { ok: true, ...parseCreatedForgeIssue(stdout) };
}
