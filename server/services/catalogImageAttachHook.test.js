import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the DB layer so the hook's attach/decision logic is exercised without a
// live Postgres. `listMediaForIngredient` is reprogrammed per-test to stand in
// for the ingredient's current media rows.
const attachMedia = vi.fn(async () => ({}));
const setPortraitMedia = vi.fn(async () => ({}));
const listMediaForIngredient = vi.fn(async () => []);
vi.mock('./catalogDB.js', () => ({ attachMedia, setPortraitMedia, listMediaForIngredient }));

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
    attachMedia.mockClear();
    setPortraitMedia.mockClear();
    listMediaForIngredient.mockReset();
    listMediaForIngredient.mockResolvedValue([]);
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

  it('swallows a DB error without rejecting (best-effort)', async () => {
    listMediaForIngredient.mockRejectedValueOnce(new Error('db down'));
    // Must not throw / leave an unhandled rejection.
    mediaJobEvents.emit('completed', completedImageJob({ catalogAttach: { ingredientId: 'ing-7' } }, 'z.png'));
    await new Promise((r) => setTimeout(r, 30));
    expect(setPortraitMedia).not.toHaveBeenCalled();
    expect(attachMedia).not.toHaveBeenCalled();
  });
});
