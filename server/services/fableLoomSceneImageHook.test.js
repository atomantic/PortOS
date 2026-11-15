import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the record layer so the hook's tag-decode + attach dispatch is
// exercised without touching disk.
const attachNodeImage = vi.fn(async (loomId, episodeId, nodeId, { filename, jobId }) => ({
  id: nodeId, image: filename, imageJobId: jobId,
}));
vi.mock('./fableLoom/records.js', () => ({ attachNodeImage }));

const { mediaJobEvents } = await import('./mediaJobQueue/index.js');
const hook = await import('./fableLoomSceneImageHook.js');

async function waitFor(predicate, { timeoutMs = 1000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor: predicate never became true');
}

const tag = (over = {}) => ({ loomId: 'loom-1', episodeId: 'ep-1', nodeId: 'node-1', ...over });
const completedImageJob = ({ params = {}, filename = 'job-abc.png', id = 'job-abc' } = {}) => ({
  kind: 'image', id, params, result: { filename },
});

describe('fableLoomSceneImageHook', () => {
  beforeEach(() => {
    hook.__testing.reset();
    hook.initFableLoomSceneImageHook();
    attachNodeImage.mockClear();
  });

  afterEach(() => {
    hook.__testing.reset();
  });

  it('files a completed fableLoom-tagged render onto its node', async () => {
    mediaJobEvents.emit('completed', completedImageJob({ params: { fableLoom: tag() } }));
    await waitFor(() => attachNodeImage.mock.calls.length > 0);
    expect(attachNodeImage).toHaveBeenCalledWith('loom-1', 'ep-1', 'node-1', {
      filename: 'job-abc.png', jobId: 'job-abc',
    });
  });

  it('derives jobId from the filename when the job carries no id', async () => {
    mediaJobEvents.emit('completed', completedImageJob({ params: { fableLoom: tag() }, filename: 'noid.png', id: null }));
    await waitFor(() => attachNodeImage.mock.calls.length > 0);
    expect(attachNodeImage.mock.calls[0][3].jobId).toBe('noid');
  });

  it('ignores jobs without the fableLoom tag and tags missing their ids', async () => {
    mediaJobEvents.emit('completed', completedImageJob({ params: {} }));
    mediaJobEvents.emit('completed', completedImageJob({ params: { fableLoom: { loomId: 'loom-1' } } }));
    await hook.__testing.settled();
    expect(attachNodeImage).not.toHaveBeenCalled();
  });
});
