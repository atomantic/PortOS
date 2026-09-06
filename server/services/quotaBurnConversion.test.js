/**
 * The runtime half of the legacy → reference conversion.
 *
 * Two things are proven here that the migration's own suite cannot: that the
 * compat door behaves like the migration (same job, same id, no duplicate), and
 * that the job the conversion mints actually RUNS with the posture the retired
 * `quotaBurnJobs/agentPrompt.js` executor gave it. The second is where that
 * module's behaviour tests moved to — the coercions are now a property of the
 * converted job and the shared custom-job generator, not of a quota-only
 * executor.
 *
 * Only the jobs FILE is doubled, so `createJob` / `getJob` / `generateTaskFromJob`
 * are the real thing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = { data: { version: 1, lastUpdated: '', jobs: [] } };

vi.mock('./autonomousJobs/store.js', () => ({
  loadJobs: vi.fn(async () => store.data),
  saveJobs: vi.fn(async (data) => { store.data = data; }),
  initJobs: vi.fn(async () => store.data),
  syncSkillTemplatesFromSample: vi.fn(async () => {}),
}));

const { buildQuotaBurnCustomJob, planQuotaBurnStepConversion } = await import('../lib/quotaBurnLegacyConversion.js');
const { generatedJobTaskFields } = await import('../lib/autonomousJobTask.js');
const { convertLegacyQuotaBurnPatch } = await import('./quotaBurnConversion.js');
const { createJob, generateTaskFromJob, getAllJobs } = await import('./autonomousJobs.js');

const legacyStep = (overrides = {}) => ({
  id: 'step-1', enabled: true, label: 'House style pass', jobType: 'agent-prompt',
  params: { appId: 'app-example', prompt: 'Rewrite the onboarding copy.', ...overrides },
});
const patchWith = (...jobs) => ({ families: { grok: { enabled: true, jobs } } });
const convertedStep = (patch) => patch.families.grok.jobs[0];

beforeEach(() => {
  store.data = { version: 1, lastUpdated: '', jobs: [] };
});

describe('convertLegacyQuotaBurnPatch', () => {
  it('converts a legacy step an old client PUT and creates its task once', async () => {
    const first = await convertLegacyQuotaBurnPatch(patchWith(legacyStep()));
    expect(convertedStep(first).taskRef).toEqual({ kind: 'custom', jobId: 'job-burn-grok-step-1' });
    expect(convertedStep(first).jobType).toBeNull();
    expect((await getAllJobs()).map((job) => job.id)).toEqual(['job-burn-grok-step-1']);

    // The same body replayed — the crash buffer the page restores from, or a
    // second tab — must not mint a second automation.
    const second = await convertLegacyQuotaBurnPatch(patchWith(legacyStep()));
    expect(convertedStep(second).taskRef).toEqual({ kind: 'custom', jobId: 'job-burn-grok-step-1' });
    expect((await getAllJobs())).toHaveLength(1);
  });

  it('cannot downgrade a step that already carries a reference', async () => {
    const step = { id: 'step-1', enabled: true, taskRef: { kind: 'builtin', taskType: 'ux', appId: 'app-example' } };
    const patch = patchWith(step);
    expect(await convertLegacyQuotaBurnPatch(patch)).toBe(patch);
    expect(await getAllJobs()).toEqual([]);
  });

  it('leaves the step legacy when its task could not be created', async () => {
    // Unavailable with a migration reason is the deliberate posture — better
    // than a reference pointing at a job that is not there.
    const { saveJobs } = await import('./autonomousJobs/store.js');
    saveJobs.mockRejectedValueOnce(new Error('disk full'));
    const patch = await convertLegacyQuotaBurnPatch(patchWith(legacyStep()));
    expect(convertedStep(patch)).toMatchObject({ jobType: 'agent-prompt' });
    expect(convertedStep(patch).taskRef).toBeUndefined();
  });

  it('passes through a family the body did not restate', async () => {
    const patch = { enabled: true, families: { claude: { enabled: false } } };
    expect(await convertLegacyQuotaBurnPatch(patch)).toBe(patch);
  });
});

describe('the converted custom task', () => {
  it('is the SAME record whichever adapter creates it', async () => {
    // The migration appends the record to the jobs file directly; this door
    // hands it to `createJob`. A divergence would mean an install migrating and
    // an install PUTting an old body ended up with different automations.
    const record = buildQuotaBurnCustomJob({
      id: 'job-burn-grok-step-1', familyId: 'grok', stepId: 'step-1', label: 'House style pass',
      appId: 'app-example', prompt: 'Rewrite the onboarding copy.', params: {},
    });
    const created = await createJob(record);
    expect({ ...created, createdAt: null, updatedAt: null }).toEqual({ ...record, createdAt: null, updatedAt: null });
  });

  it('runs with the posture the retired executor derived, all the way onto the task', async () => {
    // Was `quotaBurnJobs/agentPrompt.test.js`. `discardWorktree` means the job
    // wants a scratch checkout that nothing may land from: leaving `openPR` on
    // makes the spawner expect a PR that cannot exist, which downgrades the run
    // to `pr-missing` and RETRIES it — up to five agent runs of subscription
    // quota on a job that already did its work — while a clean tree must count
    // as success rather than as the idle-complete failure.
    const outcome = planQuotaBurnStepConversion(
      { id: 'step-1', label: 'Reasoning pass', jobType: 'agent-prompt', params: { appId: 'app-example', prompt: 'Trace the failure paths.', discardWorktree: true, openPR: true, simplify: true } },
      { familyId: 'grok' },
    );
    const generated = await generateTaskFromJob(outcome.customJob);
    expect(generatedJobTaskFields(generated)).toMatchObject({
      app: 'app-example',
      prompt: 'Trace the failure paths.',
      openPR: false,
      simplify: false,
      discardWorktree: true,
      noCodeOutput: true,
      worktreeChangesExpected: false,
    });
  });

  it('keeps the auto-merge posture for a step that never asked to discard its worktree', async () => {
    const outcome = planQuotaBurnStepConversion(
      { id: 'step-1', jobType: 'agent-prompt', params: { appId: 'app-example', prompt: 'Ship the backlog.' } },
      { familyId: 'grok' },
    );
    const generated = await generateTaskFromJob(outcome.customJob);
    expect(generatedJobTaskFields(generated)).toMatchObject({
      useWorktree: true, openPR: true, simplify: true, discardWorktree: false, noCodeOutput: false, worktreeChangesExpected: true,
    });
  });

  it('is invokable by an unattended burn — approval was never something it could give', async () => {
    const outcome = planQuotaBurnStepConversion(
      { id: 'step-1', jobType: 'agent-prompt', params: { appId: 'app-example', prompt: 'x' } },
      { familyId: 'grok' },
    );
    expect(outcome.customJob.autonomyLevel).toBe('yolo');
    expect((await generateTaskFromJob(outcome.customJob)).autoApprove).toBe(true);
  });
});
