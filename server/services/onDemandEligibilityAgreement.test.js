/**
 * The Quota Burn page and the schedule's on-demand lane must give the SAME
 * answer about the SAME task, rung for rung (#6405).
 *
 * Both sides read one ladder now (`evaluateOnDemandEligibility`), but they fill
 * its inputs from different places — the page through
 * `getQuotaBurnTaskCatalog`, dispatch through the live schedule — and that is
 * where a drift would reappear. So this suite runs BOTH real implementations
 * over one mocked world and asserts they agree: the page's `reason` is exactly
 * the error `triggerOnDemandTask` refuses with, and a step the page clears is a
 * request the schedule actually queues.
 *
 * It exists as its own file because no single module owns the contract: the
 * ladder is in `lib/`, one consumer is `taskSchedule.js` and the other is
 * `quotaBurnInvoke.js`, and only the store boundary underneath all three is
 * doubled.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const world = {
  tasks: {},
  apps: [],
  features: {},
  improvementEnabled: true,
};

vi.mock('./taskScheduleStore.js', () => ({
  loadSchedule: vi.fn(async () => world.schedule),
  updateSchedule: vi.fn(async (mutate) => (await mutate(world.schedule)).result),
}));

vi.mock('./apps.js', () => ({
  getActiveApps: vi.fn(async () => world.apps),
  getAppTaskTypeOverrides: vi.fn(async (id) => world.apps.find((app) => app.id === id)?.taskTypeOverrides || {}),
  isTaskTypeEnabledForApp: vi.fn(async () => true),
  getAppTaskTypeInterval: vi.fn(async () => null),
  getAppTaskTypeIntervalMs: vi.fn(async () => null),
  clearAllPrWatcherState: vi.fn(async () => ({ changed: false })),
  clearAllIssueWatcherState: vi.fn(async () => ({ changed: false })),
}));

vi.mock('./instanceFeatures.js', () => ({
  isInstanceFeatureEnabled: vi.fn(async (feature) => world.features[feature] !== false),
}));

vi.mock('./cosState.js', async () => {
  const actual = await vi.importActual('./cosState.js');
  return { ...actual, loadState: vi.fn(async () => ({ config: { improvementEnabled: world.improvementEnabled } })) };
});

vi.mock('./autonomousJobs.js', () => ({ getAllJobs: vi.fn(async () => []) }));
vi.mock('./cosEvents.js', () => ({ cosEvents: { emit: vi.fn() }, emitLog: vi.fn() }));
vi.mock('./userActions.js', () => ({ recordUserAction: vi.fn() }));
vi.mock('./taskLearning.js', () => ({
  getAdaptiveCooldownMultiplier: vi.fn(async () => ({ multiplier: 1, reason: 'insufficient-data', skip: false })),
}));

const { ON_DEMAND_ORIGINS, triggerOnDemandTask } = await import('./taskSchedule.js');
const { getQuotaBurnTaskCatalog } = await import('./quotaBurnInvoke.js');
const { resolveQuotaBurnStepAvailability } = await import('../lib/quotaBurnTaskRef.js');

const burn = { family: 'grok', stepId: 'step-1', limitingResetAt: 1700000000000, overrides: { providerId: 'grok-tui', model: null, effort: null } };
const burnStep = (taskType, appId = null) => ({
  id: 'step-1', enabled: true, unavailable: null,
  taskRef: { kind: 'builtin', taskType, appId },
});

/**
 * Run one task type past both surfaces and return their verdicts, having
 * already asserted that they say the same thing. `null` on both sides means
 * "runnable", and the schedule proves it by queueing a request.
 */
async function agreedVerdict(taskType, appId = null, { origin = ON_DEMAND_ORIGINS.QUOTA_BURN } = {}) {
  const page = resolveQuotaBurnStepAvailability(burnStep(taskType, appId), await getQuotaBurnTaskCatalog());
  const dispatch = await triggerOnDemandTask(taskType, appId, { emit: false, origin, burn });
  expect(dispatch.error ?? null).toBe(page?.reason ?? null);
  expect(Boolean(dispatch.id)).toBe(!page);
  return page;
}

beforeEach(() => {
  world.tasks = {
    security: { type: 'on-demand', enabled: true },
    'pr-reviewer': { type: 'on-demand', enabled: true },
    'model-comparison-refresh': { type: 'on-demand', enabled: true },
    'jira-sprint-manager': { type: 'on-demand', enabled: true, feature: 'jira' },
  };
  world.apps = [{ id: 'app-1', taskTypeOverrides: { 'pr-reviewer': { enabled: true } } }];
  world.features = {};
  world.improvementEnabled = true;
  world.schedule = { tasks: world.tasks, executions: {}, onDemandRequests: [] };
  vi.clearAllMocks();
});

describe('on-demand eligibility, page vs schedule', () => {
  it('agrees on every rung the two surfaces already shared', async () => {
    expect(await agreedVerdict('security')).toBeNull();
    expect((await agreedVerdict('not-a-task'))?.code).toBe('unknown-task');
    world.tasks.security.enabled = false;
    expect((await agreedVerdict('security'))?.code).toBe('disabled');
    world.features.jira = false;
    expect((await agreedVerdict('jira-sprint-manager'))?.reason).toContain("requires the 'jira' feature");
    expect((await agreedVerdict('pr-reviewer'))?.code).toBe('missing-app');
    expect((await agreedVerdict('model-comparison-refresh', 'app-1'))?.code).toBe('wrong-scope');
  });

  // Disagreement #1 before this ladder: the catalog refused an app the type was
  // switched off for, the schedule queued the request anyway. Decided in favour
  // of the catalog — an unattended burn picks its own step and must respect the
  // per-app switch the user set.
  it('agrees that a burn may not run a type an app has switched off', async () => {
    const verdict = await agreedVerdict('pr-reviewer', 'app-2');
    expect(verdict).toMatchObject({ code: 'wrong-scope', reason: expect.stringContaining("not enabled for app 'app-2'") });
    expect(await agreedVerdict('pr-reviewer', 'app-1')).toBeNull();
  });

  // A human pressing Run is the deliberate exception: the drain's
  // applyOnDemandRunResets exists precisely so an explicit Run overrides the
  // app's cadence switch, so that origin is not handed the rung's input.
  it('still lets a human Run Now override an app-level switch', async () => {
    const request = await triggerOnDemandTask('pr-reviewer', 'app-2', { emit: false, origin: ON_DEMAND_ORIGINS.USER });
    expect(request.error).toBeUndefined();
    expect(request.appId).toBe('app-2');
  });

  // Disagreement #2 before this ladder: the schedule refused while master
  // Improve was off, the page rendered the step as ready to run. Decided in
  // favour of the schedule, with its own reason code — "disabled" would have
  // sent the user to a task toggle that is already on.
  it('agrees that nothing runs while master Improve is off', async () => {
    world.improvementEnabled = false;
    const verdict = await agreedVerdict('security');
    expect(verdict).toMatchObject({ code: 'improvement-disabled', reason: expect.stringContaining('CoS → Config') });
  });

  // The reference's own problem outranks the master switch: a user who turns
  // Improve back on should not then discover a second, different reason.
  it('names the task-level problem first when Improve is also off', async () => {
    world.improvementEnabled = false;
    world.tasks.security.enabled = false;
    expect((await agreedVerdict('security'))?.code).toBe('disabled');
  });
});
