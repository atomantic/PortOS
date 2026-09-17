/**
 * `getProviderById` and the host's composite resolver (#7564): a stored record
 * always wins, only a composite-shaped id that the map does not hold reaches
 * the hook, and a toolkit built without the hook answers exactly as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProviderService } from './providers.js';

let dataDir;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'portos-providers-composite-'));
  await writeFile(join(dataDir, 'providers.json'), JSON.stringify({
    activeProvider: 'claude-code',
    providers: { 'claude-code': { id: 'claude-code', name: 'Claude', type: 'cli', command: 'claude', enabled: true, models: [] } },
  }));
});
afterEach(() => rm(dataDir, { recursive: true, force: true }));

describe('createProviderService({ resolveCompositeProvider })', () => {
  it('hands only an unstored composite id to the resolver, and never a preset lookup', async () => {
    const materialized = { id: 'pi.tui@nvidia-nim', type: 'tui', command: 'pi', enabled: true };
    const resolveCompositeProvider = vi.fn(async (id) => (id === 'pi.tui@nvidia-nim' ? materialized : null));
    const service = createProviderService({ dataDir, resolveCompositeProvider });

    await expect(service.getProviderById('claude-code')).resolves.toMatchObject({ id: 'claude-code' });
    await expect(service.getProviderById('no-such-preset')).resolves.toBeNull();
    expect(resolveCompositeProvider).not.toHaveBeenCalled();

    await expect(service.getProviderById('pi.tui@nvidia-nim')).resolves.toBe(materialized);
    await expect(service.getProviderById('claude.cli@nowhere')).resolves.toBeNull();
    expect(resolveCompositeProvider.mock.calls.map(([id]) => id)).toEqual(['pi.tui@nvidia-nim', 'claude.cli@nowhere']);
    // Malformed references never reach the host: the grammar is the gate.
    await expect(service.getProviderById('pi.gui@x')).resolves.toBeNull();
    await expect(service.getProviderById('direct.api@ollama+corp-auth')).resolves.toBeNull();
    expect(resolveCompositeProvider).toHaveBeenCalledTimes(2);
  });

  it('keeps the stored map authoritative: a composite never appears in the list, and cannot become active', async () => {
    const service = createProviderService({ dataDir, resolveCompositeProvider: async () => ({ id: 'pi.tui@nvidia-nim', type: 'tui' }) });
    const { providers } = await service.getAllProviders();
    expect(providers.map((p) => p.id)).toEqual(['claude-code']);
    await expect(service.setActiveProvider('pi.tui@nvidia-nim')).resolves.toBeNull();
    expect((await service.getActiveProvider()).id).toBe('claude-code');
  });

  it('answers as before with no resolver configured', async () => {
    const service = createProviderService({ dataDir });
    await expect(service.getProviderById('pi.tui@nvidia-nim')).resolves.toBeNull();
  });
});
