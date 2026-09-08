import { beforeEach, describe, expect, it, vi } from 'vitest';

const listUniverses = vi.fn();
const getUniverse = vi.fn();
const renderUniverseJobs = vi.fn();
const getQuotaBurnInFlight = vi.fn(async () => new Set());
const recordQuotaBurnInFlight = vi.fn(async () => {});

vi.mock('../universeBuilder.js', () => ({
  listUniverses: (...args) => listUniverses(...args),
  getUniverse: (...args) => getUniverse(...args),
}));
vi.mock('../universeBuilderRender.js', () => ({
  renderUniverseJobs: (...args) => renderUniverseJobs(...args),
}));
vi.mock('../quotaBurnStore.js', () => ({
  getQuotaBurnInFlight: (...args) => getQuotaBurnInFlight(...args),
  recordQuotaBurnInFlight: (...args) => recordQuotaBurnInFlight(...args),
}));

const {
  buildRenderSelection, countPending, findMissingImageEntries, inFlightKey, resolveRenderMode, run,
} = await import('./universeBibleImages.js');

const universe = {
  id: 'u1',
  name: 'Example Universe',
  categories: {
    landscapes: {
      variations: [
        { id: 'v1', label: 'Salt Flats', imageRefs: [] },
        { id: 'v2', label: 'Rendered Ridge', imageRefs: ['ridge.png'] },
      ],
    },
  },
  compositeSheets: [{ id: 's1', label: 'Cast Sheet' }],
  characters: [
    { id: 'c1', name: 'Alice', imageRefs: [] },
    { id: 'c2', name: 'Bob', imageRefs: ['bob.png'] },
  ],
  places: [{ id: 'p1', slugline: 'EXT. FOUNDRY — DAY' }],
  objects: [],
};

describe('findMissingImageEntries', () => {
  it('returns only entries whose imageRefs are empty', () => {
    const rows = findMissingImageEntries(universe);
    expect(rows.map((row) => row.label)).toEqual(['Salt Flats', 'Cast Sheet', 'Alice', 'EXT. FOUNDRY — DAY']);
  });

  it('falls back to a place\'s slugline, matching what compilePrompts selects on', () => {
    // A canon place may carry ONLY a slugline. Keying on `name` alone would make
    // those entries permanently unselectable — they would show as pending
    // forever and never render.
    const rows = findMissingImageEntries(universe, { scope: 'canon' });
    expect(rows.some((row) => row.label === 'EXT. FOUNDRY — DAY')).toBe(true);
  });

  it('honors a narrowed scope', () => {
    expect(findMissingImageEntries(universe, { scope: 'variations' }).map((r) => r.label)).toEqual(['Salt Flats']);
    expect(findMissingImageEntries(universe, { scope: 'sheets' }).map((r) => r.label)).toEqual(['Cast Sheet']);
  });

  it('tolerates an empty or malformed universe', () => {
    expect(findMissingImageEntries(null)).toEqual([]);
    expect(findMissingImageEntries({})).toEqual([]);
  });

  it('holds back undescribed canon when requireDescribed is on', () => {
    // Alice is a bare name; rendering her spends image quota on a generic
    // figure. The variation and the composite sheet are unaffected — their
    // sanitizer requires a prompt, so they cannot be undescribed.
    const rows = findMissingImageEntries(universe, { requireDescribed: true });
    expect(rows.map((row) => row.label)).toEqual(['Salt Flats', 'Cast Sheet']);
  });

  it('lets a canon entry through once it has a core description', () => {
    const described = {
      ...universe,
      characters: [{
        id: 'c1',
        name: 'Alice',
        imageRefs: [],
        physicalDescription: 'a', personality: 'b', background: 'c', motivations: 'd', visualNotes: 'e',
      }],
      places: [],
    };
    const rows = findMissingImageEntries(described, { scope: 'canon', requireDescribed: true });
    expect(rows.map((row) => row.label)).toEqual(['Alice']);
  });
});

describe('buildRenderSelection', () => {
  it('splits rows back into the three shapes compilePrompts reads', () => {
    expect(buildRenderSelection(findMissingImageEntries(universe))).toEqual({
      selection: { landscapes: ['Salt Flats'] },
      canonSelection: { characters: ['Alice'], places: ['EXT. FOUNDRY — DAY'] },
      sheetSelection: ['Cast Sheet'],
    });
  });
});

