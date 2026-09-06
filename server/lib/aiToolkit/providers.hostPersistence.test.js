/**
 * The host-persistence extension point on the provider service (#6367).
 *
 * PortOS keeps a machine-local connection graph beside `providers.json` and has
 * to know when that file changes — including when an OLD client, a migration or
 * a model refresh is what changed it. The toolkit stays self-contained
 * (`AGENTS.md` in this directory), so the host injects a callback rather than
 * the toolkit importing anything.
 *
 * Two properties matter enough to pin: the hook fires after EVERY successful
 * write (not just the one path someone remembered), and a failing hook cannot
 * turn a write that already landed into a failed call.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProviderService } from './providers.js';

let dataDir;
let saved;
let service;

const seed = () => writeFile(join(dataDir, 'providers.json'), JSON.stringify({
  activeProvider: 'example-cli',
  providers: {
    'example-cli': { id: 'example-cli', name: 'Example', type: 'cli', command: 'claude', enabled: true, models: ['m'] },
    'example-api': { id: 'example-api', name: 'Example API', type: 'api', endpoint: 'https://api.example.com', enabled: false, models: [] },
  },
}));

const readFileJson = async () => JSON.parse(await readFile(join(dataDir, 'providers.json'), 'utf-8'));

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'portos-provider-graph-'));
  await seed();
  saved = vi.fn();
  service = createProviderService({ dataDir, providersFile: 'providers.json', onProvidersSaved: saved });
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

describe('onProvidersSaved', () => {
  it.each([
    ['updateProvider', () => service.updateProvider('example-cli', { timeout: 1000 })],
    ['createProvider', () => service.createProvider({ id: 'new-cli', name: 'New', type: 'cli', command: 'claude' })],
    ['deleteProvider', () => service.deleteProvider('example-api')],
    ['setActiveProvider', () => service.setActiveProvider('example-api')],
    ['applyProviderPatches', () => service.applyProviderPatches({ 'example-cli': { timeout: 2000 } })],
  ])('fires after %s', async (_label, mutate) => {
    await mutate();
    expect(saved).toHaveBeenCalledTimes(1);
    // The hook sees what landed, not a pre-write draft.
    expect(saved.mock.calls[0][0].providers).toEqual((await readFileJson()).providers);
  });

  it('does not fire when the read path finds nothing to change', async () => {
    await service.getAllProviders();
    expect(saved).not.toHaveBeenCalled();
  });

  it('cannot fail a write that already landed', async () => {
    // The hook runs for boot warmups and schedulers too, where there is no
    // request lifecycle to bubble a rejection into.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    saved.mockRejectedValue(new Error('graph unavailable'));

    await expect(service.updateProvider('example-cli', { timeout: 3000 })).resolves.toMatchObject({ timeout: 3000 });
    expect((await readFileJson()).providers['example-cli'].timeout).toBe(3000);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('providers save hook failed'));
  });
});

describe('applyProviderPatches', () => {
  it('applies several records in ONE write and names exactly the ids it changed', async () => {
    const applied = await service.applyProviderPatches({
      'example-cli': { endpoint: 'http://127.0.0.1:11434' },
      'example-api': { endpoint: 'http://127.0.0.1:11434' },
      'not-a-provider': { endpoint: 'http://127.0.0.1:11434' },
    });

    expect(applied.sort()).toEqual(['example-api', 'example-cli']);
    expect(saved).toHaveBeenCalledTimes(1);
    const { providers } = await readFileJson();
    expect(providers['example-cli'].endpoint).toBe('http://127.0.0.1:11434');
    expect(providers['example-api'].endpoint).toBe('http://127.0.0.1:11434');
    expect(providers['not-a-provider']).toBeUndefined();
  });

  it('does NOT fan out to a conventional sibling the way updateProvider does', async () => {
    // A projection materializes a shared connection into exactly the routes
    // bound to it. Sibling fan-out would rewrite a route the graph never named.
    await writeFile(join(dataDir, 'providers.json'), JSON.stringify({
      activeProvider: null,
      providers: {
        example: { id: 'example', name: 'Example', type: 'cli', command: 'claude', enabled: true, models: ['m'] },
        'example-tui': { id: 'example-tui', name: 'Example TUI', type: 'tui', command: 'claude', enabled: true, models: ['m'] },
      },
    }));

    await service.applyProviderPatches({ example: { endpoint: 'http://127.0.0.1:11434' } });
    const { providers } = await readFileJson();
    expect(providers.example.endpoint).toBe('http://127.0.0.1:11434');
    expect(providers['example-tui'].endpoint).toBeUndefined();
  });

  it('writes nothing when no named id exists', async () => {
    expect(await service.applyProviderPatches({ ghost: { timeout: 1 } })).toEqual([]);
    expect(saved).not.toHaveBeenCalled();
  });
});
