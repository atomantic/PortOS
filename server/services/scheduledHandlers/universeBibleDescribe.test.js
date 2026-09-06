import { beforeEach, describe, expect, it, vi } from 'vitest';

const listUniverses = vi.fn();
const getUniverse = vi.fn();
const expandUniverseCharacter = vi.fn();
const expandUniverseCanonEntry = vi.fn();
const getAllProviders = vi.fn();
const getQuotaBurnInFlight = vi.fn(async () => new Set());
const recordQuotaBurnInFlight = vi.fn(async () => {});

vi.mock('../universeBuilder.js', () => ({
  listUniverses: (...args) => listUniverses(...args),
  getUniverse: (...args) => getUniverse(...args),
}));
vi.mock('../universeCharacterExpand.js', () => ({
  expandUniverseCharacter: (...args) => expandUniverseCharacter(...args),
}));
vi.mock('../universeCanonEntryExpand.js', () => ({
  expandUniverseCanonEntry: (...args) => expandUniverseCanonEntry(...args),
}));
vi.mock('../providers.js', () => ({ getAllProviders: (...args) => getAllProviders(...args) }));
vi.mock('../quotaBurnStore.js', () => ({
  getQuotaBurnInFlight: (...args) => getQuotaBurnInFlight(...args),
  recordQuotaBurnInFlight: (...args) => recordQuotaBurnInFlight(...args),
}));

const {
  countPending, describeInFlightKey, findUnderdescribedEntries, run, sortByEmptiest,
} = await import('./universeBibleDescribe.js');

const CODEX_CLI = { id: 'codex', type: 'cli', enabled: true, command: '/usr/local/bin/codex' };
const CODEX_TUI = { id: 'codex-tui', type: 'tui', enabled: true, command: '/usr/local/bin/codex' };

const universe = () => ({
  id: 'u1',
  name: 'Example Universe',
  characters: [
    // Blank except for a name — the case this job exists for.
    { id: 'c1', name: 'Alice' },
    // Locked: protected from every AI rewrite path.
    { id: 'c2', name: 'Bob', locked: true },
    // Core prose filled, sheet still thin — fewer gaps than Alice.
    {
      id: 'c3',
      name: 'Cass',
      physicalDescription: 'tall', personality: 'wry', background: 'exile',
      motivations: 'find the map', visualNotes: 'ochre coat',
    },
  ],
  places: [{ id: 'p1', name: 'The Foundry', description: 'a rolling mill, still hot' }],
  objects: [{ id: 'o1', name: 'The Ledger' }],
});

beforeEach(() => {
  vi.clearAllMocks();
  getQuotaBurnInFlight.mockResolvedValue(new Set());
  getAllProviders.mockResolvedValue([CODEX_CLI, CODEX_TUI]);
  listUniverses.mockResolvedValue([universe()]);
  expandUniverseCharacter.mockResolvedValue({ updatedFields: ['personality', 'background'] });
  expandUniverseCanonEntry.mockResolvedValue({ updatedFields: ['description'] });
});

describe('findUnderdescribedEntries', () => {
  it('skips locked entries', () => {
    // Bob is locked — an expand on it returns `{ locked: true }` without an LLM
    // call, so picking it would spend a dispatch on a guaranteed no-op.
    expect(findUnderdescribedEntries(universe()).some((row) => row.id === 'c2')).toBe(false);
  });

  it('ranks the emptiest FRACTION first, not the biggest raw gap', () => {
    // Fully-blank entries first (the character sheet wins the tiebreak on raw
    // gap size), then the partly-filled ones. Ranking on the raw count instead
    // would put every half-written character ahead of a totally blank object,
    // and on a real cast the objects would never be reached at all.
    const rows = sortByEmptiest(findUnderdescribedEntries(universe()));
    expect(rows.map((row) => row.id)).toEqual(['c1', 'o1', 'p1', 'c3']);
  });

  it('reports a place described at core depth as done, and still thin at full', () => {
    expect(findUnderdescribedEntries(universe(), { scope: 'places', depth: 'core' })).toEqual([]);
    expect(findUnderdescribedEntries(universe(), { scope: 'places', depth: 'full' })).toHaveLength(1);
  });

  it('honors a narrowed scope', () => {
    expect(findUnderdescribedEntries(universe(), { scope: 'objects' }).map((r) => r.id)).toEqual(['o1']);
    expect(findUnderdescribedEntries(universe(), { scope: 'characters' }).map((r) => r.id)).toEqual(['c1', 'c3']);
  });

  it('tolerates an empty or malformed universe', () => {
    expect(findUnderdescribedEntries(null)).toEqual([]);
    expect(findUnderdescribedEntries({})).toEqual([]);
  });
});

