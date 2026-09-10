/**
 * The generated-task/prompt BOUNDARY for the file-issues vs implement audit mode (#6380).
 *
 * Every other test of this contract stops at `isFileIssuesMode` or at the task
 * metadata. Neither proves the thing that actually matters: that an issues-only
 * run cannot ACQUIRE code-shipping instructions. The mode is enforced two hops
 * apart — the generator stamps `FILE_ISSUES_DELIVERY_SETTINGS`, and the prompt
 * builder reads `noCodeOutput` off that stamp to pick a completion contract — so
 * a change on either side can quietly re-arm `/do:push` on an audit that was
 * only ever supposed to file issues.
 *
 * This suite closes both hops: it GENERATES the real task for every audit type
 * in the catalog and RENDERS the final agent prompt from it, then asserts that
 * no commit/push/PR/auto-merge directive survives — and that the same pipeline
 * in implement mode still emits the ordinary code-delivery workflow, so the
 * assertions cannot pass by rendering nothing.
 *
 * Isolated file for the same reason `cosTaskGenerator.referenceWatch.test.js`
 * is: the mocked leaf graph (taskSchedule / taskPromptService / appActivity)
 * must not leak into the shared cosTaskGenerator suite.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// A stand-in for a shipped audit template. Deliberately WITHOUT
// `{modeInstructions}`: that is the customized-stored-prompt shape, where the
// banner has to be PREPENDED or flipping the mode would be a silent no-op on
// any install whose user edited the prompt.
const AUDIT_TEMPLATE = [
  '# Audit {appName}',
  '',
  'Repository: {repoPath}',
  '',
  'Fix what you find and commit it.',
  '',
  '## Where to record findings',
  '',
  '{trackerInstructions}',
].join('\n');

// The other shape: a template that still carries the token, so the generator
// substitutes rather than prepends.
const AUDIT_TEMPLATE_WITH_TOKEN = [
  '# Audit {appName}',
  '',
  '{modeInstructions}',
  '',
  '{trackerInstructions}',
].join('\n');

const promptTemplate = vi.hoisted(() => ({ body: null }));

vi.mock('./taskPromptService.js', () => ({
  getTaskPrompt: vi.fn(async () => promptTemplate.body),
  getStagePrompt: vi.fn(async () => promptTemplate.body),
}));

vi.mock('./taskSchedule.js', () => ({
  INTERVAL_TYPES: { PERPETUAL: 'perpetual', WEEKLY: 'weekly' },
  getTaskInterval: vi.fn(async () => ({ type: 'weekly', taskMetadata: {} })),
  stripManagedAgentOptionsFromOverride: vi.fn((_type, meta) => meta),
  recordExecution: vi.fn(async () => {}),
  parkPerpetual: vi.fn(async () => {}),
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

// Keeps the real tracker resolver but stops it shelling out `git remote get-url`
// against the fixture repoPath.
vi.mock('../lib/gitRemote.js', async (importActual) => ({
  ...(await importActual()),
  readOriginRemoteUrl: vi.fn(async () => null),
}));

import { generateManagedAppImprovementTaskForType } from './cosTaskGenerator.js';
import { generateTaskFromJob } from './autonomousJobs/skillTemplates.js';
import { buildLightContextPrompt } from './agentPromptBuilder.js';
import { declaresNoCommitCriterion } from './taskTypeHooks.js';
import { isTruthyMeta } from './agentState.js';
import {
  AUDIT_TASK_TYPES,
  FILE_ISSUES_DELIVERY_SETTINGS,
  defaultFileIssuesFor,
  isFileIssuesMode,
} from '../lib/auditCatalog.js';
import { isProgrammaticScheduledTaskType, PROGRAMMATIC_SCHEDULED_TASK_TYPES } from '../lib/taskTargetScope.js';

import { buildMaintenanceSteps } from '../lib/maintenanceSequence.js';

const AUDIT_TYPES = [...AUDIT_TASK_TYPES];
const WORKSPACE = '/tmp/example-repo';

const makeApp = (overrides = {}) => ({
  id: 'app-1',
  name: 'Example App',
  repoPath: WORKSPACE,
  workTracker: 'github',
  referenceRepos: [],
  ...overrides,
});

const STATE = { config: { confidenceAutoApproval: { enabled: false }, idleReviewPriority: 'MEDIUM' } };

/** The ordinary scheduled lane. */
const generate = (taskType, options = {}) =>
  generateManagedAppImprovementTaskForType(taskType, makeApp(), STATE, options);

