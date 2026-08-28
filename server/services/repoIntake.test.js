import { describe, it, expect, vi, beforeEach } from 'vitest';

const addTask = vi.fn();
const getAppById = vi.fn();
const readOriginRemoteUrl = vi.fn();
const existsSync = vi.fn();

vi.mock('./cos.js', () => ({ addTask: (...args) => addTask(...args) }));
vi.mock('./apps.js', () => ({
  PORTOS_APP_ID: 'portos-default',
  getAppById: (...args) => getAppById(...args),
}));
vi.mock('./malwareScanReports.js', () => ({
  prepareScanReportDirectory: vi.fn(async () => {}),
  reportPathForId: (id) => `/scans/${id}.md`,
}));
vi.mock('fs', () => ({ existsSync: (...args) => existsSync(...args) }));
// The REAL workTracker resolution runs — the tracker instructions in the prompt
// are what these tests assert. Only its one shell-out is stubbed; the tracker is
// steered through the app's own `workTracker` setting, as a user would.
vi.mock('../lib/gitRemote.js', () => ({
  readOriginRemoteUrl: (...args) => readOriginRemoteUrl(...args),
}));

const { queueMalwareScan, queueRepoStudy, runRepoIntake, buildRepoStudyContext } = await import('./repoIntake.js');

const LINK = {
  id: 'link-1',
  url: 'https://github.com/example-owner/example-repo',
  title: 'example-owner/example-repo',
  gitHubOwner: 'example-owner',
  gitHubRepo: 'example-repo',
  localPath: '/repos/example-owner/example-repo',
};

const APP = { id: 'portos-default', name: 'PortOS', repoPath: '/srv/portos', workTracker: 'github' };

beforeEach(() => {
  vi.clearAllMocks();
  existsSync.mockReturnValue(true);
  getAppById.mockResolvedValue(APP);
  readOriginRemoteUrl.mockResolvedValue(null);
  addTask.mockImplementation(async () => ({ id: 'task-abc' }));
});

describe('queueMalwareScan', () => {
  it('queues the bare slashdo command with the clone path as SCAN_DIR', async () => {
    const result = await queueMalwareScan(LINK);

    expect(result.queued).toBe(true);
    expect(result.taskId).toBe('task-abc');
    const [taskData, taskType] = addTask.mock.calls[0];
    const { reportId } = taskData.malwareScan;
    expect(taskType).toBe('user');
    expect(taskData.slashdoCommand).toBe('scan');
    // The ~65KB command body must NOT be inlined into the task context (#3114).
    expect(taskData.context).toContain(LINK.localPath);
    expect(taskData.context.length).toBeLessThan(2000);
    expect(taskData.slashdoArgs).toContain(`/scans/${reportId}.md`);
    expect(taskData.malwareScan).toEqual({ linkId: 'link-1', reportId: expect.any(String) });
    expect(taskData.useWorktree).toBe(false);
    expect(taskData.openPR).toBe(false);
  });

  // Both callers (the Links tab's Scan button and the capture-time checkbox)
  // apply this, so a pending scan is visible on the link from either entry point
  // instead of the button re-arming into a 409 after a reload.
  it('returns a link patch stamping the scan as pending, not as a readable report', () => {
    return queueMalwareScan(LINK).then(result => {
      expect(result.linkPatch).toEqual({
        malwareScan: { reportId: expect.any(String), taskId: 'task-abc', status: 'queued' },
      });
    });
  });

  it('refuses when the recorded clone path is gone from disk', async () => {
    existsSync.mockReturnValue(false);
    expect(await queueMalwareScan(LINK)).toEqual({ queued: false, reason: 'not-cloned' });
    expect(addTask).not.toHaveBeenCalled();
  });

  it('reports a rejected duplicate instead of claiming a fresh queue', async () => {
    addTask.mockResolvedValue({ id: 'task-existing', duplicate: true });
    expect(await queueMalwareScan(LINK)).toEqual({ queued: false, reason: 'duplicate', taskId: 'task-existing' });
  });
});

