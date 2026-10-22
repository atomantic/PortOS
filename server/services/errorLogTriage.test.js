import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runErrorLogTriage } from './errorLogTriage.js';

const FAULT = '❌ Media queue flush timed out while draining pending renders';
const line = (iso, text = FAULT) => `${iso}: ${text}\n`;

function fakeTracker(issues = []) {
  const comments = [];
  const created = [];
  let next = 9000;
  return {
    comments,
    created,
    searches: 0,
    async searchIssues() {
      this.searches += 1;
      return issues.map(({ number, state, closedAt }) => ({ number, state, closedAt }));
    },
    async viewIssue(number) {
      const issue = issues.find((i) => i.number === number) || created.find((i) => i.number === number);
      return { number, state: issue.state, closedAt: issue.closedAt || null };
    },
    async commentIssue(number, body) { comments.push({ number, body }); },
    async createIssue(issue) {
      const number = next++;
      created.push({ ...issue, number, state: 'OPEN' });
      return number;
    },
  };
}

describe('runErrorLogTriage', () => {
  let dir;
  let logDir;
  let logFile;
  let stateFile;
  let clock;
  const now = () => new Date(clock);
  const run = (overrides = {}) => runErrorLogTriage({ logDir, stateFile, now, redactionTerms: [], ...overrides });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'error-log-triage-'));
    logDir = join(dir, 'logs');
    logFile = join(logDir, 'portos-server-error.log');
    stateFile = join(dir, 'state.json');
    clock = '2026-10-21T12:00:00.000Z';
    await import('node:fs/promises').then(({ mkdir }) => mkdir(logDir));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('re-running over the same log adds no duplicate comment, issue or investigation', async () => {
    await writeFile(logFile, line('2026-10-21T11:00:00.000Z') + line('2026-10-21T11:01:00.000Z') + line('2026-10-21T11:02:00.000Z'));
    // Another app's log in the same PM2 home is not PortOS's to triage.
    await writeFile(join(logDir, 'other-app-error.log'), line('2026-10-21T11:00:00.000Z', '❌ not ours at all, really not ours'));
    const tracker = fakeTracker();
    const fileInvestigation = vi.fn(async () => 'task-1');

    const first = await run({ tracker, fileInvestigation });
    expect(first).toMatchObject({ entries: 3, fingerprints: 1, investigations: 1 });
    expect(fileInvestigation).toHaveBeenCalledOnce();
    expect(fileInvestigation.mock.calls[0][0].description).toContain('Media queue flush timed out');

    clock = '2026-10-23T12:00:00.000Z';
    const second = await run({ tracker, fileInvestigation });
    expect(second).toMatchObject({ entries: 0, investigations: 0 });
    expect(fileInvestigation).toHaveBeenCalledOnce();
    expect(tracker.comments).toEqual([]);
    expect(tracker.created).toEqual([]);
  });

  it('a fingerprint matching an open issue gets at most one evidence comment per day', async () => {
    const tracker = fakeTracker([{ number: 41, state: 'OPEN' }]);
    const fileInvestigation = vi.fn();
    await writeFile(logFile, line('2026-10-21T11:00:00.000Z'));
    await run({ tracker, fileInvestigation, params: { triageMinOccurrences: 1 } });
    clock = '2026-10-21T18:00:00.000Z';
    await appendFile(logFile, line('2026-10-21T17:00:00.000Z'));
    await run({ tracker, fileInvestigation });
    expect(tracker.comments.map((c) => c.number)).toEqual([41]);

    clock = '2026-10-22T19:00:00.000Z';
    await appendFile(logFile, line('2026-10-22T18:00:00.000Z'));
    await run({ tracker, fileInvestigation });
    expect(tracker.comments.map((c) => c.number)).toEqual([41, 41]);
    expect(tracker.searches).toBe(1);
    // A mapped fault never spends an investigation agent.
    expect(fileInvestigation).not.toHaveBeenCalled();
  });

  it('a recurrence after close files exactly one regression issue', async () => {
    const tracker = fakeTracker([{ number: 7, state: 'CLOSED', closedAt: '2026-10-20T00:00:00.000Z' }]);
    await writeFile(logFile, line('2026-10-21T11:00:00.000Z'));
    const first = await run({ tracker });
    expect(first.regressions).toBe(1);
    expect(tracker.created).toHaveLength(1);
    expect(tracker.created[0]).toMatchObject({ labels: ['bug', 'plan', 'model:medium', 'effort:high'] });
    expect(tracker.created[0].body).toContain('Refs #7');

    clock = '2026-10-23T12:00:00.000Z';
    await appendFile(logFile, line('2026-10-23T11:00:00.000Z'));
    const second = await run({ tracker });
    expect(second.regressions).toBe(0);
    expect(tracker.created).toHaveLength(1);
    // Later evidence lands on the regression issue, not the closed one.
    expect(tracker.comments.map((c) => c.number)).toEqual([tracker.created[0].number]);
  });

  it('lines logged before the close are not a regression', async () => {
    const tracker = fakeTracker([{ number: 7, state: 'CLOSED', closedAt: '2026-10-21T00:00:00.000Z' }]);
    await writeFile(logFile, line('2026-10-20T11:00:00.000Z'));
    const summary = await run({ tracker });
    expect(summary.regressions).toBe(0);
    expect(tracker.created).toEqual([]);
  });

  it('caps investigations per run and waits for the occurrence threshold', async () => {
    const faults = ['❌ Alpha subsystem exploded during warmup', '❌ Beta subsystem exploded during warmup', '❌ Gamma subsystem exploded during warmup'];
    await writeFile(logFile, faults.flatMap((f) => [line('2026-10-21T11:00:00.000Z', f), line('2026-10-21T11:00:01.000Z', f)]).join(''));
    const fileInvestigation = vi.fn(async ({ fingerprint }) => `task-${fingerprint}`);
    const tracker = fakeTracker();

    const below = await run({ tracker, fileInvestigation, params: { triageMinOccurrences: 3, triageMaxInvestigations: 2 } });
    expect(below.investigations).toBe(0);

    clock = '2026-10-21T13:00:00.000Z';
    await appendFile(logFile, faults.map((f) => line('2026-10-21T12:30:00.000Z', f)).join(''));
    const above = await run({ tracker, fileInvestigation, params: { triageMinOccurrences: 3, triageMaxInvestigations: 2 } });
    expect(above.investigations).toBe(2);
    expect(fileInvestigation).toHaveBeenCalledTimes(2);
  });

  it('defers an unmapped fault while the tracker is unreachable instead of investigating blind', async () => {
    await writeFile(logFile, line('2026-10-21T11:00:00.000Z'));
    const fileInvestigation = vi.fn();
    const summary = await run({ tracker: null, fileInvestigation, params: { triageMinOccurrences: 1 } });
    expect(summary.deferred).toBe(1);
    expect(fileInvestigation).not.toHaveBeenCalled();
  });

  it('restarts the cursor when the log is truncated, and never consumes a partial line', async () => {
    const tracker = fakeTracker([{ number: 3, state: 'OPEN' }]);
    await writeFile(logFile, line('2026-10-21T11:00:00.000Z') + '2026-10-21T11:00:01.000Z: ❌ half-writ');
    expect((await run({ tracker })).entries).toBe(1);

    await writeFile(logFile, line('2026-10-21T11:05:00.000Z'));
    clock = '2026-10-21T12:10:00.000Z';
    expect((await run({ tracker })).entries).toBe(1);
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    expect(state.cursors['portos-server-error.log'].offset).toBe(Buffer.byteLength(line('2026-10-21T11:05:00.000Z')));
  });

  it('keeps private values out of everything it sends to the tracker', async () => {
    const tracker = fakeTracker([{ number: 5, state: 'OPEN' }]);
    await writeFile(logFile, line('2026-10-21T11:00:00.000Z', '❌ Nightly backup upload failed on studio-mac for /Users/alice/Library/x.db via 192.0.2.10'));
    await run({ tracker, redactionTerms: ['studio-mac'] });
    const sent = tracker.comments.map((c) => c.body).join('\n');
    expect(sent).toContain('Nightly backup upload failed on <redacted>');
    for (const leaked of ['studio-mac', 'alice', '192.0.2.10']) expect(sent).not.toContain(leaked);
  });
});
