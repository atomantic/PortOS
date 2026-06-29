import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the DB layer so the hook's attach/decision logic is exercised without a
// live Postgres. `listMediaForIngredient` is reprogrammed per-test to stand in
// for the ingredient's current media rows.
const attachMedia = vi.fn(async () => ({}));
const setPortraitMedia = vi.fn(async () => ({}));
const listMediaForIngredient = vi.fn(async () => []);
// Defaults to "ingredient exists" — the 'gone'-path test overrides per-call.
const getIngredient = vi.fn(async () => ({ id: 'ing', deleted: false }));
vi.mock('./catalogDB.js', () => ({ attachMedia, setPortraitMedia, listMediaForIngredient, getIngredient }));

const { mediaJobEvents } = await import('./mediaJobQueue/index.js');
const hook = await import('./catalogImageAttachHook.js');

async function waitFor(predicate, { timeoutMs = 1000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor: predicate never became true');
}

const completedImageJob = (params, filename = 'job-abc.png') => ({
  kind: 'image',
  params,
  result: { filename },
});

describe('catalogImageAttachHook', () => {
  beforeEach(() => {
    hook.__testing.reset();
    hook.initCatalogImageAttachHook();
    // mockReset (not mockClear) so a per-test mockImplementation — e.g. the
    // stateful store in the serialization test — can't leak into later tests.
    attachMedia.mockReset();
    attachMedia.mockResolvedValue({});
    setPortraitMedia.mockReset();
    setPortraitMedia.mockResolvedValue({});
    listMediaForIngredient.mockReset();
    listMediaForIngredient.mockResolvedValue([]);
    getIngredient.mockReset();
    getIngredient.mockResolvedValue({ id: 'ing', deleted: false });
  });

  afterEach(() => {
    hook.__testing.reset();
  });

  it('sets the first render as the portrait when the ingredient has no media', async () => {
    mediaJobEvents.emit('completed', completedImageJob({ catalogAttach: { ingredientId: 'ing-1' } }, 'first.png'));
    await waitFor(() => setPortraitMedia.mock.calls.length > 0);
    expect(setPortraitMedia).toHaveBeenCalledWith('ing-1', 'first.png');
    expect(attachMedia).not.toHaveBeenCalled();
  });

  it('attaches as a reference when the ingredient already has a portrait', async () => {
    listMediaForIngredient.mockResolvedValue([{ mediaKey: 'old.png', kind: 'portrait' }]);
    mediaJobEvents.emit('completed', completedImageJob({ catalogAttach: { ingredientId: 'ing-2' } }, 'second.png'));
    await waitFor(() => attachMedia.mock.calls.length > 0);
    expect(attachMedia).toHaveBeenCalledWith('ing-2', 'second.png', 'reference');
    expect(setPortraitMedia).not.toHaveBeenCalled();
  });

  it('honors an explicit reference kind even with no existing portrait', async () => {
    mediaJobEvents.emit('completed', completedImageJob({ catalogAttach: { ingredientId: 'ing-3', kind: 'reference' } }, 'ref.png'));
    await waitFor(() => attachMedia.mock.calls.length > 0);
    expect(attachMedia).toHaveBeenCalledWith('ing-3', 'ref.png', 'reference');
    expect(setPortraitMedia).not.toHaveBeenCalled();
  });

  it('honors an explicit portrait kind even when a portrait already exists', async () => {
    listMediaForIngredient.mockResolvedValue([{ mediaKey: 'old.png', kind: 'portrait' }]);
    mediaJobEvents.emit('completed', completedImageJob({ catalogAttach: { ingredientId: 'ing-4', kind: 'portrait' } }, 'new.png'));
    await waitFor(() => setPortraitMedia.mock.calls.length > 0);
    expect(setPortraitMedia).toHaveBeenCalledWith('ing-4', 'new.png');
    expect(attachMedia).not.toHaveBeenCalled();
  });

  it('is idempotent — skips when the filename is already attached (client won the race)', async () => {
    listMediaForIngredient.mockResolvedValue([{ mediaKey: 'dup.png', kind: 'portrait' }]);
    mediaJobEvents.emit('completed', completedImageJob({ catalogAttach: { ingredientId: 'ing-5' } }, 'dup.png'));
    // Give the async handler a chance to run, then assert no second write.
    await new Promise((r) => setTimeout(r, 30));
    expect(setPortraitMedia).not.toHaveBeenCalled();
    expect(attachMedia).not.toHaveBeenCalled();
  });

  it('never files a render as a second kind — filename already a reference, plus an unrelated portrait', async () => {
    // The headline guarantee: with this filename already attached (as reference)
    // AND a different portrait present, the auto-decision must NOT also file it
    // as a portrait — the dedup guard wins over the hasPortrait branch.
    listMediaForIngredient.mockResolvedValue([
      { mediaKey: 'portrait.png', kind: 'portrait' },
      { mediaKey: 'dup.png', kind: 'reference' },
    ]);
    mediaJobEvents.emit('completed', completedImageJob({ catalogAttach: { ingredientId: 'ing-8' } }, 'dup.png'));
    await new Promise((r) => setTimeout(r, 30));
    expect(setPortraitMedia).not.toHaveBeenCalled();
    expect(attachMedia).not.toHaveBeenCalled();
  });

  it('serializes two same-ingredient completions — first becomes portrait, second a reference (no demote/loss)', async () => {
    // Stateful media store so the SECOND attach observes the FIRST's write.
    // Without per-ingredient serialization both would read [] and both pick
    // 'portrait', and the second setPortraitMedia would demote the first.
    const rows = [];
    listMediaForIngredient.mockImplementation(async () => rows.map((r) => ({ ...r })));
    setPortraitMedia.mockImplementation(async (id, key) => {
      // Demote any other live portrait (mirrors the real helper), then attach.
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].kind === 'portrait' && rows[i].mediaKey !== key) rows.splice(i, 1);
      }
      rows.push({ mediaKey: key, kind: 'portrait' });
      return {};
    });
    attachMedia.mockImplementation(async (id, key, kind) => {
      rows.push({ mediaKey: key, kind });
      return {};
    });

    // Two catalog-tagged jobs for the SAME ingredient complete back-to-back.
    mediaJobEvents.emit('completed', completedImageJob({ catalogAttach: { ingredientId: 'ing-race' } }, 'a.png'));
    mediaJobEvents.emit('completed', completedImageJob({ catalogAttach: { ingredientId: 'ing-race' } }, 'b.png'));
    await waitFor(() => rows.length === 2);

    expect(setPortraitMedia).toHaveBeenCalledTimes(1);
    expect(setPortraitMedia).toHaveBeenCalledWith('ing-race', 'a.png');
    expect(attachMedia).toHaveBeenCalledTimes(1);
    expect(attachMedia).toHaveBeenCalledWith('ing-race', 'b.png', 'reference');
    // First render survives as the portrait; second is a reference — nothing lost.
    expect(rows).toEqual([
      { mediaKey: 'a.png', kind: 'portrait' },
      { mediaKey: 'b.png', kind: 'reference' },
    ]);
  });

  it('skips attaching when the target ingredient was deleted before the render completed', async () => {
    getIngredient.mockResolvedValue(null); // soft- or hard-deleted: getIngredient filters deleted=false
    mediaJobEvents.emit('completed', completedImageJob({ catalogAttach: { ingredientId: 'ing-gone' } }, 'orphan.png'));
    await new Promise((r) => setTimeout(r, 30));
    expect(listMediaForIngredient).not.toHaveBeenCalled();
    expect(setPortraitMedia).not.toHaveBeenCalled();
    expect(attachMedia).not.toHaveBeenCalled();
  });

  it('ignores jobs without a catalogAttach tag', async () => {
    mediaJobEvents.emit('completed', completedImageJob({ universeRun: { collectionId: 'c1' } }, 'x.png'));
    mediaJobEvents.emit('completed', completedImageJob({}, 'y.png'));
    await new Promise((r) => setTimeout(r, 30));
    expect(listMediaForIngredient).not.toHaveBeenCalled();
    expect(attachMedia).not.toHaveBeenCalled();
    expect(setPortraitMedia).not.toHaveBeenCalled();
  });

  it('ignores non-image jobs and jobs with no result filename', async () => {
    mediaJobEvents.emit('completed', { kind: 'video', params: { catalogAttach: { ingredientId: 'ing-6' } }, result: { filename: 'v.mp4' } });
    mediaJobEvents.emit('completed', { kind: 'image', params: { catalogAttach: { ingredientId: 'ing-6' } }, result: {} });
    await new Promise((r) => setTimeout(r, 30));
    expect(listMediaForIngredient).not.toHaveBeenCalled();
  });

  it('demotes a stale would-be-portrait to a reference instead of clobbering a newer portrait (#1791)', async () => {
    // Stateful store so the second (older) render observes the first's portrait.
    const rows = [];
    listMediaForIngredient.mockImplementation(async () => rows.map((r) => ({ ...r })));
    setPortraitMedia.mockImplementation(async (id, key) => {
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].kind === 'portrait' && rows[i].mediaKey !== key) rows.splice(i, 1);
      }
      rows.push({ mediaKey: key, kind: 'portrait' });
      return {};
    });
    attachMedia.mockImplementation(async (id, key, kind) => { rows.push({ mediaKey: key, kind }); return {}; });

    // Newer explicit-portrait render lands first and becomes the portrait.
    mediaJobEvents.emit('completed', {
      kind: 'image', params: { catalogAttach: { ingredientId: 'ing-q', kind: 'portrait' } },
      result: { filename: 'new.png' }, queuedAt: '2026-06-29T00:00:02.000Z',
    });
    await waitFor(() => rows.length === 1);
    // An OLDER explicit-portrait render completes out of order — it must NOT
    // demote the newer portrait; it is kept as a reference instead.
    mediaJobEvents.emit('completed', {
      kind: 'image', params: { catalogAttach: { ingredientId: 'ing-q', kind: 'portrait' } },
      result: { filename: 'old.png' }, queuedAt: '2026-06-29T00:00:01.000Z',
    });
    await waitFor(() => rows.length === 2);

    expect(setPortraitMedia).toHaveBeenCalledTimes(1);
    expect(setPortraitMedia).toHaveBeenCalledWith('ing-q', 'new.png');
    expect(attachMedia).toHaveBeenCalledWith('ing-q', 'old.png', 'reference');
    expect(rows).toEqual([
      { mediaKey: 'new.png', kind: 'portrait' },
      { mediaKey: 'old.png', kind: 'reference' },
    ]);
  });

  it('marks the guard when the client already filed a newer portrait, so a later older portrait is demoted (#1791)', async () => {
    // The mounted client optimistically attached the NEWER render as the
    // portrait, so the hook sees it as a duplicate (it never runs setPortraitMedia
    // for it). The guard must still record the newer queuedAt.
    const rows = [{ mediaKey: 'new.png', kind: 'portrait' }];
    listMediaForIngredient.mockImplementation(async () => rows.map((r) => ({ ...r })));
    setPortraitMedia.mockImplementation(async (id, key) => {
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].kind === 'portrait' && rows[i].mediaKey !== key) rows.splice(i, 1);
      }
      rows.push({ mediaKey: key, kind: 'portrait' });
      return {};
    });
    attachMedia.mockImplementation(async (id, key, kind) => { rows.push({ mediaKey: key, kind }); return {}; });

    // Newer render arrives at the hook but the client already filed it → duplicate.
    mediaJobEvents.emit('completed', {
      kind: 'image', params: { catalogAttach: { ingredientId: 'ing-dup', kind: 'portrait' } },
      result: { filename: 'new.png' }, queuedAt: '2026-06-29T00:00:02.000Z',
    });
    await waitFor(() => listMediaForIngredient.mock.calls.length > 0);
    // An OLDER explicit-portrait render completes afterward — it must be demoted
    // to a reference, NOT replace the newer portrait the client filed.
    mediaJobEvents.emit('completed', {
      kind: 'image', params: { catalogAttach: { ingredientId: 'ing-dup', kind: 'portrait' } },
      result: { filename: 'old.png' }, queuedAt: '2026-06-29T00:00:01.000Z',
    });
    await waitFor(() => rows.length === 2);

    expect(setPortraitMedia).not.toHaveBeenCalled(); // newer portrait never overwritten
    expect(attachMedia).toHaveBeenCalledWith('ing-dup', 'old.png', 'reference');
    expect(rows).toEqual([
      { mediaKey: 'new.png', kind: 'portrait' },
      { mediaKey: 'old.png', kind: 'reference' },
    ]);
  });

  it('swallows a DB error without rejecting (best-effort)', async () => {
    listMediaForIngredient.mockRejectedValueOnce(new Error('db down'));
    // Must not throw / leave an unhandled rejection.
    mediaJobEvents.emit('completed', completedImageJob({ catalogAttach: { ingredientId: 'ing-7' } }, 'z.png'));
    await new Promise((r) => setTimeout(r, 30));
    expect(setPortraitMedia).not.toHaveBeenCalled();
    expect(attachMedia).not.toHaveBeenCalled();
  });
});