describe('countPending', () => {
  it('refuses to fall through to another family\'s provider', async () => {
    // `claude` has no registered provider here. Falling through to the install's
    // active provider would spend a DIFFERENT subscription while claude's window
    // expires unused — and charge claude's dispatch cap for it.
    getAllProviders.mockResolvedValue([CODEX_CLI]);
    await expect(countPending({ params: {}, family: { id: 'claude' } }))
      .resolves.toMatchObject({ count: 0, detail: expect.stringContaining('no enabled CLI/TUI provider') });
  });

  it('counts the backlog and names how many go next', async () => {
    const result = await countPending({ params: { maxEntries: 2 }, family: { id: 'codex' } });
    expect(result.count).toBe(4);
    expect(result.detail).toContain('2 queued next');
    expect(result.context.picked.rows).toHaveLength(2);
  });

  it('drops entries still inside the cooldown', async () => {
    getQuotaBurnInFlight.mockResolvedValue(new Set([describeInFlightKey('u1', 'character', 'c1')]));
    const result = await countPending({ params: {}, family: { id: 'codex' } });
    expect(result.count).toBe(3);
    expect(result.context.picked.rows.some((row) => row.id === 'c1')).toBe(false);
  });
});

describe('run', () => {
  it('prefers the headless CLI provider over the TUI and pins every expand to it', async () => {
    const result = await run({ params: { maxEntries: 2 }, job: {}, family: { id: 'codex' } });
    expect(result.dispatched).toBe(true);
    expect(expandUniverseCharacter).toHaveBeenCalledWith('u1', 'c1', { providerId: 'codex', model: undefined });
    expect(expandUniverseCanonEntry).toHaveBeenCalledWith('u1', 'object', 'o1', { providerId: 'codex', model: undefined });
    expect(result.detail).toMatchObject({ described: 2, fields: 3, providerId: 'codex' });
  });

  it('stamps a cooldown on every attempted entry, including the ones nothing was filled on', async () => {
    // At `full` depth some fields are meant to stay blank (a bit-player has no
    // Ghost→Need chain), so an entry can be permanently incomplete. Without the
    // stamp the plan re-picks the same handful every tick forever.
    expandUniverseCharacter.mockResolvedValue({ updatedFields: [] });
    await run({ params: { maxEntries: 1 }, job: {}, family: { id: 'codex' } });
    expect(recordQuotaBurnInFlight).toHaveBeenCalledWith([describeInFlightKey('u1', 'character', 'c1')]);
  });

  it('absorbs a single failed expand and still reports the batch\'s successes', async () => {
    expandUniverseCharacter.mockRejectedValueOnce(new Error('empty expansion'));
    const result = await run({ params: { maxEntries: 2 }, job: {}, family: { id: 'codex' } });
    expect(result.dispatched).toBe(true);
    expect(result.detail).toMatchObject({ described: 1, failed: 1 });
    expect(result.detail.failures[0]).toContain('empty expansion');
  });

  it('declines (rather than charging the cap) when every expand failed', async () => {
    expandUniverseCharacter.mockRejectedValue(new Error('provider refused'));
    expandUniverseCanonEntry.mockRejectedValue(new Error('provider refused'));
    const result = await run({ params: { maxEntries: 2 }, job: {}, family: { id: 'codex' } });
    expect(result.dispatched).toBe(false);
    expect(result.reason).toContain('provider refused');
    // …and does NOT stamp the cooldown: a provider down for one tick must not
    // park this batch for the ledger's whole six-hour TTL.
    expect(recordQuotaBurnInFlight).not.toHaveBeenCalled();
  });

  it('declines when nothing is under-described', async () => {
    listUniverses.mockResolvedValue([{ id: 'u2', name: 'Done', characters: [], places: [], objects: [] }]);
    await expect(run({ params: {}, job: {}, family: { id: 'codex' } }))
      .resolves.toMatchObject({ dispatched: false, reason: expect.stringContaining('already described') });
  });

  it('ignores the cooldown on a forced run', async () => {
    getQuotaBurnInFlight.mockResolvedValue(new Set([describeInFlightKey('u1', 'character', 'c1')]));
    const result = await run({ params: { maxEntries: 1 }, job: {}, family: { id: 'codex' }, force: true });
    expect(expandUniverseCharacter).toHaveBeenCalledWith('u1', 'c1', expect.anything());
    expect(result.dispatched).toBe(true);
  });

  it('honors a job-level provider and model pin', async () => {
    const job = { providerId: 'codex-tui', model: 'gpt-5' };
    await run({ params: { maxEntries: 1 }, job, family: { id: 'codex' } });
    expect(expandUniverseCharacter).toHaveBeenCalledWith('u1', 'c1', { providerId: 'codex-tui', model: 'gpt-5' });
  });
});

