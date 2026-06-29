import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mediaJobEvents } = await import('./mediaJobQueue/index.js');
const { createMediaJobImageHook } = await import('./mediaJobImageHook.js');

async function waitFor(predicate, { timeoutMs = 1000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor: predicate never became true');
}

const job = ({ params = {}, filename = 'f.png', id = 'j', kind = 'image', queuedAt } = {}) => ({
  kind, id, params, result: { filename }, ...(queuedAt ? { queuedAt } : {}),
});
const tag = (over = {}) => ({ recordId: 'r1', sceneId: 's1', ...over });

// A representative scene-frame config with the newest-wins guard on. `attach`
// and `onAttached` are returned so a test can reprogram them via
// mockImplementation (the factory holds the same fn references).
function makeHook(over = {}) {
  const attach = vi.fn(async () => ({ ok: true }));
  const onAttached = vi.fn();
  const hook = createMediaJobImageHook({
    label: 'test',
    initLog: '🧪 test hook initialized',
    tagKey: 'test',
    identify: (t) => (t?.recordId && t.sceneId ? { recordId: t.recordId, sceneId: t.sceneId } : null),
    serializeKey: (ctx) => ctx.recordId,
    sceneKey: (ctx) => `${ctx.recordId}:${ctx.sceneId}`,
    attach,
    onAttached,
    ...over,
  });
  return { hook, attach, onAttached };
}

describe('createMediaJobImageHook', () => {
  let h;
  beforeEach(() => { h = makeHook(); h.hook.init(); });
  afterEach(() => { h.hook.__testing.reset(); });

  it('attaches and emits for a tagged image job', async () => {
    mediaJobEvents.emit('completed', job({ params: { test: tag() } }));
    await waitFor(() => h.onAttached.mock.calls.length > 0);
    expect(h.attach).toHaveBeenCalledTimes(1);
    expect(h.onAttached.mock.calls[0][1]).toEqual({ ok: true });
    expect(h.attach.mock.calls[0][0]).toMatchObject({ recordId: 'r1', sceneId: 's1', filename: 'f.png' });
  });

  it('ignores non-image jobs, missing tags, invalid tags, and missing filenames', async () => {
    mediaJobEvents.emit('completed', { kind: 'video', params: { test: tag() }, result: { filename: 'v.mp4' } });
    mediaJobEvents.emit('completed', job({ params: {} }));
    mediaJobEvents.emit('completed', job({ params: { test: { recordId: 'r1' } } })); // missing sceneId
    mediaJobEvents.emit('completed', { kind: 'image', params: { test: tag() }, result: {} }); // no filename
    await new Promise((r) => setTimeout(r, 30));
    expect(h.attach).not.toHaveBeenCalled();
    expect(h.onAttached).not.toHaveBeenCalled();
  });

  it('does not let an older queuedAt overwrite a newer frame on the same scene', async () => {
    mediaJobEvents.emit('completed', job({ params: { test: tag() }, filename: 'new.png', id: 'b', queuedAt: '2026-06-29T00:00:02.000Z' }));
    await waitFor(() => h.attach.mock.calls.length > 0);
    mediaJobEvents.emit('completed', job({ params: { test: tag() }, filename: 'old.png', id: 'a', queuedAt: '2026-06-29T00:00:01.000Z' }));
    await new Promise((r) => setTimeout(r, 30));
    expect(h.attach).toHaveBeenCalledTimes(1);
    expect(h.attach.mock.calls[0][0].filename).toBe('new.png');
  });

  it('a failed attach does not advance the newest-wins guard (next render still applies)', async () => {
    h.attach.mockReset();
    h.attach
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValueOnce({ ok: true });
    // First (newer) render fails; its queuedAt must NOT be recorded.
    mediaJobEvents.emit('completed', job({ params: { test: tag() }, filename: 'fail.png', queuedAt: '2026-06-29T00:00:02.000Z' }));
    await waitFor(() => h.attach.mock.calls.length > 0);
    // A later (older) render must still apply since the failed one didn't mark the slot.
    mediaJobEvents.emit('completed', job({ params: { test: tag() }, filename: 'ok.png', queuedAt: '2026-06-29T00:00:01.000Z' }));
    await waitFor(() => h.onAttached.mock.calls.length > 0);
    expect(h.attach).toHaveBeenCalledTimes(2);
    expect(h.onAttached).toHaveBeenCalledTimes(1);
    expect(h.onAttached.mock.calls[0][1]).toEqual({ ok: true });
  });

  it('serializes same-key attaches (second awaits the first); a different key runs concurrently', async () => {
    const order = [];
    let releaseFirst;
    h.attach.mockImplementation(async (ctx) => {
      order.push(`start:${ctx.recordId}:${ctx.sceneId}`);
      if (ctx.recordId === 'r1' && ctx.sceneId === 'a') await new Promise((res) => { releaseFirst = res; });
      order.push(`end:${ctx.recordId}:${ctx.sceneId}`);
      return { ok: true };
    });

    mediaJobEvents.emit('completed', job({ params: { test: tag({ recordId: 'r1', sceneId: 'a' }) }, id: '1' }));
    mediaJobEvents.emit('completed', job({ params: { test: tag({ recordId: 'r1', sceneId: 'b' }) }, id: '2' }));
    mediaJobEvents.emit('completed', job({ params: { test: tag({ recordId: 'r2', sceneId: 'c' }) }, id: '3' }));

    // r1's first attach blocks; r1's second must NOT have started, but r2 (a
    // different serialize key) runs concurrently.
    await waitFor(() => order.includes('end:r2:c'));
    expect(order).toContain('start:r1:a');
    expect(order).not.toContain('start:r1:b');
    releaseFirst();
    await waitFor(() => order.includes('end:r1:b'));
    // Same key ran strictly one-after-another.
    expect(order.indexOf('end:r1:a')).toBeLessThan(order.indexOf('start:r1:b'));
  });

  it('swallows a thrown attach without an unhandled rejection (best-effort)', async () => {
    h.attach.mockRejectedValue(new Error('boom'));
    mediaJobEvents.emit('completed', job({ params: { test: tag() } }));
    await waitFor(() => h.attach.mock.calls.length > 0);
    await new Promise((r) => setTimeout(r, 20));
    expect(h.onAttached).not.toHaveBeenCalled();
  });

  it('init is idempotent — a double init does not double-file', async () => {
    h.hook.init(); // second init
    mediaJobEvents.emit('completed', job({ params: { test: tag() } }));
    await waitFor(() => h.attach.mock.calls.length > 0);
    await new Promise((r) => setTimeout(r, 20));
    expect(h.attach).toHaveBeenCalledTimes(1);
  });

  it('a hook with no sceneKey skips the guard entirely (every render applies)', async () => {
    h.hook.__testing.reset();
    h = makeHook({ sceneKey: null });
    h.hook.init();
    mediaJobEvents.emit('completed', job({ params: { test: tag() }, filename: 'a.png', queuedAt: '2026-06-29T00:00:02.000Z' }));
    await waitFor(() => h.attach.mock.calls.length > 0);
    mediaJobEvents.emit('completed', job({ params: { test: tag() }, filename: 'b.png', queuedAt: '2026-06-29T00:00:01.000Z' }));
    await waitFor(() => h.attach.mock.calls.length > 1);
    expect(h.attach).toHaveBeenCalledTimes(2);
  });

  it('config kind + extractResult ride the same scaffold for non-image jobs (video lane, #1760)', async () => {
    h.hook.__testing.reset();
    // A video-kind hook: it ignores image jobs and surfaces a custom ctx field
    // from a custom extractor (the music-video i2v hook's exact shape).
    h = makeHook({
      kind: 'video',
      extractResult: (j) => {
        const id = (typeof j.result?.generationId === 'string' && j.result.generationId) || j.id;
        return id ? { videoHistoryId: id } : null;
      },
    });
    h.hook.init();
    // An image-kind job is ignored by a kind:'video' hook.
    mediaJobEvents.emit('completed', { kind: 'image', id: 'i', params: { test: tag() }, result: { filename: 'f.png' } });
    // A video job attaches via extractResult → ctx.videoHistoryId (falls back to job.id).
    mediaJobEvents.emit('completed', { kind: 'video', id: 'vid-1', params: { test: tag() }, result: { generationId: 'vid-1' } });
    await waitFor(() => h.onAttached.mock.calls.length > 0);
    expect(h.attach).toHaveBeenCalledTimes(1);
    expect(h.attach.mock.calls[0][0]).toMatchObject({ recordId: 'r1', sceneId: 's1', videoHistoryId: 'vid-1' });
  });
});
