import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the project store so the hook's tag-decode + serialize + attach logic
// is exercised without touching disk or a DB. `updateProject` is reprogrammed
// per-test to stand in for the durable attach.
const updateProject = vi.fn(async (id, patch) => ({ id, ...patch }));
vi.mock('./creativeDirector/local.js', () => ({ updateProject }));

const { mediaJobEvents } = await import('./mediaJobQueue/index.js');
const hook = await import('./creativeDirectorMusicBedHook.js');

async function waitFor(predicate, { timeoutMs = 1000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor: predicate never became true');
}

const tag = (over = {}) => ({ projectId: 'proj-1', ...over });
// A completed audio job: the queue stores generateAudio's 'completed' payload
// (generateMusic's return shape) as job.result.
const completedAudioJob = ({ params = {}, result = {} } = {}) => ({
  kind: 'audio',
  params,
  result: { filename: 'music-gen-x.wav', durationSec: 12, engine: 'musicgen', modelId: 'musicgen-medium', ...result },
});

describe('creativeDirectorMusicBedHook', () => {
  beforeEach(() => {
    hook.__testing.reset();
    hook.initCreativeDirectorMusicBedHook();
    updateProject.mockReset();
    updateProject.mockImplementation(async (id, patch) => ({ id, ...patch }));
  });

  afterEach(() => {
    hook.__testing.reset();
  });

  it('attaches the rendered track onto the project musicBed field', async () => {
    mediaJobEvents.emit('completed', completedAudioJob({ params: { creativeDirectorMusicBed: tag() } }));
    await waitFor(() => updateProject.mock.calls.length > 0);
    expect(updateProject).toHaveBeenCalledWith('proj-1', {
      musicBed: expect.objectContaining({
        filename: 'music-gen-x.wav', durationSec: 12, engine: 'musicgen', modelId: 'musicgen-medium',
        generatedAt: expect.any(String),
      }),
    });
  });

  it('ignores a completed job with no creativeDirectorMusicBed tag', async () => {
    mediaJobEvents.emit('completed', completedAudioJob({ params: { prompt: 'plain audio render' } }));
    await new Promise((r) => setTimeout(r, 20));
    expect(updateProject).not.toHaveBeenCalled();
  });

  it('ignores a non-audio job kind (other hooks own those)', async () => {
    mediaJobEvents.emit('completed', { kind: 'image', params: { creativeDirectorMusicBed: tag() }, result: { filename: 'img.png' } });
    await new Promise((r) => setTimeout(r, 20));
    expect(updateProject).not.toHaveBeenCalled();
  });

  it('skips a tag missing projectId', async () => {
    mediaJobEvents.emit('completed', completedAudioJob({ params: { creativeDirectorMusicBed: {} } }));
    await new Promise((r) => setTimeout(r, 20));
    expect(updateProject).not.toHaveBeenCalled();
  });

  it('skips a completed job whose result carries no filename', async () => {
    mediaJobEvents.emit('completed', completedAudioJob({ params: { creativeDirectorMusicBed: tag() }, result: { filename: undefined } }));
    await new Promise((r) => setTimeout(r, 20));
    expect(updateProject).not.toHaveBeenCalled();
  });

  it('does not throw when the attach fails — project deleted mid-render', async () => {
    updateProject.mockRejectedValueOnce(Object.assign(new Error('Project not found'), { status: 404 }));
    mediaJobEvents.emit('completed', completedAudioJob({ params: { creativeDirectorMusicBed: tag() } }));
    await waitFor(() => updateProject.mock.calls.length > 0);
    await new Promise((r) => setTimeout(r, 20));
    // No throw escapes the listener; nothing further to assert beyond "didn't crash".
  });

  it('serializes attaches for the same project so concurrent completions do not clobber', async () => {
    const order = [];
    let resolveFirst;
    updateProject
      .mockImplementationOnce(() => new Promise((resolve) => {
        order.push('start-1');
        resolveFirst = () => { order.push('end-1'); resolve({}); };
      }))
      .mockImplementationOnce(async () => { order.push('start-2'); return {}; });

    mediaJobEvents.emit('completed', completedAudioJob({ params: { creativeDirectorMusicBed: tag() } }));
    mediaJobEvents.emit('completed', completedAudioJob({ params: { creativeDirectorMusicBed: tag() } }));

    await waitFor(() => order.includes('start-1'));
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(['start-1']);
    resolveFirst();
    await waitFor(() => order.includes('start-2'));
    expect(order).toEqual(['start-1', 'end-1', 'start-2']);
  });
});
