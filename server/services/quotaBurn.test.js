import { afterEach, describe, expect, it, vi } from 'vitest';
import { burnBudgetRemaining, evaluateFamilies, selectBurnCandidates, windowKey } from './quotaBurn.js';
import { normalizeQuotaBurnConfig } from '../lib/quotaBurnConfig.js';

const NOW = Date.parse('2026-07-26T12:00:00.000Z');
const job = (jobType = 'agent-prompt') => ({ id: 'j1', enabled: true, jobType, params: {} });
const config = normalizeQuotaBurnConfig({
  enabled: true,
  families: {
    grok: { enabled: true, resetWithinHours: 24, reservePercent: 20, maxDispatchesPerWindow: 2, jobs: [job()] },
    codex: { enabled: true, resetWithinHours: 24, reservePercent: 0, priority: 1, jobs: [job()] },
  },
});
const quota = (family, resetsAt, percentRemaining = 50, extras = {}) => ({
  family, supported: true, limits: [{ key: 'week', scope: 'week', label: 'Weekly', resetsAt, percentRemaining }], ...extras,
});

describe('selectBurnCandidates', () => {
  it('skips a card that declares itself unburnable', () => {
    // A card can carry a 0%-left limit that is an OBSERVED refusal rather than
    // a measured allowance (the Image Gen card) — burning against it would
    // dispatch work to a backend that just refused. Opt-out only.
    const candidates = selectBurnCandidates(
      [quota('grok', '2026-07-26T18:00:00.000Z', 50, { burnable: false })],
      config,
      { now: NOW },
    );
    expect(candidates).toEqual([]);
    // Absent `burnable` still means burnable — this must not regress every card.
    expect(selectBurnCandidates([quota('grok', '2026-07-26T18:00:00.000Z')], config, { now: NOW })).toHaveLength(1);
  });

  it('never burns against a card whose reading is still PENDING', () => {
    // A cold-cache status read starts the scrape and returns `pending` rather
    // than holding the page for a 20s PTY spawn. The card carries real-looking
    // fields but no reading — it must fail closed, and say so as its own state
    // rather than borrowing an error or empty-quota verdict.
    const pending = { family: 'grok', supported: true, pending: true, limits: [] };
    expect(selectBurnCandidates([pending], config, { now: NOW })).toEqual([]);
    const [verdict] = evaluateFamilies([pending], config, { now: NOW }).filter((row) => row.family.id === 'grok');
    expect(verdict.candidate).toBeUndefined();
    expect(verdict.skipReason).toMatch(/reading provider quota/i);

    // Pending holds even under force — a forced run can't invent a reading.
    expect(selectBurnCandidates([pending], config, { now: NOW, bypassGatesFor: 'grok' })).toEqual([]);
  });

  it('selects burnable windows by reset time then priority', () => {
    const candidates = selectBurnCandidates([
      quota('codex', '2026-07-27T00:00:00.000Z'),
      quota('grok', '2026-07-26T18:00:00.000Z'),
    ], config, { now: NOW });
    expect(candidates.map((candidate) => candidate.family.id)).toEqual(['grok', 'codex']);
  });

  it('skips unknown, out-of-window, reserved, unsupported, and exhausted windows', () => {
    expect(selectBurnCandidates([quota('grok', null)], config, { now: NOW })).toEqual([]);
    expect(selectBurnCandidates([quota('grok', '2026-07-28T12:00:00.000Z')], config, { now: NOW })).toEqual([]);
    expect(selectBurnCandidates([quota('grok', '2026-07-26T18:00:00.000Z', 20)], config, { now: NOW })).toEqual([]);
    expect(selectBurnCandidates([quota('grok', '2026-07-26T18:00:00.000Z', 50, { supported: false })], config, { now: NOW })).toEqual([]);
    const selected = selectBurnCandidates([quota('grok', '2026-07-26T18:00:00.000Z')], config, { now: NOW })[0];
    expect(selectBurnCandidates([quota('grok', '2026-07-26T18:00:00.000Z')], config, {
      now: NOW, dispatches: { [selected.dispatchKey]: 2 },
    })).toEqual([]);
  });

  it('skips an enabled family whose plan has no enabled job', () => {
    // An enabled family with nothing to run is a half-finished setup, not a burn
    // plan — selecting it would surface as "chosen, then skipped" every cycle.
    const empty = normalizeQuotaBurnConfig({ families: { grok: { enabled: true, jobs: [] } } });
    expect(selectBurnCandidates([quota('grok', '2026-07-26T18:00:00.000Z')], empty, { now: NOW })).toEqual([]);
    const disabledJob = normalizeQuotaBurnConfig({
      families: { grok: { enabled: true, jobs: [{ ...job(), enabled: false }] } },
    });
    expect(selectBurnCandidates([quota('grok', '2026-07-26T18:00:00.000Z')], disabledJob, { now: NOW })).toEqual([]);
  });

  it('reports how much of the window the family is willing to spend', () => {
    expect(burnBudgetRemaining({ percentRemaining: 50 }, { reservePercent: 20 })).toBe(30);
    expect(burnBudgetRemaining({ percentRemaining: 10 }, { reservePercent: 20 })).toBe(0);
  });
});

