/**
 * The calibration producer at its public boundary: an overturned goal-fidelity
 * finding in → a task queued against PortOS's own repo out.
 *
 * Three things here would each be invisible in production until they had
 * already cost something:
 *
 *  - the calibration must land on PORTOS, not on the app whose run produced the
 *    finding. Passing the app through would put a PortOS prompt fix in a managed
 *    app's backlog, where nothing can act on it — and it would look like it
 *    worked;
 *  - the dedup key must be DERIVED from the gap, never taken from the report.
 *    The reporter is a model writing JSON; a key it chose could collide with (or
 *    evict) an unrelated investigation;
 *  - the PR must wait for a human. A calibration edits the judge every future
 *    run is scored by, and "merge on green" on that is how a gate gets disarmed
 *    quietly.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const getSettings = vi.fn();
const fileInvestigationTask = vi.fn();
const updateTask = vi.fn();
const getAgents = vi.fn();
const updateAgent = vi.fn();

vi.mock('./cos.js', () => ({ updateTask }));
vi.mock('./cosAgentLifecycle.js', () => ({ getAgents, updateAgent }));
vi.mock('./settings.js', () => ({ getSettings }));
vi.mock('./investigationTaskProducer.js', () => ({ fileInvestigationTask }));

const { reportGoalFidelityFalsePositive } = await import('./goalFidelityCalibration.js');
const { SUPERVISED_INVESTIGATION_DELIVERY } = await import('../lib/investigationTasks.js');
const { goalFidelityCalibrationFingerprint } = await import('../lib/goalFidelityCalibration.js');

const REPORT = {
  gap: 'work-outside-diff',
  detail: 'The cap already existed on the base branch; the run only added its test.',
  evidence: 'server/lib/retry.js:88',
  fingerprint: 'goal-fidelity:user:comics/add-retry-caps',
  taskId: 'task-7',
  verdict: 'rethink',
};

/** The single `fileInvestigationTask` call's two arguments. */
const filed = () => ({ args: fileInvestigationTask.mock.calls[0][0], opts: fileInvestigationTask.mock.calls[0][1] });

beforeEach(() => {
  vi.clearAllMocks();
  getSettings.mockResolvedValue({ codeReview: { goalFidelity: { enabled: true } } });
  getAgents.mockResolvedValue([]);
  updateAgent.mockResolvedValue({});
  updateTask.mockResolvedValue({});
  fileInvestigationTask.mockResolvedValue({ task: { id: 'calib-1' }, approvalRequired: false, loopReason: null });
});

