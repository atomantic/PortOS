import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory store so decompose/accept/migration logic can be exercised without
// touching disk or a real AI provider.
const h = vi.hoisted(() => ({ goalsData: null, aiText: '' }));

vi.mock('./store.js', () => ({
  GOALS_FILE: 'goals.json',
  LONGEVITY_FILE: 'longevity.json',
  DEFAULT_GOALS: { goals: [], birthDate: null },
  DEFAULT_LONGEVITY: {},
  loadJSON: vi.fn(async (file) => (file === 'goals.json' ? h.goalsData : {})),
  saveJSON: vi.fn(async (file, data) => { if (file === 'goals.json') h.goalsData = data; })
}));

vi.mock('../providers.js', () => ({
  getActiveProvider: vi.fn(async () => ({ id: 'p1', apiType: 'openai', defaultModel: 'm1' })),
  getProviderById: vi.fn(async () => ({ id: 'p1', apiType: 'openai', defaultModel: 'm1' }))
}));

vi.mock('../../lib/aiProvider.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, callProviderAISimple: vi.fn(async () => ({ text: h.aiText })) };
});

const {
  computeGoalVelocity, getGoals, decomposeGoal, generateGoalPhases,
  acceptGoalPhases, acceptGoalDecomposition, completeMilestoneTask
} = await import('./goals.js');

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
