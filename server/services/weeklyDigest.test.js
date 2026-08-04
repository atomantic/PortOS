/**
 * Direct tests for the weekly digest assembly (issue #3448).
 *
 * The module previously existed in the suite only as a `vi.mock()` target in
 * `routes/cosLearningRoutes.test.js`, so none of the aggregation, the
 * week-over-week math, or the insight copy was ever executed. Here the real
 * module runs against a temp digests dir (the only file-I/O boundary) with the
 * agent history source (`cosAgents.js`) stubbed.
 *
 * Fixture timestamps are built from LOCAL date components so every expectation
 * holds regardless of the runner's timezone — the service reads local getters.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { EventEmitter } from 'events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makePathsProxy } from '../lib/mockPathsDataRoot.js';

const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'weekly-digest-test-'));
const DIGESTS_DIR = join(TEST_DATA_ROOT, 'cos', 'digests');

// weeklyDigest.js anchors its store at PATHS.digests, computed independently of
// PATHS.data — redirect it or digests land in the real install's data/cos.
vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), {
    dataRoot: TEST_DATA_ROOT,
    extraOverrides: (root) => ({ digests: join(root, 'cos', 'digests') }),
  }));

const mock = vi.hoisted(() => ({
  agents: [],        // getAgents() — the live state index
  agentsByDate: {},  // getAgentsByDate(date)
}));

vi.mock('./cosAgents.js', () => ({
  getAgents: vi.fn(async () => mock.agents),
  getAgentDates: vi.fn(async () => Object.keys(mock.agentsByDate).map(date => ({ date }))),
  getAgentsByDate: vi.fn(async (date) => mock.agentsByDate[date] || []),
}));

vi.mock('./cosEvents.js', () => ({
  cosEvents: new EventEmitter(),
  emitLog: vi.fn(),
}));

const digestService = await import('./weeklyDigest.js');
const { cosEvents } = await import('./cosEvents.js');

afterAll(() => rmSync(TEST_DATA_ROOT, { recursive: true, force: true }));

// Wednesday 2026-03-18 12:00 local → ISO week 2026-W12, week start Mon 2026-03-16.
const NOW = new Date(2026, 2, 18, 12, 0, 0);
const THIS_WEEK = '2026-W12';
const LAST_WEEK = '2026-W11';

const at = (day, hour = 10, month = 3, year = 2026) => new Date(year, month - 1, day, hour, 0, 0).toISOString();

/** Completed-agent fixture. `taskType` lands in metadata.analysisType. */
const agent = (id, {
  day = 18,
  hour = 10,
  month = 3,
  year = 2026,
  success = true,
  duration = 60000,
  taskType = null,
  description = null,
  error = null,
  status = 'completed',
  completedAt,
} = {}) => ({
  id,
  taskId: `task-${id}`,
  status,
  startedAt: at(day, hour - 1, month, year),
  completedAt: completedAt === undefined ? at(day, hour, month, year) : completedAt,
  result: { success, duration, ...(error ? { error } : {}) },
  metadata: { ...(taskType ? { analysisType: taskType } : {}), ...(description ? { taskDescription: description } : {}) },
});

/** Register agents on the date index keyed by their local completion date. */
const onDates = (agents) => {
  mock.agentsByDate = {};
  for (const a of agents) {
    const d = new Date(a.completedAt);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    (mock.agentsByDate[key] ||= []).push(a);
  }
};

const writeDigest = (weekId, digest) => {
  mkdirSync(DIGESTS_DIR, { recursive: true });
  writeFileSync(join(DIGESTS_DIR, `${weekId}.json`), JSON.stringify({ weekId, ...digest }));
};

const readDigest = (weekId) => JSON.parse(readFileSync(join(DIGESTS_DIR, `${weekId}.json`), 'utf-8'));

