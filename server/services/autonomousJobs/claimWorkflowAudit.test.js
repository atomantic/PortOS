import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queue, state, store } = vi.hoisted(() => ({ queue: { tasks: [] }, state: { agents: {} }, store: { jobs: [] } }));
vi.mock('./store.js', () => ({ loadJobs: vi.fn(async () => store), saveJobs: vi.fn(async data => { store.jobs = data.jobs; }) }));
vi.mock('./scheduler.js', () => ({ getNextDueJob: vi.fn() }));
vi.mock('../cosTaskStore.js', () => ({ getCosTasks: vi.fn(async () => queue) }));
vi.mock('../cosState.js', () => ({ loadState: vi.fn(async () => state) }));
vi.mock('../apps.js', () => ({ getAppById: vi.fn() }));
vi.mock('../taskDataInputs.js', () => ({ appendTaskDataInputs: prompt => prompt, resolveTaskDataInputs: vi.fn() }));

let audit;
let generateTaskFromJob;
const configured = () => ({ ...audit.CLAIM_WORKFLOW_AUDIT_JOB, providerId: 'chosen-provider', model: 'chosen-model', effort: 'high', formValues: { recentRuns: 3, maxFindings: 2, minutes: 15 } });

beforeEach(async () => {
  vi.resetModules();
  queue.tasks = [];
  state.agents = {};
  // Initialize the I/O doubles before exercising concurrent lazy imports.
  await import('../cosTaskStore.js');
  await import('../cosState.js');
  audit = await import('./claimWorkflowAudit.js');
  ({ generateTaskFromJob } = await import('./skillTemplates.js'));
});

describe('PortOS workflow audit job dispatch', () => {
  it('ships disabled with no selected cadence or implicit paid model and preserves configured settings across default merges', async () => {
    const { createDefaultJobsData, mergeWithDefaults } = await import('./defaults.js');
    const fresh = createDefaultJobsData().jobs.find(job => job.id === audit.CLAIM_WORKFLOW_AUDIT_ID);
    expect(fresh).toMatchObject({ enabled: false, interval: 'on-demand', intervalMs: null, model: null, providerId: null, formValues: {}, portosOnly: true });
    const saved = { ...configured(), enabled: true, interval: 'weekly', intervalMs: 604800000 };
    const merged = mergeWithDefaults({ jobs: [saved] }).data.jobs.find(job => job.id === saved.id);
    expect(merged).toMatchObject(saved);
    expect(merged.appId).toBe(fresh.appId);
  });

  it('persists cadence/model/budget edits while refusing a managed-app or delivery-posture rewrite', async () => {
    store.jobs = [{ ...audit.CLAIM_WORKFLOW_AUDIT_JOB }];
    const { updateJob, getJob } = await import('./crud.js');
    await updateJob(audit.CLAIM_WORKFLOW_AUDIT_ID, {
      enabled: true, interval: 'weekly', providerId: 'chosen-provider', model: 'chosen-model', effort: 'high',
      formValues: { recentRuns: 3, maxFindings: 2, minutes: 15 }, appId: 'another-app',
      taskMetadata: { useWorktree: false, openPR: false }, formFields: []
    });
    expect(await getJob(audit.CLAIM_WORKFLOW_AUDIT_ID)).toMatchObject({
      enabled: true, interval: 'weekly', providerId: 'chosen-provider', model: 'chosen-model', effort: 'high',
      formValues: { recentRuns: 3, maxFindings: 2, minutes: 15 }, appId: 'portos-default',
      taskMetadata: { useWorktree: true, openPR: true, noChangeSuccess: true },
      formFields: audit.CLAIM_WORKFLOW_AUDIT_JOB.formFields
    });
  });

  it('refuses incomplete or unbounded configurations before dispatch and allows a corrected retry', async () => {
    await expect(generateTaskFromJob(audit.CLAIM_WORKFLOW_AUDIT_JOB)).rejects.toMatchObject({ status: 400 });
    await expect(generateTaskFromJob({ ...configured(), formValues: { recentRuns: 999, minutes: 15, maxFindings: 2 } })).rejects.toMatchObject({ status: 400 });
    await expect(generateTaskFromJob(configured())).resolves.toMatchObject({ metadata: { model: 'chosen-model' } });
  });

  it('carries real source provenance and the existing verified no-change/changed-delivery posture into the queued task', async () => {
    const task = await generateTaskFromJob(configured());
    expect(task.metadata).toMatchObject({ jobId: audit.CLAIM_WORKFLOW_AUDIT_ID, app: 'portos-default', provider: 'chosen-provider', model: 'chosen-model', effort: 'high', useWorktree: true, openPR: true, noChangeSuccess: true });
    const snapshot = JSON.parse(task.metadata.prompt.split('Audit generator source snapshot (not a delivered-instruction manifest):\n')[1]);
    expect(snapshot).toMatchObject({ runtimeVersion: expect.any(String), budgets: { recentRuns: 3, maxFindings: 2, minutes: 15 } });
    expect(snapshot.sources).toContainEqual({ path: 'AGENTS.md', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  it('deduplicates simultaneous manual/scheduled preparation before task persistence', async () => {
    const results = await Promise.allSettled([generateTaskFromJob(configured()), generateTaskFromJob(configured())]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected').reason).toMatchObject({ status: 409, code: 'AUDIT_ACTIVE' });
  });

  it.each(['pending', 'in_progress', 'blocked'])('retains an interrupted or active %s occurrence instead of creating a recovery task', async status => {
    queue.tasks = [{ id: 'retained-audit', status, metadata: { jobId: audit.CLAIM_WORKFLOW_AUDIT_ID } }];
    await expect(generateTaskFromJob(configured())).rejects.toMatchObject({ status: 409, message: expect.stringContaining('retained-audit') });
  });

  it('retains a running scheduled audit which has no persisted task row', async () => {
    state.agents = { audit: { status: 'running', metadata: { jobId: audit.CLAIM_WORKFLOW_AUDIT_ID } } };
    await expect(generateTaskFromJob(configured())).rejects.toMatchObject({ status: 409 });
  });
});
