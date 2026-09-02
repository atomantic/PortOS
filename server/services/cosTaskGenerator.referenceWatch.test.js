/**
 * Scheduled `reference-watch` prompt assembly (#3140).
 *
 * `reference-watch` reaches an agent by two paths: the on-commit trigger
 * (`triggerReferenceAnalysis` in referenceRepos.js) and the WEEKLY scheduled
 * task (`generateManagedAppImprovementTaskForType` here). Only the former used
 * to expand the v3 prompt's `{trackerInstructions}` block, so every scheduled
 * run shipped the literal string `{trackerInstructions}` under "## Where to
 * record proposals" — leaving the agent to guess where to file, and on a
 * forge-tracker app defaulting back to the PLAN.md edit the v3 prompt exists to
 * stop. The same resolved tracker also feeds `worktreeChangesExpected`, so a
 * scheduled forge-tracker run kept hitting the `idle-no-changes` failure #3102
 * fixed for the on-commit path only.
 *
 * Isolated file so the mocked leaf graph (taskSchedule / taskPromptService /
 * appActivity) can't leak into the shared cosTaskGenerator suite.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// A stand-in for the shipped reference-watch template: the tokens whose
// ORDERING matters ({trackerInstructions} must expand before {appName}/
// {repoPath}, because the injected block carries those placeholders itself).
const REFERENCE_WATCH_TEMPLATE = [
  '# Reference watch for {appName}',
  '',
  'Repository: {repoPath}',
  '',
  '## References',
  '',
  '{referenceData}',
  '',
  '## Where to record proposals',
  '',
  '{trackerInstructions}',
].join('\n');

vi.mock('./taskPromptService.js', () => ({
  getTaskPrompt: vi.fn(async () => REFERENCE_WATCH_TEMPLATE),
  getStagePrompt: vi.fn(async () => REFERENCE_WATCH_TEMPLATE),
}));

vi.mock('./taskSchedule.js', () => ({
  INTERVAL_TYPES: { PERPETUAL: 'perpetual', WEEKLY: 'weekly' },
  getTaskInterval: vi.fn(async () => ({ type: 'weekly', taskMetadata: { readOnly: false } })),
  stripManagedAgentOptionsFromOverride: vi.fn((_type, meta) => meta),
  recordExecution: vi.fn(async () => {}),
  parkPerpetual: vi.fn(async () => {}),
  // This is a FULL-REPLACEMENT mock (no importActual spread), so it is the entire
  // taskSchedule surface this suite sees — it has to track the real module's drain
  // API or a future test here that reaches the reconcile gate gets
  // "not a function" instead of a stub.
  getPerpetualDrainState: vi.fn(async () => ({ signature: null, dispatchCount: 0 })),
  recordPerpetualDispatch: vi.fn(async () => 1),
}));

vi.mock('./appActivity.js', async (importActual) => ({
  ...(await importActual()),
  updateAppActivity: vi.fn(async () => {}),
}));

vi.mock('./apps.js', async (importActual) => ({
  ...(await importActual()),
  getAppTaskTypeOverrides: vi.fn(async () => ({})),
}));

vi.mock('./codeReview.js', async (importActual) => ({
  ...(await importActual()),
  getCodeReviewDefaults: vi.fn(async () => ({ reviewers: ['codex'], usernames: [], optionalReviewers: [] })),
}));

vi.mock('./taskLearning.js', async (importActual) => ({
  ...(await importActual()),
  getTaskTypeConfidence: vi.fn(async () => ({ autoApprove: true, tier: 'high', reason: 'test' })),
}));

// The tracker table + formatTrackerInstructions stay REAL (the point of the fix
// is that both paths share them) — only the network/disk-touching ref check is
// stubbed.
const checkReferenceRepoMock = vi.fn();
vi.mock('./referenceRepos.js', async (importActual) => ({
  ...(await importActual()),
  checkReferenceRepo: vi.fn((...args) => checkReferenceRepoMock(...args)),
}));

// workTracker.resolveAppWorkTracker stays real; only its `git remote get-url`
// probe is stubbed so an unconfigured app deterministically falls back to PLAN.md
// instead of shelling out against the fixture repoPath.
vi.mock('../lib/gitRemote.js', async (importActual) => ({
  ...(await importActual()),
  readOriginRemoteUrl: vi.fn(async () => null),
}));

import { generateManagedAppImprovementTaskForType } from './cosTaskGenerator.js';

const SNAPSHOT = {
  head: 'a'.repeat(40),
  headShort: 'aaaaaaaa',
  commitCount: 2,
  commits: [{ sha: 'b'.repeat(40), subject: 'add widget cache', author: 'Alice', date: '2026-07-01T00:00:00Z' }],
  cwd: '/tmp/example-clone',
  branch: 'main',
};

const makeApp = (overrides = {}) => ({
  id: 'app-1',
  name: 'Example App',
  repoPath: '/tmp/example-repo',
  referenceRepos: [{ id: 'ref-1', name: 'example-upstream', repoUrl: 'https://example.com/x/y.git', branch: 'main' }],
  ...overrides,
});

const STATE = { config: { confidenceAutoApproval: { enabled: false }, idleReviewPriority: 'MEDIUM' } };

const generate = (app, taskType = 'reference-watch') =>
  generateManagedAppImprovementTaskForType(taskType, app, STATE, { skipPreconditions: true });

describe('scheduled reference-watch prompt assembly (#3140)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkReferenceRepoMock.mockResolvedValue(SNAPSHOT);
  });

  it('expands {trackerInstructions} — no literal token survives into the prompt', async () => {
    const task = await generate(makeApp());
    expect(task).not.toBeNull();
    expect(task.description).not.toContain('{trackerInstructions}');
    // Unconfigured tracker + no resolvable origin → PLAN.md block.
    expect(task.description).toContain('PLAN.md');
    expect(task.metadata.workTracker).toBe('plan');
    // The PLAN.md path COMMITS checklist items, so the idle-complete gate stays armed.
    expect(task.metadata.worktreeChangesExpected).toBe(true);
  });

  it('injects the github block AND expands the {appName}/{repoPath} placeholders inside it', async () => {
    const app = makeApp({ workTracker: 'github' });
    const task = await generate(app);
    expect(task.description).not.toContain('{trackerInstructions}');
    expect(task.description).toContain('gh issue create');
    expect(task.description).toContain('GitHub Issues');
    // Ordering guard: the injected block's own placeholders must be expanded by
    // the {appName}/{repoPath} replacers that run AFTER the injection.
    expect(task.description).not.toContain('{appName}');
    expect(task.description).not.toContain('{repoPath}');
    expect(task.description).toContain(app.name);
    expect(task.description).toContain(app.repoPath);
  });

  it.each([
    ['github', false],
    ['gitlab', false],
    ['jira', false],
    ['plan', true],
  ])('stamps workTracker + worktreeChangesExpected off the same resolved tracker (%s → %s)', async (tracker, expected) => {
    const task = await generate(makeApp({ workTracker: tracker }));
    expect(task.metadata.workTracker).toBe(tracker);
    expect(task.metadata.worktreeChangesExpected).toBe(expected);
  });

  it('overrides a stale taskMetadata worktreeChangesExpected — the resolved tracker wins', async () => {
    // The flag must never disagree with the {trackerInstructions} block the
    // agent received, so the derivation beats a schedule/per-app override.
    const taskSchedule = await import('./taskSchedule.js');
    taskSchedule.getTaskInterval.mockResolvedValueOnce({
      type: 'weekly', taskMetadata: { readOnly: false, worktreeChangesExpected: true },
    });
    const task = await generate(makeApp({ workTracker: 'github' }));
    expect(task.metadata.workTracker).toBe('github');
    expect(task.metadata.worktreeChangesExpected).toBe(false);
  });

  it('leaves a non-reference-watch type untouched — no tracker resolution, no metadata stamp', async () => {
    const { readOriginRemoteUrl } = await import('../lib/gitRemote.js');
    const task = await generate(makeApp(), 'code-review');
    expect(task).not.toBeNull();
    expect(task.metadata.workTracker).toBeUndefined();
    expect(task.metadata.worktreeChangesExpected).toBeUndefined();
    expect(checkReferenceRepoMock).not.toHaveBeenCalled();
    expect(readOriginRemoteUrl).not.toHaveBeenCalled();
  });

  it('still skips dispatch when no ref produced reviewable commits', async () => {
    checkReferenceRepoMock.mockResolvedValue({ ...SNAPSHOT, commitCount: 0, commits: [] });
    expect(await generate(makeApp())).toBeNull();
  });
});

/**
 * The `ux` audit (#3273) is the second TRACKER-FILING task type: it shares the
 * {trackerInstructions} injection + `workTracker`/`worktreeChangesExpected`
 * derivation with reference-watch (resolveTrackerFilingBlock), but is worded
 * from its own TRACKER_FILING_PRESETS entry and never touches reference repos.
 */
