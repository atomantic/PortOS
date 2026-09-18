/**
 * Forge-issue capability for the persistent mind.
 *
 * Queueing work through `cos.create-task` needs a coding agent on this machine.
 * Plenty of installs have none — but almost every install can still reach a
 * GitHub or GitLab tracker, and an issue filed there is durable, reviewable, and
 * claimable later by `/do:next`, a human, or a peer machine that DOES have an
 * agent. So this capability is the preferred queueing lane whenever the mind is
 * not itself going to dispatch the work.
 *
 * The grant is re-checked after inference (like every other typed action), and
 * the target app is re-validated against the mind's managed-app allowlist and
 * its resolved work tracker through `persistentMindManagedApps` — the same
 * roster the task grant reads, so the tracker the mind writes to is the tracker
 * a claim would read from.
 */

import { execGh, ensureForgeReachable } from './github.js';
import { execGlab } from './gitlab.js';
import { loadState } from './cosState.js';
import { listAppIssues } from './appIssues.js';
import { readPersistentMindManagedApps } from './persistentMindManagedApps.js';
import { normalizePersistentMindCapabilities } from '../lib/persistentMindCapabilities.js';
import { normalizePersistentMindProfile } from '../lib/persistentMindProfile.js';
import {
  DISPATCH_EFFORT_LEVELS, DISPATCH_MODEL_TIERS,
  dispatchLabelSpec, forgeIssueLabels, resolvePlannerId,
} from '../lib/dispatchLabels.js';
import { forgeIssueCreateArgs, forgeLabelCreateArgs, parseCreatedForgeIssue } from '../lib/forgeIssueCli.js';
import { forgeCliForTracker } from '../lib/workTracker.js';
import { boundedByJsonChars } from '../lib/objects.js';
import { boundedErrorMessage } from '../lib/errorHandler.js';
import { scrubHomePath } from '../lib/homePath.js';
import { scrubSecretTokens } from '../lib/secretText.js';
import {
  PERSISTENT_MIND_ISSUE_EXTRA_LABEL_SPECS,
  PERSISTENT_MIND_ISSUE_CATEGORY_LABELS,
  PERSISTENT_MIND_ISSUE_LABEL,
  PERSISTENT_MIND_ISSUE_LIMITS,
  normalizeIssueTitleKey,
} from '../lib/persistentMindIssues.js';

const MAX_CATALOG_PROMPT_CHARS = 2_000;

/**
 * The last thing that happens to a title/body before `gh`/`glab` sees it.
 *
 * The capability's Settings guardrail asserts that no repository paths or
 * credentials ride along, and a filed issue is world-readable the moment it
 * lands — so the assertion has to be ENFORCED here rather than trusted to the
 * prompt above. Both halves are mechanically decidable and already have one
 * definition in the tree: `scrubHomePath` collapses the running user's home
 * prefix (which is what embeds the OS username in `/Users/<name>/…`), and
 * `scrubSecretTokens` replaces credential-SHAPED substrings. Neither is a
 * content filter — "no private records" stays a prompt instruction, because no
 * regex can decide whether a sentence of the mind's own prose is one, and the
 * guardrail text now says exactly that rather than promising more.
 *
 * Applied to the TITLE as well as the body: the title is what a duplicate check
 * on any other machine reads back, and a leaked path there is just as public.
 *
 * Both helpers pass a non-string through untouched, so this adds no coercion of
 * its own — the tool schema already requires both fields to be strings.
 */
const scrubForgeText = (value) => scrubSecretTokens(scrubHomePath(value));

const labelSpec = (name, cli) => dispatchLabelSpec(name, { cli })
  || (PERSISTENT_MIND_ISSUE_EXTRA_LABEL_SPECS[name]
    ? { name, ...PERSISTENT_MIND_ISSUE_EXTRA_LABEL_SPECS[name] }
    : null);

/**
 * The apps this mind may file against: granted by the managed-app allowlist AND
 * resolving to a forge. A `plan`/`jira` app is omitted rather than
 * listed-and-refused — the mind should not spend a call discovering that.
 */
export async function readPersistentMindIssueCatalog({ allowedAppIds } = {}) {
  const apps = await readPersistentMindManagedApps({ allowedAppIds });
  return {
    apps: apps
      .filter((app) => app.forge && app.granted)
      .map(({ id, name, forge, fullName }) => ({ id, name, forge, fullName })),
  };
}

