/**
 * The goal-fidelity follow-up filer, at its public boundary:
 * `runGoalFidelityFollowUp({ context: CONTEXT, agentId, task, review })` in → an issue on the
 * right tracker and/or a queued CoS task out.
 *
 * The failure this suite exists to catch is a DUPLICATE. The producer is an
 * unattended loop, so an issue filed twice is filed forever — which is why
 * every tracker arm gets the same three cases: nothing filed yet (file), an
 * existing item carrying the marker (reuse, including a CLOSED one), and a
 * tracker we could not read (refuse, never file blind). The listing is
 * label-filtered across every state precisely so none of those can be missed.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { homedir } from 'os';

const execGh = vi.fn();
const execGlab = vi.fn();
const execGlabJson = vi.fn();
const ensureForgeReachable = vi.fn();
const getAppById = vi.fn();
const getSettings = vi.fn();
const fileInvestigationTask = vi.fn();
const resolveAppForgeTarget = vi.fn();
const searchIssues = vi.fn();
const createTicket = vi.fn();

vi.mock('./github.js', () => ({ execGh, ensureForgeReachable }));
vi.mock('./gitlab.js', () => ({ execGlab, execGlabJson }));
vi.mock('./forgeExecOptions.js', () => ({
  resolveForgeExecOptions: async (repoPath) => ({ cwd: repoPath || undefined, env: { GH_TOKEN: 'synthetic' }, customEnv: null }),
}));
vi.mock('./apps.js', () => ({ getAppById, PORTOS_APP_ID: 'portos' }));
vi.mock('./settings.js', () => ({ getSettings }));
vi.mock('./investigationTaskProducer.js', () => ({ fileInvestigationTask }));
vi.mock('./jira.js', () => ({ searchIssues, createTicket, escapeJql: (s) => String(s) }));
vi.mock('../lib/workTracker.js', () => ({
  resolveAppForgeTarget,
  forgeCliForTracker: (tracker) => (tracker === 'gitlab' ? 'glab' : 'gh'),
}));

const { runGoalFidelityFollowUp } = await import('./goalFidelityFollowUp.js');
const { goalFidelityFingerprint, goalFidelityIssueMarker } = await import('../lib/goalFidelityFollowUp.js');

const TASK = { id: 'task-7', taskType: 'user', description: 'Add retry caps', metadata: { app: 'comics' } };
const CONTEXT = { base: 'a'.repeat(40), head: 'b'.repeat(40), objective: 'Add retry caps',
  publication: { source: 'tracker-issue', tracker: 'github', webHost: 'github.com', fullName: 'acme/comics', number: 7, title: 'Add retry caps' } };
let runContext = CONTEXT;
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
const GITHUB_TARGET = { forge: 'github', repoSpec: 'github.com/acme/comics', apiHost: 'github.com', webHost: 'github.com', fullName: 'acme/comics' };

const settings = (goalFidelity) => getSettings.mockResolvedValue({ codeReview: { goalFidelity } });
const run = () => runGoalFidelityFollowUp({ context: runContext, agentId: 'agent-1', task: TASK, review: REVIEW });

/** A `gh issue list --json` reply. */
const ghRows = (rows) => JSON.stringify(rows);
/** The flag value `gh` was given for `name` on call `n`. */
const ghFlag = (n, name) => {
  const args = execGh.mock.calls[n][0];
  return args[args.indexOf(name) + 1];
};

beforeEach(() => {
  vi.clearAllMocks();
  runContext = CONTEXT;
  ensureForgeReachable.mockResolvedValue({ ok: true });
  getAppById.mockResolvedValue(GITHUB_APP);
  resolveAppForgeTarget.mockResolvedValue({ tracker: 'github', target: GITHUB_TARGET });
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
    const result = await runGoalFidelityFollowUp({ context: CONTEXT,
      agentId: 'agent-1', task: TASK, review: { ...REVIEW, verdict: 'fix-first' },
    });
    expect(result).toEqual({ ran: false });
    expect(execGh).not.toHaveBeenCalled();
  });

  it('acts on fix-first once the wider trigger is chosen', async () => {
    settings({ fileIssue: true, followUpOn: 'any-finding' });
    execGh.mockResolvedValueOnce(ghRows([])).mockResolvedValue('https://github.com/acme/comics/issues/12');
    const result = await runGoalFidelityFollowUp({ context: CONTEXT,
      agentId: 'agent-1', task: TASK, review: { ...REVIEW, verdict: 'fix-first' },
    });
    expect(result.ran).toBe(true);
    expect(result.issue).toMatchObject({ number: 12, duplicate: false });
  });

  // `ship` is not a finding under either trigger — the run delivered what was
  // asked, so there is nothing to file and nothing to fix.
  it('never acts on a clean verdict', async () => {
    settings({ fileIssue: true, queueTask: true, followUpOn: 'any-finding' });
    const result = await runGoalFidelityFollowUp({ context: CONTEXT,
      agentId: 'agent-1', task: TASK, review: { ...REVIEW, verdict: 'ship' },
    });
    expect(result).toEqual({ ran: false });
  });
});

