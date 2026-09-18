/**
 * The downgrade half of the preset contract (#7565): a providers.json carrying
 * the structural keys is executed unchanged by a release that never heard of
 * them. Two facts make that true and both are pinned here — the record loads
 * and round-trips with the keys intact, and the provider schema STRIPS an
 * unknown key rather than refusing the whole record (so an older schema's
 * `PUT /:id` keeps working against a newer file).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProviderService } from './providers.js';
import { providerCreateSchema, providerSchema } from './validation.js';

const PRESET = {
  id: 'claude-local', name: 'Claude · local', type: 'cli', command: 'claude', args: ['--print'], enabled: true, models: ['example-llama'],
  envVars: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434', ANTHROPIC_AUTH_TOKEN: 'ollama' }, secretEnvVars: ['ANTHROPIC_AUTH_TOKEN'],
  harnessId: 'claude', method: 'cli', serviceId: 'ollama', catalogNarrowing: ['example-llama'], credentialBootstrapId: null,
};

describe('a providers.json carrying preset structure', () => {
  let dataDir;
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'portos-preset-fields-'));
    await writeFile(join(dataDir, 'providers.json'), JSON.stringify({ activeProvider: 'claude-local', providers: { 'claude-local': PRESET } }));
  });
  afterEach(() => rm(dataDir, { recursive: true, force: true }));

  it('loads, executes and round-trips with the keys intact', async () => {
    const service = createProviderService({ dataDir, providersCacheTtlMs: 0 });
    expect(await service.getProviderById('claude-local')).toMatchObject({ harnessId: 'claude', method: 'cli', serviceId: 'ollama', catalogNarrowing: ['example-llama'] });
    expect(await service.getActiveProvider()).toMatchObject({ id: 'claude-local', command: 'claude' });
    await service.updateProvider('claude-local', { effort: 'high' });
    const written = JSON.parse(await readFile(join(dataDir, 'providers.json'), 'utf8')).providers['claude-local'];
    expect(written).toMatchObject({ effort: 'high', harnessId: 'claude', method: 'cli', serviceId: 'ollama' });
  });

  it('is created with the keys only when named, so an ordinary create stays byte-identical', async () => {
    const service = createProviderService({ dataDir, providersCacheTtlMs: 0 });
    const derived = await service.createProvider({ ...PRESET, id: 'derived', credentialBootstrapId: 'corp-auth' });
    expect(derived).toMatchObject({ harnessId: 'claude', method: 'cli', serviceId: 'ollama', catalogNarrowing: ['example-llama'], credentialBootstrapId: 'corp-auth' });
    const legacy = await service.createProvider({ id: 'legacy', name: 'Legacy', type: 'cli', command: 'claude' });
    for (const key of ['harnessId', 'method', 'serviceId', 'catalogNarrowing', 'credentialBootstrapId']) expect(legacy).not.toHaveProperty(key);
  });
});

describe('the provider schema and a key it has never seen', () => {
  it('accepts the preset keys, and drops rather than refuses an unknown one — the older-release contract', () => {
    const parsed = providerSchema.safeParse({ ...PRESET, aKeyFromALaterRelease: { nested: true } });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({ harnessId: 'claude', method: 'cli', serviceId: 'ollama', catalogNarrowing: ['example-llama'], credentialBootstrapId: null });
    expect(parsed.data).not.toHaveProperty('aKeyFromALaterRelease');
    expect(providerSchema.partial().safeParse({ aKeyFromALaterRelease: 1, effort: 'high' }).success).toBe(true);
    expect(providerCreateSchema.safeParse(PRESET).success).toBe(true);
  });

  it('refuses a malformed structural key rather than storing it', () => {
    expect(providerSchema.safeParse({ ...PRESET, harnessId: 'Claude Code' }).success).toBe(false);
    expect(providerSchema.safeParse({ ...PRESET, method: 'gui' }).success).toBe(false);
    expect(providerSchema.safeParse({ ...PRESET, serviceId: 'nim@home' }).success).toBe(false);
  });
});
