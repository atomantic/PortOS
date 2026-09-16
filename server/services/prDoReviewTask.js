/**
 * Queue the bundled `/do:review` workflow against ONE open pull request.
 *
 * The PRs tab already had two per-row agents, and neither is "just review this":
 *
 *   - **Resolve & merge** fixes the branch and lands it. It is the whole
 *     lifecycle, so it is the wrong button for a contribution you want read
 *     before anyone decides what to do with it.
 *   - **PR review** points the `pr-reviewer` scheduled task at one request. It
 *     only appears where that task can run — an UNTRUSTED contributor's PR
 *     against the default branch — so a PR from a known code contributor, a
 *     teammate, or PortOS's own agents has no review action at all.
 *
 * Do:Review is the missing one: the install's review roster, pointed at any open
 * GitHub PR, delivering an inline review and nothing else.
 *
 * Three properties matter:
 *
 *  - **Review only.** The invocation carries `--no-apply`, so slashdo's PR mode
 *    reads the request through `gh` and publishes an inline review. Its default
 *    (`auto`) would `gh pr checkout` the head branch to commit fixes — in the
 *    app's LIVE checkout, because a report-shaped workflow gets no worktree —
 *    and switch the branch out from under whoever is working in it. Landing
 *    code is Resolve & merge's job.
 *  - **Reviewers are NOT resolved here.** The task carries the bare command and
 *    arguments; `promptSections/slashdo.js` resolves the roster from task
 *    metadata over Code Review Defaults when the prompt is built, prunes the
 *    body to the loops that roster reaches, and emits the pin. Rendering
 *    `--review-with` at queue time instead would take slashdo's precedence-1
 *    path, which makes task-level reviewer pins unreachable, suppresses the
 *    per-reviewer effort note, and freezes a roster that may sit in the queue
 *    while the defaults change.
 *  - **No contributor prose enters the prompt.** The context names the PR
 *    number and URL; the title, body, and diff stay on the forge, where the
 *    workflow reads them as the untrusted data the prompt says they are.
 */

import { UNTRUSTED_PULL_REQUEST_NOTICE } from '../lib/promptFencing.js';
import { getSlashdoWorkflow } from '../lib/slashdoCatalog.js';
import { emitLog } from './cosEvents.js';

/** The bundled slashdo workflow this task runs. */
const DO_REVIEW_COMMAND = 'review';

/**
 * A `/do:review` task pinned to one request. `targetPullRequest` is the tree's
 * established "this task targets PR #N" key — the same one `pr-reviewer` runs
 * carry, read by the agent registration record and the preflight card — so this
 * run shows up in those projections instead of hiding behind a private key. The
 * two are told apart by what else the metadata holds (`slashdoCommand` here,
 * `analysisType` there), not by using two vocabularies for one fact.
 */
export const isDoReviewTask = (metadata) => metadata?.slashdoCommand === DO_REVIEW_COMMAND
  && metadata?.targetPullRequest != null;

/**
 * The task's agent-facing framing. Everything procedural lives in the
 * `/do:review` body the prompt builder inlines; this says which request, and
 * that the request is evidence rather than instruction.
 */
function renderContext({ number, url, repoLabel }) {
  return [
    `Review pull request #${number} in ${repoLabel} (${url}) and publish the result as a review on that pull request.`,
    '',
    UNTRUSTED_PULL_REQUEST_NOTICE,
    '',
    'This run is review-only. The invocation carries `--no-apply`: publish findings as an inline review and do not commit, push, check the branch out, or merge. Landing the PR is a separate action the user triggers themselves.',
  ].join('\n');
}

/**
 * Queue and immediately start one `/do:review` run for an open pull request.
 *
 * Immediate dispatch because pressing the button IS the approval — the same
 * reasoning as the tab's Resolve & merge action. `suppressDequeue` keeps the
 * autonomous dequeue from racing that force-spawn for the same task.
 *
 * The result speaks `spawnReviewLoopFollowUp`'s vocabulary (`duplicate` plus a
 * `dispatch: { started, reason }` block) rather than inventing a second dialect
 * of "queued but not started" for the route beside it to translate.
 *
 * `cos.js` is imported lazily: it carries a ~400-module closure this file needs
 * two functions from, and a static edge would charge that to every test file
 * that reaches this module (server/AGENTS.md, "Import scoping").
 *
 * @param {Object} params
 * @param {Object} params.app - the managed app record (`id`, `name`)
 * @param {Object} params.pullRequest - the freshly-read open PR (`number`, `url`)
 * @param {string} [params.repoFullName] - `owner/repo`, for the prompt's label
 * @param {string} [params.provider] - "Run with" provider pin
 * @param {string} [params.model] - "Run with" model pin
 * @param {string} [params.effort] - "Run with" reasoning-effort pin
 * @returns {Promise<{task: Object|null, duplicate: boolean, dispatch: {started: boolean, reason: string|null}}>}
 */
export async function spawnPrDoReviewTask({ app, pullRequest, repoFullName = '', provider, model, effort } = {}) {
  const { addTask, forceSpawnTask } = await import('./cos.js');
  const { number, url } = pullRequest;
  const appLabel = String(app.name || app.id).replace(/\s+/g, ' ').trim();
  const repoLabel = repoFullName || appLabel;

  const created = await addTask({
    description: `Review PR #${number} for ${appLabel}`,
    app: app.id,
    priority: 'HIGH',
    context: renderContext({ number, url, repoLabel }),
    slashdoCommand: DO_REVIEW_COMMAND,
    // The URL is what puts slashdo into PR mode; `--no-apply` is the one flag
    // this button owns. Everything about reviewers is left to the prompt layer.
    slashdoArgs: `${url} --no-apply`,
    provider, model, effort,
    // The catalog's own posture for `review` (no worktree, no PR, no simplify,
    // a clean tree IS the success shape), read rather than restated so a catalog
    // change reaches this surface too.
    ...getSlashdoWorkflow(DO_REVIEW_COMMAND).settings,
    // Specific to PR mode with `--no-apply`: the deliverable is a review
    // published during the run, so every commit/push/PR instruction is stripped
    // from the prompt. The same workflow on a local branch prints a report
    // instead and needs no such marker.
    noCodeOutput: true,
    // Each `/do:*` body owns its own review sequence; a CoS loop on top would
    // review the review.
    reviewLoop: false,
    metadata: { targetPullRequest: number },
  }, 'user', { suppressDequeue: true });

  if (!created) return { task: null, duplicate: false, dispatch: { started: false, reason: null } };
  if (created.duplicate) {
    emitLog('info', `🔍 /do:review for ${repoLabel} #${number} is already queued as ${created.id}`, {
      taskId: created.id, appId: app.id, prNumber: number,
    });
    return { task: created, duplicate: true, dispatch: { started: false, reason: null } };
  }

  const spawn = await forceSpawnTask(created.id).catch(err => ({ error: err.message }));
  if (spawn?.error) {
    // The task is persisted and holds its place in the queue — report why it has
    // not started rather than claiming an agent is on it.
    emitLog('warn', `⏳ Queued /do:review task ${created.id} for ${repoLabel} #${number} — ${spawn.error}`, {
      taskId: created.id, appId: app.id, prNumber: number,
    });
    return { task: created, duplicate: false, dispatch: { started: false, reason: spawn.error } };
  }
  emitLog('info', `🔍 Started /do:review agent for task ${created.id} (app ${app.id} request #${number})`, {
    taskId: created.id, appId: app.id, prNumber: number,
  });
  return { task: created, duplicate: false, dispatch: { started: true, reason: null } };
}
