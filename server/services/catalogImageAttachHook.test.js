vi.mock('./catalogDB/identityAccess.js', () => ({ assertCatalogIdentityWritable: vi.fn(async id => id) }));
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the DB layer so the hook's tag/guard/metadata logic is exercised without
// a live Postgres. `rows` stands in for the ingredient's live media, and the
// fake attachGeneratedMedia mirrors the real one's decision (auto → portrait
// when none exists, an already-attached filename is returned untouched). The
// lock and cross-writer orderings are proven in catalogDB.media.db.test.js.
let rows = [];
const attachGeneratedMedia = vi.fn();
const fakeAttachGeneratedMedia = async (_id, mediaKey, { kind, library }) => {
  const existing = rows.find((row) => row.mediaKey === mediaKey);
  if (existing) return { media: { ...existing }, kind: existing.kind, attached: false };
  const target = kind === 'auto' ? (rows.some((row) => row.kind === 'portrait') ? 'reference' : 'portrait') : kind;
  if (target === 'portrait') rows = rows.filter((row) => row.kind !== 'portrait');
  const media = { mediaKey, kind: target, library: library || {} };
  rows.push(media);
  return { media, kind: target, attached: true };
};
const updateMediaLibrary = vi.fn(async () => ({}));
// Defaults to "ingredient exists" — the 'gone'-path test overrides per-call.
const getIngredient = vi.fn(async () => ({ id: 'ing', deleted: false }));
vi.mock('./catalogDB.js', () => ({ attachGeneratedMedia, getIngredient, updateMediaLibrary }));
vi.mock('./catalogMedia.js', () => ({ readImageGenerationMetadata: async () => ({}) }));

const { mediaJobEvents } = await import('./mediaJobQueue/index.js');
const { catalogEvents } = await import('./catalogEvents.js');
const hook = await import('./catalogImageAttachHook.js');

const completedImageJob = (params, filename = 'job-abc.png', queuedAt) => ({
  kind: 'image',
  params,
  result: { filename },
  ...(queuedAt ? { queuedAt } : {}),
});
const attachedKeys = () => rows.map(({ mediaKey, kind }) => ({ mediaKey, kind }));

