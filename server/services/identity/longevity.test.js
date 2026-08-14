import { describe, it, expect, vi, beforeEach } from 'vitest';

// Birth dates are personal data, so every fixture below is computed relative to
// "now" instead of being transcribed from anywhere — which also keeps the
// assertions stable as the calendar moves.
const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;
const birthDateYearsAgo = years => new Date(Date.now() - years * YEAR_MS).toISOString().slice(0, 10);

const h = vi.hoisted(() => ({ goalsData: null, longevityData: null }));

vi.mock('./store.js', () => ({
  GOALS_FILE: 'goals.json',
  LONGEVITY_FILE: 'longevity.json',
  DEFAULT_GOALS: { goals: [], birthDate: null, lifeExpectancy: null, timeHorizons: null },
  DEFAULT_LONGEVITY: { lifeExpectancy: { adjusted: null }, derivedAt: null },
  loadJSON: vi.fn(async file => (file === 'goals.json' ? h.goalsData : h.longevityData)),
  saveJSON: vi.fn(async (file, data) => {
    if (file === 'goals.json') h.goalsData = data;
    else h.longevityData = data;
  })
}));

vi.mock('../genome.js', () => ({ getGenomeSummary: vi.fn(async () => ({ savedMarkers: {} })) }));
vi.mock('../meatspaceCalendar.js', () => ({ getActivities: vi.fn(async () => []) }));

const { computeTimeHorizons } = await import('./markers.js');
const { applyFreshTimeHorizons, readLongevity, getLongevity } = await import('./longevity.js');
const { getGoals, getGoalsTree, computeGoalUrgency } = await import('./goals.js');
const { saveJSON } = await import('./store.js');

// A stored snapshot whose horizons were computed a year before "now": at age 44
// against an 80-year adjusted expectancy the derive stamped 36 years remaining.
// A year on, the truth is 35 — the drift this module exists to correct.
const staleSnapshotAYearOld = () => ({
  lifeExpectancy: { baseline: 78.5, adjusted: 80 },
  timeHorizons: { ageYears: 44, yearsRemaining: 36, healthyYearsRemaining: 30.6, percentLifeComplete: 55 },
  derivedAt: new Date(Date.now() - YEAR_MS).toISOString()
});

// Fully-normalized so getGoals' lazy migration has nothing to backfill (and so
// never writes) — this suite asserts the read path stays a read path.
const normalizedGoal = overrides => ({
  id: 'goal-1',
  title: 'Example Goal',
  description: '',
  horizon: '10-year',
  category: 'mastery',
  goalType: 'standard',
  status: 'active',
  parentId: null,
  tags: [],
  linkedActivities: [],
  linkedCalendars: [],
  featureAreas: [],
  targetDate: null,
  timeBlockConfig: null,
  scheduledEvents: [],
  checkIns: [],
  milestones: [],
  progress: 0,
  progressHistory: [],
  todos: [],
  urgency: null,
  ...overrides
});

beforeEach(() => {
  h.goalsData = { goals: [], birthDate: null, lifeExpectancy: null, timeHorizons: null };
  h.longevityData = { lifeExpectancy: { adjusted: null }, derivedAt: null };
  saveJSON.mockClear();
});

describe('computeTimeHorizons', () => {
  it('derives horizons from a birth date against an adjusted life expectancy', () => {
    const horizons = computeTimeHorizons(birthDateYearsAgo(45), 80);

    expect(horizons.ageYears).toBeCloseTo(45, 1);
    expect(horizons.yearsRemaining).toBeCloseTo(35, 1);
    expect(horizons.healthyYearsRemaining).toBeCloseTo(29.8, 1);
    expect(horizons.percentLifeComplete).toBeCloseTo(56.3, 1);
  });

  it('returns null — not a zeroed shape — when the birth date is missing', () => {
    // "We cannot compute horizons" must stay distinguishable from "no time left".
    expect(computeTimeHorizons(null, 80)).toBeNull();
    expect(computeTimeHorizons(undefined, 80)).toBeNull();
    expect(computeTimeHorizons('', 80)).toBeNull();
  });

  it('returns null when no life expectancy has been derived yet', () => {
    expect(computeTimeHorizons(birthDateYearsAgo(45), null)).toBeNull();
    expect(computeTimeHorizons(birthDateYearsAgo(45), undefined)).toBeNull();
  });

  it('returns null for an unparseable birth date rather than NaN horizons', () => {
    expect(computeTimeHorizons('not-a-date', 80)).toBeNull();
  });

  it('clamps a birth date already past the life expectancy', () => {
    const horizons = computeTimeHorizons(birthDateYearsAgo(95), 80);

    expect(horizons.yearsRemaining).toBe(0);
    expect(horizons.healthyYearsRemaining).toBe(0);
    expect(horizons.percentLifeComplete).toBe(100);
  });
});

