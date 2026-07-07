import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockNoPeerSync, mockNoPeers } from '../../lib/mockPathsDataRoot.js';

const fileStore = new Map();

vi.mock('../../lib/fileUtils.js', () => ({
tryReadFile: vi.fn().mockResolvedValue(null),
  PATHS: { data: '/mock/data' },
  ensureDir: vi.fn().mockResolvedValue(undefined),
  atomicWrite: vi.fn(async (path, data) => { fileStore.set(path, data); }),
  readJSONFile: vi.fn(async (path, fallback) => (fileStore.has(path) ? fileStore.get(path) : fallback)),
}));

let uuidCounter = 0;
vi.mock('crypto', async () => {
  const actual = await vi.importActual('crypto');
  return { ...actual, randomUUID: () => `uuid-${++uuidCounter}` };
});

vi.mock('../instances.js', () => mockNoPeers());
vi.mock('../sharing/peerSync.js', () => mockNoPeerSync());

const svc = await import('./series.js');
const { recordEvents, registerSubscriptionAdapter, __resetSubscriptionAdapter } = await import('../sharing/recordEvents.js');

describe('pipeline series service', () => {
  beforeEach(() => {
    fileStore.clear();
    uuidCounter = 0;
  });

  // A test that registers a subscription-adapter double must not leak it into
  // later tests even when its assertions fail mid-body.
  afterEach(() => {
    __resetSubscriptionAdapter();
  });

  it('listSeries returns [] for fresh state', async () => {
    expect(await svc.listSeries()).toEqual([]);
  });

  it('createSeries assigns ser- prefixed id and persists the basic fields', async () => {
    // Phase B.4: canon (characters/settings/objects) no longer lives on the
    // series — it lives on the linked universe. This test exercises only
    // the series-owned fields; canon round-tripping is covered by
    // universeBuilder.test.js + promoteToPipeline.test.js.
    const s = await svc.createSeries({
      name: 'Salt Run',
      logline: 'A foundry city goes silent.',
      premise: 'Long-form premise about a salt-mining city...',
      universeId: 'world-123',
      styleNotes: 'moebius linework, washed sepia',
      targetFormat: 'comic+tv',
      issueCountTarget: 6,
    });
    expect(s.id).toMatch(/^ser-/);
    expect(s.name).toBe('Salt Run');
    expect(s.logline).toBe('A foundry city goes silent.');
    expect(s.universeId).toBe('world-123');
    expect(s.targetFormat).toBe('comic+tv');
    expect(s.issueCountTarget).toBe(6);
    expect(s.characters).toBeUndefined();
    expect(s.settings).toBeUndefined();
    expect(s.objects).toBeUndefined();
  });

  it('createSeries stores an author byline + authorId FK; defaults authorId to null', async () => {
    const s = await svc.createSeries({ name: 'Salt Run', author: 'Jane Doe', authorId: 'auth-1' });
    expect(s.author).toBe('Jane Doe');
    expect(s.authorId).toBe('auth-1');
    const noAuthor = await svc.createSeries({ name: 'No Byline' });
    expect(noAuthor.author).toBe('');
    expect(noAuthor.authorId).toBeNull();
  });

  it('updateSeries can re-link or clear the authorId FK', async () => {
    const s = await svc.createSeries({ name: 'Salt Run', author: 'Jane Doe', authorId: 'auth-1' });
    const relinked = await svc.updateSeries(s.id, { author: 'John Roe', authorId: 'auth-2' });
    expect(relinked.authorId).toBe('auth-2');
    expect(relinked.author).toBe('John Roe');
    const cleared = await svc.updateSeries(s.id, { author: '', authorId: null });
    expect(cleared.authorId).toBeNull();
    expect(cleared.author).toBe('');
  });

  it('createSeries requires a non-empty name', async () => {
    await expect(svc.createSeries({})).rejects.toMatchObject({ code: svc.ERR_VALIDATION });
    await expect(svc.createSeries({ name: '   ' })).rejects.toMatchObject({ code: svc.ERR_VALIDATION });
  });

  it('updateSeries merges fields without clobbering omitted ones', async () => {
    const s = await svc.createSeries({ name: 'Salt Run', logline: 'L1', premise: 'P1', styleNotes: 'S1' });
    const updated = await svc.updateSeries(s.id, { logline: 'L2' });
    expect(updated.logline).toBe('L2');
    expect(updated.premise).toBe('P1');
    expect(updated.styleNotes).toBe('S1');
    // ISO strings have ms precision; >= rather than > avoids flake when create
    // and update land in the same ms tick.
    expect(updated.updatedAt >= s.updatedAt).toBe(true);
  });

  it('defaults fact-checking fields off (#1588) and round-trips an opt-in + reference', async () => {
    const off = await svc.createSeries({ name: 'Fantasy' });
    expect(off.factCritical).toBe(false);
    expect(off.factReference).toBe('');

    const on = await svc.createSeries({
      name: 'Grounded',
      factCritical: true,
      factReference: 'Paris is the capital of France.',
    });
    expect(on.factCritical).toBe(true);
    expect(on.factReference).toBe('Paris is the capital of France.');
  });

  it('updateSeries clears the fact reference with "" but preserves it on omission (#1588)', async () => {
    const s = await svc.createSeries({ name: 'Grounded', factCritical: true, factReference: 'Real facts.' });
    // Omitting the field preserves both.
    const kept = await svc.updateSeries(s.id, { logline: 'L2' });
    expect(kept.factCritical).toBe(true);
    expect(kept.factReference).toBe('Real facts.');
    // Explicit "" clears the reference; toggling factCritical off sticks.
    const cleared = await svc.updateSeries(s.id, { factCritical: false, factReference: '' });
    expect(cleared.factCritical).toBe(false);
    expect(cleared.factReference).toBe('');
  });

  it('defaults editorialCheckConfig to {} and round-trips per-series overrides (#1591)', async () => {
    const plain = await svc.createSeries({ name: 'Plain' });
    // Always present (empty) — like factReference/styleGuide — so a clear can
    // propagate between v8 peers and is protected as an additive field on sync.
    expect(plain.editorialCheckConfig).toEqual({});

    const tuned = await svc.createSeries({
      name: 'YA Graphic Novel',
      editorialCheckConfig: { 'comic.lettering-density': { maxWordsPerBalloon: 18, x: true } },
    });
    expect(tuned.editorialCheckConfig).toEqual({ 'comic.lettering-density': { maxWordsPerBalloon: 18, x: true } });
  });

  it('defaults exportSettings to null and per-field-merges partial PATCHes (#2181)', async () => {
    const plain = await svc.createSeries({ name: 'Prose Book' });
    // Absent / all-default → null (no empty husk), like styleGuide.
    expect(plain.exportSettings).toBeNull();

    // Set two fields.
    const set = await svc.updateSeries(plain.id, { exportSettings: { trimSize: 'digest', interiorFont: 'courier' } });
    expect(set.exportSettings).toMatchObject({ trimSize: 'digest', interiorFont: 'courier' });

    // Partial PATCH of ONE field must NOT erase the other (per-field merge).
    const tuned = await svc.updateSeries(plain.id, { exportSettings: { titlePageTitle: 'My Title' } });
    expect(tuned.exportSettings.trimSize).toBe('digest');
    expect(tuned.exportSettings.interiorFont).toBe('courier');
    expect(tuned.exportSettings.titlePageTitle).toBe('My Title');

    // Explicit null clears the whole sub-object (defaults apply).
    const cleared = await svc.updateSeries(plain.id, { exportSettings: null });
    expect(cleared.exportSettings).toBeNull();
  });

  it('sanitizes editorialCheckConfig: drops empty/non-object overrides and non-primitive leaves (#1591)', async () => {
    const s = await svc.createSeries({
      name: 'Messy',
      editorialCheckConfig: {
        'comic.lettering-density': { maxWordsPerBalloon: 30, bad: null, nested: { a: 1 }, arr: [1] },
        'empty.check': {},          // empty override → dropped
        'bogus.check': 'not-an-object', // non-object override → dropped
      },
    });
    expect(s.editorialCheckConfig).toEqual({ 'comic.lettering-density': { maxWordsPerBalloon: 30 } });
  });

  it('updateSeries replaces overrides wholesale and clears them with {}/null (#1591)', async () => {
    const s = await svc.createSeries({
      name: 'Tunable',
      editorialCheckConfig: { 'comic.lettering-density': { maxWordsPerBalloon: 10 } },
    });
    // Omission preserves.
    const kept = await svc.updateSeries(s.id, { logline: 'L2' });
    expect(kept.editorialCheckConfig).toEqual({ 'comic.lettering-density': { maxWordsPerBalloon: 10 } });
    // Wholesale replace.
    const replaced = await svc.updateSeries(s.id, { editorialCheckConfig: { 'comic.panel-rhythm': { maxConsecutiveSplash: 1 } } });
    expect(replaced.editorialCheckConfig).toEqual({ 'comic.panel-rhythm': { maxConsecutiveSplash: 1 } });
    // {} clears all overrides (sanitizer keeps the always-present empty map).
    const cleared = await svc.updateSeries(s.id, { editorialCheckConfig: {} });
    expect(cleared.editorialCheckConfig).toEqual({});
  });

  it('defaults severityWeights/blockingSeverities to {} and round-trips overrides (#1616)', async () => {
    const plain = await svc.createSeries({ name: 'PlainSev' });
    expect(plain.severityWeights).toEqual({});
    expect(plain.blockingSeverities).toEqual({});

    const tuned = await svc.createSeries({
      name: 'TunedSev',
      severityWeights: { high: 20, low: 2 },
      blockingSeverities: { arc: ['high'], editorial: [] },
    });
    expect(tuned.severityWeights).toEqual({ high: 20, low: 2 });
    // Explicit empty array preserved (= nothing blocks the editorial gate).
    expect(tuned.blockingSeverities).toEqual({ arc: ['high'], editorial: [] });
  });

  it('sanitizes severityWeights/blockingSeverities: drops junk, keeps valid (#1616)', async () => {
    const s = await svc.createSeries({
      name: 'MessySev',
      severityWeights: { high: 20, medium: -1, low: '2', bogus: 9 },
      blockingSeverities: { arc: ['high', 'nope', 'high'], beatContinuity: 'high', bogusGate: ['high'] },
    });
    expect(s.severityWeights).toEqual({ high: 20 });
    expect(s.blockingSeverities).toEqual({ arc: ['high'] });
  });

  it('updateSeries replaces severity overrides wholesale and clears with {} (#1616)', async () => {
    const s = await svc.createSeries({
      name: 'TunableSev',
      severityWeights: { high: 20 },
      blockingSeverities: { arc: ['high'] },
    });
    // Omission preserves.
    const kept = await svc.updateSeries(s.id, { logline: 'L2' });
    expect(kept.severityWeights).toEqual({ high: 20 });
    expect(kept.blockingSeverities).toEqual({ arc: ['high'] });
    // Wholesale replace + clear.
    const replaced = await svc.updateSeries(s.id, { severityWeights: { low: 3 }, blockingSeverities: {} });
    expect(replaced.severityWeights).toEqual({ low: 3 });
    expect(replaced.blockingSeverities).toEqual({});
  });

  it('updateSeries throws ERR_NOT_FOUND for unknown id', async () => {
    await expect(svc.updateSeries('ser-nope', { name: 'x' })).rejects.toMatchObject({ code: svc.ERR_NOT_FOUND });
  });

  it('updateSeries rejects clearing universeId once a series is linked (hierarchy invariant)', async () => {
    const s = await svc.createSeries({ name: 'Linked', universeId: 'u-1' });
    await expect(svc.updateSeries(s.id, { universeId: '' })).rejects.toMatchObject({ code: svc.ERR_VALIDATION });
    await expect(svc.updateSeries(s.id, { universeId: null })).rejects.toMatchObject({ code: svc.ERR_VALIDATION });
    await expect(svc.updateSeries(s.id, { universeId: '   ' })).rejects.toMatchObject({ code: svc.ERR_VALIDATION });
    // Link survived the rejected clears.
    expect((await svc.getSeries(s.id)).universeId).toBe('u-1');
  });

  it('updateSeries allows MOVING a linked series to a different universe', async () => {
    const s = await svc.createSeries({ name: 'Mover', universeId: 'u-1' });
    const moved = await svc.updateSeries(s.id, { universeId: 'u-2' });
    expect(moved.universeId).toBe('u-2');
  });

  it('mergeSeriesFromSync preserves the local universe link when an older peer pushes an orphan payload', async () => {
    const s = await svc.createSeries({ name: 'Linked', universeId: 'uni-A' });
    // Older peer pushes a NEWER series record that lost its universe link.
    const orphanPayload = { ...s, universeId: null, name: 'Linked (peer edit)', updatedAt: '2999-01-01T00:00:00.000Z' };
    const res = await svc.mergeSeriesFromSync([orphanPayload]);
    expect(res.applied).toBe(true);
    const after = await svc.getSeries(s.id);
    expect(after.name).toBe('Linked (peer edit)'); // remote edit applied
    expect(after.universeId).toBe('uni-A');         // …but the link was preserved
  });

  it('mergeSeriesFromSync still applies a MOVE to a different non-empty universe', async () => {
    const s = await svc.createSeries({ name: 'Mover', universeId: 'uni-A' });
    const movePayload = { ...s, universeId: 'uni-B', updatedAt: '2999-01-01T00:00:00.000Z' };
    await svc.mergeSeriesFromSync([movePayload]);
    expect((await svc.getSeries(s.id)).universeId).toBe('uni-B');
  });

  it('updateSeries allows first-linking a legacy orphan (universeId null → set)', async () => {
    // createSeries via the service is permissive (importer path); simulate a
    // legacy orphan, then assign its first universe.
    const s = await svc.createSeries({ name: 'Orphan', universeId: null });
    expect(s.universeId).toBe(null);
    const linked = await svc.updateSeries(s.id, { universeId: 'u-3' });
    expect(linked.universeId).toBe('u-3');
  });

  it('deleteSeries drops the record and is idempotent only on second call', async () => {
    const s = await svc.createSeries({ name: 'Salt Run' });
    await svc.deleteSeries(s.id);
    await expect(svc.deleteSeries(s.id)).rejects.toMatchObject({ code: svc.ERR_NOT_FOUND });
    expect(await svc.listSeries()).toEqual([]);
  });

  describe('soft-delete (tombstones for peer sync)', () => {
    it('deleteSeries soft-deletes (record stays on disk with deleted=true)', async () => {
      const s = await svc.createSeries({ name: 'Salt Run' });
      await svc.deleteSeries(s.id);
      expect(await svc.listSeries()).toEqual([]);
      const all = await svc.listSeries({ includeDeleted: true });
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ id: s.id, deleted: true });
      expect(all[0].deletedAt).toBeTruthy();
      expect(all[0].updatedAt).toBe(all[0].deletedAt);
    });

    it('getSeries 404s for tombstoned; includeDeleted exposes it', async () => {
      const s = await svc.createSeries({ name: 'Hidden' });
      await svc.deleteSeries(s.id);
      await expect(svc.getSeries(s.id)).rejects.toMatchObject({ code: svc.ERR_NOT_FOUND });
      const tomb = await svc.getSeries(s.id, { includeDeleted: true });
      expect(tomb).toMatchObject({ id: s.id, deleted: true });
    });

    it('updateSeries 404s on a tombstone (no zombie edits)', async () => {
      const s = await svc.createSeries({ name: 'Locked' });
      await svc.deleteSeries(s.id);
      await expect(svc.updateSeries(s.id, { name: 'Zombie' })).rejects.toMatchObject({
        code: svc.ERR_NOT_FOUND,
      });
    });

    it('insertSeriesWithId overwrites a tombstoned record (re-import undeletes)', async () => {
      const id = 'ser-550e8400-e29b-41d4-a716-44665544abcd';
      await svc.insertSeriesWithId({ id, name: 'First' });
      await svc.deleteSeries(id);
      const restored = await svc.insertSeriesWithId({ id, name: 'Restored' });
      expect(restored).toMatchObject({ id, name: 'Restored', deleted: false });
      expect((await svc.listSeries()).map((s) => s.id)).toContain(id);
    });

    it('insertSeriesWithId resurrection fires emitRecordUpdated + autoSubscribeRecordToAllPeers', async () => {
      const id = 'ser-550e8400-e29b-41d4-a716-44665544abcf';
      await svc.insertSeriesWithId({ id, name: 'ToResurrect' });
      await svc.deleteSeries(id);

      const emitSpy = vi.spyOn(recordEvents, 'emit');
      // The auto-subscribe flows through the recordEvents subscription
      // adapter (peerSync registers the real impl at boot) — register a
      // test double to observe the call.
      const subscribeSpy = vi.fn().mockResolvedValue([]);
      registerSubscriptionAdapter({ autoSubscribeRecordToAllPeers: subscribeSpy });

      await svc.insertSeriesWithId({ id, name: 'Resurrected' });
      // Allow the fire-and-forget adapter call to settle.
      await new Promise((r) => setTimeout(r, 0));

      expect(emitSpy).toHaveBeenCalledWith('updated', { recordKind: 'series', recordId: id });
      expect(subscribeSpy).toHaveBeenCalledWith('series', id);

      emitSpy.mockRestore();
    });

    it('insertSeriesWithId fresh insert does NOT fire emitRecordUpdated', async () => {
      const id = 'ser-550e8400-e29b-41d4-a716-44665544abd0';
      const emitSpy = vi.spyOn(recordEvents, 'emit');

      await svc.insertSeriesWithId({ id, name: 'Fresh' });

      expect(emitSpy).not.toHaveBeenCalledWith('updated', { recordKind: 'series', recordId: id });
      emitSpy.mockRestore();
    });

    it('insertSeriesWithId still rejects DUPLICATE on a LIVE record', async () => {
      const id = 'ser-550e8400-e29b-41d4-a716-44665544abce';
      await svc.insertSeriesWithId({ id, name: 'First' });
      await expect(svc.insertSeriesWithId({ id, name: 'Second' }))
        .rejects.toMatchObject({ code: svc.ERR_DUPLICATE });
    });

    describe('mergeSeriesFromSync', () => {
      it('applies an inbound soft-delete from a peer', async () => {
        const s = await svc.createSeries({ name: 'Synced' });
        const ts = new Date(Date.now() + 60_000).toISOString();
        const r = await svc.mergeSeriesFromSync([{
          ...s,
          deleted: true,
          deletedAt: ts,
          updatedAt: ts,
        }]);
        expect(r).toEqual({ applied: true, count: 1 });
        await expect(svc.getSeries(s.id)).rejects.toMatchObject({ code: svc.ERR_NOT_FOUND });
      });

      it('LWW: an inbound edit with later updatedAt wins over a local tombstone', async () => {
        const s = await svc.createSeries({ name: 'Original' });
        await svc.deleteSeries(s.id);
        const editTs = new Date(Date.now() + 60_000).toISOString();
        const r = await svc.mergeSeriesFromSync([{
          ...s,
          name: 'Edited After Delete',
          deleted: false,
          deletedAt: null,
          updatedAt: editTs,
        }]);
        expect(r.applied).toBe(true);
        const live = await svc.getSeries(s.id);
        expect(live).toMatchObject({ name: 'Edited After Delete', deleted: false });
      });

      it('LWW: an inbound tombstone with later updatedAt wins over a local edit', async () => {
        const s = await svc.createSeries({ name: 'Edited Locally' });
        const ts = new Date(Date.now() + 60_000).toISOString();
        await svc.mergeSeriesFromSync([{
          ...s,
          deleted: true,
          deletedAt: ts,
          updatedAt: ts,
        }]);
        await expect(svc.getSeries(s.id)).rejects.toMatchObject({ code: svc.ERR_NOT_FOUND });
      });
    });

    describe('pruneTombstonedSeries', () => {
      it('removes tombstones older than the cutoff and leaves newer ones + live records', async () => {
        const live = await svc.createSeries({ name: 'Live' });
        const oldT = await svc.createSeries({ name: 'Old tombstone' });
        const newT = await svc.createSeries({ name: 'New tombstone' });
        await svc.deleteSeries(oldT.id);
        await svc.deleteSeries(newT.id);
        // Back-date the old tombstone via merge so the GC sees it as 100s ago.
        const oldDeletedAt = new Date(Date.now() - 100_000).toISOString();
        const oldSeries = await svc.getSeries(oldT.id, { includeDeleted: true });
        await svc.mergeSeriesFromSync([{
          ...oldSeries,
          deletedAt: oldDeletedAt,
          updatedAt: new Date(Date.now() + 10_000).toISOString(),
        }]);
        const cutoff = Date.now() - 50_000;
        const result = await svc.pruneTombstonedSeries(cutoff);
        expect(result.pruned).toBe(1);
        const remaining = await svc.listSeries({ includeDeleted: true });
        const ids = remaining.map((s) => s.id);
        expect(ids).toContain(live.id);
        expect(ids).toContain(newT.id);
        expect(ids).not.toContain(oldT.id);
      });

      it('keeps tombstones with unparseable deletedAt (conservative — never silently delete)', async () => {
        const s = await svc.createSeries({ name: 'Corrupt' });
        await svc.deleteSeries(s.id);
        const tomb = await svc.getSeries(s.id, { includeDeleted: true });
        await svc.mergeSeriesFromSync([{
          ...tomb,
          deletedAt: 'not-a-date',
          updatedAt: new Date(Date.now() + 10_000).toISOString(),
        }]);
        const result = await svc.pruneTombstonedSeries(Date.now() + 60_000_000);
        expect(result.pruned).toBe(0);
      });

      it('returns { pruned: 0 } for a non-finite cutoff (defensive)', async () => {
        expect(await svc.pruneTombstonedSeries(NaN)).toEqual({ pruned: 0 });
        expect(await svc.pruneTombstonedSeries(Infinity)).toEqual({ pruned: 0 });
        expect(await svc.pruneTombstonedSeries('nope')).toEqual({ pruned: 0 });
      });
    });
  });

  it('listSeries sorts newest updated first', async () => {
    const a = await svc.createSeries({ name: 'A' });
    await new Promise((r) => setTimeout(r, 5));
    const b = await svc.createSeries({ name: 'B' });
    const list = await svc.listSeries();
    expect(list.map((s) => s.id)).toEqual([b.id, a.id]);
  });

  it('targetFormat falls back to comic+tv when invalid', async () => {
    const s = await svc.createSeries({ name: 'X', targetFormat: 'nonsense' });
    expect(s.targetFormat).toBe('comic+tv');
  });

  describe('stylePromptOverrideMode', () => {
    it('defaults to "prepend" when not supplied', async () => {
      const s = await svc.createSeries({ name: 'X' });
      expect(s.stylePromptOverrideMode).toBe('prepend');
    });

    it('accepts "append" and "override" on create', async () => {
      const a = await svc.createSeries({ name: 'A', stylePromptOverrideMode: 'append' });
      const b = await svc.createSeries({ name: 'B', stylePromptOverrideMode: 'override' });
      expect(a.stylePromptOverrideMode).toBe('append');
      expect(b.stylePromptOverrideMode).toBe('override');
    });

    it('coerces an unknown value back to "prepend"', async () => {
      const s = await svc.createSeries({ name: 'X', stylePromptOverrideMode: 'nonsense' });
      expect(s.stylePromptOverrideMode).toBe('prepend');
    });

    it('round-trips through updateSeries', async () => {
      const s = await svc.createSeries({ name: 'X' });
      const u = await svc.updateSeries(s.id, { stylePromptOverrideMode: 'override' });
      expect(u.stylePromptOverrideMode).toBe('override');
    });
  });

  it('silently drops legacy canon fields on create (Phase B.4: canon moved to universe)', async () => {
    // A stale client that still sends `characters: [...]` on series create
    // gets a 200 — the field is dropped server-side instead of 400'ing —
    // so old browser tabs don't fail on a save. The actual canon round-
    // trips through the linked universe now.
    const s = await svc.createSeries({
      name: 'X',
      characters: [{ name: 'ignored' }],
      settings: [{ name: 'ignored' }],
      objects: [{ name: 'ignored' }],
    });
    expect(s.characters).toBeUndefined();
    expect(s.settings).toBeUndefined();
    expect(s.objects).toBeUndefined();
  });

  describe('titleLogo + author fields', () => {
    it('createSeries persists titleLogo + author when provided', async () => {
      const s = await svc.createSeries({
        name: 'Salt Run',
        titleLogo: 'Hand-lettered slab serif in salt-crusted iron, with a single hairline crack through the O.',
        author: 'A. Foundryworker',
      });
      expect(s.titleLogo).toContain('Hand-lettered slab serif');
      expect(s.author).toBe('A. Foundryworker');
    });

    it('createSeries defaults titleLogo + author to empty strings', async () => {
      const s = await svc.createSeries({ name: 'X' });
      expect(s.titleLogo).toBe('');
      expect(s.author).toBe('');
    });

    it('updateSeries replaces titleLogo + author independently', async () => {
      const s = await svc.createSeries({ name: 'X', titleLogo: 'first', author: 'first' });
      const updated = await svc.updateSeries(s.id, { titleLogo: 'second' });
      expect(updated.titleLogo).toBe('second');
      expect(updated.author).toBe('first'); // omitted keys preserve
    });

    it('updateSeries can clear titleLogo + author to empty', async () => {
      const s = await svc.createSeries({ name: 'X', titleLogo: 'present', author: 'present' });
      const cleared = await svc.updateSeries(s.id, { titleLogo: '', author: '' });
      expect(cleared.titleLogo).toBe('');
      expect(cleared.author).toBe('');
    });
  });

  describe('insertSeriesWithId', () => {
    it('preserves the caller-supplied id', async () => {
      const s = await svc.insertSeriesWithId({ id: 'ser-fixed-abc', name: 'Imported' });
      expect(s.id).toBe('ser-fixed-abc');
      expect(s.name).toBe('Imported');
    });

    it('preserves createdAt/updatedAt when provided', async () => {
      const ts = '2026-01-01T00:00:00.000Z';
      const s = await svc.insertSeriesWithId({ id: 'ser-stamped', name: 'X', createdAt: ts, updatedAt: ts });
      expect(s.createdAt).toBe(ts);
      expect(s.updatedAt).toBe(ts);
    });

    it('rejects malformed id', async () => {
      await expect(svc.insertSeriesWithId({ id: 'not-a-series-id', name: 'X' }))
        .rejects.toMatchObject({ code: svc.ERR_VALIDATION });
      await expect(svc.insertSeriesWithId({ name: 'X' }))
        .rejects.toMatchObject({ code: svc.ERR_VALIDATION });
    });

    it('rejects duplicate id', async () => {
      await svc.insertSeriesWithId({ id: 'ser-dup', name: 'First' });
      await expect(svc.insertSeriesWithId({ id: 'ser-dup', name: 'Second' }))
        .rejects.toMatchObject({ code: svc.ERR_DUPLICATE });
    });

    it('requires a name', async () => {
      await expect(svc.insertSeriesWithId({ id: 'ser-noname' }))
        .rejects.toMatchObject({ code: svc.ERR_VALIDATION });
    });
  });

  describe('locked field (stage approval)', () => {
    it('defaults to empty object on a fresh series', async () => {
      const s = await svc.createSeries({ name: 'X' });
      expect(s.locked).toEqual({});
    });

    it('persists locked.arc=true through round-trip', async () => {
      const s = await svc.createSeries({ name: 'X' });
      const updated = await svc.updateSeries(s.id, { locked: { arc: true } });
      expect(updated.locked).toEqual({ arc: true });
      // Survives a re-read (sanitizer + atomic write).
      const fresh = await svc.getSeries(s.id);
      expect(fresh.locked).toEqual({ arc: true });
    });

    it('toggling locked.arc back off clears the key', async () => {
      const s = await svc.createSeries({ name: 'X' });
      await svc.updateSeries(s.id, { locked: { arc: true } });
      const cleared = await svc.updateSeries(s.id, { locked: { arc: false } });
      // Only `true` is recorded — false collapses to absent so the on-disk
      // shape stays minimal (matches universeBuilder.sanitizeLocked).
      expect(cleared.locked).toEqual({});
    });

    it('ignores unknown lock keys', async () => {
      const s = await svc.createSeries({
        name: 'X',
        locked: { arc: true, bogus: true, premise: true },
      });
      expect(s.locked).toEqual({ arc: true });
    });

    it('omitting locked from patch preserves existing locks', async () => {
      const s = await svc.createSeries({ name: 'X', locked: { arc: true } });
      const updated = await svc.updateSeries(s.id, { logline: 'new logline' });
      expect(updated.locked).toEqual({ arc: true });
      expect(updated.logline).toBe('new logline');
    });

    it('setArcFieldLock merges against latest arcFields without clobbering siblings', async () => {
      const s = await svc.createSeries({ name: 'X', locked: { arcFields: { logline: true } } });
      const updated = await svc.setArcFieldLock(s.id, 'themes', true);
      expect(updated.locked.arcFields).toEqual({ logline: true, themes: true });
      const cleared = await svc.setArcFieldLock(s.id, 'logline', false);
      expect(cleared.locked.arcFields).toEqual({ themes: true });
    });

    it('setArcFieldLock rejects unknown arc fields', async () => {
      const s = await svc.createSeries({ name: 'X' });
      await expect(svc.setArcFieldLock(s.id, 'bogus', true))
        .rejects.toMatchObject({ code: svc.ERR_VALIDATION });
    });

    it('setArcFieldLock accepts readerMap as a lockable arc field', async () => {
      const s = await svc.createSeries({ name: 'X' });
      const locked = await svc.setArcFieldLock(s.id, 'readerMap', true);
      expect(locked.locked.arcFields).toEqual({ readerMap: true });
      const cleared = await svc.setArcFieldLock(s.id, 'readerMap', false);
      expect(cleared.locked.arcFields).toBeUndefined();
    });
  });

  describe('arc.readerMap', () => {
    it('persists a reader map through an arc-replace update and re-read', async () => {
      const s = await svc.createSeries({ name: 'X', arc: { logline: 'spine' } });
      const updated = await svc.updateSeries(s.id, {
        arc: { logline: 'spine', readerMap: { hooks: [{ label: 'who?' }], beats: [{ kind: 'reveal', intensity: 0.6 }] } },
      });
      expect(updated.arc.readerMap.hooks).toHaveLength(1);
      expect(updated.arc.readerMap.beats[0].kind).toBe('reveal');
      const fresh = await svc.getSeries(s.id);
      expect(fresh.arc.readerMap.hooks[0].label).toBe('who?');
    });

    it('arc is null and readerMap absent on a fresh series with no arc', async () => {
      const s = await svc.createSeries({ name: 'X' });
      expect(s.arc).toBe(null);
    });
  });

  describe('characterArcs (#1293)', () => {
    it('defaults to [] on a fresh series', async () => {
      const s = await svc.createSeries({ name: 'X' });
      expect(s.characterArcs).toEqual([]);
    });

    it('persists per-character arcs + transitions through an update and re-read', async () => {
      const s = await svc.createSeries({ name: 'X' });
      const updated = await svc.updateSeries(s.id, {
        characterArcs: [
          {
            characterName: 'Mara',
            want: 'revenge',
            need: 'to forgive',
            transitions: [{ kind: 'point-of-no-return', label: 'burns the bridge', atIssue: 4 }],
          },
        ],
      });
      expect(updated.characterArcs).toHaveLength(1);
      expect(updated.characterArcs[0]).toMatchObject({ characterName: 'Mara', want: 'revenge' });
      expect(updated.characterArcs[0].transitions[0]).toMatchObject({ kind: 'point-of-no-return', atIssue: 4 });
      const fresh = await svc.getSeries(s.id);
      expect(fresh.characterArcs[0].transitions[0].label).toBe('burns the bridge');
    });

    it('drops empty arcs and clears with an empty array', async () => {
      const s = await svc.createSeries({
        name: 'X',
        characterArcs: [{ characterName: 'A', want: 'w' }, { characterName: 'Ghost' }],
      });
      expect(s.characterArcs).toHaveLength(1);
      const cleared = await svc.updateSeries(s.id, { characterArcs: [] });
      expect(cleared.characterArcs).toEqual([]);
    });
  });

  // Issue #1361 — a behind/legacy peer pushes a newer series payload that simply
  // OMITS an additive content field. sanitizeSeries flattens that absence to the
  // same null/[]/'' as a deliberate clear, so without the absent-vs-clear guard
  // LWW would erase the locally-authored value. An explicit null/empty from an
  // up-to-date peer must still apply as an intentional clear.
  describe('mergeSeriesFromSync — additive-field preservation (behind-sender)', () => {
    const NEWER = '2999-01-01T00:00:00.000Z';

    it('preserves styleNotes/styleGuide/seasons when the remote omits the keys', async () => {
      const s = await svc.createSeries({
        name: 'Additive',
        styleNotes: 'moebius linework',
        styleGuide: { tense: 'past', povPerson: 'first' },
        seasons: [{ number: 1, title: 'Season One' }],
      });
      expect(s.styleGuide).not.toBeNull();
      expect(s.seasons).toHaveLength(1);
      // Behind-sender payload — newer updatedAt, but no styleNotes/styleGuide/
      // seasons keys at all.
      const behind = { id: s.id, name: 'Additive (peer edit)', updatedAt: NEWER };
      const res = await svc.mergeSeriesFromSync([behind]);
      expect(res.applied).toBe(true);
      const after = await svc.getSeries(s.id);
      expect(after.name).toBe('Additive (peer edit)'); // remote edit applied
      expect(after.styleNotes).toBe('moebius linework'); // …additive fields kept
      expect(after.styleGuide.tense).toBe('past');
      expect(after.seasons).toHaveLength(1);
      expect(after.seasons[0].title).toBe('Season One');
    });

    it('preserves editorialCheckConfig when a behind-sender omits the key, applies an explicit clear (#1591)', async () => {
      const s = await svc.createSeries({
        name: 'TunedSeries',
        editorialCheckConfig: { 'comic.lettering-density': { maxWordsPerBalloon: 18 } },
      });
      expect(s.editorialCheckConfig).toEqual({ 'comic.lettering-density': { maxWordsPerBalloon: 18 } });
      // Behind-sender (older peer) omits the key → local overrides preserved.
      const behind = { id: s.id, name: 'TunedSeries (peer edit)', updatedAt: NEWER };
      await svc.mergeSeriesFromSync([behind]);
      const kept = await svc.getSeries(s.id);
      expect(kept.name).toBe('TunedSeries (peer edit)');
      expect(kept.editorialCheckConfig).toEqual({ 'comic.lettering-density': { maxWordsPerBalloon: 18 } });
      // Up-to-date peer present-but-empty map → the clear applies (present key wins).
      const clear = { id: s.id, name: 'TunedSeries', editorialCheckConfig: {}, updatedAt: '2999-06-01T00:00:00.000Z' };
      await svc.mergeSeriesFromSync([clear]);
      const cleared = await svc.getSeries(s.id);
      expect(cleared.editorialCheckConfig).toEqual({});
    });

    it('preserves severityWeights/blockingSeverities when a behind-sender omits them, applies an explicit clear (#1616)', async () => {
      const s = await svc.createSeries({
        name: 'SevKeep',
        severityWeights: { high: 20 },
        blockingSeverities: { arc: ['high'] },
      });
      // Behind-sender (older peer) omits both keys → local overrides preserved.
      const behind = { id: s.id, name: 'SevKeep (peer edit)', updatedAt: NEWER };
      await svc.mergeSeriesFromSync([behind]);
      const kept = await svc.getSeries(s.id);
      expect(kept.name).toBe('SevKeep (peer edit)');
      expect(kept.severityWeights).toEqual({ high: 20 });
      expect(kept.blockingSeverities).toEqual({ arc: ['high'] });
      // Up-to-date peer present-but-empty maps → the clear applies (present key wins).
      const clear = { id: s.id, name: 'SevKeep', severityWeights: {}, blockingSeverities: {}, updatedAt: '2999-06-01T00:00:00.000Z' };
      await svc.mergeSeriesFromSync([clear]);
      const cleared = await svc.getSeries(s.id);
      expect(cleared.severityWeights).toEqual({});
      expect(cleared.blockingSeverities).toEqual({});
    });

    it('preserves arc (incl. readerMap + tickingClock) when the remote omits arc', async () => {
      const s = await svc.createSeries({
        name: 'ArcKeep',
        arc: {
          logline: 'spine',
          readerMap: { hooks: [{ label: 'who?' }] },
          tickingClock: { enabled: true, label: 'the eclipse' },
        },
      });
      expect(s.arc.readerMap.hooks).toHaveLength(1);
      expect(s.arc.tickingClock.enabled).toBe(true);
      const behind = { id: s.id, name: 'ArcKeep (peer edit)', updatedAt: NEWER };
      await svc.mergeSeriesFromSync([behind]);
      const after = await svc.getSeries(s.id);
      expect(after.arc).not.toBeNull();
      expect(after.arc.logline).toBe('spine');
      expect(after.arc.readerMap.hooks[0].label).toBe('who?');
      expect(after.arc.tickingClock.label).toBe('the eclipse');
    });

    it('preserves nested readerMap/tickingClock when the remote sends arc but omits those sub-keys (legacy peer)', async () => {
      const s = await svc.createSeries({
        name: 'NestedKeep',
        arc: {
          logline: 'old spine',
          readerMap: { hooks: [{ label: 'mystery' }] },
          tickingClock: { enabled: true, label: 'countdown' },
        },
      });
      // Legacy peer predates readerMap/tickingClock: it still authors `arc`, just
      // without those sub-fields. The new arc.logline applies; the sub-fields are
      // preserved.
      const behind = { id: s.id, name: 'NestedKeep', arc: { logline: 'new spine' }, updatedAt: NEWER };
      await svc.mergeSeriesFromSync([behind]);
      const after = await svc.getSeries(s.id);
      expect(after.arc.logline).toBe('new spine'); // remote arc edit applied
      expect(after.arc.readerMap.hooks[0].label).toBe('mystery'); // sub-fields kept
      expect(after.arc.tickingClock.label).toBe('countdown');
    });

    it('applies an explicit null/empty clear from an up-to-date peer (present key wins)', async () => {
      const s = await svc.createSeries({
        name: 'ClearMe',
        styleNotes: 'to be cleared',
        styleGuide: { tense: 'past' },
        arc: { logline: 'spine', readerMap: { hooks: [{ label: 'keep?' }] } },
      });
      // Up-to-date peer intentionally clears: keys present, values empty/null.
      const clear = {
        id: s.id,
        name: 'ClearMe',
        styleNotes: '',
        styleGuide: null,
        arc: { logline: 'spine', readerMap: null },
        updatedAt: NEWER,
      };
      await svc.mergeSeriesFromSync([clear]);
      const after = await svc.getSeries(s.id);
      expect(after.styleNotes).toBe('');     // intentional clear honored
      expect(after.styleGuide).toBeNull();
      expect(after.arc.readerMap).toBeNull(); // nested intentional clear honored
      expect(after.arc.logline).toBe('spine');
    });

    it('does not resurrect content onto an inbound tombstone', async () => {
      const s = await svc.createSeries({ name: 'Doomed', styleNotes: 'doomed notes' });
      const tombstone = { id: s.id, name: 'Doomed', deleted: true, deletedAt: NEWER, updatedAt: NEWER };
      await svc.mergeSeriesFromSync([tombstone]);
      const after = await svc.getSeries(s.id, { includeDeleted: true });
      expect(after.deleted).toBe(true);
      expect(after.styleNotes).toBe(''); // tombstone stays clean, no resurrection
    });
  });

  describe('sanitizeAutopilot healthBreakdown (#1579)', () => {
    it('persists a well-formed pause breakdown, bounding rows and coercing counts', () => {
      const a = svc.sanitizeAutopilot({
        status: 'paused',
        healthBreakdown: {
          score: 72,
          open: 6,
          topChecks: [
            { checkId: 'continuity', count: 3 },
            { checkId: 'naming', count: 1.0 },
            { checkId: 42, count: 1 }, // non-string checkId → dropped
          ],
          topIssues: [
            { issueNumber: 3, open: 5 },
            { issueNumber: null, open: 2 }, // series-scoped bucket kept
            { open: 'x' }, // non-finite open → dropped
          ],
        },
      });
      expect(a.healthBreakdown).toEqual({
        score: 72,
        open: 6,
        topChecks: [{ checkId: 'continuity', count: 3 }, { checkId: 'naming', count: 1 }],
        topIssues: [{ issueNumber: 3, open: 5 }, { issueNumber: null, open: 2 }],
      });
    });

    it('drops a malformed/absent breakdown to null (non-health pauses carry none)', () => {
      expect(svc.sanitizeAutopilot({ status: 'paused' }).healthBreakdown).toBeNull();
      expect(svc.sanitizeAutopilot({ status: 'paused', healthBreakdown: 'nope' }).healthBreakdown).toBeNull();
      expect(svc.sanitizeAutopilot({ status: 'paused', healthBreakdown: [] }).healthBreakdown).toBeNull();
    });
  });
});
