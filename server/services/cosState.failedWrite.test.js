import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';

const { tempRoot, makeProxy, spies, cleanup } = mockPathsDataRoot({
  prefix: 'cos-failed-write-', wrapExports: ['atomicWrite', 'ensureDirs', 'readJSONFileStrict'], makeSpy: vi.fn,
});
vi.mock('../lib/fileUtils.js', async importOriginal => makeProxy(await importOriginal()));
// Agent records are cos_agents rows (#12738): their write is the injectable failure point.
vi.mock('./cosAgentRepository.js', async importOriginal => {
  const real = await importOriginal();
  return { ...real, applyAgentSave: vi.fn(real.applyAgentSave) };
});

const cosDir = join(tempRoot, 'cos');
const statePath = join(cosDir, 'state.json');
const configPath = join(cosDir, 'config.json');
const binding = { branch: 'claim/issue-example', repository: 'github.com/example/project' };
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value));
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const writeFailure = () => Object.assign(new Error('Synthetic persistence failure'), { code: 'EIO' });
let store;
let repo;
let realWrite;
let realApply;
const storedAgents = async () => Object.fromEntries((await repo.loadAgentRows()).rows.map(row => [row.id, JSON.parse(row.body)]));

beforeEach(async () => {
  vi.resetModules();
  rmSync(cosDir, { force: true, recursive: true });
  mkdirSync(cosDir, { recursive: true });
  writeJson(configPath, { maxConcurrentAgents: 3 });
  writeJson(statePath, {});
  store = await import('./cosState.js');
  repo = await import('./cosAgentRepository.js');
  repo.__resetCosAgentRepository();
  realApply ??= repo.applyAgentSave.getMockImplementation();
  repo.applyAgentSave.mockReset().mockImplementation(realApply);
  await repo.__seedCosAgents({ example: { id: 'example', status: 'running', metadata: { claimBranches: [] } } });
  const actual = await vi.importActual('../lib/fileUtils.js');
  realWrite = actual.atomicWrite;
  for (const [name, spy] of Object.entries(spies)) spy.mockReset().mockImplementation(actual[name]);
});
afterAll(cleanup);

async function saveHealthCheck() {
  await store.withStateLock(async () => {
    const state = await store.loadState();
    state.lastHealthCheck = '2026-01-01T00:00:00.000Z';
    await store.saveState(state);
  });
}