describe('resolveRenderMode', () => {
  it('refuses to fall through to the install default for a family with no image backend', () => {
    // `claude` renders no images. Falling through would spend a DIFFERENT
    // provider's image quota while claude's window expires unused — and charge
    // claude's dispatch cap for it, the exact inversion the pin exists to stop.
    expect(resolveRenderMode({ family: { id: 'claude' }, params: {} }))
      .toMatchObject({ mode: null, reason: expect.stringContaining('renders no images') });
    expect(resolveRenderMode({ family: { id: 'codex' }, params: {} })).toEqual({ mode: 'codex' });
    // An explicit pin on the job always wins.
    expect(resolveRenderMode({ family: { id: 'claude' }, params: { mode: 'grok' } })).toEqual({ mode: 'grok' });
  });

  it('lets the render-target ladder decide when there is no burning family', () => {
    // An ordinary scheduled run has no window to protect, so an unset backend
    // must resolve to "let renderUniverseJobs pick" (mode undefined) rather than
    // to the family refusal — the two are opposite outcomes, which is why the
    // helper returns an object instead of a single falsy value.
    expect(resolveRenderMode({ params: {} })).toEqual({ mode: undefined });
    expect(resolveRenderMode({ params: { mode: 'codex' } })).toEqual({ mode: 'codex' });
  });
});

describe('countPending', () => {
  it('reports zero (with a fixable reason) when the family has no render backend', async () => {
    await expect(countPending({ params: {}, family: { id: 'claude' } }))
      .resolves.toMatchObject({ count: 0, detail: expect.stringContaining('renders no images') });
  });
});

describe('label deduping', () => {
  it('collapses entries that share a label case-insensitively', () => {
    // compilePrompts matches a selection entry against EVERY variation whose
    // label matches case-insensitively, and nothing dedupes labels on write —
    // so one selected row would enqueue two renders, one of them re-rendering
    // an entry that already has an image, and blow past maxEntries.
    const dupes = {
      id: 'u2',
      categories: { vehicles: { variations: [
        { id: 'a', label: 'Skiff', imageRefs: [] },
        { id: 'b', label: 'skiff', imageRefs: [] },
      ] } },
    };
    const { selection } = buildRenderSelection(findMissingImageEntries(dupes));
    expect(selection.vehicles).toHaveLength(2);
    // The job's own collect() dedupes before selecting — pinned via the export,
    // which takes a ROW (passing bare labels here would compare `undefined` to
    // `undefined` and pass no matter what the key did).
    const row = (label) => ({ kind: 'variation', categoryKey: 'vehicles', label });
    expect(inFlightKey('u2', row('Skiff'))).toBe(inFlightKey('u2', row('skiff')));
    expect(inFlightKey('u2', row('Skiff'))).not.toBe(inFlightKey('u2', row('Barge')));
  });
});

describe('probe → run context handoff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getQuotaBurnInFlight.mockResolvedValue(new Set());
    listUniverses.mockResolvedValue([universe]);
    renderUniverseJobs.mockResolvedValue({ runId: 'run-1', jobIds: ['j1'], promptCount: 2, mode: 'codex' });
  });

  it('reuses the probe\'s scan instead of walking every universe again', async () => {
    const probe = await countPending({ params: { maxEntries: 2 }, family: { id: 'codex' } });
    listUniverses.mockClear();

    const result = await run({ params: { maxEntries: 2 }, job: {}, family: { id: 'codex' }, context: probe.context });

    expect(result.dispatched).toBe(true);
    expect(listUniverses).not.toHaveBeenCalled();
  });

  it('still runs when there is no probe context — the manual/force path', async () => {
    const result = await run({ params: { maxEntries: 2 }, job: {}, family: { id: 'codex' }, context: undefined });
    expect(result.dispatched).toBe(true);
    expect(listUniverses).toHaveBeenCalled();
  });

  it('probes without writing, enqueueing, or calling a provider', async () => {
    await countPending({ params: {}, family: { id: 'codex' } });
    expect(renderUniverseJobs).not.toHaveBeenCalled();
    expect(recordQuotaBurnInFlight).not.toHaveBeenCalled();
  });

  it('leaves the render backend to the ladder on an ordinary scheduled run', async () => {
    await run({ params: { maxEntries: 2 }, job: {} });
    expect(renderUniverseJobs).toHaveBeenCalledWith('u1', expect.objectContaining({ mode: undefined }), expect.any(Function));
  });
});