describe('scheduled ux prompt assembly (#3273)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkReferenceRepoMock.mockResolvedValue(SNAPSHOT);
  });

  const generateUx = (app) => generate(app, 'ux');

  it('injects the ux-worded tracker block and expands its inner placeholders', async () => {
    const app = makeApp({ workTracker: 'github' });
    const task = await generateUx(app);
    expect(task).not.toBeNull();
    expect(task.description).not.toContain('{trackerInstructions}');
    // ux wording, not reference-watch's.
    expect(task.description).toContain('[ux-…]');
    expect(task.description).toContain('gh label create ux');
    expect(task.description).not.toContain('ref-watch');
    // Ordering guard: {trackerInstructions} expands BEFORE {appName}/{repoPath}.
    expect(task.description).not.toContain('{appName}');
    expect(task.description).not.toContain('{repoPath}');
    expect(task.description).toContain(app.name);
    expect(task.description).toContain(app.repoPath);
  });

  it.each([
    ['github', false],
    ['gitlab', false],
    ['jira', false],
    ['plan', true],
  ])('stamps workTracker + worktreeChangesExpected off the same resolved tracker (%s → %s)', async (tracker, expected) => {
    const task = await generateUx(makeApp({ workTracker: tracker }));
    expect(task.metadata.workTracker).toBe(tracker);
    expect(task.metadata.worktreeChangesExpected).toBe(expected);
  });

  it('never checks reference repos — and dispatches on an app that has none', async () => {
    const task = await generateUx(makeApp({ referenceRepos: [] }));
    expect(task).not.toBeNull();
    expect(task.metadata.workTracker).toBe('plan');
    expect(checkReferenceRepoMock).not.toHaveBeenCalled();
  });

  it('defaults ux to file-issues posture (noCodeOutput, no worktree/PR)', async () => {
    const task = await generateUx(makeApp());
    expect(task.metadata.fileIssues).toBe(true);
    expect(task.metadata.noCodeOutput).toBe(true);
    expect(task.metadata.useWorktree).toBe(false);
    expect(task.metadata.openPR).toBe(false);
    expect(task.description).toContain('Mode: file issues, change nothing');
  });
});

