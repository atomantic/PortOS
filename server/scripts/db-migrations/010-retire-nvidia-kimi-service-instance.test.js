import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { up } from './010-retire-nvidia-kimi-service-instance.js';

describe('DB migration 010 — retire NVIDIA Kimi service instance', () => {
  let tempDir;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  const writeProviders = async (providers) => {
    tempDir = await mkdtemp(join(tmpdir(), 'db-migration-nvidia-kimi-'));
    const providersPath = join(tempDir, 'providers.json');
    await writeFile(providersPath, `${JSON.stringify({ providers })}\n`);
    return providersPath;
  };

  const clientFor = ({ candidates = [{ id: 'connection-example' }], routes = [] } = {}) => {
    const query = vi.fn(async (sql) => {
      if (sql.includes('FROM ai_connections')) return { rows: candidates };
      if (sql.includes('FROM ai_route_bindings')) return { rows: routes };
      if (sql.includes('DELETE FROM ai_connections')) return { rows: candidates.map(({ id }) => ({ id })) };
      return { rows: [] };
    });
    return { query };
  };

  it('deletes the retired instance and its orphaned routes and bindings', async () => {
    const providersPath = await writeProviders({ 'nvidia-nim': { id: 'nvidia-nim' } });
    const client = clientFor({ routes: [{ provider_id: 'nvidia-kimi' }] });

    await expect(up(client, { providersPath })).resolves.toEqual({ removed: 1, skipped: null });

    expect(client.query).toHaveBeenCalledTimes(5);
    expect(client.query).toHaveBeenNthCalledWith(1,
      expect.stringContaining('FROM ai_connections'), ['nvidia-kimi', 'nvidia-nim', 'gateway:nvidia-nim']);
    expect(client.query).toHaveBeenNthCalledWith(2,
      expect.stringContaining('FOR UPDATE OF route, binding'), ['connection-example']);
    expect(client.query).toHaveBeenNthCalledWith(3,
      expect.stringContaining('DELETE FROM ai_route_bindings'), ['connection-example']);
    expect(client.query).toHaveBeenNthCalledWith(4,
      expect.stringContaining('DELETE FROM ai_harness_bindings'), ['connection-example']);
    expect(client.query).toHaveBeenNthCalledWith(5,
      expect.stringContaining('DELETE FROM ai_connections'), ['connection-example', 'nvidia-kimi', 'nvidia-nim', 'gateway:nvidia-nim']);
  });

  it('preserves the service when the retired preset remains configured', async () => {
    const providersPath = await writeProviders({ 'nvidia-kimi': { id: 'nvidia-kimi' } });
    const client = clientFor();

    await expect(up(client, { providersPath })).resolves.toEqual({ removed: 0, skipped: 'provider-still-configured' });
    expect(client.query).not.toHaveBeenCalled();
  });

  it('preserves a service named by a customized preset even before its route is imported', async () => {
    const providersPath = await writeProviders({ 'custom-nvidia-route': { serviceId: 'nvidia-kimi' } });
    const client = clientFor();

    await expect(up(client, { providersPath })).resolves.toEqual({ removed: 0, skipped: 'provider-still-configured' });
    expect(client.query).not.toHaveBeenCalled();
  });

  it('preserves a service used by another configured route', async () => {
    const providersPath = await writeProviders({ 'opencode-nvidia-nim': { id: 'opencode-nvidia-nim' } });
    const client = clientFor({ routes: [{ provider_id: 'opencode-nvidia-nim' }] });

    await expect(up(client, { providersPath })).resolves.toEqual({ removed: 0, skipped: null });
    expect(client.query.mock.calls.map(([sql]) => sql)).toHaveLength(2);
  });

  it('does not retire rows when the installed provider file is absent', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'db-migration-nvidia-kimi-'));
    const client = clientFor();

    await expect(up(client, { providersPath: join(tempDir, 'missing.json') }))
      .resolves.toEqual({ removed: 0, skipped: 'provider-file-absent' });
    expect(client.query).not.toHaveBeenCalled();
  });

  it('fails safely on malformed provider configuration', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'db-migration-nvidia-kimi-'));
    const providersPath = join(tempDir, 'providers.json');
    await writeFile(providersPath, '{invalid');
    const client = clientFor();

    await expect(up(client, { providersPath })).rejects.toThrow(/Cannot parse data\/providers\.json/);
    expect(client.query).not.toHaveBeenCalled();
  });
});