describe('queueRepoStudy', () => {
  it('files into the app\'s resolved tracker and expects no commit on a forge tracker', async () => {
    const result = await queueRepoStudy(LINK);

    expect(result.queued).toBe(true);
    expect(result.linkPatch).toEqual({ repoStudy: { taskId: 'task-abc', queuedAt: expect.any(String) } });
    const [taskData] = addTask.mock.calls[0];
    expect(taskData.workTracker).toBe('github');
    // A github-tracker run files issues out of band and leaves the tree clean —
    // flagging otherwise scores every successful run as `idle-no-changes`.
    expect(taskData.worktreeChangesExpected).toBe(false);
    expect(taskData.repoStudy).toEqual({ linkId: 'link-1' });
    expect(taskData.context).toContain('gh issue create');
    expect(taskData.context).toContain('repo-study-');
    expect(taskData.context).toContain('Repo-study complete-label contract (mandatory)');
    expect(taskData.context).toContain('--label area:<area> --label model:<tier> --label effort:<level>');
  });

  it('files against the selected managed app', async () => {
    const target = { id: 'app-2', name: 'Example App', repoPath: '/srv/example-app', workTracker: 'github' };
    getAppById.mockImplementation(async id => id === target.id ? target : null);
    await queueRepoStudy(LINK, target.id);
    expect(getAppById).toHaveBeenCalledWith(target.id);
    expect(addTask.mock.calls[0][0].app).toBe(target.id);
    expect(addTask.mock.calls[0][0].context).toContain('Example App');
    expect(addTask.mock.calls[0][0].context).toContain('inspected target-app files');
    expect(addTask.mock.calls[0][0].context).not.toContain('current PortOS area vocabulary');
  });

  it('passes the selected provider, model, and effort to the repo-study task', async () => {
    await queueRepoStudy(LINK, undefined, undefined, {
      providerId: 'codex',
      model: 'gpt-5',
      effort: 'high',
    });

    expect(addTask.mock.calls[0][0]).toEqual(expect.objectContaining({
      provider: 'codex',
      model: 'gpt-5',
      effort: 'high',
    }));
  });

  // `analysisType` enrolls a task in taskSchedule's per-type consecutive-failure
  // ledger (agentFinalization.js), which auto-parks and notifies. A hand-queued
  // repo study has no schedule to park, so it must reach the no-commit gate via
  // `workTracker` instead — see taskTypeHooks.js#isTrackerFilingDispatch.
  it('points the brief at the app\'s feature map when the repo keeps one, else asks for one to be built', async () => {
    await queueRepoStudy(LINK);
    expect(addTask.mock.calls[0][0].context).toContain('Read `/srv/portos/docs/features/product-surfaces.md`');

    // Only the clone exists; the app has no product-surfaces map.
    existsSync.mockImplementation((path) => path === LINK.localPath);
    await queueRepoStudy(LINK);
    expect(addTask.mock.calls[1][0].context).toMatch(/keeps no single feature inventory; build one/);
  });

  it('does not masquerade as a scheduled task type', async () => {
    await queueRepoStudy(LINK);
    expect(addTask.mock.calls[0][0].analysisType).toBeUndefined();
  });

  it('expects a commit on a PLAN.md tracker, where proposals dirty the tree', async () => {
    getAppById.mockResolvedValue({ ...APP, workTracker: 'plan' });
    await queueRepoStudy(LINK);
    const [taskData] = addTask.mock.calls[0];
    expect(taskData.workTracker).toBe('plan');
    expect(taskData.worktreeChangesExpected).toBe(true);
    expect(taskData.context).toContain('PLAN.md');
  });

  it('does not queue against an app archived after capture', async () => {
    getAppById.mockResolvedValue({ ...APP, archived: true });
    expect(await queueRepoStudy(LINK)).toEqual({ queued: false, reason: 'app-not-found' });
    expect(addTask).not.toHaveBeenCalled();
  });

  it('degrades to the PLAN.md block when the origin lookup fails', async () => {
    getAppById.mockResolvedValue({ ...APP, workTracker: 'auto' });
    readOriginRemoteUrl.mockRejectedValue(new Error('not a git repository'));
    await queueRepoStudy(LINK);
    const [taskData] = addTask.mock.calls[0];
    expect(taskData.workTracker).toBe('plan');
    expect(taskData.context).toContain('PLAN.md');
  });

  it('expands the tracker block\'s {appName}/{repoPath} placeholders', async () => {
    getAppById.mockResolvedValue({ ...APP, workTracker: 'plan' });
    await queueRepoStudy(LINK);
    const { context } = addTask.mock.calls[0][0];
    expect(context).not.toMatch(/\{appName\}|\{repoPath\}/);
    expect(context).toContain('/srv/portos');
  });

  it('refuses when PortOS has no repo path to file against', async () => {
    getAppById.mockResolvedValue({ id: 'portos-default', name: 'PortOS' });
    expect(await queueRepoStudy(LINK)).toEqual({ queued: false, reason: 'app-not-found' });
    expect(addTask).not.toHaveBeenCalled();
  });
});

