// Generate real tasks and render final prompts: mode metadata alone cannot prove
// that issues-only audits stay free of shipping instructions (#6380).

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
// Per-type applicability verdicts; absent = applies. The repository scan that
// produces them is covered in appQualitySchedule.test.js.
const applicability = vi.hoisted(() => ({ inapplicable: {} }));
vi.mock('./appQualitySchedule.js', () => ({
  resolveAuditApplicability: vi.fn(async (_app, taskType) => (applicability.inapplicable[taskType]
    ? { applicable: false, reason: applicability.inapplicable[taskType] }
    : { applicable: true, reason: null })),
}));

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

import { prepareManagedAppImprovementTask } from './cosTaskGenerator.js';
import { generateTaskFromJob } from './autonomousJobs/skillTemplates.js';
import { buildLightContextPrompt } from './agentPromptBuilder.js';
import { declaresNoCommitCriterion } from './taskTypeHooks.js';
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
const generate = async (taskType, options = {}) => {
  const prepared = await prepareManagedAppImprovementTask(taskType, makeApp(), STATE, options);
  return prepared.task;
};

/**
 * The FINAL text an agent sees: the rendered mission plus the operating
 * contract the prompt builder derives from the task's settings. `tui`/`cli`
 * providers are the ones a scheduled audit actually runs on, and they all take
 * this path — a mode enforced only in the api-path builder would be no
 * enforcement at all.
 */
