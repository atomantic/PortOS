import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// In-memory store so decompose/accept/migration logic can be exercised without
// touching disk or a real AI provider.
const h = vi.hoisted(() => ({ goalsData: null, aiText: '', derivedBarrier: null, derivedResult: null }));

vi.mock('./store.js', () => ({
  editGoals: vi.fn(async fn => fn(h.goalsData)),
  mutateGoals: vi.fn(async fn => {
    h.goalsData = await fn(h.goalsData);
    return h.goalsData;
  }),
  GOALS_FILE: 'goals.json',
  LONGEVITY_FILE: 'longevity.json',
  DEFAULT_GOALS: { goals: [], birthDate: null },
  DEFAULT_LONGEVITY: {},
  loadJSON: vi.fn(async (file) => (file === 'goals.json' ? h.goalsData : {})),
  saveJSON: vi.fn(async (file, data) => { if (file === 'goals.json') h.goalsData = data; })
}));

vi.mock('../settings.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getSettings: vi.fn(async () => ({ timezone: 'America/Los_Angeles' })),
}));

vi.mock('../provider/providers.js', () => ({
  getActiveProvider: vi.fn(async () => ({ id: 'p1', apiType: 'openai', defaultModel: 'm1' })),
  getProviderById: vi.fn(async () => ({ id: 'p1', apiType: 'openai', defaultModel: 'm1' }))
}));

vi.mock('../meatspace/meatspaceCalendar.js', () => ({ getActivities: vi.fn(async () => []) }));
vi.mock('../meatspace/meatspace.js', () => ({ updateBirthDate: vi.fn(async () => {}) }));
vi.mock('./longevity.js', async importOriginal => ({
  ...await importOriginal(),
  deriveLongevity: vi.fn(async () => {
    if (h.derivedBarrier) {
      h.derivedBarrier.entered.resolve();
      await h.derivedBarrier.release.promise;
    }
    return h.derivedResult;
  })
}));

vi.mock('../aiProvider.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, callProviderAISimple: vi.fn(async () => ({ text: h.aiText })) };
});

const {
  computeGoalVelocity, getGoals, decomposeGoal, generateGoalPhases,
  acceptGoalPhases, acceptGoalDecomposition, completeMilestoneTask, updateGoalProgress, getGoalsTree,
  createGoal, linkActivity, linkCalendarToGoal
} = await import('./goals.js');
const { setBirthDate, reconcileCalendarProgress, unlinkActivity } = await import('./goals.js');
const { addTodo } = await import('./todos.js');

describe('computeGoalVelocity', () => {
  it('returns null with fewer than two progress entries', () => {
    expect(computeGoalVelocity({ progressHistory: [] })).toBeNull();
    expect(computeGoalVelocity({ progressHistory: [{ date: '2026-01-01', value: 10 }] })).toBeNull();
    expect(computeGoalVelocity({})).toBeNull();
  });

  it('computes a positive percent-per-month from a valid history', () => {
    const v = computeGoalVelocity({
      progress: 30,
      progressHistory: [
        { date: '2026-01-01', value: 0 },
        { date: '2026-02-01', value: 30 },
      ],
    });
    expect(v).not.toBeNull();
    // 30 points over ~31 days ≈ one month → ~30%/month.
    expect(v.percentPerMonth).toBeGreaterThan(25);
    expect(v.trend).toBe('stable');
  });

  it('returns null when a progress entry has a malformed date (NaN guard)', () => {
    // A bad `progressHistory.date` makes the date subtraction NaN; without the
    // guard that yields NaN velocity / mis-ordered trend rather than a clean
    // "insufficient data" null.
    expect(computeGoalVelocity({
      progressHistory: [
        { date: 'not-a-date', value: 0 },
        { date: '2026-02-01', value: 30 },
      ],
    })).toBeNull();
  });
});

