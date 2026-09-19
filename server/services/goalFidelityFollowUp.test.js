/**
 * The goal-fidelity follow-up filer, at its public boundary:
 * `runGoalFidelityFollowUp({ agentId, task, review })` in → an issue on the
 * right tracker and/or a queued CoS task out.
 *
 * The failure this suite exists to catch is a DUPLICATE. The producer is an
 * unattended loop, so an issue filed twice is filed forever — which is why
 * every tracker arm gets the same three cases: no existing issue (file), an
 * existing one carrying the marker (reuse, including a CLOSED one), and a
 * tracker we could not read (refuse, never file blind).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const execGh = vi.fn();
const execGlab = vi.fn();
const execGlabJson = vi.fn();
const ensureForgeReachable = vi.fn();
const listAppIssues = vi.fn();
const getAppById = vi.fn();
const getSettings = vi.fn();
const fileInvestigationTask = vi.fn();
const resolveAppForgeTarget = vi.fn();
const searchIssues = vi.fn();
const createTicket = vi.fn();

vi.mock('./github.js', () => ({ execGh, ensureForgeReachable }));
vi.mock('./gitlab.js', () => ({ execGlab, execGlabJson }));
vi.mock('./forgeExecOptions.js', () => ({
  resolveForgeExecOptions: async () => ({ cwd: '/repo', env: {}, customEnv: null }),
}));
vi.mock('./appIssues.js', () => ({ listAppIssues }));
vi.mock('./apps.js', () => ({ getAppById }));
vi.mock('./cosState.js', () => ({ ROOT_DIR: '/portos' }));
vi.mock('./settings.js', () => ({ getSettings }));
vi.mock('./investigationTaskProducer.js', () => ({ fileInvestigationTask }));
vi.mock('./jira.js', () => ({ searchIssues, createTicket, escapeJql: (s) => String(s) }));
vi.mock('../lib/workTracker.js', () => ({ resolveAppForgeTarget }));

const { runGoalFidelityFollowUp } = await import('./goalFidelityFollowUp.js');
const { goalFidelityFingerprint, goalFidelityIssueMarker } = await import('../lib/goalFidelityFollowUp.js');

const TASK = { id: 'task-7', taskType: 'user', description: 'Add retry caps', metadata: { app: 'comics' } };
const REVIEW = {
  verdict: 'rethink',
  missing: ['the retry cap'],
  unrequested: [],
  evidence: 'Rewrote the scheduler instead.',
  backend: 'ollama',
  model: 'qwen3',
};
const FINGERPRINT = goalFidelityFingerprint(TASK);
const MARKER = goalFidelityIssueMarker(FINGERPRINT);

const GITHUB_APP = { id: 'comics', repoPath: '/repo', workTracker: 'github' };
const GITHUB_TARGET = { forge: 'github', repoSpec: 'github.com/acme/comics', apiHost: 'github.com', fullName: 'acme/comics' };

const settings = (goalFidelity) => getSettings.mockResolvedValue({ codeReview: { goalFidelity } });
const run = () => runGoalFidelityFollowUp({ agentId: 'agent-1', task: TASK, review: REVIEW });

/** A `gh issue list --json` reply. */
const ghRows = (rows) => JSON.stringify(rows);

beforeEach(() => {
  vi.clearAllMocks();
  ensureForgeReachable.mockResolvedValue({ ok: true });
  getAppById.mockResolvedValue(GITHUB_APP);
  resolveAppForgeTarget.mockResolvedValue({ tracker: 'github', target: GITHUB_TARGET });
  listAppIssues.mockResolvedValue({ transient: false, issues: [], reason: 'no-open-issues' });
  execGh.mockResolvedValue(ghRows([]));
  fileInvestigationTask.mockResolvedValue({ task: { id: 'cos-9' }, approvalRequired: false });
});