/** Minimal stored-digest shape the week-over-week comparison reads. */
const storedDigest = (weekId, { totalTasks, successRate, totalWorkTimeMs }) => ({
  weekId,
  weekStart: at(9),
  weekEnd: at(15),
  generatedAt: at(15),
  summary: { totalTasks, succeededTasks: totalTasks, failedTasks: 0, successRate, totalWorkTimeMs, totalWorkTime: '1m' },
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  mock.agents = [];
  mock.agentsByDate = {};
  rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
  mkdirSync(DIGESTS_DIR, { recursive: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  // The mocked bus is shared across cases — drop listeners here so a failing
  // assertion can't strand one and have a later case observe it.
  cosEvents.removeAllListeners();
});

describe('generateWeeklyDigest — summary assembly', () => {
  it('aggregates only the target week and reports exact totals', async () => {
    const weekAgents = [
      agent('a1', { day: 16, duration: 3600000, taskType: 'review' }),
      agent('a2', { day: 17, duration: 1800000, taskType: 'review' }),
      agent('a3', { day: 17, success: false, duration: 600000, taskType: 'triage', error: 'timeout' }),
      agent('a4', { day: 18, success: false, duration: 0, taskType: 'triage', error: 'timeout' }),
    ];
    const outOfWeek = agent('old', { day: 10, duration: 999 });
    const neverFinished = agent('open', { status: 'running', completedAt: null });
    onDates([...weekAgents, outOfWeek, neverFinished]);

    const digest = await digestService.generateWeeklyDigest();

    expect(digest.weekId).toBe(THIS_WEEK);
    expect(digest.summary).toEqual({
      totalTasks: 4,
      succeededTasks: 2,
      failedTasks: 2,
      successRate: 50,
      totalWorkTimeMs: 6000000,
      totalWorkTime: '1h 40m',
    });
    expect(digest.weekStart).toBe(new Date(2026, 2, 16, 0, 0, 0).toISOString());
    expect(digest.weekEnd).toBe(new Date(2026, 2, 22, 0, 0, 0).toISOString());
    expect(digest.generatedAt).toBe(NOW.toISOString());
  });

  it('ranks task types by volume with per-type success rates', async () => {
    onDates([
      agent('a1', { day: 16, taskType: 'review' }),
      agent('a2', { day: 16, taskType: 'review' }),
      agent('a3', { day: 17, taskType: 'review', success: false, error: 'lint' }),
      agent('a4', { day: 17, taskType: 'triage' }),
      // No metadata at all → the 'user-task' default bucket.
      agent('a5', { day: 18 }),
    ]);

    const { byTaskType } = await digestService.generateWeeklyDigest();

    expect(byTaskType).toEqual([
      { type: 'review', completed: 3, succeeded: 2, failed: 1, totalDurationMs: 180000, successRate: 67 },
      { type: 'triage', completed: 1, succeeded: 1, failed: 0, totalDurationMs: 60000, successRate: 100 },
      { type: 'user-task', completed: 1, succeeded: 1, failed: 0, totalDurationMs: 60000, successRate: 100 },
    ]);
  });

  it('lists successful tasks as accomplishments, longest first, capped at ten', async () => {
    onDates([
      ...Array.from({ length: 12 }, (_, i) => agent(`ok-${i}`, { day: 16, duration: (i + 1) * 1000, description: `did thing ${i}` })),
      agent('bad', { day: 16, success: false, duration: 99999999, error: 'boom' }),
    ]);

    const { accomplishments } = await digestService.generateWeeklyDigest();

    expect(accomplishments).toHaveLength(10);
    expect(accomplishments[0]).toMatchObject({ id: 'ok-11', taskId: 'task-ok-11', duration: 12000, description: 'did thing 11', taskType: 'task' });
    expect(accomplishments.at(-1).duration).toBe(3000);
    expect(accomplishments.some(a => a.id === 'bad')).toBe(false);
  });

  it('truncates a long accomplishment description to 100 characters', async () => {
    const longDescription = 'x'.repeat(140);
    onDates([agent('a1', { day: 16, description: longDescription })]);

    const { accomplishments } = await digestService.generateWeeklyDigest();

    expect(accomplishments[0].description).toHaveLength(100);
    expect(accomplishments[0].description).toBe(`${'x'.repeat(97)}...`);
  });

  it('groups failures into ranked error patterns, top five only', async () => {
    onDates([
      agent('e1', { day: 16, success: false, error: 'timeout', description: 'y'.repeat(80) }),
      agent('e2', { day: 16, success: false, error: 'timeout' }),
      agent('e3', { day: 17, success: false, error: 'lint' }),
      agent('e4', { day: 17, success: false }),
    ]);

    const { issues } = await digestService.generateWeeklyDigest();

    expect(issues).toHaveLength(3);
    expect(issues[0]).toMatchObject({ error: 'timeout', count: 2 });
    // Issue-level descriptions truncate at 50 chars, and a missing one reads
    // as the explicit 'No description' placeholder.
    expect(issues[0].tasks[0]).toEqual({ id: 'task-e1', description: `${'y'.repeat(47)}...` });
    expect(issues[0].tasks[1]).toEqual({ id: 'task-e2', description: 'No description' });
    expect(issues.map(i => i.error)).toEqual(['timeout', 'lint', 'unknown']);
  });

  it('keeps only the five most frequent error patterns', async () => {
    // Six distinct errors with descending counts (6…1 occurrences).
    const failures = [];
    for (let rank = 6; rank >= 1; rank--) {
      for (let n = 0; n < rank; n++) {
        failures.push(agent(`e${rank}-${n}`, { day: 16, success: false, error: `error-${rank}` }));
      }
    }
    onDates(failures);

    const { issues } = await digestService.generateWeeklyDigest();

    expect(issues.map(i => i.error)).toEqual(['error-6', 'error-5', 'error-4', 'error-3', 'error-2']);
    expect(issues.map(i => i.count)).toEqual([6, 5, 4, 3, 2]);
  });

  it('counts an agent present in both the date index and live state exactly once', async () => {
    const shared = agent('dupe', { day: 17 });
    onDates([shared]);
    mock.agents = [shared, agent('state-only', { day: 18 })];

    const digest = await digestService.generateWeeklyDigest();

    expect(digest.summary.totalTasks).toBe(2);
    expect(digest.accomplishments.map(a => a.id).sort()).toEqual(['dupe', 'state-only']);
  });

  it('splits an ISO week straddling the new year across two digests (#3465)', async () => {
    // Characterization, not endorsement: the week id pairs the ISO week NUMBER
    // with the CALENDAR year, so the single ISO week containing Mon 2025-12-29
    // and Thu 2026-01-01 is filed as '2025-W01' and '2026-W01' — and '2025-W01'
    // is also the id of the *January* 2025 week, so the two overwrite each
    // other on disk. Pinned so the fix in #3465 has to update this deliberately.
    vi.setSystemTime(new Date(2025, 11, 29, 12, 0, 0));
    onDates([
      agent('dec', { year: 2025, month: 12, day: 29 }),
      agent('jan', { year: 2026, month: 1, day: 1 }),
    ]);

    const december = await digestService.generateWeeklyDigest();

    expect(december.weekId).toBe('2025-W01');
    expect(december.summary.totalTasks).toBe(1);
    expect(december.accomplishments.map(a => a.id)).toEqual(['dec']);
    expect(existsSync(join(DIGESTS_DIR, '2025-W01.json'))).toBe(true);

    // Same ISO week, three days later — filed as a second, separate digest.
    vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 0));
    const january = await digestService.generateWeeklyDigest();

    expect(january.weekId).toBe('2026-W01');
    expect(january.summary.totalTasks).toBe(1);
    expect(january.accomplishments.map(a => a.id)).toEqual(['jan']);

    // And the collision half: the week of 2025-01-02 stamps '2025-W01' too, so
    // regenerating it merges in the December-2025 agent and overwrites the file
    // the first generation wrote.
    onDates([
      agent('dec', { year: 2025, month: 12, day: 29 }),
      agent('jan', { year: 2026, month: 1, day: 1 }),
      agent('jan2025', { year: 2025, month: 1, day: 2 }),
    ]);
    vi.setSystemTime(new Date(2025, 0, 2, 12, 0, 0));
    const collided = await digestService.generateWeeklyDigest();

    expect(collided.weekId).toBe('2025-W01');
    expect(collided.summary.totalTasks).toBe(2);
    expect(collided.accomplishments.map(a => a.id).sort()).toEqual(['dec', 'jan2025']);
    expect(readDigest('2025-W01').summary.totalTasks).toBe(2);
  });

  it('persists the digest and announces it on the CoS event bus', async () => {
    const emitted = [];
    const listener = (d) => emitted.push(d.weekId);
    cosEvents.on('digest:generated', listener);
    onDates([agent('a1', { day: 16 })]);

    await digestService.generateWeeklyDigest();

    expect(existsSync(join(DIGESTS_DIR, `${THIS_WEEK}.json`))).toBe(true);
    expect(readDigest(THIS_WEEK).summary.totalTasks).toBe(1);
    expect(emitted).toEqual([THIS_WEEK]);

    cosEvents.off('digest:generated', listener);
  });
});