describe('goal decomposition', () => {
  beforeEach(() => {
    h.goalsData = {
      goals: [{
        id: 'goal-1', title: 'Write a novel', description: 'A fantasy epic',
        targetDate: '2027-01-01', milestones: []
      }],
      birthDate: null
    };
    h.aiText = '';
  });

  it('decomposeGoal returns ordered milestones with tasks and does NOT persist', async () => {
    h.aiText = JSON.stringify([
      { title: 'Outline', description: 'Sketch the arc', targetDate: '2026-09-01', order: 0,
        tasks: [{ title: 'Beat sheet', priority: 'high', estimateMinutes: 120 }] },
      { title: 'Draft', description: 'Write it', targetDate: '2026-12-01', order: 1,
        tasks: [{ title: 'Chapter 1', priority: 'medium', estimateMinutes: 240 }] }
    ]);
    const proposal = await decomposeGoal('goal-1', {});
    expect(Array.isArray(proposal)).toBe(true);
    expect(proposal).toHaveLength(2);
    expect(proposal[0].tasks[0].title).toBe('Beat sheet');
    // Not persisted — the stored goal still has no milestones.
    expect(h.goalsData.goals[0].milestones).toHaveLength(0);
  });

  it('decomposeGoal throws AI_PARSE_ERROR when the model returns a non-array', async () => {
    h.aiText = JSON.stringify({ not: 'an array' });
    await expect(decomposeGoal('goal-1', {})).rejects.toMatchObject({ code: 'AI_PARSE_ERROR' });
  });

  it('decomposeGoal throws NOT_FOUND for a missing goal', async () => {
    await expect(decomposeGoal('nope', {})).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  it('acceptGoalDecomposition normalizes tasks (ids, pending status, default priority)', async () => {
    const goal = await acceptGoalDecomposition('goal-1', [
      { title: 'Outline', order: 0, tasks: [
        { title: 'Beat sheet', priority: 'high', estimateMinutes: 120 },
        { title: 'Research' } // no priority/estimate → defaults
      ] }
    ]);
    expect(goal.milestones).toHaveLength(1);
    const ms = goal.milestones[0];
    expect(ms.id).toMatch(/^ms-/);
    expect(ms.tasks).toHaveLength(2);
    expect(ms.tasks[0].id).toMatch(/^ms-task-/);
    expect(ms.tasks[0].status).toBe('pending');
    expect(ms.tasks[0].completedAt).toBeNull();
    expect(ms.tasks[1].priority).toBe('medium');
    expect(ms.tasks[1].estimateMinutes).toBeNull();
    // Persisted to the store.
    expect(h.goalsData.goals[0].milestones[0].tasks).toHaveLength(2);
  });

  it('completeMilestoneTask toggles a task between done and pending', async () => {
    await acceptGoalDecomposition('goal-1', [
      { title: 'Outline', order: 0, tasks: [{ title: 'Beat sheet' }] }
    ]);
    const msId = h.goalsData.goals[0].milestones[0].id;
    const taskId = h.goalsData.goals[0].milestones[0].tasks[0].id;

    const done = await completeMilestoneTask('goal-1', msId, taskId);
    expect(done.status).toBe('done');
    expect(done.completedAt).not.toBeNull();

    const undone = await completeMilestoneTask('goal-1', msId, taskId);
    expect(undone.status).toBe('pending');
    expect(undone.completedAt).toBeNull();
  });

  it('completeMilestoneTask returns null for an unknown task', async () => {
    await acceptGoalDecomposition('goal-1', [{ title: 'Outline', order: 0, tasks: [] }]);
    const msId = h.goalsData.goals[0].milestones[0].id;
    expect(await completeMilestoneTask('goal-1', msId, 'missing')).toBeNull();
  });

  it('acceptGoalDecomposition tolerates null estimateMinutes / targetDate from the LLM', async () => {
    const goal = await acceptGoalDecomposition('goal-1', [
      { title: 'Outline', order: 0, targetDate: null, tasks: [
        { title: 'Beat sheet', priority: 'high', estimateMinutes: null }
      ] }
    ]);
    expect(goal.milestones[0].targetDate).toBeNull();
    expect(goal.milestones[0].tasks[0].estimateMinutes).toBeNull();
  });

  it('getGoals lazily backfills milestone.tasks = [] on legacy milestones', async () => {
    h.goalsData.goals[0].milestones = [{ id: 'ms-legacy', title: 'Old', completedAt: null }];
    const data = await getGoals();
    expect(data.goals[0].milestones[0].tasks).toEqual([]);
  });
});

describe('goal record reconciliation', () => {
  beforeEach(() => {
    h.goalsData = {
      goals: [
        { id: 'goal-1', title: 'First', status: 'active', linkedActivities: [{ activityName: 'Running', requiredFrequency: 2, note: '' }], progressLog: [] },
        { id: 'goal-2', title: 'Second', status: 'active', linkedActivities: [], progressLog: [] }
      ], birthDate: null
    };
    h.derivedBarrier = null;
    h.derivedResult = null;
  });

  it('updates an existing activity link instead of duplicating it', async () => {
    const goal = await linkActivity('goal-1', { activityName: 'Running', requiredFrequency: 4, note: 'Weekly' });
    expect(goal.linkedActivities).toEqual([{ activityName: 'Running', requiredFrequency: 4, note: 'Weekly' }]);
  });

  it('leaves the goal unchanged when unlinking an activity name that is absent', async () => {
    Object.assign(h.goalsData.goals[0], {
      goalType: 'standard', parentId: null, tags: [], linkedCalendars: [], featureAreas: [],
      targetDate: null, timeBlockConfig: null, scheduledEvents: [], checkIns: [],
      progress: 0, progressHistory: [], todos: []
    });
    const before = structuredClone(h.goalsData.goals[0]);
    const result = await unlinkActivity('goal-1', 'Cycling');
    expect(result).toEqual(before);
    expect(h.goalsData.goals[0]).toEqual(before);
  });

  it('does not apply derived horizons after a newer birth-date edit wins', async () => {
    const barrier = { entered: Promise.withResolvers(), release: Promise.withResolvers() };
    h.derivedBarrier = barrier;
    h.derivedResult = {
      timeHorizons: { yearsRemaining: 5, healthyYearsRemaining: 4, percentLifeComplete: 90 },
      lifeExpectancy: { adjusted: 84 }
    };

    const olderWrite = setBirthDate('1980-01-01');
    await barrier.entered.promise;
    h.goalsData.birthDate = '1990-01-01';
    barrier.release.resolve();

    const result = await olderWrite;
    expect(result.birthDate).toBe('1990-01-01');
    expect(result.timeHorizons).toBeUndefined();
    expect(result.lifeExpectancy).toBeUndefined();
  });

  it('reconciles calendar progress in place when it moves between goals', async () => {
    const first = await reconcileCalendarProgress('calendar-review-1', {
      goalId: 'goal-1', date: '2026-01-01', note: 'Review', durationMinutes: 30
    });
    const second = await reconcileCalendarProgress('calendar-review-1', {
      goalId: 'goal-2', date: '2026-01-02', note: 'Updated review', durationMinutes: 45
    });

    expect(second).toMatchObject({ id: first.id, createdAt: first.createdAt, sourceKey: 'calendar-review-1' });
    expect(h.goalsData.goals[0].progressLog).toEqual([]);
    expect(h.goalsData.goals[1].progressLog).toEqual([expect.objectContaining({
      id: first.id, createdAt: first.createdAt, sourceKey: 'calendar-review-1', date: '2026-01-02', note: 'Updated review'
    })]);
  });
});

describe('proposal validation (raw LLM output)', () => {
  beforeEach(() => {
    h.goalsData = {
      goals: [{
        id: 'goal-1', title: 'Write a novel', description: 'A fantasy epic',
        targetDate: '2027-01-01', milestones: []
      }],
      birthDate: null
    };
    h.aiText = '';
  });

  it('generateGoalPhases coerces/strips and returns a clean proposal', async () => {
    h.aiText = JSON.stringify([
      { title: 'Phase 1', description: 'Start', targetDate: '2026-09-01', order: 0, junk: 'x' }
    ]);
    const phases = await generateGoalPhases('goal-1', {});
    expect(phases).toHaveLength(1);
    expect(phases[0].title).toBe('Phase 1');
    expect(phases[0].junk).toBeUndefined(); // unknown keys stripped
  });

  it('generateGoalPhases throws AI_PARSE_ERROR when an element is missing its title', async () => {
    h.aiText = JSON.stringify([{ description: 'no title', targetDate: '2026-09-01', order: 0 }]);
    await expect(generateGoalPhases('goal-1', {})).rejects.toMatchObject({ status: 502, code: 'AI_PARSE_ERROR' });
  });

  it('generateGoalPhases throws AI_PARSE_ERROR on an empty array', async () => {
    h.aiText = JSON.stringify([]);
    await expect(generateGoalPhases('goal-1', {})).rejects.toMatchObject({ code: 'AI_PARSE_ERROR' });
  });

  it('decomposeGoal coerces task priority default and strips unknown milestone keys', async () => {
    h.aiText = JSON.stringify([
      { title: 'Outline', order: 0, extra: 'drop me', tasks: [{ title: 'Beat sheet' }] }
    ]);
    const proposal = await decomposeGoal('goal-1', {});
    expect(proposal[0].extra).toBeUndefined();
    expect(proposal[0].tasks[0].priority).toBe('medium'); // coerced default
  });

  it('decomposeGoal throws AI_PARSE_ERROR when a task has a non-string title', async () => {
    h.aiText = JSON.stringify([
      { title: 'Outline', order: 0, tasks: [{ title: 42 }] }
    ]);
    await expect(decomposeGoal('goal-1', {})).rejects.toMatchObject({ status: 502, code: 'AI_PARSE_ERROR' });
  });

  it('stamps a missing order from the array index so the proposal stays accept-ready', async () => {
    // No `order` keys → the array-level transform fills them from position.
    h.aiText = JSON.stringify([
      { title: 'First', tasks: [] },
      { title: 'Second', tasks: [] }
    ]);
    const proposal = await decomposeGoal('goal-1', {});
    expect(proposal.map(m => m.order)).toEqual([0, 1]);
  });

  it('keeps the intentional looseness — a free-form targetDate survives generation', async () => {
    // The proposal schema is deliberately looser than the strict accept schema:
    // a non-calendar date the user fixes in review must NOT be rejected here.
    h.aiText = JSON.stringify([
      { title: 'Outline', targetDate: 'next quarter', order: 0, tasks: [] }
    ]);
    const proposal = await decomposeGoal('goal-1', {});
    expect(proposal[0].targetDate).toBe('next quarter');
  });
});

describe('re-plan guard — orphaned scheduledEvents', () => {
  beforeEach(() => {
    h.goalsData = {
      goals: [{
        id: 'goal-1', title: 'Write a novel', description: 'A fantasy epic',
        targetDate: '2027-01-01', milestones: [{ id: 'ms-old', title: 'Old', order: 0, tasks: [] }]
      }],
      birthDate: null
    };
    h.aiText = '';
  });

  it('acceptGoalPhases rejects with 409 GOAL_HAS_SCHEDULED_EVENTS when calendar blocks exist', async () => {
    h.goalsData.goals[0].scheduledEvents = [{ id: 'sched-1', googleEventId: 'g1', milestoneId: 'ms-old' }];
    await expect(acceptGoalPhases('goal-1', [{ title: 'New', targetDate: '2026-09-01', order: 0 }]))
      .rejects.toMatchObject({ status: 409, code: 'GOAL_HAS_SCHEDULED_EVENTS' });
    // Milestones untouched — the wholesale replace never ran.
    expect(h.goalsData.goals[0].milestones[0].id).toBe('ms-old');
  });

  it('acceptGoalDecomposition rejects with 409 GOAL_HAS_SCHEDULED_EVENTS when calendar blocks exist', async () => {
    h.goalsData.goals[0].scheduledEvents = [{ id: 'sched-1', googleEventId: 'g1', milestoneId: 'ms-old' }];
    await expect(acceptGoalDecomposition('goal-1', [{ title: 'New', order: 0, tasks: [] }]))
      .rejects.toMatchObject({ status: 409, code: 'GOAL_HAS_SCHEDULED_EVENTS' });
    expect(h.goalsData.goals[0].milestones[0].id).toBe('ms-old');
  });

  it('accept paths proceed when scheduledEvents is empty or absent', async () => {
    // empty array
    h.goalsData.goals[0].scheduledEvents = [];
    const g1 = await acceptGoalPhases('goal-1', [{ title: 'Fresh', targetDate: '2026-09-01', order: 0 }]);
    expect(g1.milestones[0].title).toBe('Fresh');

    // absent entirely
    delete h.goalsData.goals[0].scheduledEvents;
    const g2 = await acceptGoalDecomposition('goal-1', [{ title: 'Fresh decomp', order: 0, tasks: [] }]);
    expect(g2.milestones[0].title).toBe('Fresh decomp');
  });
});

describe('updateGoalProgress dates the history point by the user-local day', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-07T01:30:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('keys progressHistory by the configured timezone day', async () => {
    h.goalsData = {
      goals: [{ id: 'goal-1', title: 'Write a novel', progress: 10, progressHistory: [] }],
      birthDate: null
    };
    await updateGoalProgress('goal-1', 20);
    expect(h.goalsData.goals[0].progressHistory).toEqual([
      expect.objectContaining({ date: '2026-11-06', value: 20 })
    ]);
  });
});

describe('getGoalsTree tag index', () => {
  it('indexes reserved-looking tags as own keys and dedupes per goal', async () => {
    h.goalsData = {
      goals: [
        { id: 'goal-a', title: 'A', status: 'active', tags: ['constructor', '__proto__', 'plain', 'plain'] },
        { id: 'goal-b', title: 'B', status: 'active', tags: ['toString', 'constructor'] }
      ],
      birthDate: null
    };
    const tree = await getGoalsTree();
    const serialized = JSON.parse(JSON.stringify(tree.tagIndex));
    expect(Object.keys(serialized).sort()).toEqual(['__proto__', 'constructor', 'plain', 'toString']);
    expect(serialized.constructor).toEqual(['goal-a', 'goal-b']);
    expect(serialized.toString).toEqual(['goal-b']);
    expect(tree.tagIndex['__proto__']).toEqual(['goal-a']);
    expect(serialized.plain).toEqual(['goal-a']);
  });
});

describe('identity logs keep user-authored text out of stdout', () => {
  const SECRET_TITLE = 'Quit smoking before the wedding';
  const SECRET_ACTIVITY = 'Therapy with Dr Example';
  const SECRET_CALENDAR = 'Private family calendar';
  let logs;

  beforeEach(() => {
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => { logs.push(args.join(' ')); });
    h.goalsData = { goals: [], birthDate: null };
  });
  afterEach(() => vi.restoreAllMocks());

  it('createGoal logs the goal id but not the title', async () => {
    const goal = await createGoal({ title: SECRET_TITLE, horizon: 'short' });
    const out = logs.join('\n');
    expect(out).toContain(goal.id);
    expect(out).not.toContain(SECRET_TITLE);
  });

  it('linkActivity and linkCalendarToGoal log ids, not activity, calendar or goal names', async () => {
    h.goalsData = { goals: [{ id: 'goal-1', title: SECRET_TITLE, linkedActivities: [], linkedCalendars: [] }], birthDate: null };
    await linkActivity('goal-1', { activityName: SECRET_ACTIVITY });
    await linkCalendarToGoal('goal-1', { subcalendarId: 'cal-1', subcalendarName: SECRET_CALENDAR, matchPattern: '' });
    const out = logs.join('\n');
    expect(out).toContain('goal-1');
    expect(out).not.toContain(SECRET_ACTIVITY);
    expect(out).not.toContain(SECRET_CALENDAR);
    expect(out).not.toContain(SECRET_TITLE);
  });

  it('updateGoalProgress logs percents and the goal id, not the title', async () => {
    h.goalsData = { goals: [{ id: 'goal-1', title: SECRET_TITLE, progress: 10, progressHistory: [] }], birthDate: null };
    await updateGoalProgress('goal-1', 25);
    const out = logs.join('\n');
    expect(out).toContain('10%');
    expect(out).toContain('25%');
    expect(out).not.toContain(SECRET_TITLE);
  });

  it('addTodo logs ids, not the todo title or the goal title', async () => {
    const SECRET_TODO = 'Call the lawyer about the will';
    h.goalsData = { goals: [{ id: 'goal-1', title: SECRET_TITLE, todos: [] }], birthDate: null };
    await addTodo('goal-1', { title: SECRET_TODO });
    const out = logs.join('\n');
    expect(out).toContain('goal-1');
    expect(out).not.toContain(SECRET_TODO);
    expect(out).not.toContain(SECRET_TITLE);
  });
});