describe('CoS failed persistence recovery', () => {
  it.each(['bind', 'release'])('does not carry a rejected %s into the next queued write or a stale retry', async action => {
    const durable = action === 'bind' ? [] : [binding];
    await repo.__seedCosAgents({ example: { status: 'running', metadata: { claimBranches: durable } } });
    let rejectedState;
    repo.applyAgentSave.mockRejectedValueOnce(writeFailure());
    await expect(store.withStateLock(async () => {
      const state = await store.loadState();
      rejectedState = { ...state, agents: { ...state.agents, example: {
        ...state.agents.example, metadata: { claimBranches: action === 'bind' ? [binding] : [] },
      } } };
      await store.saveState(rejectedState);
    })).rejects.toMatchObject({ code: 'EIO' });
    expect((await storedAgents()).example.metadata.claimBranches).toEqual(durable);
    await saveHealthCheck();
    expect((await storedAgents()).example.metadata.claimBranches).toEqual(durable);
    expect(readJson(statePath).lastHealthCheck).toBe('2026-01-01T00:00:00.000Z');
    await expect(store.saveState({ ...rejectedState })).rejects.toMatchObject({ code: 'COS_PERSISTENCE_STALE_WRITE' });
  });

  it('discards an existing agent lifecycle caller\'s in-place mutation after rejection', async () => {
    const { updateAgent } = await import('./cosAgentLifecycle.js');
    repo.applyAgentSave.mockRejectedValueOnce(writeFailure());
    await expect(updateAgent('example', { metadata: { claimBranches: [binding] } })).rejects.toMatchObject({ code: 'EIO' });
    await updateAgent('example', { status: 'paused' });
    expect((await storedAgents()).example).toMatchObject({ status: 'paused', metadata: { claimBranches: [] } });
  });

  it('reloads rejected in-place config changes and re-anchors a live runtime read independently', async () => {
    const state = await store.loadState();
    const failedConfig = state.config;
    spies.atomicWrite.mockRejectedValueOnce(writeFailure());
    await expect(store.withConfigLock(async () => {
      failedConfig.maxConcurrentAgents = 12;
      await store.saveConfig(failedConfig);
    })).rejects.toMatchObject({ code: 'EIO' });
    // An already-started runtime transaction remains valid after a config error.
    await store.withStateLock(async () => {
      state.paused = true;
      await store.saveState(state);
    });
    expect(state.config.maxConcurrentAgents).toBe(3);
    expect(readJson(statePath)).toMatchObject({ paused: true });
    expect(readJson(statePath)).not.toHaveProperty('config');
    await store.withConfigLock(async () => {
      const config = await store.loadConfig();
      expect((await store.loadState()).config).toBe(config);
      await store.saveConfig({ ...config, maxTotalProcesses: 20 });
    });
    expect(readJson(configPath)).toMatchObject({ maxConcurrentAgents: 3, maxTotalProcesses: 20 });
    await expect(store.saveConfig({ ...failedConfig })).rejects.toMatchObject({ code: 'COS_PERSISTENCE_STALE_WRITE' });
  });

  it.each(['state', 'config'])('reads the disk outcome when a %s write succeeds before reporting failure', async kind => {
    const load = kind === 'state' ? store.loadState : store.loadConfig;
    const save = kind === 'state' ? store.saveState : store.saveConfig;
    const queue = kind === 'state' ? store.withStateLock : store.withConfigLock;
    const path = kind === 'state' ? statePath : configPath;
    const value = await load();
    value.exampleCommitted = true;
    spies.atomicWrite.mockImplementationOnce(async (...args) => {
      await realWrite(...args);
      throw writeFailure();
    });
    await expect(queue(() => save(value))).rejects.toMatchObject({ code: 'EIO' });
    await queue(async () => {
      const current = await load();
      expect(current.exampleCommitted).toBe(true);
      current.exampleNextWrite = true;
      await save(current);
    });
    expect(readJson(path)).toMatchObject({ exampleCommitted: true, exampleNextWrite: true });
  });

  it.each(['state', 'config'])('refuses to default unreadable %s after a failed write until repaired', async kind => {
    const load = kind === 'state' ? store.loadState : store.loadConfig;
    const save = kind === 'state' ? store.saveState : store.saveConfig;
    const path = kind === 'state' ? statePath : configPath;
    const value = await load();
    spies.atomicWrite.mockImplementationOnce(async () => {
      writeFileSync(path, 'unreadable');
      throw writeFailure();
    });
    await expect(save(value)).rejects.toMatchObject({ code: 'EIO' });
    await expect(load()).rejects.toMatchObject({ code: 'COS_PERSISTENCE_RECOVERY_REQUIRED' });
    await expect(save({})).rejects.toMatchObject({ code: 'COS_PERSISTENCE_STALE_WRITE' });
    expect(readFileSync(path, 'utf8')).toBe('unreadable');
    writeJson(path, { repaired: true });
    await save(await load());
    expect(readJson(path).repaired).toBe(true);
  });

  it('reads the stored outcome when an agent row write commits before reporting failure', async () => {
    const value = await store.loadState();
    value.agents.example = { ...value.agents.example, status: 'completed' };
    repo.applyAgentSave.mockImplementationOnce(async (...args) => {
      await realApply(...args);
      throw writeFailure();
    });
    await expect(store.withStateLock(() => store.saveState(value))).rejects.toMatchObject({ code: 'EIO' });
    await store.withStateLock(async () => {
      const current = await store.loadState();
      expect(current.agents.example.status).toBe('completed');
      current.agents.example.metadata = { claimBranches: [binding] };
      await store.saveState(current);
    });
    expect((await storedAgents()).example).toMatchObject({ status: 'completed', metadata: { claimBranches: [binding] } });
  });

  it('retries a rejected legacy config split before runtime writes can remove the legacy settings', async () => {
    rmSync(configPath);
    writeJson(statePath, { config: { maxConcurrentAgents: 9 } });
    spies.atomicWrite.mockRejectedValueOnce(writeFailure());
    await expect(store.loadState()).rejects.toMatchObject({ code: 'EIO' });
    expect(readJson(statePath).config.maxConcurrentAgents).toBe(9);
    await saveHealthCheck();
    expect(readJson(configPath).maxConcurrentAgents).toBe(9);
    expect(readJson(statePath)).not.toHaveProperty('config');
  });

  it('shares a pending legacy split so a late loader cannot overwrite the next config update', async () => {
    rmSync(configPath);
    writeJson(statePath, { config: { maxConcurrentAgents: 9 } });
    spies.atomicWrite.mockRejectedValueOnce(writeFailure());
    await expect(store.saveConfig({ maxConcurrentAgents: 9 })).rejects.toMatchObject({ code: 'EIO' });
    // Keep the interleaving deterministic: only the first write waits; all
    // other file work is synchronous over these temporary synthetic files.
    spies.ensureDirs.mockResolvedValue(undefined);
    spies.readJSONFileStrict.mockImplementation(async (path, fallback) => ({
      ok: true, value: existsSync(path) ? readJson(path) : fallback,
    }));
    let releaseWrite;
    let signalStarted;
    const gate = new Promise(resolve => { releaseWrite = resolve; });
    const started = new Promise(resolve => { signalStarted = resolve; });
    let first = true;
    spies.atomicWrite.mockImplementation(async (path, value) => {
      if (first) {
        first = false;
        signalStarted();
        await gate;
      }
      writeJson(path, value);
    });
    const initial = store.loadConfig();
    await started;
    const update = store.withConfigLock(async () => {
      await store.saveConfig({ ...(await store.loadConfig()), maxConcurrentAgents: 5 });
    });
    // Drain the synchronous I/O doubles' promise continuations before allowing
    // the original split to finish, reproducing a late legacy overwrite.
    await new Promise(resolve => setImmediate(resolve));
    releaseWrite();
    await Promise.all([initial, update]);
    expect(readJson(configPath).maxConcurrentAgents).toBe(5);
    expect((await store.loadState()).config.maxConcurrentAgents).toBe(5);
  });

  it('keeps the state queue until the rejected write settles while config can progress', async () => {
    let rejectWrite;
    let signalStarted;
    const started = new Promise(resolve => { signalStarted = resolve; });
    repo.applyAgentSave.mockImplementationOnce(() => new Promise((resolve, reject) => {
      rejectWrite = reject;
      signalStarted();
    }));
    const failed = store.withStateLock(async () => {
      const state = await store.loadState();
      state.agents.example.metadata.claimBranches.push(binding);
      await store.saveState(state);
    });
    const failureAssertion = expect(failed).rejects.toMatchObject({ code: 'EIO' });
    await started;
    const next = saveHealthCheck();
    await store.withConfigLock(async () => {
      await store.saveConfig({ ...(await store.loadConfig()), maxConcurrentAgents: 5 });
    });
    expect(readJson(statePath)).not.toHaveProperty('lastHealthCheck');
    rejectWrite(writeFailure());
    await failureAssertion;
    await next;
    expect((await storedAgents()).example.metadata.claimBranches).toEqual([]);
    expect((await store.loadState()).config.maxConcurrentAgents).toBe(5);
  });
});
