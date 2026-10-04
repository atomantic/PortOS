import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./apiCore.js', () => ({ request: vi.fn() }));

let request;
let importReferenceAudio;

beforeEach(async () => {
  vi.resetModules();
  ({ request } = await import('./apiCore.js'));
  ({ importReferenceAudio } = await import('./apiRounds.js'));
  request.mockReset();
});

describe('importReferenceAudio', () => {
  it('sends the saved reference target so the server can attach the finished file (#9943)', async () => {
    await importReferenceAudio('https://example.com/clip', { roundId: 'round-1', referenceId: 'ref-1', silent: true });
    const [path, options] = request.mock.lastCall;
    expect(path).toBe('/rounds/reference-audio/import');
    expect(JSON.parse(options.body)).toEqual({ url: 'https://example.com/clip', roundId: 'round-1', referenceId: 'ref-1' });
    // The target is wire data; request options pass through untouched.
    expect(options.silent).toBe(true);
    expect(options).not.toHaveProperty('roundId');
  });

  it('sends only the url for an unsaved draft row', async () => {
    await importReferenceAudio('https://example.com/clip', { silent: true });
    expect(JSON.parse(request.mock.lastCall[1].body)).toEqual({ url: 'https://example.com/clip' });
  });

  it('never sends half a target, which the server rejects', async () => {
    await importReferenceAudio('https://example.com/clip', { roundId: 'round-1' });
    expect(JSON.parse(request.mock.lastCall[1].body)).toEqual({ url: 'https://example.com/clip' });
  });
});
