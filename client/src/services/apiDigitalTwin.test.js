import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./apiCore.js', () => ({
  request: vi.fn(),
}));

let request;
let detectDigitalTwinContradictions;
let openDigitalTwinSpotifyBrowser;
let importDigitalTwinSpotifyBrowser;

beforeEach(async () => {
  vi.resetModules();
  ({ request } = await import('./apiCore.js'));
  ({ detectDigitalTwinContradictions, openDigitalTwinSpotifyBrowser, importDigitalTwinSpotifyBrowser } = await import('./apiDigitalTwin.js'));
  request.mockReset();
});

describe('detectDigitalTwinContradictions', () => {
  // OverviewTab renders the failure inline (contradictions.error), so it needs a
  // way to suppress request()'s own toast — otherwise one failure reports twice.
  it('forwards caller options (e.g. silent) into the request', async () => {
    request.mockResolvedValue({ issues: [] });

    await detectDigitalTwinContradictions('openai', 'gpt-4', { silent: true });

    const [path, options] = request.mock.calls[0];
    expect(path).toBe('/digital-twin/validate/contradictions');
    expect(options.silent).toBe(true);
    // Options must not clobber the request shape.
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({ providerId: 'openai', model: 'gpt-4' });
  });

  it('stays callable without options (back-compat) and then toasts by default', async () => {
    request.mockResolvedValue({ issues: [] });

    await detectDigitalTwinContradictions('openai', 'gpt-4');

    const [, options] = request.mock.calls[0];
    expect(options.silent).toBeUndefined();
    expect(options.method).toBe('POST');
  });
});

describe('interactive Spotify import wrappers', () => {
  it('opens the managed browser without accepting a caller URL', async () => {
    request.mockResolvedValue({ status: 'ready' });

    await openDigitalTwinSpotifyBrowser({ silent: true });

    const [path, options] = request.mock.calls[0];
    expect(path).toBe('/digital-twin/import/spotify/browser/open');
    expect(options).toMatchObject({ method: 'POST', silent: true });
    expect(options.body).toBeUndefined();
  });

  it('sends only the selected provider and model for browser analysis', async () => {
    request.mockResolvedValue({ status: 'complete' });

    await importDigitalTwinSpotifyBrowser('local', 'example-model', { silent: true });

    const [path, options] = request.mock.calls[0];
    expect(path).toBe('/digital-twin/import/spotify/browser/import');
    expect(options).toMatchObject({ method: 'POST', silent: true });
    expect(JSON.parse(options.body)).toEqual({ providerId: 'local', model: 'example-model' });
  });
});
// @vitest-environment node