describe('runGoalFidelityFollowUp — when it runs at all', () => {
  it('does nothing when neither action is configured', async () => {
    settings({ enabled: true });
    await expect(run()).resolves.toEqual({ ran: false });
    expect(execGh).not.toHaveBeenCalled();
    expect(fileInvestigationTask).not.toHaveBeenCalled();
  });

  it('does nothing on a verdict the configured trigger does not cover', async () => {
    settings({ fileIssue: true, followUpOn: 'rethink' });
    const result = await runGoalFidelityFollowUp({
      agentId: 'agent-1', task: TASK, review: { ...REVIEW, verdict: 'fix-first' },
    });
    expect(result).toEqual({ ran: false });
    expect(execGh).not.toHaveBeenCalled();
  });

  it('acts on fix-first once the wider trigger is chosen', async () => {
    settings({ fileIssue: true, followUpOn: 'any-finding' });
    execGh.mockResolvedValueOnce(ghRows([])).mockResolvedValue('https://github.com/acme/comics/issues/12');
    const result = await runGoalFidelityFollowUp({
      agentId: 'agent-1', task: TASK, review: { ...REVIEW, verdict: 'fix-first' },
    });
    expect(result.ran).toBe(true);
    expect(result.issue).toMatchObject({ number: 12, duplicate: false });
  });

  // `ship` is not a finding under either trigger — the run delivered what was
  // asked, so there is nothing to file and nothing to fix.
  it('never acts on a clean verdict', async () => {
    settings({ fileIssue: true, queueTask: true, followUpOn: 'any-finding' });
    const result = await runGoalFidelityFollowUp({
      agentId: 'agent-1', task: TASK, review: { ...REVIEW, verdict: 'ship' },
    });
    expect(result).toEqual({ ran: false });
  });
});

describe('runGoalFidelityFollowUp — GitHub', () => {
  it('files the issue with the marker label and reports its number', async () => {
    settings({ fileIssue: true });
    execGh
      .mockResolvedValueOnce(ghRows([]))              // marker search
      .mockResolvedValueOnce('')                      // label create
      .mockResolvedValueOnce('https://github.com/acme/comics/issues/42');
    const result = await run();
    expect(result.issue).toEqual({ number: 42, url: 'https://github.com/acme/comics/issues/42', duplicate: false });
    const createArgs = execGh.mock.calls.at(-1)[0];
    expect(createArgs.slice(0, 2)).toEqual(['issue', 'create']);
    expect(createArgs).toContain('--label');
    expect(createArgs).toContain('goal-fidelity');
    // The body carries the key the next run's search reads back.
    expect(createArgs[createArgs.indexOf('--body') + 1]).toContain(MARKER);
  });

  // The whole feature's point of failure. A closed issue is still a filed
  // issue — re-filing it is exactly the "same issue over and over" loop.
  it('reuses an existing issue carrying the marker, even when it is CLOSED', async () => {
    settings({ fileIssue: true });
    execGh.mockResolvedValueOnce(ghRows([
      { number: 5, title: 'Goal-fidelity rethink: Add retry caps', body: `stuff ${MARKER}`, url: 'u5', state: 'CLOSED' },
    ]));
    const result = await run();
    expect(result.issue).toMatchObject({ number: 5, duplicate: true });
    expect(execGh).toHaveBeenCalledTimes(1); // searched, never created
  });

  it('searches every state, not just the open ones', async () => {
    settings({ fileIssue: true });
    await run();
    const searchArgs = execGh.mock.calls[0][0];
    expect(searchArgs[searchArgs.indexOf('--state') + 1]).toBe('all');
    expect(searchArgs[searchArgs.indexOf('--search') + 1]).toBe(MARKER);
  });

  // The forge search index trails a creation by minutes; two runs of one
  // schedule inside that window are ordinary, and without the rescan the
  // second files a duplicate the search genuinely could not see.
  it('catches a just-filed issue the search index has not indexed yet', async () => {
    settings({ fileIssue: true });
    execGh.mockResolvedValueOnce(ghRows([])); // search: index lag, no hit
    listAppIssues.mockResolvedValue({
      transient: false,
      issues: [{ number: 6, title: 't', body: `fresh ${MARKER}`, url: 'u6' }],
    });
    const result = await run();
    expect(result.issue).toMatchObject({ number: 6, duplicate: true });
    expect(execGh).toHaveBeenCalledTimes(1);
  });

  it("does not match another finding's marker", async () => {
    settings({ fileIssue: true });
    execGh
      .mockResolvedValueOnce(ghRows([{ number: 5, title: 't', body: 'portosgf-goal-fidelity-user-other', url: 'u5' }]))
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('https://github.com/acme/comics/issues/43');
    const result = await run();
    expect(result.issue).toMatchObject({ number: 43, duplicate: false });
  });

  // Fail-CLOSED, against the usual sentinel convention: a tracker we could not
  // read is not "nothing is filed". Filing blind is how a `gh` blip duplicates.
  it('refuses to file when the marker search could not be read', async () => {
    settings({ fileIssue: true });
    execGh.mockResolvedValueOnce('not json');
    const result = await run();
    expect(result.issue).toBeNull();
    expect(result.issueError).toMatch(/could not read/);
    expect(execGh).toHaveBeenCalledTimes(1);
  });

  it('refuses to file when the open-issue rescan is transient', async () => {
    settings({ fileIssue: true });
    execGh.mockResolvedValueOnce(ghRows([]));
    listAppIssues.mockResolvedValue({ transient: true, issues: [], reason: 'gh-offline' });
    const result = await run();
    expect(result.issue).toBeNull();
    expect(result.issueError).toMatch(/gh-offline/);
    expect(execGh).toHaveBeenCalledTimes(1);
  });

  it('refuses to file when the forge is unreachable', async () => {
    settings({ fileIssue: true });
    ensureForgeReachable.mockResolvedValue({ ok: false, status: 'offline' });
    const result = await run();
    expect(result.issue).toBeNull();
    expect(result.issueError).toMatch(/could not read/);
  });

  it('reports a failed create rather than claiming an issue exists', async () => {
    settings({ fileIssue: true });
    execGh
      .mockResolvedValueOnce(ghRows([]))
      .mockResolvedValueOnce('')
      .mockRejectedValueOnce(new Error('422 label missing'));
    const result = await run();
    expect(result.issue).toBeNull();
    expect(result.issueError).toContain('422');
  });
});