describe('generateWeeklyDigest — week-over-week comparison', () => {
  it('leaves every delta null when no prior digest exists', async () => {
    onDates([agent('a1', { day: 16 })]);

    const digest = await digestService.generateWeeklyDigest();

    expect(digest.weekOverWeek).toEqual({ tasksChange: null, successRateChange: null, workTimeChange: null });
    expect(digest.previousWeekId).toBeNull();
  });

  it('computes percentage and point deltas against the prior week', async () => {
    writeDigest(LAST_WEEK, storedDigest(LAST_WEEK, { totalTasks: 2, successRate: 100, totalWorkTimeMs: 1000000 }));
    onDates([
      agent('a1', { day: 16, duration: 1000000 }),
      agent('a2', { day: 17, duration: 500000 }),
      agent('a3', { day: 17, success: false, duration: 250000, error: 'timeout' }),
      agent('a4', { day: 18, success: false, duration: 250000, error: 'timeout' }),
    ]);

    const digest = await digestService.generateWeeklyDigest();

    expect(digest.previousWeekId).toBe(LAST_WEEK);
    expect(digest.weekOverWeek).toEqual({ tasksChange: 100, successRateChange: -50, workTimeChange: 100 });
  });

  it('treats a zero-task prior week as a 100% gain, or 0% when still idle', async () => {
    writeDigest(LAST_WEEK, storedDigest(LAST_WEEK, { totalTasks: 0, successRate: 0, totalWorkTimeMs: 0 }));
    onDates([agent('a1', { day: 16, duration: 1000 })]);

    expect((await digestService.generateWeeklyDigest()).weekOverWeek)
      .toEqual({ tasksChange: 100, successRateChange: 100, workTimeChange: 100 });

    onDates([]);
    expect((await digestService.generateWeeklyDigest()).weekOverWeek)
      .toEqual({ tasksChange: 0, successRateChange: 0, workTimeChange: 0 });
  });
});