export function buildPersistentMindIssueCapabilityPrompt({ enabled, catalog = { apps: [] } } = {}) {
  if (!enabled) {
    return `# Issue tracker capability
Issue filing access is OFF. Do not call issues.list or issues.file, and never claim an issue was filed.`;
  }
  const apps = boundedByJsonChars(catalog.apps, MAX_CATALOG_PROMPT_CHARS);
  if (apps.length === 0) {
    return `# Issue tracker capability
Issue filing access is ON, but no authorized managed app currently resolves to a GitHub or GitLab tracker, so there is nothing you can file against this wake. Say so rather than claiming work was queued.`;
  }
  return `# Issue tracker capability
Issue filing access is ON. Filing an issue is the PREFERRED way to queue concrete work: an issue is durable, a human can read and re-scope it, and a coding agent can claim it later even on a machine that has none attached right now. Prefer it over describing work only in conversation, and use it instead of a CoS task whenever you are not the one dispatching the work.

Read before you write. Call issues.list for the target app first and skip anything already tracked; duplicates are refused on an exact title match, but a near-duplicate still wastes the backlog.

File with issues.file. Write the body so someone can pick it up cold: what is wrong or missing, where in the repo, why it matters now, and the chosen fix. Do not file speculative or future-only refactors.

A filed issue is world-readable. Write the title and body in your own prose and never paste in a secret, an absolute filesystem path, a hostname, network address, personal name, contact detail, or the contents of a private record — refer to a file by its repo-relative path instead. Home-directory prefixes and credential-shaped strings are stripped before filing, but that scrub cannot recognize a private record, so keeping one out is on you.

Both dispatch axes are required and independent — never derive one from the other, and do not stamp medium on both by reflex:
- model: ${DISPATCH_MODEL_TIERS.join(', ')} — the CAPABILITY the work needs, from mechanical (a rename, a config change, a well-specified single-file edit) through routine multi-file work and genuinely hard reasoning (concurrency, schema/compatibility design, redesign) to exceptional frontier reasoning.
- effort: ${DISPATCH_EFFORT_LEVELS.join(', ')} — the REASONING BUDGET per step, independent of the model. A mechanical sweep across many call sites is the lowest model tier at the highest effort; a two-line change hinging on one idea is a high model tier at low effort.

Optional category labels: ${Object.keys(PERSISTENT_MIND_ISSUE_CATEGORY_LABELS).join(', ')}. Every issue you file is additionally marked '${PERSISTENT_MIND_ISSUE_LABEL}' and attributed to the model that planned it.

Authorized apps (ids are authoritative; do not invent ids):
${JSON.stringify(apps)}`;
}

/**
 * Re-check the live grant and resolve the forge for one request. Returns
 * `{ error }` for every refusal so the caller renders one bounded message.
 */
const resolveTarget = async (appId) => {
  const root = await loadState();
  const capabilities = normalizePersistentMindCapabilities(root.config?.persistentMindCapabilities);
  if (!capabilities.fileIssues) return { error: 'Persistent mind issue access is disabled' };
  const app = (await readPersistentMindManagedApps()).find((candidate) => candidate.id === appId);
  if (!app) return { error: `App '${appId}' has no configured repository` };
  if (!app.granted) {
    return { error: `Managed app '${appId}' is not authorized for Persistent Mind work; update Persistent Mind Tools permissions` };
  }
  if (!app.forge) {
    return { error: `App '${appId}' has no GitHub or GitLab issue list; check its work tracker and git remote` };
  }
  return { app, root };
};

/** Open issues on the app's tracker, projected down to what a prompt can use. */
export async function listPersistentMindIssues(args) {
  const { app, error } = await resolveTarget(args.appId);
  if (error) return { ok: false, error };
  const result = await listAppIssues(app);
  if (result.transient) {
    return { ok: false, error: `Could not read the ${app.forge} issue list (${result.reason}); ${result.remedy || 'retry once the forge CLI is reachable'}` };
  }
  const search = args.search ? args.search.toLowerCase() : null;
  const limit = args.limit || PERSISTENT_MIND_ISSUE_LIMITS.defaultListLimit;
  const issues = result.issues
    .filter((issue) => !args.label || issue.labels.some((label) => label.name === args.label))
    .filter((issue) => !search || `${issue.title}\n${issue.body}`.toLowerCase().includes(search))
    .slice(0, limit)
    .map((issue) => ({
      number: issue.number,
      title: issue.title,
      url: issue.url,
      labels: issue.labels.map((label) => label.name),
      assignees: issue.assignees,
      updatedAt: issue.updatedAt,
      bodyPreview: String(issue.body || '').slice(0, PERSISTENT_MIND_ISSUE_LIMITS.bodyPreviewChars),
    }));
  return {
    ok: true,
    appId: args.appId,
    forge: app.forge,
    repository: result.fullName,
    issues,
    // The tracker's real open count, so a truncated page never reads as the
    // whole backlog when the mind checks for an existing item.
    totalOpen: result.issues.length,
    truncated: result.issues.length > issues.length,
  };
}