describe('probe → run context handoff', () => {
  it('reuses the probe\'s scan instead of walking every universe again', async () => {
    // The contract in scheduledHandlers/index.js: an expensive probe hands its
    // result to the run. Counting the universe walk is the only way to see it —
    // a run that re-scanned would produce the same output and cost twice.
    const probe = await countPending({ params: { maxEntries: 2 }, family: { id: 'codex' } });
    listUniverses.mockClear();
    getAllProviders.mockClear();

    const result = await run({ params: { maxEntries: 2 }, job: {}, family: { id: 'codex' }, context: probe.context });

    expect(result.dispatched).toBe(true);
    expect(listUniverses).not.toHaveBeenCalled();
    expect(getAllProviders).not.toHaveBeenCalled();
  });

  it('still runs when there is no probe context — the manual/force path', async () => {
    const result = await run({ params: { maxEntries: 2 }, job: {}, family: { id: 'codex' }, context: undefined });
    expect(result.dispatched).toBe(true);
    expect(listUniverses).toHaveBeenCalled();
  });

  it('probes without writing, enqueueing, or calling a provider', async () => {
    // Listing/probing must spend nothing: the Quota Burn page probes every
    // configured job on every load (AGENTS.md — no cold-bootstrap LLM calls).
    await countPending({ params: {}, family: { id: 'codex' } });
    expect(expandUniverseCharacter).not.toHaveBeenCalled();
    expect(expandUniverseCanonEntry).not.toHaveBeenCalled();
    expect(recordQuotaBurnInFlight).not.toHaveBeenCalled();
  });
});

describe('ordinary scheduled run (no burning family)', () => {
  it('probes without refusing when nothing is pinned', async () => {
    // There is no window to protect, so "no pin" is a valid configuration —
    // reporting the family refusal here would make Run Now permanently dead.
    getAllProviders.mockResolvedValue([]);
    const result = await countPending({ params: { maxEntries: 2 }, job: {} });
    expect(result.count).toBe(4);
    expect(result.detail).toContain('2 queued next');
  });

  it('leaves the provider unset so the stage runner resolves the active one', async () => {
    const result = await run({ params: { maxEntries: 1 }, job: {} });
    expect(result.dispatched).toBe(true);
    expect(expandUniverseCharacter).toHaveBeenCalledWith('u1', 'c1', { providerId: undefined, model: undefined });
    expect(result.detail.providerId).toBeNull();
  });

  it('honors the scheduled task\'s own provider and model pin', async () => {
    await run({ params: { maxEntries: 1 }, job: { providerId: 'codex-tui', model: 'gpt-5' } });
    expect(expandUniverseCharacter).toHaveBeenCalledWith('u1', 'c1', { providerId: 'codex-tui', model: 'gpt-5' });
  });
});
