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
import { getAllProviders } from '../providers.js';

/**
 * An agent-capable provider in the burning family. An explicit `providerId`
 * (job first, then family) wins; otherwise match the family id against the
 * enabled CLI/TUI providers. API-type providers are excluded on purpose — this
 * job exists to spend a SUBSCRIPTION window, and an API provider bills per
 * token instead.
 */
export function providerForFamily(providers, { familyId, providerId }) {
  const available = (providers || []).filter((provider) =>
    provider?.enabled && (provider.type === 'cli' || provider.type === 'tui'));
  if (providerId) return available.find((provider) => provider.id === providerId) || null;
  const needle = String(familyId || '').toLowerCase();
  return available.find((provider) => String(provider.id || '').toLowerCase().includes(needle)) || null;
}

async function resolve({ params, job, family }) {
  const appId = typeof params?.appId === 'string' ? params.appId.trim() : '';
  const prompt = typeof params?.prompt === 'string' ? params.prompt.trim() : '';
  if (!appId) return { error: 'no managed app selected' };
  if (!prompt) return { error: 'no work prompt configured' };
  const app = await getAppById(appId);
  if (!app) return { error: `managed app ${appId} no longer exists` };
  const result = await getAllProviders();
  const provider = providerForFamily(
    Array.isArray(result) ? result : result?.providers,
    { familyId: family?.id, providerId: job?.providerId || family?.providerId || null },
  );
  if (!provider) return { error: `no enabled CLI/TUI provider in the ${family?.id} family` };
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

/** The burn context the agent sees above the user's own prompt. */
export function renderBurnPrompt({ family, candidate, prompt }) {
  const hours = Math.max(0, Math.ceil(candidate?.hoursUntilReset ?? 0));
  return [
    `# ${family.id} quota-burn task`,
    '',
    `This ${family.id} quota window resets in about ${hours} hour${hours === 1 ? '' : 's'}.`,
    `Window: ${candidate?.limit?.label || candidate?.limit?.scope || 'provider window'}; remaining: ${candidate?.limit?.percentRemaining}%; reserve: ${family.reservePercent}%.`,
    `Dispatch cap: ${family.maxDispatchesPerWindow} for this reset window.`,
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
  const task = await addTask({
    description: `[Quota burn: ${family.id}] ${label} for ${app.name}`,
    app: app.id,
    context: renderBurnPrompt({ family, candidate, prompt }),
    provider: provider.id,
    model: job?.model || undefined,
    useWorktree: params?.useWorktree !== false,
    openPR: params?.openPR !== false,
    simplify: params?.simplify !== false,
    // Opt-in throwaway posture for jobs whose deliverable is NOT code (the audit
    // presets). Without it, `useWorktree + !openPR` auto-merges whatever the
    // agent happened to commit onto the managed app's default branch, unreviewed
    // — and a run that correctly changed nothing is judged a failure by the
    // idle-complete gate, which expects a dirty tree.
    discardWorktree: params?.discardWorktree === true,
    worktreeChangesExpected: params?.discardWorktree !== true,
    reviewLoop: false,
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
    detail: { taskId: task.id, appId: app.id, providerId: provider.id, model: job?.model || null },
  };
}