describe('buildRepoStudyContext', () => {
  const context = () => buildRepoStudyContext(LINK, {
    appName: 'PortOS',
    repoPath: '/srv/portos',
    trackerInstructions: 'FILE HERE',
  });

  it('forbids executing or editing the untrusted clone', () => {
    const body = context();
    expect(body).toMatch(/Never execute anything from the clone/);
    expect(body).toMatch(/Never edit the clone/);
    expect(body).toContain(LINK.localPath);
  });

  it('frames the study around features and design, with engineering hygiene out of scope', () => {
    const body = context();
    // The brief must ask for product-level ideas — a study that only reports
    // module layout / spawn plumbing / build tooling is the failure mode this
    // pins (#5301–#5304 were all of that shape).
    expect(body).toMatch(/Study it as a PRODUCT/);
    expect(body).toMatch(/New features PortOS lacks/);
    expect(body).toMatch(/Enhancements to features PortOS already has/);
    expect(body).toMatch(/\*\*Out of scope:\*\* code organization, module layout, build tooling/);
    expect(body).toMatch(/file ONE epic .* plus one ready-to-work issue per phase/);
  });

  it('makes the agent state the repo purpose and map it onto the whole feature inventory first', () => {
    const body = context();
    expect(body).toMatch(/## First: what is this repo, and where does it land in PortOS\?/);
    expect(body).toMatch(/State the repo's purpose/);
    expect(body).toMatch(/three\.js game, scene, or visual-rendering demo belongs to the 3D \/ OpenWorld surface/);
    // No feature map supplied → the brief tells the agent to build one.
    expect(body).toMatch(/keeps no single feature inventory; build one from its README/);
  });

  it('points the agent at the feature map when the target app keeps one', () => {
    const body = buildRepoStudyContext(LINK, {
      appName: 'PortOS',
      repoPath: '/srv/portos',
      trackerInstructions: 'FILE HERE',
      featureMapPath: '/srv/portos/docs/features/product-surfaces.md',
    });
    expect(body).toContain('Read `/srv/portos/docs/features/product-surfaces.md` — PortOS\'s user-facing feature inventory — in full');
    expect(body).not.toMatch(/keeps no single feature inventory/);
  });

  it('states the clean-room and license rules the proposals depend on', () => {
    const body = context();
    expect(body).toMatch(/Clean-room/);
    expect(body).toMatch(/LICENSE/);
  });

  it('includes requester context as guidance for the study', () => {
    const body = buildRepoStudyContext(LINK, {
      appName: 'PortOS',
      repoPath: '/srv/portos',
      trackerInstructions: 'FILE HERE',
      studyContext: 'Look for indexing improvements and where they fit in search.',
    });
    expect(body).toContain('## Additional context from the requester');
    expect(body).toContain('Look for indexing improvements and where they fit in search.');
  });
});

describe('runRepoIntake', () => {
  it('does nothing when the user ticked nothing', async () => {
    expect(await runRepoIntake(LINK, { malwareScan: false, learn: false })).toEqual({});
    expect(addTask).not.toHaveBeenCalled();
  });

  it('queues only the ticked action and returns its link patch', async () => {
    const patch = await runRepoIntake(LINK, { learn: true });
    expect(addTask).toHaveBeenCalledTimes(1);
    expect(patch.malwareScan).toBeUndefined();
    expect(patch.repoStudy).toEqual({ taskId: 'task-abc', queuedAt: expect.any(String) });
  });

  it('passes requester context into the queued repo study', async () => {
    await runRepoIntake(LINK, { learn: true, studyContext: 'Focus on the search architecture.' });
    expect(addTask.mock.calls[0][0].context).toContain('Focus on the search architecture.');
  });

  it('passes provider pins from the stored intake into the queued repo study', async () => {
    await runRepoIntake(LINK, {
      learn: true,
      providerId: 'codex',
      model: 'gpt-5',
      effort: 'high',
    });
    expect(addTask.mock.calls[0][0]).toEqual(expect.objectContaining({
      provider: 'codex',
      model: 'gpt-5',
      effort: 'high',
    }));
  });

  it('stamps a queued scan as `queued`, so the UI does not link at a missing report', async () => {
    const patch = await runRepoIntake(LINK, { malwareScan: true });
    expect(patch.malwareScan).toEqual({
      reportId: expect.any(String),
      taskId: 'task-abc',
      status: 'queued',
    });
  });

  it('still queues the other action when one throws', async () => {
    addTask
      .mockRejectedValueOnce(new Error('task store down'))
      .mockResolvedValueOnce({ id: 'task-study' });
    const patch = await runRepoIntake(LINK, { malwareScan: true, learn: true });
    expect(patch.malwareScan).toBeUndefined();
    expect(patch.repoStudy).toEqual({ taskId: 'task-study', queuedAt: expect.any(String) });
  });
});