describe('reportGoalFidelityFalsePositive', () => {
  it('queues the calibration against PortOS, never the app the finding was about', async () => {
    const result = await reportGoalFidelityFalsePositive({ ...REPORT, app: 'comics' });
    expect(result.queued).toBe(true);
    expect(result.taskId).toBe('calib-1');
    // `fileInvestigationTask` resolves the repo from `app` and defaults to
    // PortOS when it is absent, so the assertion is that we never pass one —
    // the judge is PortOS code however the finding got here.
    expect(filed().args).not.toHaveProperty('app');
  });

  // The reporter is a model writing JSON, so the key it names is provenance and
  // nothing else. The hostile input is the probe: a report pointing at an
  // unrelated investigation's key must not be able to fold into — or evict — it.
  it('derives the dedup key from the gap and ignores the key the reporter supplied', async () => {
    await reportGoalFidelityFalsePositive({ ...REPORT, fingerprint: 'crash:provider:ollama-timeout' });
    expect(filed().args.fingerprint).toBe(goalFidelityCalibrationFingerprint('work-outside-diff'));
    expect(filed().args.fingerprint).not.toBe('crash:provider:ollama-timeout');
  });

  it('records the misjudged run as an affected task, so repeat reports accumulate', async () => {
    await reportGoalFidelityFalsePositive(REPORT);
    expect(filed().args.affectedTasks).toEqual(['task-7']);
  });

  it('stamps every matching run when the calibration was queued without rewriting its verdict', async () => {
    getAgents.mockResolvedValue([
      { id: 'agent-1', taskId: 'task-7', result: { success: false, goalFidelity: { verdict: 'rethink', evidence: 'partial diff' } } },
      { id: 'agent-2', metadata: { taskId: 'task-7' }, result: { goalFidelity: { verdict: 'fix-first' } } },
      { id: 'agent-ship', taskId: 'task-7', result: { goalFidelity: { verdict: 'ship' } } },
      { id: 'agent-other', taskId: 'task-8', result: { goalFidelity: { verdict: 'rethink' } } },
    ]);

    await reportGoalFidelityFalsePositive(REPORT);

    expect(updateAgent).toHaveBeenCalledTimes(2);
    expect(updateAgent).toHaveBeenCalledWith('agent-1', {
      result: {
        success: false,
        goalFidelity: {
          verdict: 'rethink',
          evidence: 'partial diff',
          overturned: {
            gap: 'work-outside-diff',
            calibrationTaskId: 'calib-1',
            at: expect.any(String),
          },
        },
      },
    });
    expect(updateAgent.mock.calls[1][1].result.goalFidelity.verdict).toBe('fix-first');
  });

  it('sends no affected tasks when the report named no run', async () => {
    await reportGoalFidelityFalsePositive({ gap: 'rubric-gap' });
    expect(filed().args.affectedTasks).toEqual([]);
  });

  it('makes the PR wait for a human, because the change edits the judge itself', async () => {
    await reportGoalFidelityFalsePositive(REPORT);
    expect(filed().opts.delivery).toBe(SUPERVISED_INVESTIGATION_DELIVERY);
    expect(SUPERVISED_INVESTIGATION_DELIVERY.prCompletion).toBe('review-then-merge');
  });

  it('carries the investigator\'s diagnosis into the queued body', async () => {
    await reportGoalFidelityFalsePositive(REPORT);
    expect(filed().args.description).toContain('the run only added its test');
    expect(filed().args.description).toContain('server/lib/retry.js:88');
  });

  it('normalizes an unknown gap and still queues it', async () => {
    const result = await reportGoalFidelityFalsePositive({ ...REPORT, gap: 'the-model-was-confused' });
    expect(result.queued).toBe(true);
    expect(result.gap).toBe('other');
    expect(filed().args.fingerprint).toBe(goalFidelityCalibrationFingerprint('other'));
  });

  it('refuses when the gate is off — no review could have produced this finding', async () => {
    getSettings.mockResolvedValue({ codeReview: { goalFidelity: { enabled: false } } });
    const result = await reportGoalFidelityFalsePositive(REPORT);
    expect(result.queued).toBe(false);
    expect(result.reason).toMatch(/disabled/);
    expect(fileInvestigationTask).not.toHaveBeenCalled();
    expect(getAgents).not.toHaveBeenCalled();
    expect(updateAgent).not.toHaveBeenCalled();
  });

  it('runs on an install that configured nothing, since the gate defaults on', async () => {
    // The follow-up switches (`fileIssue` / `queueTask`) gate outward actions and
    // are off by default; a calibration writes one local queue entry and would be
    // lost on exactly the installs most likely to produce it.
    getSettings.mockResolvedValue({ codeReview: {} });
    expect((await reportGoalFidelityFalsePositive(REPORT)).queued).toBe(true);
  });

  it('survives an unreadable settings file rather than dropping the report', async () => {
    getSettings.mockRejectedValue(new Error('EACCES'));
    expect((await reportGoalFidelityFalsePositive(REPORT)).queued).toBe(true);
  });

  it('reports a fold into the open calibration as a usable outcome, not a failure', async () => {
    fileInvestigationTask.mockResolvedValue({ task: { id: 'calib-1', duplicate: true }, approvalRequired: false });
    const result = await reportGoalFidelityFalsePositive(REPORT);
    expect(result).toMatchObject({ queued: true, duplicate: true, taskId: 'calib-1' });
  });

  // `addTask`'s dedup returns the surviving task untouched, so without an explicit
  // union the calibration names only the FIRST misjudged run however many times
  // the gap fires — and the task body tells the agent to size the fix by exactly
  // that count.
  it('unions a repeat report\'s run into the calibration that already tracks the gap', async () => {
    fileInvestigationTask.mockResolvedValue({
      task: { id: 'calib-1', duplicate: true, description: '[Auto] Goal-fidelity calibration', metadata: { affectedTasks: ['task-1'] } },
    });
    await reportGoalFidelityFalsePositive({ ...REPORT, taskId: 'task-9' });
    expect(updateTask).toHaveBeenCalledWith('calib-1', expect.objectContaining({
      metadata: { affectedTasks: ['task-1', 'task-9'] },
    }), 'internal');
    // The body is what the agent actually reads, so the run has to land there too.
    expect(updateTask.mock.calls[0][1].description).toContain('task-9');
  });

  it('does not re-add a run the calibration already names', async () => {
    fileInvestigationTask.mockResolvedValue({
      task: { id: 'calib-1', duplicate: true, description: 'x', metadata: { affectedTasks: ['task-7'] } },
    });
    await reportGoalFidelityFalsePositive(REPORT);
    expect(updateTask).not.toHaveBeenCalled();
  });

  it('leaves a freshly-created calibration alone — there is nothing to union into', async () => {
    await reportGoalFidelityFalsePositive(REPORT);
    expect(updateTask).not.toHaveBeenCalled();
  });

  it('still reports the queued calibration when the union write fails', async () => {
    fileInvestigationTask.mockResolvedValue({
      task: { id: 'calib-1', duplicate: true, description: 'x', metadata: {} },
    });
    updateTask.mockRejectedValue(new Error('state locked'));
    const result = await reportGoalFidelityFalsePositive({ ...REPORT, taskId: 'task-9' });
    expect(result).toMatchObject({ queued: true, duplicate: true });
  });

  // The report block emits a curl whose fields are all `<…>` placeholders; an
  // agent running it verbatim must not queue a task whose diagnosis is the template.
  it('refuses the unfilled template with a reason naming what to send instead', async () => {
    const result = await reportGoalFidelityFalsePositive({
      gap: '<one of: truncated-diff | other>',
      detail: '<what the reviewer could not see, in one or two sentences>',
      evidence: '<file:line, commit, or PR that shows the objective WAS delivered>',
    });
    expect(result.queued).toBe(false);
    expect(result.reason).toMatch(/unfilled template/);
    expect(result.reason).toContain('rubric-gap');
    expect(fileInvestigationTask).not.toHaveBeenCalled();
  });

  it('refuses the template before reading settings, so a disabled gate is not the reported cause', async () => {
    getSettings.mockResolvedValue({ codeReview: { goalFidelity: { enabled: false } } });
    const result = await reportGoalFidelityFalsePositive({ gap: '<one of: …>' });
    expect(result.reason).toMatch(/unfilled template/);
  });

  it('names the loop policy\'s own reason when it suppressed the calibration', async () => {
    fileInvestigationTask.mockResolvedValue({ task: null, loopReason: 'repeat-fingerprint' });
    const result = await reportGoalFidelityFalsePositive(REPORT);
    expect(result.queued).toBe(false);
    expect(result.reason).toContain('repeat-fingerprint');
  });

  it('still answers when the producer returned nothing at all', async () => {
    fileInvestigationTask.mockResolvedValue(null);
    const result = await reportGoalFidelityFalsePositive(REPORT);
    expect(result).toMatchObject({ queued: false, gap: 'work-outside-diff' });
    expect(result.reason).toBeTruthy();
  });

  it('surfaces an approval hold rather than reporting it as queued', async () => {
    fileInvestigationTask.mockResolvedValue({ task: { id: 'calib-1' }, approvalRequired: true });
    expect((await reportGoalFidelityFalsePositive(REPORT)).approvalRequired).toBe(true);
  });
});
