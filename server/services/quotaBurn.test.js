import { afterEach, describe, expect, it, vi } from 'vitest';
import { burnBudgetRemaining, evaluateFamilies, selectBurnCandidates } from './quotaBurn.js';
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

  const withLedger = async (initial = {}) => {
    vi.resetModules();
    let stored = { ...initial };
    vi.doMock('../lib/fileUtils.js', async (importActual) => ({
      ...(await importActual()),
      readJSONFile: async () => ({ ...stored }),
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
});