/**
 * `plan-feature` is the THIRD tracker-filing task type: like reference-watch it
 * is ALWAYS-filing (no fileIssues toggle — it is not an audit type), but worded
 * from its own TRACKER_FILING_PRESETS entry. It brainstorms one feature and
 * files its plan as a tracker item instead of implementing anything.
 */
describe('scheduled plan-feature prompt assembly', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkReferenceRepoMock.mockResolvedValue(SNAPSHOT);
  });

  const generatePlanFeature = (app) => generate(app, 'plan-feature');

  it('injects the plan-feature-worded tracker block and expands its inner placeholders', async () => {
    const app = makeApp({ workTracker: 'github' });
    const task = await generatePlanFeature(app);
    expect(task).not.toBeNull();
    expect(task.description).not.toContain('{trackerInstructions}');
    // plan-feature wording, not reference-watch's.
    expect(task.description).toContain('[plan-feature-…]');
    expect(task.description).toContain('gh label create plan-feature');
    expect(task.description).not.toContain('ref-watch');
    // Ordering guard: {trackerInstructions} expands BEFORE {appName}/{repoPath}.
    expect(task.description).not.toContain('{appName}');
    expect(task.description).not.toContain('{repoPath}');
    expect(task.description).toContain(app.name);
    expect(task.description).toContain(app.repoPath);
  });

  it.each([
    ['github', false],
    ['gitlab', false],
    ['jira', false],
    ['plan', true],
  ])('stamps workTracker + worktreeChangesExpected off the same resolved tracker (%s → %s)', async (tracker, expected) => {
    const task = await generatePlanFeature(makeApp({ workTracker: tracker }));
    expect(task.metadata.workTracker).toBe(tracker);
    expect(task.metadata.worktreeChangesExpected).toBe(expected);
  });

  it('never checks reference repos, files without a fileIssues flag, and takes no worktree/PR posture', async () => {
    const task = await generatePlanFeature(makeApp({ referenceRepos: [] }));
    expect(task).not.toBeNull();
    expect(checkReferenceRepoMock).not.toHaveBeenCalled();
    // Always-filing (non-audit): no mode banner, no audit toggle metadata.
    expect(task.description).not.toContain('Mode: file issues, change nothing');
    expect(task.metadata.fileIssues).toBeUndefined();
    expect(task.metadata.noCodeOutput).toBeUndefined();
  });
});