describe('catalogImageAttachHook', () => {
  beforeEach(() => {
    hook.__testing.reset();
    hook.initCatalogImageAttachHook();
    rows = [];
    attachGeneratedMedia.mockReset();
    attachGeneratedMedia.mockImplementation(fakeAttachGeneratedMedia);
    getIngredient.mockReset();
    getIngredient.mockResolvedValue({ id: 'ing', deleted: false });
    updateMediaLibrary.mockClear();
  });

  afterEach(async () => {
    await hook.__testing.settled();
    hook.__testing.reset();
  });

  const emit = async (...args) => {
    mediaJobEvents.emit('completed', completedImageJob(...args));
    await hook.__testing.settled();
  };

  it('asks for an automatic kind when the tag names none, so the first render becomes the portrait', async () => {
    await emit({ catalogAttach: { ingredientId: 'ing-1' } }, 'first.png');
    await emit({ catalogAttach: { ingredientId: 'ing-1' } }, 'second.png');
    expect(attachGeneratedMedia).toHaveBeenCalledWith('ing-1', 'first.png', { kind: 'auto' });
    expect(attachedKeys()).toEqual([{ mediaKey: 'first.png', kind: 'portrait' }, { mediaKey: 'second.png', kind: 'reference' }]);
  });

  it('honors an explicit tag kind', async () => {
    await emit({ catalogAttach: { ingredientId: 'ing-3', kind: 'reference' } }, 'ref.png');
    expect(attachGeneratedMedia).toHaveBeenCalledWith('ing-3', 'ref.png', { kind: 'reference' });
    expect(attachedKeys()).toEqual([{ mediaKey: 'ref.png', kind: 'reference' }]);
  });

  // Uniquely catches a reference sheet taking the portrait slot of a record
  // with no media, or losing its `sheet:<variant>` role on the way to the row.
  it('files a role-tagged render as a reference with its role, never the portrait', async () => {
    await emit({ catalogAttach: { ingredientId: 'ing-sheet', kind: 'portrait', role: 'sheet:environment' } }, 'sheet.png');
    expect(attachGeneratedMedia).toHaveBeenCalledWith('ing-sheet', 'sheet.png', { kind: 'reference', role: 'sheet:environment' });
  });

  it('durably attaches an unreviewed refinement with age, feedback and source lineage after the client leaves', async () => {
    const library = { variant: { age: 27, formId: 'adult' }, guide: false,
      review: { status: 'unreviewed', feedback: 'Keep the face, correct the hair' },
      derivedFrom: { mediaKey: 'original.png', kind: 'reference' } };
    await emit({ catalogAttach: { ingredientId: 'ing-refine', kind: 'reference', role: 'refinement', library } }, 'refined.png');
    expect(attachGeneratedMedia).toHaveBeenCalledWith('ing-refine', 'refined.png', {
      kind: 'reference', role: 'refinement', library, preserveExistingOnConflict: true,
    });
    expect(updateMediaLibrary).not.toHaveBeenCalled();
  });

  it('fills missing lineage on a row the client already filed and notifies other views once', async () => {
    const changed = vi.fn();
    catalogEvents.on('primitive-changed', changed);
    const library = { review: { status: 'unreviewed', feedback: 'Correct the hair' }, derivedFrom: { mediaKey: 'source.png', kind: 'reference' } };
    rows = [{ mediaKey: 'refined.png', kind: 'reference', library: {} }];
    await emit({ catalogAttach: { ingredientId: 'ing-refine', library } }, 'refined.png');
    expect(updateMediaLibrary).toHaveBeenCalledWith('ing-refine', 'refined.png', 'reference', library, { preserveExisting: true });
    expect(changed).toHaveBeenCalledExactlyOnceWith({ ingredientId: 'ing-refine' });
    rows = [{ mediaKey: 'refined.png', kind: 'reference', library }];
    await emit({ catalogAttach: { ingredientId: 'ing-refine', library } }, 'refined.png');
    expect(changed).toHaveBeenCalledOnce();
    catalogEvents.off('primitive-changed', changed);
  });

  it('is a no-op for a render the client already filed, under any kind', async () => {
    const changed = vi.fn();
    catalogEvents.on('primitive-changed', changed);
    rows = [{ mediaKey: 'portrait.png', kind: 'portrait' }, { mediaKey: 'dup.png', kind: 'reference' }];
    await emit({ catalogAttach: { ingredientId: 'ing-8' } }, 'dup.png');
    expect(attachedKeys()).toEqual([{ mediaKey: 'portrait.png', kind: 'portrait' }, { mediaKey: 'dup.png', kind: 'reference' }]);
    expect(updateMediaLibrary).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    catalogEvents.off('primitive-changed', changed);
  });

  it('demotes a stale would-be-portrait to a reference instead of clobbering a newer portrait (#1791)', async () => {
    await emit({ catalogAttach: { ingredientId: 'ing-q', kind: 'portrait' } }, 'new.png', '2026-06-29T00:00:02.000Z');
    await emit({ catalogAttach: { ingredientId: 'ing-q', kind: 'portrait' } }, 'old.png', '2026-06-29T00:00:01.000Z');
    expect(attachGeneratedMedia).toHaveBeenLastCalledWith('ing-q', 'old.png', { kind: 'reference', queuedAt: '2026-06-29T00:00:01.000Z' });
    expect(attachedKeys()).toEqual([{ mediaKey: 'new.png', kind: 'portrait' }, { mediaKey: 'old.png', kind: 'reference' }]);
  });

  it('marks the guard when the client already filed a newer portrait, so a later older portrait is demoted (#1791)', async () => {
    rows = [{ mediaKey: 'new.png', kind: 'portrait' }];
    await emit({ catalogAttach: { ingredientId: 'ing-dup', kind: 'portrait' } }, 'new.png', '2026-06-29T00:00:02.000Z');
    await emit({ catalogAttach: { ingredientId: 'ing-dup' } }, 'old.png', '2026-06-29T00:00:01.000Z');
    expect(attachedKeys()).toEqual([{ mediaKey: 'new.png', kind: 'portrait' }, { mediaKey: 'old.png', kind: 'reference' }]);
  });

  it('skips attaching when the target ingredient was deleted before the render completed', async () => {
    getIngredient.mockResolvedValue(null); // soft- or hard-deleted: getIngredient filters deleted=false
    await emit({ catalogAttach: { ingredientId: 'ing-gone' } }, 'orphan.png');
    expect(attachGeneratedMedia).not.toHaveBeenCalled();
  });

  it('ignores untagged, non-image, and filename-less jobs', async () => {
    await emit({ universeRun: { collectionId: 'c1' } }, 'x.png');
    await emit({}, 'y.png');
    mediaJobEvents.emit('completed', { kind: 'video', params: { catalogAttach: { ingredientId: 'ing-6' } }, result: { filename: 'v.mp4' } });
    mediaJobEvents.emit('completed', { kind: 'image', params: { catalogAttach: { ingredientId: 'ing-6' } }, result: {} });
    await hook.__testing.settled();
    expect(attachGeneratedMedia).not.toHaveBeenCalled();
  });

  it('swallows a DB error without rejecting (best-effort)', async () => {
    attachGeneratedMedia.mockRejectedValueOnce(new Error('db down'));
    // Must not throw / leave an unhandled rejection.
    await emit({ catalogAttach: { ingredientId: 'ing-7' } }, 'z.png');
    expect(rows).toEqual([]);
  });
});