describe('generateWeeklyDigest — insights', () => {
  it('calls a week with no completions quiet', async () => {
    const digest = await digestService.generateWeeklyDigest();

    expect(digest.insights).toEqual([{ type: 'info', title: 'Quiet Week', message: 'No tasks were completed this week.' }]);
  });

  it('celebrates twenty or more completions', async () => {
    onDates(Array.from({ length: 20 }, (_, i) => agent(`a${i}`, { day: 16, taskType: 'review' })));

    const digest = await digestService.generateWeeklyDigest();

    expect(digest.insights).toContainEqual({
      type: 'success',
      title: 'High Productivity',
      message: 'Completed 20 tasks this week - excellent output!',
    });
  });

  it('flags rising volume and improving success against the prior week', async () => {
    writeDigest(LAST_WEEK, storedDigest(LAST_WEEK, { totalTasks: 2, successRate: 50, totalWorkTimeMs: 1000 }));
    onDates([
      agent('a1', { day: 16 }),
      agent('a2', { day: 17 }),
      agent('a3', { day: 18 }),
    ]);

    const digest = await digestService.generateWeeklyDigest();

    expect(digest.insights).toContainEqual({
      type: 'success',
      title: 'Increased Output',
      message: 'Task completion increased by 50% compared to last week.',
    });
    expect(digest.insights).toContainEqual({
      type: 'success',
      title: 'Improved Success Rate',
      message: 'Success rate improved by 50 percentage points.',
    });
  });

  it('warns on falling volume and a declining success rate', async () => {
    writeDigest(LAST_WEEK, storedDigest(LAST_WEEK, { totalTasks: 10, successRate: 100, totalWorkTimeMs: 1000 }));
    onDates([
      agent('a1', { day: 16, success: false, error: 'timeout' }),
      agent('a2', { day: 17 }),
    ]);

    const digest = await digestService.generateWeeklyDigest();

    expect(digest.insights).toContainEqual({
      type: 'warning',
      title: 'Decreased Output',
      message: 'Task completion decreased by 80% compared to last week.',
    });
    expect(digest.insights).toContainEqual({
      type: 'warning',
      title: 'Declining Success Rate',
      message: 'Success rate dropped by 50 percentage points.',
    });
  });

  it('names star performers, problem areas, recurring errors and the focus area', async () => {
    onDates([
      // 3 completed at 100% → star performer; the self-improve: prefix is dropped
      // and dashes become spaces in the rendered copy.
      agent('s1', { day: 16, taskType: 'self-improve:code-review' }),
      agent('s2', { day: 16, taskType: 'self-improve:code-review' }),
      agent('s3', { day: 16, taskType: 'self-improve:code-review' }),
      // 4 completed at 25% → needs attention, and its 3 failures are the top error.
      agent('p1', { day: 17, taskType: 'flaky-check' }),
      agent('p2', { day: 17, taskType: 'flaky-check', success: false, error: 'timeout' }),
      agent('p3', { day: 17, taskType: 'flaky-check', success: false, error: 'timeout' }),
      agent('p4', { day: 18, taskType: 'flaky-check', success: false, error: 'timeout' }),
    ]);

    const digest = await digestService.generateWeeklyDigest();

    expect(digest.insights).toContainEqual({
      type: 'success',
      title: 'Star Performer',
      message: 'code review tasks achieved 100% success rate.',
    });
    expect(digest.insights).toContainEqual({
      type: 'warning',
      title: 'Needs Attention',
      message: 'flaky check tasks have only 25% success rate.',
    });
    expect(digest.insights).toContainEqual({
      type: 'action',
      title: 'Recurring Issue',
      message: '"timeout" error occurred 3 times this week.',
    });
    expect(digest.insights).toContainEqual({
      type: 'info',
      title: 'Focus Area',
      message: 'Most effort spent on flaky check tasks (4 completed).',
    });
  });

  it('omits volume-threshold insights for a small, healthy week', async () => {
    onDates([agent('a1', { day: 16, taskType: 'review' }), agent('a2', { day: 17, taskType: 'review' })]);

    const digest = await digestService.generateWeeklyDigest();

    expect(digest.insights.map(i => i.title)).toEqual(['Focus Area']);
  });
});