/**
 * The FINAL text an agent sees: the rendered mission plus the operating
 * contract the prompt builder derives from the task's settings. `tui`/`cli`
 * providers are the ones a scheduled audit actually runs on, and they all take
 * this path — a mode enforced only in the api-path builder would be no
 * enforcement at all.
 */
const renderPrompt = (task) =>
  `${task.description}\n\n${buildLightContextPrompt(task, WORKSPACE, null, isTruthyMeta, { isTui: true })}`;

/**
 * Affirmative code-delivery directives. Matched as numbered workflow STEPS and
 * section headers rather than bare substrings on purpose: the no-code
 * completion section names `/do:push`, `git commit` and "open a pull request"
 * inside its own PROHIBITION, and a naive `toContain` would fire on the very
 * text that enforces the mode.
 */
const CODE_DELIVERY_DIRECTIVES = [
  ['completion-workflow header', /^## Completion Workflow$/m],
  ['run-these-in-order preamble', /When the task is complete, run these in order:/],
  ['/do:push step', /^\s*\d+\.\s+`\/do:push/m],
  ['/do:pr step', /^\s*\d+\.\s+`\/do:pr/m],
  ['/simplify step', /^\s*\d+\.\s+`\/simplify`/m],
  ['git commit step', /^\s*\d+\..*`git commit/m],
  ['git push step', /^\s*\d+\..*`git push/m],
  ['PR merge step', /`gh pr merge|`glab mr merge/],
  ['auto-merge handoff', /merged back to the source branch/],
  ['open-a-PR handoff', /the system will push your branch and open a pull request/],
];

const expectNoCodeDelivery = (prompt, label) => {
  for (const [name, pattern] of CODE_DELIVERY_DIRECTIVES) {
    expect(pattern.test(prompt), `${label}: emitted a ${name}`).toBe(false);
  }
};

describe('issues-only audit dispatch never acquires code-shipping instructions (#6380)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    promptTemplate.body = AUDIT_TEMPLATE;
  });

  it.each(AUDIT_TYPES)('%s — file-issues mode renders no commit/push/PR/auto-merge directive', async (taskType) => {
    const { getTaskInterval } = await import('./taskSchedule.js');
    getTaskInterval.mockResolvedValue({ type: 'weekly', taskMetadata: { fileIssues: true } });

    const task = await generate(taskType);
    expect(task, taskType).not.toBeNull();
    expect(task.metadata).toMatchObject(FILE_ISSUES_DELIVERY_SETTINGS);

    const prompt = renderPrompt(task);
    expectNoCodeDelivery(prompt, taskType);
    // Positive control: the file-issues contract IS what rendered, so the
    // negatives above are not passing on an empty or truncated prompt.
    expect(prompt).toContain('Mode: file issues, change nothing');
    expect(prompt).toContain('Repository-wide discovery, worst offender first');
    expect(prompt).toContain(`"category":"${taskType}"`);
    expect(prompt).toContain('## Completion (No Code Output)');
    expect(prompt).not.toContain('{modeInstructions}');
    expect(prompt).not.toContain('{trackerInstructions}');
  });

  it.each(AUDIT_TYPES)('%s — a diff-free run is not a failure, so nothing retries it', async (taskType) => {
    const { getTaskInterval } = await import('./taskSchedule.js');
    getTaskInterval.mockResolvedValue({ type: 'weekly', taskMetadata: { fileIssues: true } });

    const task = await generate(taskType);
    // The mechanism, not a phrasing: `declaresNoCommitCriterion` is the gate
    // agentFinalization consults before scoring a clean tree as a miss (and
    // before the failure ledger can park or retry the type).
    expect(declaresNoCommitCriterion(task), taskType).toBe(true);
  });

  it.each(AUDIT_TYPES)('%s — implement mode keeps the normal code-delivery settings', async (taskType) => {
    const { getTaskInterval } = await import('./taskSchedule.js');
    getTaskInterval.mockResolvedValue({ type: 'weekly', taskMetadata: { fileIssues: false, simplify: true } });

    const task = await generate(taskType);
    expect(task, taskType).not.toBeNull();
    expect(task.metadata.fileIssues).toBe(false);
    expect(task.metadata.noCodeOutput).toBeUndefined();
    expect(task.metadata.simplify).toBe(true);
    expect(declaresNoCommitCriterion(task), taskType).toBe(false);

    const prompt = renderPrompt(task);
    expect(prompt).toContain('Mode: implement the highest-value fix');
    expect(prompt).toContain('Repository-wide discovery, worst offender first');
    expect(prompt).toContain(`"category":"${taskType}"`);
    expect(prompt).toMatch(/^## Completion Workflow$/m);
    expect(prompt).toMatch(/^\s*\d+\.\s+`\/do:push/m);
  });

  it('substitutes the banner into a template that still carries {modeInstructions}', async () => {
    promptTemplate.body = AUDIT_TEMPLATE_WITH_TOKEN;
    const { getTaskInterval } = await import('./taskSchedule.js');
    getTaskInterval.mockResolvedValue({ type: 'weekly', taskMetadata: { fileIssues: true } });

    const prompt = renderPrompt(await generate('security'));
    expect(prompt).toContain('Mode: file issues, change nothing');
    expect(prompt).not.toContain('{modeInstructions}');
    expectNoCodeDelivery(prompt, 'security/{modeInstructions}');
  });
});

/**
 * A custom app job is the OTHER agent lane a quota burn may invoke. It has no
 * catalog entry, so file-issues delivery is opt-in — but when it opts in it
 * must land the SAME posture, from the same object, or "issues only" would mean
 * two different things depending on which lane ran.
 */
describe('eligible custom agent task honors the same file-issues contract', () => {
  const job = (taskMetadata) => ({
    id: 'job-1',
    name: 'Example audit job',
    category: 'audit',
    priority: 'MEDIUM',
    autonomyLevel: 'yolo',
    promptTemplate: 'Audit the example slice and file what you find.',
    appId: 'app-1',
    taskMetadata,
  });

  it('stamps the shared delivery posture and renders no code-delivery directive', async () => {
    const generated = await generateTaskFromJob(job({ fileIssues: true, useWorktree: true, openPR: true, simplify: true }));
    expect(generated.metadata).toMatchObject(FILE_ISSUES_DELIVERY_SETTINGS);
    // The opt-in OVERRIDES the job's own code-shipping toggles rather than
    // landing beside them — a task that both files issues and opens a PR is the
    // contradiction this contract exists to make unrepresentable.
    expect(generated.metadata.useWorktree).toBe(false);
    expect(generated.metadata.openPR).toBe(false);
    expect(generated.metadata.simplify).toBe(false);

    const task = { ...generated, description: generated.metadata.prompt };
    expect(declaresNoCommitCriterion(task)).toBe(true);
    expectNoCodeDelivery(renderPrompt(task), 'custom agent job');
  });

  it('leaves a job that did not opt in on its normal code-delivery policy', async () => {
    const generated = await generateTaskFromJob(job({ useWorktree: true, openPR: true, simplify: true }));
    expect(generated.metadata.fileIssues).toBeUndefined();
    expect(generated.metadata.noCodeOutput).toBeUndefined();
    expect(generated.metadata.useWorktree).toBe(true);
    expect(generated.metadata.openPR).toBe(true);
  });
});

/**
 * The mode is a property of the TASK, not of who invoked it. All three lanes
 * reach the same generator; a burn additionally carries per-invocation run
 * parameters, which is the only legitimate difference between them.
 */
describe('mode is honored identically from schedule, manual run, and quota burn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    promptTemplate.body = AUDIT_TEMPLATE;
  });

  it.each([
    ['ordinary schedule', {}],
    ['manual run / on-demand', { skipPreconditions: true, deferPerpetualDispatch: true, targetPullRequest: null, runOverrides: null }],
    ['quota burn (no param override)', { skipPreconditions: true, deferPerpetualDispatch: true, targetPullRequest: null, runOverrides: {} }],
  ])('%s renders the same file-issues prompt and settings', async (_lane, options) => {
    const { getTaskInterval } = await import('./taskSchedule.js');
    getTaskInterval.mockResolvedValue({ type: 'weekly', taskMetadata: { fileIssues: true } });

    const task = await generate('ux', options);
    expect(task.metadata).toMatchObject(FILE_ISSUES_DELIVERY_SETTINGS);
    expectNoCodeDelivery(renderPrompt(task), _lane);
  });

  it("a burn step's explicit true beats a shipped scheduled default of false", async () => {
    const { getTaskInterval } = await import('./taskSchedule.js');
    // `security` ships defaulting to IMPLEMENT, and this schedule says nothing —
    // exactly the install a migrated issues-only burn step lands on.
    getTaskInterval.mockResolvedValue({ type: 'weekly', taskMetadata: {} });
    expect(defaultFileIssuesFor('security')).toBe(false);

    const withoutOverride = await generate('security', { skipPreconditions: true });
    expect(withoutOverride.metadata.noCodeOutput).toBeUndefined();

    const burned = await generate('security', { skipPreconditions: true, runOverrides: { fileIssues: true } });
    expect(burned.metadata).toMatchObject(FILE_ISSUES_DELIVERY_SETTINGS);
    expectNoCodeDelivery(renderPrompt(burned), 'burn override');
  });

  it("a burn step's explicit false beats a shipped scheduled default of true", async () => {
    const { getTaskInterval } = await import('./taskSchedule.js');
    getTaskInterval.mockResolvedValue({ type: 'weekly', taskMetadata: {} });
    expect(defaultFileIssuesFor('ux')).toBe(true);

    const task = await generate('ux', { skipPreconditions: true, runOverrides: { fileIssues: false } });
    expect(task.metadata.fileIssues).toBe(false);
    expect(task.metadata.noCodeOutput).toBeUndefined();
    expect(task.description).toContain('Mode: implement the highest-value fix');
  });

  it('maintenance fixes override issue-only PR defaults through the final Codex prompt', async () => {
    const { getTaskInterval } = await import('./taskSchedule.js');
    getTaskInterval.mockResolvedValue({ type: 'weekly', taskMetadata: {
      fileIssues: true, useWorktree: false, openPR: false,
    } });
    const [step] = buildMaintenanceSteps({ appId: 'app-1', idPrefix: 'maintenance', mode: 'fix' });
    const task = await generate(step.taskRef.taskType, {
      skipPreconditions: true, runOverrides: step.overrides.params,
    });
    expect(task.metadata).toMatchObject({ fileIssues: false, useWorktree: true, openPR: true });
    const prompt = buildLightContextPrompt(task, WORKSPACE, {
      branch: 'cos/example', worktreePath: WORKSPACE,
    }, isTruthyMeta, { isTui: true, providerId: 'codex-tui', providerCommand: 'codex' });
    expect(prompt).toContain('gh pr create');
    expect(prompt).toContain('## Merge Gate');
    expect(prompt).toContain('--merge --delete-branch');
    expect(prompt).not.toContain('PortOS will merge it back after completion');
  });

  it('run overrides pass the same allowlist a stored override does', async () => {
    const { getTaskInterval } = await import('./taskSchedule.js');
    getTaskInterval.mockResolvedValue({ type: 'weekly', taskMetadata: { fileIssues: true } });

    const task = await generate('ux', { skipPreconditions: true, runOverrides: { fileIssues: true, notARealFlag: true } });
    expect(task.metadata.fileIssues).toBe(true);
    expect(task.metadata.notARealFlag).toBeUndefined();
  });

  // Either Priority-0 engine may drain any given request, so a burn step's run
  // parameters must reach the generator whichever one got there first. They do
  // by construction now — both engines delegate to the one shared drain — so
  // this asserts the forwarding survives in that single owner.
  it('the shared on-demand drain forwards the burn step run parameters', async () => {
    const { readFile } = await import('fs/promises');
    const { PATHS } = await import('../lib/fileUtils.js');
    const source = await readFile(`${PATHS.root}/server/services/onDemandDrain.js`, 'utf8');
    expect(source).toContain('runOverrides: request.burn?.overrides?.params ?? null');
  });
});

/**
 * The programmatic scheduled handlers (description/image generation) do the work
 * themselves — there is no agent to instruct, so "file issues instead" is not a
 * mode they can honor. They must therefore expose no toggle to turn on.
 */
describe('programmatic scheduled handlers expose no issues-only toggle', () => {
  it('none of them is an audit type, so no mode banner or default reaches them', () => {
    expect(PROGRAMMATIC_SCHEDULED_TASK_TYPES.length).toBeGreaterThan(0);
    for (const taskType of PROGRAMMATIC_SCHEDULED_TASK_TYPES) {
      expect(AUDIT_TASK_TYPES.has(taskType), taskType).toBe(false);
      expect(defaultFileIssuesFor(taskType), taskType).toBe(false);
      // Even a hand-edited schedule cannot switch one on: the catalog gate in
      // `isFileIssuesMode` refuses a type it does not own.
      expect(isFileIssuesMode(taskType, { fileIssues: true }), taskType).toBe(false);
      // `getScheduleStatus` sets the UI's `fileIssuesCapable` flag for exactly
      // two shapes — an audit-catalog type (ruled out above) and the
      // `user-action-review` carve-out — so the toggle cannot render for these.
      expect(taskType).not.toBe('user-action-review');
    }
  });

  it('no programmatic handler is registered in the audit catalog', () => {
    for (const taskType of AUDIT_TYPES) {
      expect(isProgrammaticScheduledTaskType(taskType), taskType).toBe(false);
    }
  });
});
