/**
 * Burn job — queue a CoS agent in a managed app with a custom prompt.
 *
 * This is the original quota-burn behavior, now expressed as one job type among
 * several rather than as a per-app scheduled task type. The loop lives in
 * PortOS; only the WORK targets a managed app, named per job — so one install
 * can point its codex window at one repo and its claude window at another.
 *
 * The task is queued (not spawned directly) so the burn is visible in the CoS
 * queue and Active Agents like any other task, and inherits the daemon's
 * provider/worktree/PR handling instead of forking a second dispatch path.
 */

import { addTask } from '../cosTaskStore.js';
import { getAppById } from '../apps.js';
import { noProviderReason, resolveBurnProvider } from './providerPick.js';
import { burnTaskDescription, isUnlimitedDispatchCap } from '../../lib/quotaBurnConfig.js';
import { windowLabelOf } from '../../lib/quotaWindows.js';

async function resolve({ params, job, family }) {
  const appId = typeof params?.appId === 'string' ? params.appId.trim() : '';
  const prompt = typeof params?.prompt === 'string' ? params.prompt.trim() : '';
  if (!appId) return { error: 'no managed app selected' };
  if (!prompt) return { error: 'no work prompt configured' };
  const app = await getAppById(appId);
  if (!app) return { error: `managed app ${appId} no longer exists` };
  // Default `prefer: 'tui'` — an agent burn runs for minutes and should be
  // watchable in Active Agents.
  const provider = await resolveBurnProvider({ job, family });
  if (!provider) return { error: noProviderReason(family) };
  return { app, prompt, provider };
}

export async function countPending({ params, job, family } = {}) {
  const resolved = await resolve({ params, job, family });
  return resolved.error
    ? { count: 0, detail: resolved.error }
    // Handed back to run() by the runner so the app + provider lookups happen
    // once per dispatch instead of twice — see the registry's hook contract.
    : { count: 1, context: resolved, detail: `ready to queue an agent in ${resolved.app.name}` };
}

/**
 * The burn context the agent sees above the user's own prompt.
 *
 * Names the TARGET window (the weekly allowance this burn is racing) and, when
 * the family reports a separate short rolling window, that one too — a run that
 * is refused mid-way is nearly always the short window running out, and an agent
 * told only "the weekly window has 60% left" reads that refusal as a bug.
 */
export function renderBurnPrompt({ family, candidate, prompt }) {
  const hours = Math.max(0, Math.ceil(candidate?.hoursUntilReset ?? 0));
  const target = windowLabelOf(candidate?.limit);
  const limiting = candidate?.limitingLimit;
  const showsLimiting = limiting && limiting !== candidate?.limit;
  return [
    `# ${family.id} quota-burn task`,
    '',
    `The ${family.id} ${target} quota window resets in about ${hours} hour${hours === 1 ? '' : 's'}.`,
    `Window: ${target}; remaining: ${candidate?.limit?.percentRemaining}%; reserve: ${family.reservePercent}%.`,
    ...(showsLimiting
      ? [`Shorter window in play: ${windowLabelOf(limiting)} at ${limiting.percentRemaining}% remaining — it is what will refuse this run if it empties.`]
      : []),
    `Dispatch cap: ${isUnlimitedDispatchCap(family.maxDispatchesPerWindow) ? 'unlimited' : family.maxDispatchesPerWindow} for this reset window.`,
    '',
    'Carry out the configured work below. Do not use another provider family as a substitute.',
    '',
    prompt,
  ].join('\n');
}

export async function run({ params, job, family, candidate, context } = {}) {
  // Reuse the probe's lookups when the runner supplied them; the page's force
  // path calls run() with no probe, so fall back to resolving here.
  const resolved = context ?? await resolve({ params, job, family });
  if (resolved.error) return { dispatched: false, reason: resolved.error };
  const { app, prompt, provider } = resolved;

  const label = job?.label?.trim() || 'quota-burn work';
  // The two "lands no code" postures. `noCodeOutput` = the deliverable is an
  // action performed during the run (a filed issue, an endpoint call), so the
  // job needs no branch at all. `discardWorktree` = the job wants a scratch
  // checkout but nothing in it may land. Either one means there is no diff to
  // ship, which is what the coercions below rest on.
  const discardsWorktree = params?.discardWorktree === true;
  const landsNoCode = params?.noCodeOutput === true || discardsWorktree;
  const task = await addTask({
    description: burnTaskDescription(family.id, label, app.name),
    app: app.id,
    context: renderBurnPrompt({ family, candidate, prompt }),
    provider: provider.id,
    model: job?.model || undefined,
    effort: job?.effort || undefined,
    useWorktree: params?.useWorktree !== false,
    // A job that lands no code can never produce a PR. Leaving `openPR: true`
    // on it (the param's default, one checkbox away) makes the spawner expect a
    // PR that cannot exist: the run is downgraded to `pr-missing` and RETRIED,
    // burning up to five agent runs of subscription quota per misconfigured job.
    // `/simplify` reviews changed code ahead of a commit that never happens.
    // Coerced here rather than only in the UI so a hand-edited plan can't reach
    // that state.
    openPR: !landsNoCode && params?.openPR !== false,
    simplify: !landsNoCode && params?.simplify !== false,
    // Scratch-checkout posture. Without it, `useWorktree + !openPR` auto-merges
    // whatever the agent happened to commit onto the managed app's default
    // branch, unreviewed.
    discardWorktree: discardsWorktree,
    // Where the deliverable goes: the action the agent takes DURING the run, not
    // a commit and not the completion sentinel (which is only the done-signal).
    // Without this the prompt tells it "write your result to the sentinel" — so
    // an audit writes its findings into a file instead of filing anything — and,
    // on a no-worktree job, tells it to `/do:push` to the branch it is standing
    // on, which is the app's default branch.
    noCodeOutput: landsNoCode,
    // A run that correctly changed nothing must retain its report-shaped
    // deliverable posture instead of being treated like code work.
    worktreeChangesExpected: !landsNoCode,
    reviewLoop: false,
    // Burn provenance, read back after the task round-trips through
    // COS-TASKS.md by `isCooldownExemptTask` (cosTaskGenerator.js, which owns
    // the why), by the runner's completion continuation, and by the denial
    // ledger — a burn the provider REFUSES is the signal that this family's
    // short rolling window is spent, but only a run this plan dispatched says
    // anything about that. The limiting window's reset rides along so the block
    // can wait on the right clock instead of a bounded guess.
    quotaBurnFamily: family.id,
    quotaBurnLimitingResetAt: candidate?.limitingResetAt ?? null,
  }, 'internal');

  // A duplicate means an identical burn task for this app is still pending or
  // running. Report it as NOT dispatched so the window's cap isn't charged for
  // a task that already exists — otherwise a family whose burn keeps colliding
  // would exhaust its budget without ever adding work.
  if (task?.duplicate) return { dispatched: false, reason: `an identical burn task is already ${task.status}` };

  console.log(`🔥 Quota-burn queued agent task ${task.id} for ${app.name} via ${provider.id}`);
  return {
    dispatched: true,
    summary: `Queued "${label}" in ${app.name} via ${provider.id}`,
    detail: { taskId: task.id, appId: app.id, providerId: provider.id, model: job?.model || null, effort: job?.effort || null },
  };
}