/**
 * The page renders `evaluateFamilies`' answer verbatim, and the runner selects
 * from the SAME ladder — a card that says "ready" while the runner skips (or
 * vice versa) is worse than no explanation at all, so the two must be one
 * function, not two that mirror each other.
 */
describe('evaluateFamilies', () => {
  const family = { enabled: true, resetWithinHours: 24, reservePercent: 20, maxDispatchesPerWindow: 2, jobs: [job()] };
  const reasonFor = (rawFamily, quotas, opts = {}) =>
    evaluateFamilies(quotas, { families: { grok: rawFamily } }, { now: NOW, ...opts })[0].skipReason;

  it('yields a candidate exactly when selectBurnCandidates does', () => {
    const quotas = [quota('grok', '2026-07-26T18:00:00.000Z')];
    const [verdict] = evaluateFamilies(quotas, { families: { grok: family } }, { now: NOW });
    expect(verdict.skipReason).toBeUndefined();
    expect(verdict.candidate).toBeTruthy();
    expect(selectBurnCandidates(quotas, { families: { grok: family } }, { now: NOW })).toHaveLength(1);
  });

  it('names the specific gate that closed', () => {
    expect(reasonFor({ ...family, enabled: false }, [])).toBe('disabled');
    expect(reasonFor({ ...family, jobs: [] }, [])).toBe('no enabled jobs configured');
    expect(reasonFor(family, [])).toBe('no enabled provider in this family');
    expect(reasonFor(family, [quota('grok', null)])).toBe('no window states a reset time');
    expect(reasonFor(family, [quota('grok', '2026-07-28T12:00:00.000Z')])).toMatch(/outside the 24h window/);
    expect(reasonFor(family, [quota('grok', '2026-07-26T18:00:00.000Z', 20)]))
      .toMatch(/20% left is at or below the 20% reserve/);
    const selected = selectBurnCandidates([quota('grok', '2026-07-26T18:00:00.000Z')], { families: { grok: family } }, { now: NOW })[0];
    expect(reasonFor(family, [quota('grok', '2026-07-26T18:00:00.000Z')], { dispatches: { [selected.dispatchKey]: 2 } }))
      .toBe('dispatch cap reached (2/2)');
  });

  it('never closes the cap gate when the cap is unlimited (the default)', () => {
    // -1 means the tally is not consulted at all. The remaining gates — the
    // reset horizon, the reserve, an observed refusal — still bound the spend,
    // and they read live numbers rather than a count.
    const uncapped = { ...family, maxDispatchesPerWindow: -1 };
    const quotas = [quota('grok', '2026-07-26T18:00:00.000Z')];
    const selected = selectBurnCandidates(quotas, { families: { grok: uncapped } }, { now: NOW })[0];
    expect(reasonFor(uncapped, quotas, { dispatches: { [selected.dispatchKey]: 999 } })).toBeUndefined();
    // …and the horizon still closes on the same plan.
    expect(reasonFor(uncapped, [quota('grok', '2026-07-28T12:00:00.000Z')])).toMatch(/outside the 24h window/);
  });
});

