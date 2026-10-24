import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

// Observe the first real Git result, then deterministically interleave another
// writer before readback. No retry can erase the original failed exit.
const observation = vi.hoisted(() => ({ afterCommit: null, results: [] }));
vi.mock('../lib/execGit.js', async importOriginal => {
  const actual = await importOriginal();
  return {
    ...actual,
    execGit: async (...args) => {
      const result = await actual.execGit(...args);
      if (args[0][0] === 'commit' && observation.afterCommit) {
        observation.results.push(result);
        await observation.afterCommit(...args);
      }
      return result;
    }
  };
});
import { execGit } from '../lib/execGit.js';
import { makeGitSandbox, destroyGitSandbox } from '../lib/gitTestRepo.js';
import { commit } from './git.js';

let fixture;
let repo;
let owner;
let ownerClosed;
const git = (...args) => execGit(args, repo);
const head = async () => (await git('rev-parse', 'HEAD')).stdout.trim();

// The child exclusively creates, holds and releases its own lock. IPC proves
// ownership/ready state without sleeps, stale-lock inference or production data.
async function holdLock(name) {
  const path = (await git('rev-parse', '--path-format=absolute', '--git-path', name)).stdout.trim();
  owner = spawn(process.execPath, ['-e', `
    const fs = require('node:fs');
    const path = process.argv[1];
    const fd = fs.openSync(path, 'wx');
    fs.writeSync(fd, String(process.pid));
    process.on('message', () => {
      fs.closeSync(fd);
      fs.unlinkSync(path);
      process.disconnect();
    });
    process.send({ pid: process.pid });
  `, path], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  ownerClosed = new Promise(resolve => owner.once('close', resolve));
  const ready = new Promise((resolve, reject) => {
    owner.once('error', reject);
    owner.once('message', resolve);
    owner.once('exit', () => reject(new Error('fixture lock owner exited before ready')));
  });
  const { pid } = await ready;
  expect(pid).toBe(owner.pid);
  expect(await readFile(path, 'utf8')).toBe(String(pid));
  return path;
}

beforeEach(async () => {
  fixture = await makeGitSandbox({ prefix: 'git-commit-readback-' });
  repo = join(fixture.scratch, 'linked');
  await execGit(['worktree', 'add', '-b', 'claim/example', repo], fixture.repo);
  await git('config', 'rerere.enabled', 'true');
  await writeFile(join(repo, 'initial.txt'), 'requested change\n');
  await git('add', 'initial.txt');
  observation.results = [];
  observation.afterCommit = async () => {};
});
afterEach(async () => {
  observation.afterCommit = null;
  if (owner?.connected) owner.send('release');
  if (ownerClosed) await ownerClosed;
  owner = null;
  ownerClosed = null;
  await destroyGitSandbox(fixture?.scratch);
});

describe('commit outcome readback with real Git', () => {
  it('recognizes exactly one scoped commit after a rerere collision and preserves the live lock and other staged work', async () => {
    const before = await head();
    await writeFile(join(repo, '[id].txt'), 'literal filename\n');
    await writeFile(join(repo, 'i.txt'), 'unrelated staged work\n');
    await git('add', '--', ':(literal)[id].txt', 'i.txt');
    const lock = await holdLock('MERGE_RR.lock');
    const result = await commit(repo, 'requested commit', { paths: ['initial.txt', '[id].txt'] });
    const after = await head();
    expect(result).toEqual({ hash: after, message: 'requested commit', commitOutcome: {
      command: 'commit', exitCode: 128, beforeHead: before, afterHead: after, status: 'verified-committed'
    } });
    expect(observation.results).toHaveLength(1);
    expect(observation.results[0]).toMatchObject({ exitCode: 128, stderr: expect.stringContaining('MERGE_RR.lock') });
    expect((await git('rev-list', '--count', `${before}..HEAD`)).stdout.trim()).toBe('1');
    expect((await git('show', 'HEAD:initial.txt')).stdout).toBe('requested change\n');
    expect((await git('diff', '--cached', '--name-only')).stdout.trim()).toBe('i.txt');
    expect((await git('show', 'HEAD:[id].txt')).stdout).toBe('literal filename\n');
    expect(owner.exitCode).toBeNull();
    expect(await readFile(lock, 'utf8')).toBe(String(owner.pid));
  });

  it('preserves the first genuine commit failure without retrying or deleting its live index lock', async () => {
    const before = await head();
    const lock = await holdLock('index.lock');
    await expect(commit(repo, 'not committed')).rejects.toMatchObject({
      message: expect.stringContaining('index.lock'),
      commitOutcome: { beforeHead: before, afterHead: before, status: 'unverified', exitCode: 128 }
    });
    expect(observation.results).toHaveLength(1);
    expect(await head()).toBe(before);
    expect(await readFile(lock, 'utf8')).toBe(String(owner.pid));
    expect((await git('diff', '--cached', '--name-only')).stdout.trim()).toBe('initial.txt');
  });

  it('refuses an unrelated branch advance even when the attempted commit was recorded', async () => {
    await holdLock('MERGE_RR.lock');
    observation.afterCommit = async () => {
      const committed = await head();
      const tree = (await git('rev-parse', 'HEAD^{tree}')).stdout.trim();
      const other = (await git('commit-tree', tree, '-p', committed, '-m', 'competing writer')).stdout.trim();
      await git('update-ref', '-m', 'competing writer', 'HEAD', other, committed);
    };
    await expect(commit(repo, 'requested commit')).rejects.toMatchObject({
      message: expect.stringContaining('MERGE_RR.lock'), commitOutcome: { status: 'unverified' }
    });
    expect(observation.results).toHaveLength(1);
    expect((await git('log', '-1', '--format=%s')).stdout.trim()).toBe('competing writer');
  });

  it('refuses a changed current branch while retaining the commit on the original branch', async () => {
    await git('branch', 'other');
    await holdLock('MERGE_RR.lock');
    observation.afterCommit = () => git('symbolic-ref', 'HEAD', 'refs/heads/other');
    await expect(commit(repo, 'requested commit')).rejects.toMatchObject({ commitOutcome: { status: 'unverified' } });
    expect(observation.results).toHaveLength(1);
    expect((await git('log', '-1', '--format=%s', 'claim/example')).stdout.trim()).toBe('requested commit');
    expect((await git('symbolic-ref', 'HEAD')).stdout.trim()).toBe('refs/heads/other');
  });

  it('refuses unavailable invocation evidence instead of treating any advanced branch as success', async () => {
    await holdLock('MERGE_RR.lock');
    observation.afterCommit = async () => {
      const log = (await git('rev-parse', '--path-format=absolute', '--git-path', 'logs/refs/heads/claim/example')).stdout.trim();
      await unlink(log);
    };
    await expect(commit(repo, 'requested commit')).rejects.toMatchObject({
      message: expect.stringContaining('MERGE_RR.lock'), commitOutcome: { status: 'unverified' }
    });
    expect(observation.results).toHaveLength(1);
  });

  it('keeps ordinary successful commits on slash-named branches working', async () => {
    await expect(commit(repo, 'unsafe path', { paths: ['../escape.json'] })).rejects.toThrow('Invalid file path');
    expect(observation.results).toHaveLength(0);
    const result = await commit(repo, 'ordinary success');
    expect(result).toEqual({ hash: expect.stringMatching(/^[a-f0-9]+$/), message: 'ordinary success' });
    expect((await head()).startsWith(result.hash)).toBe(true);
    expect(observation.results).toHaveLength(1);
    expect(observation.results[0].exitCode).toBe(0);
  });

  it('returns the commit header hash when the subject ends with bracketed hexadecimal text', async () => {
    const message = 'fix [example deadbeef]';
    const result = await commit(repo, message);
    const expected = (await git('rev-parse', '--short', 'HEAD')).stdout.trim();
    expect(result).toEqual({ hash: expected, message });
    expect(observation.results).toHaveLength(1);
    expect(observation.results[0].exitCode).toBe(0);
  });
});