describe('runGoalFidelityFollowUp — GitLab', () => {
  beforeEach(() => {
    resolveAppForgeTarget.mockResolvedValue({
      tracker: 'gitlab',
      target: { forge: 'gitlab', repoSpec: null, fullName: 'acme/comics' },
    });
  });

  it('files through glab when no existing issue carries the marker', async () => {
    settings({ fileIssue: true });
    execGlabJson.mockResolvedValue({ rows: [], reason: 'ok' });
    execGlab.mockResolvedValueOnce('').mockResolvedValueOnce('https://gitlab.com/acme/comics/-/issues/8');
    const result = await run();
    expect(result.issue).toMatchObject({ number: 8, duplicate: false });
  });

  // `--all` on `glab issue list` is every STATE, which is what makes a closed
  // duplicate visible at all.
  it('reads every state, so a closed issue still dedupes', async () => {
    settings({ fileIssue: true });
    execGlabJson.mockResolvedValue({
      rows: [{ iid: 3, title: 't', description: `x ${MARKER}`, web_url: 'u3', state: 'closed' }],
      reason: 'ok',
    });
    const result = await run();
    expect(result.issue).toMatchObject({ number: 3, duplicate: true });
    expect(execGlabJson.mock.calls[0][0]).toContain('--all');
    expect(execGlab).not.toHaveBeenCalled();
  });

  it('refuses to file when glab could not answer', async () => {
    settings({ fileIssue: true });
    execGlabJson.mockResolvedValue({ rows: null, reason: 'cli-failed' });
    const result = await run();
    expect(result.issue).toBeNull();
    expect(result.issueError).toMatch(/could not read/);
    expect(execGlab).not.toHaveBeenCalled();
  });
});

describe('runGoalFidelityFollowUp — JIRA', () => {
  const JIRA_APP = {
    id: 'comics', repoPath: '/repo', workTracker: 'jira',
    jira: { enabled: true, instanceId: 'inst-1', projectKey: 'COM' },
  };

  beforeEach(() => {
    getAppById.mockResolvedValue(JIRA_APP);
    resolveAppForgeTarget.mockResolvedValue({ tracker: 'jira', target: null });
  });

  it("creates a ticket in the app's project", async () => {
    settings({ fileIssue: true });
    searchIssues.mockResolvedValue([]);
    createTicket.mockResolvedValue({ success: true, ticketId: 'COM-12', url: 'https://jira/browse/COM-12' });
    const result = await run();
    expect(result.issue).toMatchObject({ number: 'COM-12', duplicate: false });
    expect(createTicket.mock.calls[0][1].projectKey).toBe('COM');
    expect(createTicket.mock.calls[0][1].description).toContain(MARKER);
  });

  // JIRA returns the body as `description`, not `body` — a dedup that read only
  // `body` would treat every existing ticket as a non-match and re-file forever.
  it('dedupes on the description field JIRA actually returns', async () => {
    settings({ fileIssue: true });
    searchIssues.mockResolvedValue([{ key: 'COM-4', summary: 't', description: `x ${MARKER}`, url: 'u' }]);
    const result = await run();
    expect(result.issue).toMatchObject({ number: 'COM-4', duplicate: true });
    expect(createTicket).not.toHaveBeenCalled();
  });

  it("scopes the marker search to the app's own project", async () => {
    settings({ fileIssue: true });
    searchIssues.mockResolvedValue([]);
    createTicket.mockResolvedValue({ success: true, ticketId: 'COM-13', url: 'u' });
    await run();
    expect(searchIssues.mock.calls[0][1]).toContain('project = "COM"');
    expect(searchIssues.mock.calls[0][1]).toContain(MARKER);
  });

  it('refuses to file when the JIRA search failed', async () => {
    settings({ fileIssue: true });
    searchIssues.mockRejectedValue(new Error('401'));
    const result = await run();
    expect(result.issue).toBeNull();
    expect(result.issueError).toMatch(/could not read the JIRA project/);
    expect(createTicket).not.toHaveBeenCalled();
  });

  it('says what is missing when the app tracks JIRA but configured no project', async () => {
    settings({ fileIssue: true });
    getAppById.mockResolvedValue({ ...JIRA_APP, jira: { enabled: true, instanceId: 'inst-1' } });
    const result = await run();
    expect(result.issueError).toMatch(/not configured/);
  });
});