const renderPrompt = (task) =>
  `${task.description}\n\n${buildLightContextPrompt(task, WORKSPACE, null, { isTui: true })}`;

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
    applicability.inapplicable = {};
  });

  it.each([
    [undefined, 'review-then-merge', 'codex'],
    ['merge-on-green', 'merge-on-green', 'none'],
    ['leave-open', 'leave-open', 'codex'],
  ])('resolves app completion %s before rendering scheduled reviewers', async (appPolicy, expectedPolicy, reviewers) => {
    const { getTaskInterval } = await import('./taskSchedule.js');
    getTaskInterval.mockResolvedValue({ type: 'weekly', taskMetadata: { fileIssues: false, openPR: true, useWorktree: true } });
    promptTemplate.body = 'Reviewers: {reviewers}';
    const { task } = await prepareManagedAppImprovementTask('security', makeApp({ defaultPrCompletion: appPolicy }), STATE, { skipPreconditions: true });
    expect(task.metadata.prCompletion).toBe(expectedPolicy);
    expect(task.description).toContain(`Reviewers: ${reviewers}`);
  });

  it.each([true, false])('cognitive-load comment policy survives dispatch with fileIssues=%s', async (fileIssues) => {
    const { DEFAULT_TASK_PROMPTS } = await import('./taskPromptDefaults.js');
    const { getTaskInterval } = await import('./taskSchedule.js');
    promptTemplate.body = DEFAULT_TASK_PROMPTS['better-cognitive-load'];
    getTaskInterval.mockResolvedValue({ type: 'weekly', taskMetadata: { fileIssues } });

    const task = await generate('better-cognitive-load');
    const prompt = renderPrompt(task);
    expect(prompt).toContain('Excessive code comments');
    // The resolve-every-finding contract binds the agent that CHANGES code; a
    // file-issues run changes nothing, so only the do-work banner carries it (#12080).
    const resolveEveryFinding = [
      'Every accepted finding requires resolution regardless of severity',
      'Previously accepted rules are revisable',
      'Prefer investing effort in high-quality fixes',
      'Difficulty alone is not an exemption',
      'no current solution worth pursuing',
      'not permission to hide a known important defect',
      'warnings and nits are not exemptions',
      'Never hide findings, weaken tests, or disable useful checks',
    ];
    for (const sentence of resolveEveryFinding) {
      expect(prompt.split(sentence).length - 1, sentence)[fileIssues ? 'toBe' : 'toBeGreaterThanOrEqual'](fileIssues ? 0 : 1);
    }
    expect(prompt).toContain('safety rationale, external contracts, and justified workarounds');
    expect(prompt).toContain('Preserve licenses, tool directives, meaningful type/JSDoc metadata');
    expect(prompt).toContain('not a rewrite of user-facing documentation');
    expect(prompt).toContain('review the diff for behavior preservation');
    expect(prompt).not.toContain('{modeInstructions}');
    expect(prompt).not.toMatch(/add (?:clear |helpful )?comments/i);
    if (fileIssues) {
      expectNoCodeDelivery(prompt, 'better-cognitive-load');
      expect(prompt).toContain('Mode: file issues, change nothing');
    } else {
      expect(task.metadata.noCodeOutput).not.toBe(true);
      expect(prompt).toContain('## Completion Workflow');
    }
  });

  it.each([true, false])('infrastructure renders measured CI efficiency and safe delivery with fileIssues=%s', async (fileIssues) => {
    const { DEFAULT_TASK_PROMPTS } = await import('./taskPromptDefaults.js');
    const { getTaskInterval } = await import('./taskSchedule.js');
    promptTemplate.body = DEFAULT_TASK_PROMPTS.infrastructure;
    getTaskInterval.mockResolvedValue({ type: 'on-demand', taskMetadata: { fileIssues, useWorktree: true, openPR: true } });
    const task = await generate('infrastructure');
    const prompt = renderPrompt(task);
    for (const instruction of [
      'CI efficiency and placement', 'sample window and count', 'execution frequency',
      'summed runner time', 'critical path', 'measured avoidable runner time',
      'coverage/required-check failure', 'trigger/path selection', 'affected-test',
      'duplicate work', 'unnecessary serialization', 'cache hits/misses',
      'artifact upload/download cost', 'superseded-run', 'risk-based PR/MR',
      'stronger surviving coverage', 'A slow test is not a valueless test',
      'representative', 'required-check behavior', 'do not invent savings',
      'preserve essential correctness/security coverage',
    ]) expect(prompt).toContain(instruction);
    expect(prompt).not.toContain('{modeInstructions}');
    if (fileIssues) {
      expectNoCodeDelivery(prompt, 'infrastructure');
      expect(prompt).toContain('Mode: file issues, change nothing');
    } else {
      expect(task.metadata.fileIssues).toBe(false);
      expect(task.metadata.noCodeOutput).not.toBe(true);
      expect(prompt).toContain('Mode: audit and fix');
      expect(prompt).toContain('## Completion Workflow');
    }
  });

  it('keeps CI-efficiency discovery in customized infrastructure prompts', async () => {
    const task = await generate('infrastructure');
    expect(renderPrompt(task)).toContain('measure run frequency, job duration and critical path');
    expect(renderPrompt(task)).toContain('preserve essential correctness/security coverage');
  });

  it('bails out before generating an audit that cannot apply, advancing the cadence', async () => {
    applicability.inapplicable = { 'mobile-responsive': 'no user interface found in this repository' };
    const { recordExecution } = await import('./taskSchedule.js');
    expect(await generate('mobile-responsive')).toBeNull();
    expect(recordExecution).toHaveBeenCalledWith('mobile-responsive', 'app-1');
    // A sibling audit that does apply still generates.
    expect(await generate('reliability')).not.toBeNull();
  });

  it('runs an inapplicable audit the user explicitly chose: an override or a manual Run', async () => {
    applicability.inapplicable = { 'mobile-responsive': 'no user interface found in this repository' };
    const { getTaskInterval } = await import('./taskSchedule.js');
    // An on-demand request (a manual Run) is an explicit choice and is not gated —
    // whether the drain serves it or idle review steals it.
    expect(await generate('mobile-responsive', { skipPreconditions: true })).not.toBeNull();
    expect(await generate('mobile-responsive', { onDemand: true })).not.toBeNull();
    // The schedule form's recorded override lets the scheduled lane run it too.
    getTaskInterval.mockResolvedValue({ type: 'weekly', taskMetadata: { runInapplicableAudit: true } });
    expect(await generate('mobile-responsive')).not.toBeNull();
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
    const handoff = prompt.slice(prompt.indexOf('## Required audit assessment handoff'));
    expect(handoff).toContain(`category "${taskType}"`);
    expect(handoff).toContain('summary AND exactly one single-line QUALITY_AUDIT_JSON:');
    expect(prompt).not.toContain('write a one-line summary');
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
    expect(prompt).toContain('Mode: audit and fix, track every deferred finding');
    expect(prompt).toContain('Repository-wide discovery, worst offender first');
    expect(prompt).toContain(`"category":"${taskType}"`);
    expect(prompt).toMatch(/^## Completion Workflow$/m);
    expect(prompt).toContain('## Required audit assessment handoff');
    expect(prompt).toMatch(/^\s*\d+\.\s+`\/do:push/m);
  });

  it('gives the complexity audit its report command and a fallback for other languages or repositories', async () => {
    const prompt = renderPrompt(await generate('better-complexity'));
    expect(prompt).toContain('If the target repository has server/scripts/complexity-report.js');
    expect(prompt).toContain('npm run quality:complexity');
    expect(prompt).toContain('record scan failures and separately analyze first-party languages the report does not cover');
    expect(prompt).toContain('If the command is absent or fails, use another language-aware complexity analyzer');
    expect(prompt).toContain('in the run narrative, not QUALITY_AUDIT_JSON');
    expect(prompt).toContain('A high count alone is not a finding');
    expect(renderPrompt(await generate('security'))).not.toContain('npm run quality:complexity');
  });

  it('requires a persisted report for CLI audits that normally finish by exiting', async () => {
    const task = await generate('better-complexity');
    const prompt = buildLightContextPrompt(task, WORKSPACE, null, { isTui: false });
    expect(prompt).toContain('## Required audit assessment handoff');
    expect(prompt).toContain('including agents that normally finish by exiting');
    expect(prompt).toContain('.agent-done');
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
    ['manual run / on-demand', { skipPreconditions: true, targetPullRequest: null, runOverrides: null }],
    ['quota burn (no param override)', { skipPreconditions: true, targetPullRequest: null, runOverrides: {} }],
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
    expect(task.description).toContain('Mode: audit and fix, track every deferred finding');
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
    }, { isTui: true, providerId: 'codex-tui', providerCommand: 'codex' });
    expect(prompt).toContain('gh pr create');
    expect(prompt).toContain('## Merge Gate');
    expect(prompt).toContain('--merge --match-head-commit <verified-head>');
    expect(prompt).not.toContain('PortOS will merge it back after completion');
  });

  it('allows a verified no-change completion only in fix mode', async () => {
    const fix = await generate('security', { skipPreconditions: true, runOverrides: { fileIssues: false } });
    expect(fix.metadata.noChangeSuccess).toBe(true);
    const filing = await generate('security', { skipPreconditions: true, runOverrides: { fileIssues: true } });
    expect(filing.metadata.noChangeSuccess).not.toBe(true);
  });

  it('requires tracked deferrals even with a customized one-fix mission', async () => {
    const { getTaskInterval } = await import('./taskSchedule.js');
    getTaskInterval.mockResolvedValue({ type: 'weekly', taskMetadata: { fileIssues: true } });
    promptTemplate.body = 'Audit {appName}. Stop after one fix and do not file deferred issues.';
    const task = await generate('security', { skipPreconditions: true, runOverrides: { fileIssues: false } });
    const prompt = renderPrompt(task);
    const rule = 'Every actionable finding must end as a verified fix or a linked existing/new tracker issue.';
    expect(prompt).toContain(rule);
    expect(prompt).toContain('This banner OVERRIDES any later instruction to stop after one fix');
    expect(prompt.indexOf(rule)).toBeLessThan(prompt.indexOf('Stop after one fix and do not file deferred issues.'));
    expect(prompt).toContain('A summary-only deferral is incomplete delivery');
  });

  it('run overrides pass the same allowlist a stored override does', async () => {
    const { getTaskInterval } = await import('./taskSchedule.js');
    getTaskInterval.mockResolvedValue({ type: 'weekly', taskMetadata: { fileIssues: true } });

    const task = await generate('ux', { skipPreconditions: true, runOverrides: { fileIssues: true, notARealFlag: true } });
    expect(task.metadata.fileIssues).toBe(true);
    expect(task.metadata.notARealFlag).toBeUndefined();
  });

  it.each([{ prCompletion: 'merge-on-green' }, { readOnly: true }])('preserves run-level draft delivery through pipeline stage zero %j', async stagePosture => {
    const { getTaskInterval } = await import('./taskSchedule.js');
    getTaskInterval.mockResolvedValue({ type: 'weekly', taskMetadata: {
      pipeline: { stages: [{ name: 'Audit', promptKey: 'security', ...stagePosture }] },
    } });
    const [step] = buildMaintenanceSteps({
      appId: 'app-1', idPrefix: 'pipeline-draft', mode: 'fix', prCompletion: 'draft', taskTypes: ['security'],
    });
    const task = await generate('security', { skipPreconditions: true, runOverrides: step.overrides.params });
    expect(task.metadata.prCompletion).toBe('draft');
    expect(task.metadata.pipeline.taskDefaults.prCompletion).toBe('draft');
    if (stagePosture.readOnly) expect(task.metadata).toMatchObject({ readOnly: true, openPR: false, useWorktree: false });
  });

  it('keeps explicit draft delivery through scheduled defaults, app overrides and the generated Codex contract', async () => {
    const { getTaskInterval } = await import('./taskSchedule.js');
    const { getAppTaskTypeOverrides } = await import('./apps.js');
    getTaskInterval.mockResolvedValue({ type: 'weekly', taskMetadata: {
      fileIssues: true, useWorktree: false, openPR: false, prCompletion: 'merge-on-green',
    } });
    getAppTaskTypeOverrides.mockResolvedValueOnce({ security: { taskMetadata: {
      prCompletion: 'review-then-merge', reviewLoop: true,
    } } });
    const [step] = buildMaintenanceSteps({
      appId: 'app-1', idPrefix: 'draft-review', mode: 'fix', prCompletion: 'draft', taskTypes: ['security'],
    });
    const task = await generate(step.taskRef.taskType, {
      skipPreconditions: true, runOverrides: step.overrides.params,
    });
    expect(task.metadata).toMatchObject({ fileIssues: false, useWorktree: true, openPR: true, prCompletion: 'draft' });
    expect(task.metadata.noCodeOutput).toBeUndefined();
    const prompt = buildLightContextPrompt(task, WORKSPACE, {
      branchName: 'audit/security', worktreePath: WORKSPACE,
    }, { isTui: true, providerId: 'codex-tui', providerCommand: 'codex' });
    expect(prompt).toContain('Mode: audit and fix, track every deferred finding');
    expect(prompt).toContain('DRAFT pull request for human review');
    expect(prompt).toContain('Do NOT push, open, or merge a pull request yourself');
    expect(prompt).not.toMatch(/## Merge Gate|## Review Loop|gh pr merge|glab mr merge/);
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


describe('new extended Deep creation boundaries', () => {
  it.each(['schedule', 'manual'])('stamps a new %s task without creating a certification identity', async lane => {
    const { getTaskInterval } = await import('./taskSchedule.js');
    promptTemplate.body = AUDIT_TEMPLATE;
    getTaskInterval.mockResolvedValue({ type: 'weekly', taskMetadata: lane === 'schedule' ? { auditDepth: 'deep', fileIssues: false } : {} });
    const task = await generate('security', lane === 'manual' ? { skipPreconditions: true, runOverrides: { auditDepth: 'deep', fileIssues: false } } : {});
    expect(task.metadata).toMatchObject({ auditDepth: 'deep', auditWorkflow: 'extended-v1', fileIssues: false });
    expect(task.metadata.deepAuditId).toBeUndefined();
  });
  it('stamps custom jobs but rejects historical checkpoint injection', async () => {
    const job = { id: 'job-example', name: 'Audit', promptTemplate: 'Investigate and fix', appId: 'app-1', taskMetadata: { auditDepth: 'deep', fileIssues: false, useWorktree: true, openPR: true } };
    expect((await generateTaskFromJob(job)).metadata).toMatchObject({ auditWorkflow: 'extended-v1', useWorktree: true, openPR: true });
    await expect(generateTaskFromJob({ ...job, taskMetadata: { ...job.taskMetadata, deepAuditId: 'historical' } })).rejects.toThrow('read-only');
  });
});