describe('applyFreshTimeHorizons', () => {
  it('replaces a year-old snapshot with horizons measured from today', () => {
    const stored = staleSnapshotAYearOld();

    const fresh = applyFreshTimeHorizons(stored, birthDateYearsAgo(45));

    expect(fresh.timeHorizons.yearsRemaining).toBeCloseTo(35, 1);
    expect(fresh.timeHorizons.yearsRemaining).toBeLessThan(stored.timeHorizons.yearsRemaining);
    expect(fresh.timeHorizons.ageYears).toBeCloseTo(45, 1);
    // Non-mutating: the caller's snapshot is untouched.
    expect(stored.timeHorizons.yearsRemaining).toBe(36);
  });

  it('leaves everything else on the snapshot alone', () => {
    const stored = staleSnapshotAYearOld();

    const fresh = applyFreshTimeHorizons(stored, birthDateYearsAgo(45));

    expect(fresh.derivedAt).toBe(stored.derivedAt);
    expect(fresh.lifeExpectancy).toEqual(stored.lifeExpectancy);
  });

  it('keeps the stored snapshot when there is no birth date to re-derive from', () => {
    const stored = staleSnapshotAYearOld();

    // Degrades to the last known value rather than blanking it — absent inputs
    // mean "cannot recompute", not "there are no horizons".
    expect(applyFreshTimeHorizons(stored, null)).toBe(stored);
    expect(applyFreshTimeHorizons(stored, undefined).timeHorizons.yearsRemaining).toBe(36);
  });

  it('keeps the stored snapshot when no life expectancy has been derived', () => {
    const stored = { lifeExpectancy: { adjusted: null }, timeHorizons: null, derivedAt: null };

    expect(applyFreshTimeHorizons(stored, birthDateYearsAgo(45))).toBe(stored);
  });
});

describe('readLongevity / getLongevity', () => {
  it('re-derives horizons against the stored birth date on read', async () => {
    h.longevityData = staleSnapshotAYearOld();
    h.goalsData = { ...h.goalsData, birthDate: birthDateYearsAgo(45) };

    const longevity = await readLongevity();

    expect(longevity.timeHorizons.yearsRemaining).toBeCloseTo(35, 1);
    expect(saveJSON).not.toHaveBeenCalled();
  });

  it('getLongevity hands back a fresh snapshot without re-running the derive', async () => {
    h.longevityData = staleSnapshotAYearOld();
    h.goalsData = { ...h.goalsData, birthDate: birthDateYearsAgo(45) };

    const longevity = await getLongevity();

    expect(longevity.derivedAt).toBe(h.longevityData.derivedAt);
    expect(longevity.timeHorizons.yearsRemaining).toBeCloseTo(35, 1);
    expect(saveJSON).not.toHaveBeenCalled();
  });
});

describe('goal urgency ranks on the re-derived horizons', () => {
  // Age 70 against an 80-year expectancy → 10 years remaining, 8.5 healthy. A
  // 10-year goal therefore scores rawUrgency 0.5 + 0.2 health pressure = 0.7,
  // while the stale snapshot's 40 remaining years would score a flat 0.
  const staleGenerousSnapshot = () => ({
    lifeExpectancy: { baseline: 78.5, adjusted: 80 },
    timeHorizons: { ageYears: 40, yearsRemaining: 40, healthyYearsRemaining: 34, percentLifeComplete: 50 },
    derivedAt: new Date(Date.now() - 30 * YEAR_MS).toISOString()
  });

  beforeEach(() => {
    h.longevityData = staleGenerousSnapshot();
    h.goalsData = {
      goals: [normalizedGoal({ urgency: 0 })],
      birthDate: birthDateYearsAgo(70),
      lifeExpectancy: null,
      timeHorizons: null
    };
  });

  it('getGoalsTree enriches urgency from today\'s horizons, not the snapshot', async () => {
    const tree = await getGoalsTree();

    const staleUrgency = computeGoalUrgency({ horizon: '10-year' }, staleGenerousSnapshot().timeHorizons);
    expect(staleUrgency).toBe(0);

    expect(tree.flat[0].urgency).toBeCloseTo(0.7, 2);
    expect(tree.timeHorizons.yearsRemaining).toBeCloseTo(10, 1);
  });

  it('getGoalsTree orders goals by the re-derived urgency', async () => {
    h.goalsData.goals = [
      normalizedGoal({ id: 'goal-short', horizon: '1-year' }),
      normalizedGoal({ id: 'goal-long', horizon: 'lifetime' })
    ];

    const tree = await getGoalsTree();
    const byId = Object.fromEntries(tree.flat.map(g => [g.id, g.urgency]));

    // With only ~10 years left a lifetime goal is far more urgent than a 1-year one.
    expect(byId['goal-long']).toBeGreaterThan(byId['goal-short']);
  });

  it('getGoals refreshes the persisted urgency in memory without writing', async () => {
    // jobGates / goalCheckIn / telegram all read goals through here, so the
    // refresh has to land before the record leaves this function.
    const data = await getGoals();

    expect(data.goals[0].urgency).toBeCloseTo(0.7, 2);
    expect(saveJSON).not.toHaveBeenCalled();
  });

  it('falls back to the stored horizons when there is no birth date', async () => {
    // Nothing to re-derive from, so this degrades to exactly the pre-fix
    // behavior — the snapshot's own horizons — rather than fabricating any.
    h.goalsData.birthDate = null;

    const tree = await getGoalsTree();

    expect(tree.timeHorizons).toEqual(staleGenerousSnapshot().timeHorizons);
    expect(tree.flat[0].urgency).toBe(0);
  });

  it('leaves urgency untouched when neither a birth date nor stored horizons exist', async () => {
    h.goalsData.birthDate = null;
    h.goalsData.goals = [normalizedGoal({ urgency: 0.42 })];
    h.longevityData = { lifeExpectancy: { adjusted: null }, timeHorizons: null, derivedAt: null };

    const data = await getGoals();

    // No horizons anywhere is "unknown", not "zero urgency".
    expect(data.goals[0].urgency).toBe(0.42);
  });
});