describe('runGoalFidelityFollowUp — unfilable trackers', () => {
  it('reports rather than throws for a PLAN.md app', async () => {
    settings({ fileIssue: true });
    resolveAppForgeTarget.mockResolvedValue({ tracker: 'plan', target: null });
    const result = await run();
    expect(result.ran).toBe(true);
    expect(result.issueError).toMatch(/plan/);
  });

  it('refuses when the configured tracker and the remote disagree', async () => {
    settings({ fileIssue: true });
    resolveAppForgeTarget.mockResolvedValue({ tracker: 'github', target: { forge: 'gitlab' } });
    const result = await run();
    expect(result.issueError).toMatch(/does not match/);
  });

  it('reports an app with no repository', async () => {
    settings({ fileIssue: true });
    getAppById.mockResolvedValue(null);
    const result = await run();
    expect(result.issueError).toMatch(/no configured repository/);
  });

  // A task with no `metadata.app` is PortOS's own work, which runs against the
  // install root — the same fallback that picks its workspace.
  it('falls back to the install root for a task with no app', async () => {
    settings({ fileIssue: true });
    execGh.mockResolvedValueOnce(ghRows([])).mockResolvedValueOnce('').mockResolvedValueOnce('u/1');
    await runGoalFidelityFollowUp({
      agentId: 'agent-1', task: { id: 't', taskType: 'user', description: 'Fix it' }, review: REVIEW,
    });
    expect(getAppById).not.toHaveBeenCalled();
    expect(resolveAppForgeTarget.mock.calls[0][0].repoPath).toBe('/portos');
  });
});

describe('runGoalFidelityFollowUp — the queued task', () => {
  it('queues through the shared investigation producer with the shared fingerprint', async () => {
    settings({ queueTask: true });
    const result = await run();
    expect(result.task).toEqual({ id: 'cos-9' });
    const [args] = fileInvestigationTask.mock.calls[0];
    expect(args.fingerprint).toBe(FINGERPRINT);
    expect(args.affectedTasks).toEqual(['task-7']);
    expect(args.app).toBe('comics');
    expect(execGh).not.toHaveBeenCalled(); // no issue filing was asked for
  });

  it('hands the filed issue to the queued task so it can claim it', async () => {
    settings({ fileIssue: true, queueTask: true });
    execGh
      .mockResolvedValueOnce(ghRows([]))
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('https://github.com/acme/comics/issues/42');
    await run();
    expect(fileInvestigationTask.mock.calls[0][0].description).toContain('#42');
  });

  // The task is the arm that actually gets the work done; a tracker that
  // refused the file must not cancel it.
  it('still queues the task when the issue could not be filed', async () => {
    settings({ fileIssue: true, queueTask: true });
    execGh.mockResolvedValueOnce('not json');
    const result = await run();
    expect(result.issueError).toBeTruthy();
    expect(result.task).toEqual({ id: 'cos-9' });
  });

  it('reports a suppressed queue rather than silently returning nothing', async () => {
    settings({ queueTask: true });
    fileInvestigationTask.mockResolvedValue({ task: null });
    const result = await run();
    expect(result.task).toBeNull();
    expect(result.taskError).toBeTruthy();
  });
});
