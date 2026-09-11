import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { EventEmitter } from 'events';
import { makePathsProxy } from '../lib/mockPathsDataRoot.js';

const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'integration-writeback-'));
const fault = vi.hoisted(() => ({ path: null }));
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readFile: (...args) => String(args[0]) === fault.path
      ? Promise.reject(Object.assign(new Error('injected read denial'), { code: 'EACCES' }))
      : actual.readFile(...args),
  };
});
vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: TEST_DATA_ROOT }));
vi.mock('./settings.js', () => ({ getSettings: vi.fn(), updateSettings: vi.fn() }));
vi.mock('../lib/childProcess.js', async (importOriginal) => ({
  ...await importOriginal(),
  spawn: (_command, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    queueMicrotask(() => {
      const output = args[0] === 'repo'
        ? JSON.stringify([{ name: 'sample', nameWithOwner: 'test-owner/sample' }])
        : args[0] === 'auth' ? 'test-token' : 'test-owner';
      child.stdout.emit('data', output);
      child.emit('close', 0);
    });
    return child;
  },
}));

const calendar = await import('./calendarAccounts.js');
const datadog = await import('./datadog.js');
const github = await import('./github.js');
const obsidian = await import('./obsidian.js');
const updates = await import('./updateChecker.js');
const tools = await import('./tools.js');
const { PATHS } = await import('../lib/fileUtils.js');

const stores = [
  {
    name: 'calendar accounts', path: join(PATHS.calendar, 'accounts.json'),
    seed: { existing: { id: 'existing', name: 'Existing' } },
    mutate: () => calendar.createAccount({ name: 'New', type: 'outlook-calendar' }),
    preserved: data => data.existing,
    initialized: data => Object.values(data).some(account => account.name === 'New'),
  },
  {
    name: 'Datadog instances', path: join(PATHS.data, 'datadog.json'),
    seed: { instances: { existing: { name: 'Existing', site: 'api.datadoghq.com' } } },
    mutate: () => datadog.upsertInstance('new', { name: 'New', site: 'api.datadoghq.com' }),
    preserved: data => data.instances.existing,
    initialized: data => data.instances.new.name === 'New',
  },
  {
    name: 'GitHub repository configuration', path: join(PATHS.data, 'github-repos.json'),
    seed: {
      repos: { 'test-owner/sample': { fullName: 'test-owner/sample', flags: { npmProject: true }, managedSecrets: ['EXAMPLE'] } },
      secrets: {}, githubUser: 'test-owner',
    },
    mutate: () => github.syncRepos(),
    preserved: data => data.repos['test-owner/sample'].flags,
    initialized: data => data.repos['test-owner/sample'].fullName === 'test-owner/sample',
  },
  {
    name: 'Obsidian vault configuration', path: join(PATHS.brain, 'obsidian-vaults.json'),
    seed: { vaults: [{ id: 'existing', name: 'Existing', path: '/example/old-vault' }] },
    mutate: () => obsidian.addVault({ name: 'New', path: TEST_DATA_ROOT }),
    preserved: data => data.vaults[0],
    initialized: data => data.vaults[0].name === 'New',
  },
  {
    name: 'update preferences', path: join(PATHS.data, 'update.json'),
    seed: { ignoredVersions: ['1.0.0'], lastUpdateResult: { success: false, error: 'existing result' } },
    mutate: () => updates.ignoreVersion('2.0.0'),
    preserved: data => data.lastUpdateResult,
    initialized: data => data.ignoredVersions.includes('2.0.0'),
  },
];

beforeEach(() => {
  fault.path = null;
  github.__resetGitHubDataCache();
  rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
  mkdirSync(TEST_DATA_ROOT, { recursive: true });
});
afterAll(() => rmSync(TEST_DATA_ROOT, { recursive: true, force: true }));

// These service boundaries uniquely prove each store cannot persist its fallback,
// using real IO rather than assertions that a mocked reader received strict:true.
describe.each(stores)('$name durable write-back', store => {
  it.each(['{"truncated":', ''])('preserves unreadable bytes (%j) and can retry after repair', async bytes => {
    mkdirSync(dirname(store.path), { recursive: true });
    writeFileSync(store.path, bytes);
    await expect(store.mutate()).rejects.toThrow('Unreadable JSON file');
    expect(readFileSync(store.path, 'utf8')).toBe(bytes);

    writeFileSync(store.path, JSON.stringify(store.seed));
    await store.mutate();
    const saved = JSON.parse(readFileSync(store.path, 'utf8'));
    expect(store.preserved(saved)).toEqual(store.preserved(store.seed));
  });

  it('preserves existing bytes on a filesystem read failure', async () => {
    mkdirSync(dirname(store.path), { recursive: true });
    const bytes = JSON.stringify(store.seed);
    writeFileSync(store.path, bytes);
    fault.path = store.path;
    await expect(store.mutate()).rejects.toThrow('Unreadable JSON file');
    expect(readFileSync(store.path, 'utf8')).toBe(bytes);
  });

  it('initializes an absent file through the mutation entry point', async () => {
    await store.mutate();
    expect(store.initialized(JSON.parse(readFileSync(store.path, 'utf8')))).toBe(true);
  });
});

it('tool updates already refuse to rewrite an unreadable record', async () => {
  const path = join(PATHS.tools, 'existing.json');
  mkdirSync(dirname(path), { recursive: true });
  const bytes = '{"truncated":';
  writeFileSync(path, bytes);
  expect(await tools.updateTool('existing', { name: 'Changed' })).toBeNull();
  expect(readFileSync(path, 'utf8')).toBe(bytes);
});