describe('getWeeklyDigest', () => {
  it('returns a stored digest for a past week without recomputing', async () => {
    writeDigest('2026-W05', storedDigest('2026-W05', { totalTasks: 99, successRate: 42, totalWorkTimeMs: 5000 }));
    const { getAgents } = await import('./cosAgents.js');

    const digest = await digestService.getWeeklyDigest('2026-W05');

    expect(digest.summary.totalTasks).toBe(99);
    expect(getAgents).not.toHaveBeenCalled();
  });

  it('regenerates the current week even when a stale file exists', async () => {
    writeDigest(THIS_WEEK, storedDigest(THIS_WEEK, { totalTasks: 99, successRate: 42, totalWorkTimeMs: 5000 }));
    onDates([agent('a1', { day: 16 })]);

    const digest = await digestService.getWeeklyDigest();

    expect(digest.summary.totalTasks).toBe(1);
    expect(readDigest(THIS_WEEK).summary.totalTasks).toBe(1);
  });
});

describe('listWeeklyDigests', () => {
  it('summarizes stored digests newest week first', async () => {
    writeDigest('2026-W10', storedDigest('2026-W10', { totalTasks: 4, successRate: 75, totalWorkTimeMs: 1000 }));
    writeDigest(LAST_WEEK, storedDigest(LAST_WEEK, { totalTasks: 7, successRate: 100, totalWorkTimeMs: 2000 }));

    const list = await digestService.listWeeklyDigests();

    expect(list.map(d => d.weekId)).toEqual([LAST_WEEK, '2026-W10']);
    expect(list[0]).toEqual({
      weekId: LAST_WEEK,
      weekStart: at(9),
      weekEnd: at(15),
      totalTasks: 7,
      successRate: 100,
      generatedAt: at(15),
    });
  });

  it('returns an empty list when nothing has been generated', async () => {
    expect(await digestService.listWeeklyDigests()).toEqual([]);
  });
});

describe('compareWeeks', () => {
  it('returns null when either week is missing', async () => {
    writeDigest(LAST_WEEK, storedDigest(LAST_WEEK, { totalTasks: 4, successRate: 50, totalWorkTimeMs: 1000 }));

    expect(await digestService.compareWeeks(LAST_WEEK, '2026-W10')).toBeNull();
  });

  it('reports the deltas between two stored weeks', async () => {
    writeDigest(LAST_WEEK, storedDigest(LAST_WEEK, { totalTasks: 6, successRate: 80, totalWorkTimeMs: 3000 }));
    writeDigest('2026-W10', storedDigest('2026-W10', { totalTasks: 4, successRate: 50, totalWorkTimeMs: 6000 }));

    const result = await digestService.compareWeeks(LAST_WEEK, '2026-W10');

    expect(result.week1).toMatchObject({ weekId: LAST_WEEK, totalTasks: 6, successRate: 80 });
    expect(result.week2).toMatchObject({ weekId: '2026-W10', totalTasks: 4, successRate: 50 });
    expect(result.comparison).toEqual({ tasksChange: 50, successRateChange: 30, workTimeChange: -50 });
  });
});