describe('selectBurnCandidates bypassGatesFor', () => {
  const closed = normalizeQuotaBurnConfig({
    families: { grok: { enabled: true, resetWithinHours: 0, reservePercent: 99, maxDispatchesPerWindow: 1, jobs: [job()] } },
  });
  const quotas = [quota('grok', '2026-07-27T18:00:00.000Z', 10)];

  it('still reports the family\'s REAL window when the gates are bypassed', () => {
    // The forced candidate must not be a fabricated stand-in: the agent prompt
    // renders `percentRemaining` and the reset hours into its brief, and the run
    // log records them, so a synthesized zero would lie in both places.
    expect(selectBurnCandidates(quotas, closed, { now: NOW })).toEqual([]);
    const [forced] = selectBurnCandidates(quotas, closed, { now: NOW, bypassGatesFor: 'grok' });
    expect(forced.limit.percentRemaining).toBe(10);
    expect(forced.hoursUntilReset).toBeCloseTo(30, 0);
    expect(forced.dispatchKey).toMatch(/^grok:/);
  });

  it('marks a forced candidate uncharged and an ordinary one charged', () => {
    // `charge`, not a null dispatchKey: keyed on WHY it ran, so a force whose
    // gates happen to pass is still uncharged instead of silently billing the
    // window.
    expect(selectBurnCandidates(quotas, closed, { now: NOW, bypassGatesFor: 'grok' })[0].charge).toBe(false);
    const open = normalizeQuotaBurnConfig({ families: { grok: { enabled: true, jobs: [job()] } } });
    expect(selectBurnCandidates([quota('grok', '2026-07-26T18:00:00.000Z')], open, { now: NOW })[0].charge).toBe(true);
    expect(selectBurnCandidates([quota('grok', '2026-07-26T18:00:00.000Z')], open, { now: NOW, bypassGatesFor: 'grok' })[0].charge).toBe(false);
  });

  it('does not bypass gates for a family it was not named for', () => {
    expect(selectBurnCandidates(quotas, closed, { now: NOW, bypassGatesFor: 'codex' })).toEqual([]);
  });

  it('still refuses a window with no readable reset time', () => {
    // Unknowable, not merely closed — a forced run can't invent a reset either.
    expect(selectBurnCandidates([quota('grok', null)], closed, { now: NOW, bypassGatesFor: 'grok' })).toEqual([]);
  });
});

/**
 * The scheduler tick and an on-demand "Run now" can both land a dispatch at
 * once. The ledger update is a read-modify-write, so without serialization both
 * would read the same count and write the same increment — losing a burn and
 * letting the window overspend its cap.
 */
describe('recordQuotaBurnDispatch', () => {
  afterEach(() => { vi.doUnmock('../lib/fileUtils.js'); vi.resetModules(); });

  // `readable: false` drives the present-but-unreadable case (#4115): the strict
  // reader's `ok: false`, which must never be mistaken for an empty ledger.
  const withLedger = async (initial = {}, { readable = true } = {}) => {
    vi.resetModules();
    let stored = { ...initial };
    vi.doMock('../lib/fileUtils.js', async (importActual) => ({
      ...(await importActual()),
      readJSONFileStrict: async () => (readable ? { ok: true, value: { ...stored } } : { ok: false, value: {} }),
      // The delay must sit on the WRITE: it holds each read-modify-write open
      // long enough for the next caller's read to observe the pre-write state.
      // (A delay on the read instead resolves in a macrotask whose continuation
      // runs the whole RMW in microtasks, so the cycles never actually overlap
      // and the test would pass even unserialized.)
      atomicWrite: async (_file, data) => { await new Promise((r) => setTimeout(r, 5)); stored = { ...data }; },
    }));
    return import('./quotaBurn.js');
  };

  it('does not lose an increment when two dispatches race', async () => {
    const { recordQuotaBurnDispatch, getQuotaBurnDispatches } = await withLedger();
    // Live window keys, not `grok:1` — the retention prune reads the epoch out
    // of the key, and a 1970 epoch would be dropped by the very write under test.
    const grok = `grok:${Date.now() + 3_600_000}`;
    const codex = `codex:${Date.now() + 7_200_000}`;
    await Promise.all([
      recordQuotaBurnDispatch(grok),
      recordQuotaBurnDispatch(grok),
      recordQuotaBurnDispatch(codex),
    ]);
    await expect(getQuotaBurnDispatches()).resolves.toEqual({ [grok]: 2, [codex]: 1 });
  });

  it('prunes windows that reset over a month ago', async () => {
    // A key is `<family>:<resetEpochMs>`; a passed window can never be selected
    // again, so its count is dead weight that would grow the file forever.
    const stale = NOW - 40 * 24 * 60 * 60 * 1000;
    const { recordQuotaBurnDispatch } = await withLedger({ [`grok:${stale}`]: 3, 'grok:not-a-number': 1 });
    const next = await recordQuotaBurnDispatch(`grok:${NOW}`, { now: NOW });
    expect(next).toEqual({ 'grok:not-a-number': 1, [`grok:${NOW}`]: 1 });
  });

  // #4115: an unreadable ledger used to read as "0 dispatches this window",
  // which both under-reports the family card's `N/M used` badge and lets the
  // next write persist an empty ledger over every surviving count.
  it('reports an unreadable ledger as null rather than an empty one', async () => {
    const { getQuotaBurnDispatches } = await withLedger({ 'grok:1': 4 }, { readable: false });
    await expect(getQuotaBurnDispatches()).resolves.toBeNull();
  });

  it('refuses to write over a ledger it could not read', async () => {
    const { recordQuotaBurnDispatch } = await withLedger({ [`grok:${NOW}`]: 4 }, { readable: false });
    // No write, and a null return so the caller knows the dispatch went
    // unrecorded instead of believing the window is now at 1.
    await expect(recordQuotaBurnDispatch(`grok:${NOW}`, { now: NOW })).resolves.toBeNull();
  });
});

