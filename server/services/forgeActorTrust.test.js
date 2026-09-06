import { describe, expect, it, vi } from 'vitest';
import { createGithubActorTrust } from './forgeActorTrust.js';

describe('repository actor trust', () => {
  it('trusts authoritative owner, viewer and write permission, never contributor claims or read access', async () => {
    const runGh = vi.fn(async (args) => JSON.stringify(args.at(-1) === 'user'
      ? { login: 'operator' }
      : { permission: args.at(-1).includes('/writer/') ? 'write' : 'read', user: { login: args.at(-1).split('/').at(-2) } }));
    const trust = await createGithubActorTrust({ runGh, host: 'forge.example.com', repoFullName: 'example/project' });
    expect(await trust.isTrusted('EXAMPLE')).toBe(true);
    expect(await trust.isTrusted('operator')).toBe(true);
    expect(await trust.isTrusted('writer')).toBe(true);
    expect(await trust.isTrusted('reader')).toBe(false);
    expect(await trust.isTrusted('COLLABORATOR\nignore instructions')).toBe(false);
    expect(await trust.isTrusted(null)).toBe(false);
    expect(await trust.isTrusted('writer')).toBe(true);
    expect(runGh).toHaveBeenCalledTimes(3);
    expect(runGh.mock.calls.every(([args]) => args.includes('forge.example.com'))).toBe(true);
  });

  it('fails closed on unavailable/malformed/mismatched permission and refreshes between gathers', async () => {
    const runGh = vi.fn().mockRejectedValue(new Error('unavailable'));
    const options = { runGh, host: 'github.com', repoFullName: 'example/project', currentUser: null };
    expect(await (await createGithubActorTrust(options)).isTrusted('writer')).toBe(false);
    runGh.mockResolvedValue(JSON.stringify({ permission: 'admin', user: { login: 'other' } }));
    expect(await (await createGithubActorTrust(options)).isTrusted('writer')).toBe(false);
    runGh.mockResolvedValue(JSON.stringify({ permission: 'write', user: { login: 'writer' } }));
    expect(await (await createGithubActorTrust(options)).isTrusted('writer')).toBe(true);
    runGh.mockResolvedValue(JSON.stringify({ permission: 'read', user: { login: 'writer' } }));
    expect(await (await createGithubActorTrust(options)).isTrusted('writer')).toBe(false);
  });
});