describe('audit fileIssues toggle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stamps no-code posture and injects the file-issues banner when fileIssues is on', async () => {
    const { getTaskInterval } = await import('./taskSchedule.js');
    getTaskInterval.mockResolvedValue({ type: 'weekly', taskMetadata: { fileIssues: true } });
    const task = await generate(makeApp(), 'security');
    expect(task.metadata.fileIssues).toBe(true);
    expect(task.metadata.noCodeOutput).toBe(true);
    expect(task.metadata.useWorktree).toBe(false);
    expect(task.metadata.openPR).toBe(false);
    expect(task.description).toContain('Mode: file issues, change nothing');
    expect(task.description).toContain('[security-…]');
    expect(task.description).not.toContain('{modeInstructions}');
    expect(task.description).not.toContain('{trackerInstructions}');
  });

  it('does not file and asks the agent to implement when fileIssues is off', async () => {
    const { getTaskInterval } = await import('./taskSchedule.js');
    getTaskInterval.mockResolvedValue({ type: 'weekly', taskMetadata: { fileIssues: false } });
    const task = await generate(makeApp(), 'security');
    expect(task.metadata.fileIssues).toBe(false);
    expect(task.metadata.noCodeOutput).toBeUndefined();
    expect(task.description).toContain('Mode: implement the highest-value fix');
    expect(task.description).not.toContain('[security-…]');
  });

  it('forces module-hygiene remediation into a worktree after an unsafe toggle transition', async () => {
    const { getTaskInterval } = await import('./taskSchedule.js');
    getTaskInterval.mockResolvedValue({
      type: 'weekly',
      taskMetadata: { fileIssues: false, useWorktree: false, openPR: false },
    });
    const task = await generate(makeApp(), 'module-hygiene');
    expect(task.metadata.fileIssues).toBe(false);
    expect(task.metadata.useWorktree).toBe(true);
    expect(task.metadata.openPR).toBe(false);
    expect(task.metadata.noCodeOutput).toBeUndefined();
    expect(task.description).toContain('Mode: implement the highest-value fix');
  });
});