describe('windowKey', () => {
  it('collapses a provider that reports its reset only as a relative duration', () => {
    // Antigravity states "Refreshes in 4h 57m", which parseAgyUsage turns into
    // `now + duration` — so an exact-epoch key drifts a minute or two on every
    // scrape and each cycle mints a FRESH key with a count of zero. The cap
    // would never engage: ~48 burns/day against a maxDispatchesPerWindow of 5,
    // with the page's badge stuck at 0/5.
    const base = Date.parse('2026-07-26T16:57:00.000Z');
    const drifted = Date.parse('2026-07-26T16:56:20.500Z');
    expect(windowKey('agy', { resetsAt: new Date(base).toISOString() }, { now: NOW }))
      .toBe(windowKey('agy', { resetsAt: new Date(drifted).toISOString() }, { now: NOW }));
  });

  it('still separates genuinely different windows', () => {
    expect(windowKey('grok', { resetsAt: '2026-07-26T18:00:00.000Z' }, { now: NOW }))
      .not.toBe(windowKey('grok', { resetsAt: '2026-07-27T18:00:00.000Z' }, { now: NOW }));
  });
});

/**
 * Every subscription family publishes a short rolling window AND a weekly one.
 * They answer different questions and both have to be read correctly: the weekly
 * allowance is what expires unused (the burn's deadline and its dispatch
 * budget), the short one is what actually refuses a run.
 */
const twoWindow = (sessionLeft, weekLeft, weekResetsAt = '2026-07-27T00:00:00.000Z') => ({
  family: 'claude', supported: true,
  limits: [
    { key: 'session', scope: 'session', label: '5-hour', resetsAt: '2026-07-26T15:00:00.000Z', percentRemaining: sessionLeft },
    { key: 'week', scope: 'week', label: 'Weekly', resetsAt: weekResetsAt, percentRemaining: weekLeft },
  ],
});

describe('reserve across every window', () => {
  const family = normalizeQuotaBurnConfig({
    families: { claude: { enabled: true, resetWithinHours: 24, reservePercent: 40, jobs: [job()] } },
  });

  it('refuses to drain the WEEKLY window just because the session window is full', () => {
    // Checking only the selected limit made the reserve inert for every provider
    // that reports two windows.
    const verdict = evaluateFamilies([twoWindow(100, 2)], family, { now: NOW })[0];
    expect(verdict.candidate).toBeUndefined();
    expect(verdict.skipReason).toMatch(/Weekly at 2% left is at or below the 40% reserve/);
  });

  it('burns when EVERY window on the card is above the reserve', () => {
    expect(evaluateFamilies([twoWindow(100, 90)], family, { now: NOW })[0].candidate).toBeTruthy();
  });
});