describe('getCurrentWeekProgress', () => {
  it('projects the full week from the pace so far and lists recent completions', async () => {
    mock.agents = [
      agent('a1', { day: 16, duration: 600000, description: 'z'.repeat(80) }),
      agent('a2', { day: 17, duration: 600000 }),
      agent('a3', { day: 18, duration: 600000, success: false, error: 'timeout' }),
      agent('old', { day: 10, duration: 600000 }),
      { id: 'live', taskId: 'task-live', status: 'running', startedAt: new Date(NOW.getTime() - 600000).toISOString() },
    ];

    const progress = await digestService.getCurrentWeekProgress();

    expect(progress.weekId).toBe(THIS_WEEK);
    expect(progress.weekStart).toBe(new Date(2026, 2, 16, 0, 0, 0).toISOString());
    // Week runs Mon 03-16 → Mon 03-23 00:00; now is Wed 12:00 → 4.5 days left.
    expect(progress.daysRemaining).toBe(5);
    expect(progress.daysPassed).toBe(2);
    expect(progress.current).toMatchObject({
      totalTasks: 3,
      succeededTasks: 2,
      failedTasks: 1,
      successRate: 67,
      totalWorkTimeMs: 1800000,
      totalWorkTime: '30m',
      runningAgents: 1,
      activeTimeMs: 600000,
      activeTime: '10m',
    });
    expect(progress.projected).toEqual({ tasks: 11, workTimeMs: 6300000, workTime: '1h 45m' });
    expect(progress.recentCompletions.map(c => c.id)).toEqual(['a3', 'a2', 'a1']);
    // Recent-completion descriptions truncate at 60 characters.
    expect(progress.recentCompletions.at(-1).description).toBe(`${'z'.repeat(57)}...`);
  });

  it('reports an idle week without projecting phantom tasks', async () => {
    const progress = await digestService.getCurrentWeekProgress();

    expect(progress.current).toMatchObject({ totalTasks: 0, successRate: 0, runningAgents: 0, totalWorkTime: '0m' });
    expect(progress.projected).toEqual({ tasks: 0, workTimeMs: 0, workTime: '0m' });
    expect(progress.recentCompletions).toEqual([]);
  });
});

describe('generateTextSummary', () => {
  it('renders the digest as plain text with week-over-week and insight lines', async () => {
    writeDigest(LAST_WEEK, storedDigest(LAST_WEEK, { totalTasks: 2, successRate: 50, totalWorkTimeMs: 1000 }));
    onDates([
      agent('a1', { day: 16, duration: 1800000, taskType: 'review', description: 'shipped the digest' }),
      agent('a2', { day: 17, duration: 1800000, taskType: 'review', description: 'fixed the streaks' }),
      agent('a3', { day: 18, duration: 0, taskType: 'review', description: 'tried a thing' }),
    ]);

    const text = await digestService.generateTextSummary();

    expect(text).toContain(`Weekly Digest: ${THIS_WEEK}`);
    expect(text).toContain('  - Tasks Completed: 3');
    expect(text).toContain('  - Success Rate: 100%');
    expect(text).toContain('  - Total Work Time: 1h 0m');
    expect(text).toContain('  - Tasks: +50%');
    expect(text).toContain('  - Success Rate: +50 pts');
    expect(text).toContain('  - shipped the digest');
    expect(text).toContain('  [+] Increased Output: Task completion increased by 50% compared to last week.');
    expect(text).toContain('  [-] Focus Area: Most effort spent on review tasks (3 completed).');
  });

  it('omits the week-over-week block when there is no prior week', async () => {
    onDates([agent('a1', { day: 16, description: 'only thing' })]);

    const text = await digestService.generateTextSummary();

    expect(text).not.toContain('Week-over-Week:');
    expect(text).toContain('Top Accomplishments:');
    expect(text).toContain('  - only thing');
  });
});
