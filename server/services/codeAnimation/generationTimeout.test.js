/**
 * Generating an animation may take hours. A wall-clock cap on the authoring
 * run timed out a working Claude Code TUI run at 15 minutes, failed it over,
 * and benched the provider for every other caller.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { lazyTempDataRoot, makePathsProxy, cleanupTempDataRoots } from '../../lib/mockPathsDataRoot.js';

vi.mock('../../lib/paths.js', async importOriginal =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('code-animation-timeout-') }));
vi.mock('../../lib/databaseMaintenanceJournal.js', async importOriginal => ({
  ...(await importOriginal()),
  assertDatabaseAdmission: () => {},
}));
vi.mock('../socket.js', () => ({ emitCodeAnimationChanged: vi.fn() }));
const jobs = vi.hoisted(() => ({ saveCodeAnimationJobRecord: vi.fn(async job => job), saveCodeAnimationHtml: vi.fn() }));
vi.mock('./jobStore.js', async importOriginal => ({ ...(await importOriginal()), ...jobs }));
vi.mock('../providers.js', () => ({
  getProviderById: vi.fn(async () => ({ id: 'example-tui', type: 'tui', enabled: true, timeout: 300000 })),
}));
const runner = vi.hoisted(() => ({
  runPromptThroughProvider: vi.fn(async () => ({ text: '```html\n<!doctype html><html><canvas></canvas></html>\n```' })),
}));
vi.mock('../promptRunner.js', () => runner);
vi.mock('../creativeStyleSources.js', () => ({
  resolveUniverseStyleSource: vi.fn(async () => null),
  resolveMoodBoardStyleSource: vi.fn(async () => ({ board: null, images: [] })),
}));

const { startCodeAnimationGeneration } = await import('./index.js');

afterAll(() => cleanupTempDataRoots('code-animation-timeout-'));

describe('code animation generation run budget', () => {
  it('runs the authoring prompt with no total-runtime cap on any provider type', async () => {
    await startCodeAnimationGeneration({
      providerId: 'example-tui', concept: 'A cube hops over a cone.',
      format: { aspectRatio: '16:9', resolution: '720p', fps: 24, durationSeconds: 4 },
    });
    await vi.waitFor(() => expect(jobs.saveCodeAnimationJobRecord).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'completed' })));
    const [{ source, timeout, absoluteTimeoutMs }] = runner.runPromptThroughProvider.mock.calls.at(-1);
    expect({ source, absoluteTimeoutMs }).toEqual({ source: 'code-animation-generation', absoluteTimeoutMs: 0 });
    // CLI/TUI read `timeout` as a total cap; API runs keep their no-progress bound.
    expect(timeout({ type: 'tui', timeout: 300000 })).toBe(0);
    expect(timeout({ type: 'cli', timeout: 300000 })).toBe(0);
    expect(timeout({ type: 'api', timeout: 300000 })).toBe(15 * 60 * 1000);
    expect(timeout({ type: 'api', timeout: 30 * 60 * 1000 })).toBe(30 * 60 * 1000);
  });
});