describe('window targeting', () => {
  const family = normalizeQuotaBurnConfig({
    families: { claude: { enabled: true, resetWithinHours: 24, reservePercent: 0, jobs: [job()] } },
  });

  it('reports the WEEKLY window, not the 5-hour one that resets sooner', () => {
    // The bug this exists for: the 5-hour window is nearly always the soonest to
    // reset, so selecting "soonest" made the page say "resets in 3h · 100% left"
    // for a plan written against a weekly allowance — and re-opened
    // resetWithinHours every five hours, so the horizon never bounded anything.
    const [{ candidate }] = evaluateFamilies([twoWindow(100, 62)], family, { now: NOW });
    expect(candidate.limit.label).toBe('Weekly');
    expect(candidate.hoursUntilReset).toBeCloseTo(12, 0);
    expect(candidate.limit.percentRemaining).toBe(62);
    // And the short window rides along as the one that will refuse first.
    expect(candidate.limitingLimit.label).toBe('5-hour');
    expect(candidate.limitingResetAt).toBe(Date.parse('2026-07-26T15:00:00.000Z'));
  });

  it('keys the dispatch cap on the WEEKLY reset, so the cap is per week', () => {
    // Keyed on the 5-hour reset, `maxDispatchesPerWindow: 5` silently meant
    // "5 burns every 5 hours" — ~24/day against a weekly allowance.
    const [{ candidate }] = evaluateFamilies([twoWindow(100, 62)], family, { now: NOW });
    expect(candidate.dispatchKey).toBe(windowKey('claude', { resetsAt: '2026-07-27T00:00:00.000Z' }, { now: NOW }));
  });

  it('falls back to soonest-reset when no window states a period it can classify', () => {
    // A provider whose vocabulary this doesn't know must keep working, not park.
    const opaque = {
      family: 'claude', supported: true,
      limits: [
        { key: 'a', scope: 'burst', label: 'Burst', resetsAt: '2026-07-26T15:00:00.000Z', percentRemaining: 80 },
        { key: 'b', scope: 'pool', label: 'Pool', resetsAt: '2026-07-26T20:00:00.000Z', percentRemaining: 80 },
      ],
    };
    const [{ candidate }] = evaluateFamilies([opaque], family, { now: NOW });
    expect(candidate.limit.label).toBe('Burst');
    expect(candidate.limitingLimit).toBeNull();
  });
});

/**
 * A refusal the provider actually issued outranks the numbers it reports: a burn
 * plan spending a weekly allowance exhausts the 5-hour window underneath it long
 * before the weekly card stops looking healthy, and without this the runner
 * re-dispatched into the same wall every tick.
 */
describe('denial blocks', () => {
  const family = normalizeQuotaBurnConfig({
    families: { claude: { enabled: true, resetWithinHours: 24, reservePercent: 0, jobs: [job()] } },
  });
  const quotas = [twoWindow(100, 62)];

  it('skips a family the provider refused, and names the block', () => {
    const blocks = { claude: { at: NOW - 1000, until: NOW + 3_600_000, reason: 'Usage limit exceeded' } };
    const [verdict] = evaluateFamilies(quotas, family, { now: NOW, blocks });
    expect(verdict.candidate).toBeUndefined();
    expect(verdict.skipReason).toMatch(/provider refused the last burn.*Usage limit exceeded/);
    expect(selectBurnCandidates(quotas, family, { now: NOW, blocks })).toEqual([]);
  });

  it('burns again once the block has lapsed', () => {
    const blocks = { claude: { at: NOW - 7_200_000, until: NOW - 1000, reason: 'Usage limit exceeded' } };
    expect(selectBurnCandidates(quotas, family, { now: NOW, blocks })).toHaveLength(1);
  });

  it('lets a forced run retry a block the user believes is stale', () => {
    // The force path is how a user retries; a run that then succeeds clears it.
    const blocks = { claude: { at: NOW - 1000, until: NOW + 3_600_000, reason: 'Usage limit exceeded' } };
    expect(selectBurnCandidates(quotas, family, { now: NOW, blocks, bypassGatesFor: 'claude' })).toHaveLength(1);
  });
});