describe('runGoalFidelityFollowUp — GitHub', () => {
  it('files the issue with the marker label and reports its number', async () => {
    settings({ fileIssue: true });
    execGh
      .mockResolvedValueOnce(ghRows([]))              // duplicate listing
      .mockResolvedValueOnce('')                      // label create
      .mockResolvedValueOnce('https://github.com/acme/comics/issues/42');
    const result = await run();
    expect(result.issue).toMatchObject({ number: 42, url: 'https://github.com/acme/comics/issues/42', duplicate: false });
    const createArgs = execGh.mock.calls.at(-1)[0];
    expect(createArgs.slice(0, 2)).toEqual(['issue', 'create']);
    expect(createArgs).toContain('--label');
    expect(createArgs).toContain('goal-fidelity');
    // The body carries the key the next run's listing reads back.
    expect(createArgs[createArgs.indexOf('--body') + 1]).toContain(MARKER);
  });

  // #7687 — the forge path no longer scrubs at the call site; it is enforced
  // by `fileForgeIssue` itself, by construction, so this caller can't forget.
  it('strips a home-directory prefix and a credential-shaped token from the filed title and body', async () => {
    settings({ fileIssue: true });
    const home = homedir();
    execGh
      .mockResolvedValueOnce(ghRows([]))
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('https://github.com/acme/comics/issues/50');
    const result = await runGoalFidelityFollowUp({ context: { ...CONTEXT,
      objective: `Fix the sync poller under ${home}/work/demo`,
      publication: { ...CONTEXT.publication, title: `Fix the sync poller under ${home}/work/demo` } },
      agentId: 'agent-1',
      task: { ...TASK, description: `Fix the sync poller under ${home}/work/demo` },
      review: { ...REVIEW, evidence: `Retried with ghp_${'A'.repeat(36)} and gave up.` },
    });
    expect(result.issue).toMatchObject({ number: 50, duplicate: false });
    const createArgs = execGh.mock.calls.at(-1)[0];
    const title = createArgs[createArgs.indexOf('--title') + 1];
    const body = createArgs[createArgs.indexOf('--body') + 1];
    expect(title).not.toContain(home);
    expect(title).toContain('~/work/demo');
    expect(body).not.toContain(home);
    expect(body).not.toContain('ghp_');
    expect(body).toContain('[REDACTED]');
    // The dedup marker survives — the scrub must not touch it, or the issue it
    // files could never dedupe against itself.
    expect(body).toContain(goalFidelityIssueMarker(goalFidelityFingerprint({ ...TASK, description: `Fix the sync poller under ${home}/work/demo` })));
  });

  // The dedup lists by LABEL across every STATE rather than by full-text
  // search: a label is a direct field filter with no index lag, and the lag
  // window is exactly when a scheduled task re-runs.
  it('lists by the marker label across every state', async () => {
    settings({ fileIssue: true });
    await run();
    expect(execGh.mock.calls[0][0].slice(0, 2)).toEqual(['issue', 'list']);
    expect(ghFlag(0, '--label')).toBe('goal-fidelity');
    expect(ghFlag(0, '--state')).toBe('all');
    expect(ghFlag(0, '--repo')).toBe('github.com/acme/comics');
  });

  // A closed issue is still a filed issue — re-filing it is exactly the "same
  // issue over and over" loop this feature has to avoid.
  it('reuses an existing issue carrying the marker, even when it is CLOSED', async () => {
    settings({ fileIssue: true });
    execGh.mockResolvedValueOnce(ghRows([
      { number: 5, title: 'Goal-fidelity rethink: Add retry caps', body: 'stuff portosgf-goal-fidelity-user-comics-add-retry-caps', url: 'u5' },
    ]));
    const result = await run();
    expect(result.issue).toMatchObject({ number: 5, duplicate: true });
    expect(execGh).toHaveBeenCalledTimes(1); // listed, never created
  });

  it('recognizes its own redacted issue when a dated task is reviewed again', async () => {
    settings({ fileIssue: true });
    const task = { ...TASK, description: 'Dependency audit 2026-09-21 for alice@example.com' };
    execGh.mockResolvedValueOnce(ghRows([])).mockResolvedValueOnce('').mockResolvedValueOnce('https://github.com/acme/comics/issues/42');
    const first = await runGoalFidelityFollowUp({ agentId: 'agent-1', task, review: REVIEW, context: CONTEXT });
    expect(first.issue.body).not.toContain('2026-09-21');
    expect(first.issue.body).not.toContain('alice');
    expect(first.issue.body).toContain(goalFidelityIssueMarker(goalFidelityFingerprint(task)));

    execGh.mockClear();
    execGh.mockResolvedValueOnce(ghRows([first.issue]));
    const second = await runGoalFidelityFollowUp({ agentId: 'agent-2', task, review: REVIEW, context: CONTEXT });
    expect(second.issue).toMatchObject({ number: 42, duplicate: true });
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
  it('refuses to file when the listing could not be read', async () => {
    settings({ fileIssue: true });
    execGh.mockResolvedValueOnce('not json');
    const result = await run();
    expect(result.issue).toBeNull();
    expect(result.issueError).toMatch(/could not read/);
    expect(execGh).toHaveBeenCalledTimes(1);
  });

// A scan that came back at the ceiling proves we stopped looking, not that
  // nothing is filed — so it fails closed like every other unreadable tracker.
  it('refuses to file when the scan hit its ceiling without matching', async () => {
    settings({ fileIssue: true });
    execGh.mockResolvedValueOnce(ghRows(
      Array.from({ length: 1000 }, (_, i) => ({ number: i + 1, title: 't', body: 'other', url: 'u' })),
    ));
    const result = await run();
    expect(result.issue).toBeNull();
    expect(result.issueError).toMatch(/duplicate cannot be ruled out/);
    expect(execGh).toHaveBeenCalledTimes(1);
  });

  it('refuses to file when the forge is unreachable, before reading or creating anything', async () => {
    settings({ fileIssue: true });
    ensureForgeReachable.mockResolvedValue({ ok: false, status: 'offline' });
    const result = await run();
    expect(result.issue).toBeNull();
    expect(result.issueError).toMatch(/not reachable/);
    expect(execGh).not.toHaveBeenCalled();
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

  // An app pinned to a non-ambient forge account files under the wrong login
  // without this — the 404 pattern `resolveForgeExecOptions` exists to prevent.
  it('runs the create under the same resolved forge credentials as the listing', async () => {
    settings({ fileIssue: true });
    execGh.mockResolvedValueOnce(ghRows([])).mockResolvedValueOnce('').mockResolvedValueOnce('u/1');
    await run();
    for (const call of execGh.mock.calls) {
      expect(call[2]).toMatchObject({ cwd: '/repo', env: { GH_TOKEN: 'synthetic' } });
    }
  });
});

describe('runGoalFidelityFollowUp — GitLab', () => {
  beforeEach(() => {
    runContext = { ...CONTEXT, publication: { ...CONTEXT.publication, tracker: 'gitlab', webHost: 'gitlab.com' } };
    resolveAppForgeTarget.mockResolvedValue({
      tracker: 'gitlab',
      target: { forge: 'gitlab', repoSpec: null, fullName: 'acme/comics', webHost: 'gitlab.com' },
    });
    execGlabJson.mockResolvedValue({ rows: [], reason: 'ok' });
  });

  it('files through glab when no existing issue carries the marker', async () => {
    settings({ fileIssue: true });
    execGlab.mockResolvedValueOnce('').mockResolvedValueOnce('https://gitlab.com/acme/comics/-/issues/8');
    const result = await run();
    expect(result.issue).toMatchObject({ number: 8, duplicate: false });
  });

  // An unfiltered page is the silent-duplicate bug: on a repo with more issues
  // than the page holds, our own issue falls off the end and the dedup reports
  // "nothing filed" every cadence. `--all` is every STATE, so a closed one
  // still counts.
  it('lists by the marker label across every state', async () => {
    settings({ fileIssue: true });
    await run();
    const args = execGlabJson.mock.calls[0][0];
    expect(args[args.indexOf('--label') + 1]).toBe('goal-fidelity');
    expect(args).toContain('--all');
  });

  it('reuses an existing labelled issue rather than filing a second', async () => {
    settings({ fileIssue: true });
    execGlabJson.mockResolvedValue({
      rows: [{ iid: 3, title: 't', description: `x ${MARKER}`, web_url: 'u3' }],
      reason: 'ok',
    });
    const result = await run();
    expect(result.issue).toMatchObject({ number: 3, duplicate: true });
    expect(execGlab).not.toHaveBeenCalled();
  });

// Once more goal-fidelity issues exist than one page holds, an older
  // fingerprint falls off the only page read and the schedule re-files it every
  // cadence — the same silent-duplicate shape the unfiltered listing had.
  it('walks every page, so an issue past the first page still dedupes', async () => {
    settings({ fileIssue: true });
    const filler = Array.from({ length: 100 }, (_, i) => ({ iid: i + 1, title: 't', description: 'other', web_url: 'u' }));
    execGlabJson
      .mockResolvedValueOnce({ rows: filler, reason: 'ok' })
      .mockResolvedValueOnce({ rows: [{ iid: 200, title: 't', description: `x ${MARKER}`, web_url: 'u200' }], reason: 'ok' });
    const result = await run();
    expect(result.issue).toMatchObject({ number: 200, duplicate: true });
    expect(execGlabJson).toHaveBeenCalledTimes(2);
    expect(execGlabJson.mock.calls[1][0]).toContain('2'); // --page 2
    expect(execGlab).not.toHaveBeenCalled();
  });

  it('stops paging as soon as a page comes back short', async () => {
    settings({ fileIssue: true });
    execGlabJson.mockResolvedValue({ rows: [{ iid: 1, title: 't', description: 'other', web_url: 'u' }], reason: 'ok' });
    execGlab.mockResolvedValueOnce('').mockResolvedValueOnce('https://gitlab.com/acme/comics/-/issues/9');
    await run();
    expect(execGlabJson).toHaveBeenCalledTimes(1);
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
    searchIssues.mockResolvedValue([]);
    createTicket.mockResolvedValue({ success: true, ticketId: 'COM-12', url: 'https://jira/browse/COM-12' });
  });

  it('keeps the investigation local when no independently fetched JIRA objective exists', async () => {
    settings({ fileIssue: true, queueTask: true });
    const result = await run();
    expect(result.issue).toBeNull();
    expect(result.issueError).toMatch(/nothing was published/);
    expect(searchIssues).not.toHaveBeenCalled();
    expect(createTicket).not.toHaveBeenCalled();
    expect(result.task).toMatchObject({ id: 'cos-9' });
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

  // PortOS's own tasks resolve to the REAL PortOS app record, not a fabricated
  // one — the literal would drop `workTracker`, `forgeAccount` and `jira`, the
  // three fields that decide which tracker the issue even lands on.
  it("reads the real PortOS app record for a task with no app", async () => {
    settings({ fileIssue: true });
    execGh.mockResolvedValueOnce(ghRows([])).mockResolvedValueOnce('').mockResolvedValueOnce('u/1');
    await runGoalFidelityFollowUp({ context: CONTEXT,
      agentId: 'agent-1', task: { id: 't', taskType: 'user', description: 'Fix it' }, review: REVIEW,
    });
    expect(getAppById).toHaveBeenCalledWith('portos');
  });
});

describe('runGoalFidelityFollowUp — the queued task', () => {
  it('queues through the shared investigation producer with the shared fingerprint', async () => {
    settings({ queueTask: true });
    const result = await run();
    expect(result.task).toMatchObject({ id: 'cos-9', approvalRequired: false });
    const [args] = fileInvestigationTask.mock.calls[0];
    expect(args.fingerprint).toBe(FINGERPRINT);
    expect(args.affectedTasks).toEqual(['task-7']);
    expect(args.app).toBe('comics');
    expect(execGh).not.toHaveBeenCalled(); // no issue filing was asked for
  });

  // The investigator can only report an overturned finding if the task it is
  // handed tells it how, with THIS install's loopback base and the bearer
  // argument — neither of which the pure body builder can resolve. Without them
  // a false positive ends where it always did: an agent spent, nothing learned.
  it('tells the investigator to check the finding and how to report it if it was wrong', async () => {
    settings({ queueTask: true });
    await run();
    const { description } = fileInvestigationTask.mock.calls[0][0];
    expect(description).toMatch(/is the finding actually right/i);
    expect(description).toMatch(/http:\/\/127\.0\.0\.1:\d+\/api\/cos\/goal-fidelity\/false-positive/);
    expect(description).toContain('Authorization: Bearer ${PORTOS_API_TOKEN:-}');
  });

  // The loop policy can HOLD a follow-up for a human; reporting "queued" for a
  // task nothing will pick up is the one wrong thing to say about it.
  it('carries the producer approval verdict, so a held task is not reported as queued', async () => {
    settings({ queueTask: true });
    fileInvestigationTask.mockResolvedValue({ task: { id: 'cos-9' }, approvalRequired: true, loopReason: 'failure-storm' });
    const result = await run();
    expect(result.task.approvalRequired).toBe(true);
  });

  it('hands the filed issue to the queued task so it can claim it', async () => {
    settings({ fileIssue: true, queueTask: true });
    execGh
      .mockResolvedValueOnce(ghRows([]))
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('https://github.com/acme/comics/issues/42');
    const result = await run();
    const { description } = fileInvestigationTask.mock.calls[0][0];
    expect(description).toContain('#42');
    expect(description).toContain(result.issue.title);
    expect(description).toContain('Filed issue snapshot:');
    expect(description).toContain('## Resolution criteria\\nIf the finding is false');
    expect(description).toContain('CURRENT body and comments');
    expect(description).toContain('close the finding as not planned');
    expect(description).toContain('verify closure after merge');
    expect(description).toContain('leave it open with the exact blocker');
    expect(description).toContain('read its state back');
    expect(description).toContain('complete any tracked issue resolution');
  });

  it('hands a deduplicated issue snapshot to the investigator without rewriting the issue', async () => {
    settings({ fileIssue: true, queueTask: true });
    execGh.mockResolvedValueOnce(ghRows([
      { number: 5, title: 'Earlier finding', body: `Earlier acceptance criteria ${MARKER}`, url: 'https://example.com/issues/5' },
    ]));
    await run();
    expect(execGh).toHaveBeenCalledTimes(1);
    const { description } = fileInvestigationTask.mock.calls[0][0];
    expect(description).toContain('Earlier acceptance criteria');
    expect(description).toContain('https://example.com/issues/5');
    expect(description).toContain('snapshot below may be stale');
  });

  it('never publishes private local records while preserving the configured local investigation', async () => {
    settings({ fileIssue: true, queueTask: true });
    const objective = 'Fix journal search\nPRIVATE JOURNAL RECORD: a synthetic personal memory.';
    const result = await runGoalFidelityFollowUp({ agentId: 'agent-1', task: { ...TASK, description: objective },
      review: REVIEW, context: { base: CONTEXT.base, head: CONTEXT.head, objective } });
    expect(result.issue).toBeNull();
    expect(result.issueError).toMatch(/nothing was published/);
    expect(execGh).not.toHaveBeenCalled();
    expect(execGlab).not.toHaveBeenCalled();
    expect(createTicket).not.toHaveBeenCalled();
    expect(result.task).toMatchObject({ id: 'cos-9' });
    expect(fileInvestigationTask.mock.calls[0][0].description).toContain(objective);
  });

  it.each([
    { fullName: 'other/project' },
    { webHost: 'other.example.com' },
    { tracker: 'gitlab' },
  ])('refuses to republish a fetched objective to a different destination: %j', async changed => {
    settings({ fileIssue: true, queueTask: true });
    const result = await runGoalFidelityFollowUp({ agentId: 'agent-1', task: TASK, review: REVIEW,
      context: { ...CONTEXT, publication: { ...CONTEXT.publication, ...changed } } });
    expect(result.issue).toBeNull();
    expect(result.issueError).toMatch(/nothing was published/);
    expect(execGh).not.toHaveBeenCalled();
    expect(result.task).toMatchObject({ id: 'cos-9' });
  });

  it('files the substantive objective and exact diff while withholding private metadata and redacting public text', async () => {
    settings({ fileIssue: true, queueTask: true });
    execGh.mockResolvedValueOnce(ghRows([])).mockResolvedValueOnce('').mockResolvedValueOnce('https://github.com/acme/comics/issues/42');
    const result = await runGoalFidelityFollowUp({
      agentId: 'agent-1',
      task: { ...TASK, description: 'PRIVATE OUTER TASK TITLE', metadata: { ...TASK.metadata, prompt: 'Stale outer claim workflow', transcript: 'PRIVATE TRANSCRIPT' } },
      review: REVIEW,
      context: { ...CONTEXT, objective: 'Retry transient failures; verify persisted success. Contact alice@example.com at host-XXXX.ts.net with ghp_' + 'A'.repeat(36) },
    });
    const body = result.issue.body;
    expect(result.issue.title).toBe('Goal-fidelity rethink: Add retry caps');
    expect(body).not.toContain('PRIVATE OUTER TASK TITLE');
    expect(body).toContain('Retry transient failures; verify persisted success.');
    expect(body).toContain(`git diff ${CONTEXT.base}..${CONTEXT.head}`);
    expect(body).toContain('Rewrote the scheduler instead.');
    expect(body).toContain('unverified finding');
    for (const privateText of ['alice@example.com', 'host-XXXX.ts.net', 'ghp_', 'PRIVATE TRANSCRIPT', 'Stale outer claim workflow']) {
      expect(body).not.toContain(privateText);
    }
    expect(body).toContain('[REDACTED]');
  });

  it.each([
    ['missing commit references', { ...CONTEXT, base: null }, /commit references/],
    ['truncated objective', { ...CONTEXT, objective: 'Task\n…[objective truncated]' }, /complete reviewed objective/],
    ['oversized objective', { ...CONTEXT, objective: 'x'.repeat(13_000) }, /body limit/],
  ])('refuses an issue with %s but still queues the investigation', async (_name, context, error) => {
    settings({ fileIssue: true, queueTask: true });
    const result = await runGoalFidelityFollowUp({ agentId: 'agent-1', task: TASK, review: REVIEW, context });
    expect(result.issue).toBeNull();
    expect(result.issueError).toMatch(error);
    expect(execGh.mock.calls.some(([args]) => args[0] === 'issue' && args[1] === 'create')).toBe(false);
    expect(result.task).toMatchObject({ id: 'cos-9' });
  });

  // The task is the arm that actually gets the work done; a tracker that
  // refused the file must not cancel it.
  it('still queues the task when the issue could not be filed', async () => {
    settings({ fileIssue: true, queueTask: true });
    execGh.mockResolvedValueOnce('not json');
    const result = await run();
    expect(result.issueError).toBeTruthy();
    expect(result.task).toMatchObject({ id: 'cos-9' });
  });

// "could not be queued" is the least actionable thing to say about a
  // deliberate suppression; the loop policy's own reason is the useful part.
  it('names the loop policy reason when the queue was suppressed', async () => {
    settings({ queueTask: true });
    fileInvestigationTask.mockResolvedValue({ task: null, loopReason: 'failure-storm' });
    const result = await run();
    expect(result.task).toBeNull();
    expect(result.taskError).toContain('failure-storm');
  });

  // The card reads this to decide what to call the task and whether to still
  // offer the manual fallback, so a held task must not read as queued.
  it('reports a folded duplicate distinctly from a fresh queue', async () => {
    settings({ queueTask: true });
    fileInvestigationTask.mockResolvedValue({ task: { id: 'cos-9', duplicate: true }, approvalRequired: false });
    const result = await run();
    expect(result.task).toMatchObject({ id: 'cos-9', duplicate: true, approvalRequired: false });
  });

  it('reports a suppressed queue rather than silently returning nothing', async () => {
    settings({ queueTask: true });
    fileInvestigationTask.mockResolvedValue({ task: null });
    const result = await run();
    expect(result.task).toBeNull();
    expect(result.taskError).toBeTruthy();
  });
});
