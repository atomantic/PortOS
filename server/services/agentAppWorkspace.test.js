import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'path';
import { homedir } from 'os';

vi.mock('../lib/fileUtils.js', async (importOriginal) => ({
  ...(await importOriginal()),
  readJSONFile: vi.fn(),
}));

import { readJSONFile } from '../lib/fileUtils.js';
import { getAppDataForTask, getAppWorkspace } from './agentAppWorkspace.js';

beforeEach(() => vi.resetAllMocks());

// A moved lookup must still resolve persisted legacy registries and refuse to
// substitute the PortOS checkout when a task's app cannot be resolved (#3180).
describe('read-only agent app resolution', () => {
  it.each([
    app => ({ apps: { 'example-app': app } }),
    app => ({ 'example-app': app }),
    app => [app],
  ])('resolves IDs and names in a supported registry shape', async (registry) => {
    const app = { id: 'example-app', name: 'Example App', repoPath: '~/example-repo', jira: { enabled: false } };
    readJSONFile.mockResolvedValue(registry(app));
    for (const name of ['example-app', 'Example App']) {
      expect(await getAppWorkspace(name)).toBe(join(homedir(), 'example-repo'));
      expect(await getAppDataForTask({ metadata: { app: name } })).toEqual(app);
    }
  });

  it('keeps missing registry, unknown app and absent repo paths unresolved', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const registry of [null, { apps: {} }, { apps: { missing: { name: 'Missing' } } }]) {
      readJSONFile.mockResolvedValue(registry);
      expect(await getAppWorkspace('missing')).toBeNull();
    }
    readJSONFile.mockResolvedValue(null);
    expect(await getAppDataForTask({ metadata: { app: 'missing' } })).toBeNull();
    readJSONFile.mockClear();
    expect(await getAppDataForTask({})).toBeNull();
    expect(readJSONFile).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