/**
 * Create the labels this issue needs before creating the issue. Both CLIs fail
 * the whole `issue create` with a 422 when a named label does not exist, and
 * creation is idempotent, so this always runs first. The calls are independent
 * and every failure is swallowed — a label we could not create resurfaces as
 * the create's own error if it actually mattered — so they run concurrently
 * rather than adding a serial spawn per label to every file.
 */
const ensureLabels = async ({ app, names }) => {
  const cli = forgeCliForTracker(app.forge);
  await Promise.all(names.map((name) => {
    const spec = labelSpec(name, cli);
    if (!spec) return null;
    return (cli === 'glab'
      ? execGlab(forgeLabelCreateArgs(cli, spec), app.repoPath)
      : execGh(forgeLabelCreateArgs(cli, spec, { repo: app.repoSpec }))).catch(() => null);
  }));
};

const createIssue = ({ app, title, body, labels }) => {
  const cli = forgeCliForTracker(app.forge);
  const args = forgeIssueCreateArgs(cli, {
    title, body, labels, repo: cli === 'glab' ? null : app.repoSpec,
  });
  const run = cli === 'glab'
    ? execGlab(args, app.repoPath, undefined, { rejectOnError: true })
    : execGh(args);
  return run.then(
    (stdout) => ({ ok: true, ...parseCreatedForgeIssue(stdout) }),
    (error) => ({ ok: false, error: boundedErrorMessage(error, 'Issue creation failed') }),
  );
};

/** File one issue on the app's tracker. */
export async function filePersistentMindIssue(args) {
  const { app, root, error } = await resolveTarget(args.appId);
  if (error) return { ok: false, error };

  // The reachability probe runs before anything is created: on an unreachable
  // forge this is one failing call instead of a whole label fan-out that each
  // has to time out first.
  if (app.forge === 'github') {
    const forge = await ensureForgeReachable('mind-issue-file', { hostname: app.apiHost });
    if (!forge.ok) return { ok: false, error: `GitHub is not reachable (${forge.status}); ${forge.remedy || 'check `gh auth status`'}` };
  }

  // Duplicate guard. A failed read must NOT read as "nothing is tracked" — that
  // is exactly how a transient `gh` blip files the same issue twice — so an
  // unreadable tracker refuses the file rather than proceeding blind.
  const existing = await listAppIssues(app);
  if (existing.transient) {
    return { ok: false, error: `Could not read the existing ${app.forge} issues to check for duplicates (${existing.reason}); nothing was filed` };
  }
  // Scrubbed BEFORE the duplicate check, not just before the create: the title
  // that dedupes has to be the title that gets filed, or an issue whose only
  // leaked path was in its title would re-file itself on every wake.
  const title = scrubForgeText(args.title);
  const body = scrubForgeText(args.body);

  // An all-punctuation title normalizes to the empty string, which would match
  // every other such title — only a title with real content can dedupe.
  const titleKey = normalizeIssueTitleKey(title);
  const duplicate = titleKey
    && existing.issues.find((issue) => normalizeIssueTitleKey(issue.title) === titleKey);
  if (duplicate) {
    return {
      ok: true, duplicate: true, number: duplicate.number, url: duplicate.url,
      summary: `Issue #${duplicate.number} already tracks this work; nothing new was filed`,
    };
  }

  const profile = normalizePersistentMindProfile(root.config?.persistentMindProfile);
  const labels = [
    PERSISTENT_MIND_ISSUE_LABEL,
    ...forgeIssueLabels({
      cli: forgeCliForTracker(app.forge),
      model: args.model,
      effort: args.effort,
      // The planner axis records who WROTE the plan — this mind's own model —
      // and is independent of the model:/effort: dispatch hints above.
      planner: resolvePlannerId({ providerId: profile.providerId, model: profile.model }),
    }),
    ...(args.labels || []),
  ].filter((name, index, all) => all.indexOf(name) === index);
  await ensureLabels({ app, names: labels });

  const created = await createIssue({ app, title, body, labels });
  if (!created.ok) return created;
  return {
    ok: true,
    duplicate: false,
    appId: args.appId,
    forge: app.forge,
    repository: app.fullName,
    number: created.number,
    url: created.url,
    labels,
    summary: `Filed ${created.number ? `#${created.number}` : 'an issue'} on ${app.fullName || app.forge}`,
  };
}
