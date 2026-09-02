// @vitest-environment node
/**
 * previewLoraInstall's body-serialization boundary — a curated video LoRA
 * card without a `file` (buildCard's `file: entry.file || null`) must not
 * serialize a literal `null`: the route schema's `.optional()` accepts an
 * ABSENT key, not `null`, and JSON.stringify keeps `null` while it drops
 * `undefined`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./apiCore.js', async (importOriginal) => ({
  ...(await importOriginal()),
  request: vi.fn(),
}));

let request;
let previewLoraInstall;

beforeEach(async () => {
  vi.resetModules();
  ({ request } = await import('./apiCore.js'));
  ({ previewLoraInstall } = await import('./apiImageVideo.js'));
  request.mockReset();
});

describe('previewLoraInstall', () => {
  it('omits family/file from the body when the card carries them as null', async () => {
    request.mockResolvedValue({ verdict: 'ok' });
    await previewLoraInstall({ url: 'https://huggingface.co/org/repo', source: 'huggingface', family: null, file: null });

    const body = JSON.parse(request.mock.calls[0][1].body);
    expect(body).toEqual({ url: 'https://huggingface.co/org/repo', source: 'huggingface' });
    expect(body).not.toHaveProperty('family');
    expect(body).not.toHaveProperty('file');
  });

  it('includes family/file when the caller provides them', async () => {
    request.mockResolvedValue({ verdict: 'ok' });
    await previewLoraInstall({ url: 'https://huggingface.co/org/repo', source: 'huggingface', family: 'ltx-video', file: 'weights.safetensors' });

    const body = JSON.parse(request.mock.calls[0][1].body);
    expect(body).toEqual({
      url: 'https://huggingface.co/org/repo',
      source: 'huggingface',
      family: 'ltx-video',
      file: 'weights.safetensors',
    });
  });
});
