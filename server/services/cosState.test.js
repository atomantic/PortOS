import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs';
import { join } from 'path';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';
import { __createManualClock } from '../lib/eventLoopLagProbe.js';

const { tempRoot, makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'cos-state-test-' });

vi.mock('../lib/fileUtils.js', async (importOriginal) => makeProxy(await importOriginal()));
// cosState's view of the backend choice; the repositories keep the real (in-memory) one.
const backendMode = vi.hoisted(() => ({ postgres: false }));
vi.mock('../lib/pgFileFacade.js', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, isFileBackend: () => !backendMode.postgres && real.isFileBackend() };
});
// Observe the row writes cosState sends, against the real in-memory backend.
vi.mock('./cosAgentRepository.js', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, applyAgentSave: vi.fn(real.applyAgentSave) };
});

const COS_DIR = join(tempRoot, 'cos');
const STATE_PATH = join(COS_DIR, 'state.json');
const CONFIG_PATH = join(COS_DIR, 'config.json');

afterAll(cleanup);

// The module caches state and config in memory, so every case needs a fresh
// module instance reading whatever the case just wrote to disk.
const freshModule = async () => {
  vi.resetModules();
  return import('./cosState.js');
};

const writeState = (state) => writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
// Agent records are cos_agents rows (#12738); seed them into the in-memory store
// the freshly imported cosState module uses.
const seedAgents = async (agents) => (await import('./cosAgentRepository.js')).__seedCosAgents(agents);
const storedAgents = async () => Object.fromEntries((await (await import('./cosAgentRepository.js')).loadAgentRows()).rows.map((row) => [row.id, JSON.parse(row.body)]));
const writeConfig = (config) => writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));
const quarantined = (prefix) => readdirSync(COS_DIR).filter(f => f.startsWith(`${prefix}.corrupted.`));

beforeEach(async () => {
  rmSync(COS_DIR, { recursive: true, force: true });
  mkdirSync(COS_DIR, { recursive: true });
  (await import('./cosAgentRepository.js')).__resetCosAgentRepository();
  backendMode.postgres = false;
});

describe('cosState persistence', () => {
  it('persists opted-in maintainer intent while absence stays disabled', async () => {
    let store = await freshModule();
    expect((await store.getConfig()).persistentMindMaintainer.enabled).toBe(false);
    writeConfig({ persistentMindMaintainer: { enabled: true, appIds: ['example-app'], intervalMinutes: 120 }, persistentMindPrompt: { instructions: 'Keep my voice.' } });
    store = await freshModule();
    const config = await store.getConfig();
    expect(config.persistentMindMaintainer).toEqual({ schemaVersion: 1, enabled: true, appIds: ['example-app'], intervalMinutes: 120,
      inference: { maxCallsPerTurn: 6, maxCallsPerDay: 48, maxPromptChars: 96000, maxCallMs: 120000,
        maxReservedMsPerDay: 5760000, paidPresetIds: [], maxPaidCallsPerDay: 0 } });
    await store.saveConfig(config);
    expect(readJson(CONFIG_PATH).persistentMindMaintainer.enabled).toBe(true);
    expect(readJson(CONFIG_PATH).persistentMindPrompt.instructions).toBe('Keep my voice.');
  });

  // The regression: a `}{` heuristic declared VALID state files corrupt as soon
  // as any stored string held that byte pair (a slashdo doc quoting
  // `{value}{ — project|global}`, a diff carrying JSX), and the fallback reset
  // every user setting to DEFAULT_CONFIG.
  it('keeps user config when a stored string contains "}{"', async () => {
    writeConfig({
      maxConcurrentAgents: 20,
      maxConcurrentAgentsPerProject: 12,
    });
    writeState({
      running: false,
      // Verbatim shape of the text that triggered the false positive.
      note: 'Using saved defaults: --review-with={value}{, --review-iterations=…}{ — project|global}',
    });

    const { loadState } = await freshModule();
    const state = await loadState();

    expect(state.config.maxConcurrentAgents).toBe(20);
    expect(state.config.maxConcurrentAgentsPerProject).toBe(12);
    expect(state.note).toContain('{value}{');
    // A valid file is never treated as corrupt, so nothing is quarantined.
    expect(quarantined('state.json')).toHaveLength(0);
  });

  it('keeps user config when config.json itself contains "}{"', async () => {
    writeConfig({
      maxConcurrentAgents: 20,
      persistentMindPrompt: { instructions: 'quote {value}{ — project|global} verbatim' },
    });

    const { getConfig } = await freshModule();
    const config = await getConfig();

    expect(config.maxConcurrentAgents).toBe(20);
    expect(config.persistentMindPrompt.instructions).toBe('quote {value}{ — project|global} verbatim');
    expect(quarantined('config.json')).toHaveLength(0);
  });

  it('reports a "}{"-carrying state file as trusted to the update safety gate', async () => {
    const { readAgentsStateForSafetyCheck } = await freshModule();
    await seedAgents({ 'agent-1': { id: 'agent-1', status: 'running', prompt: 'a }{ b' } });

    // `trusted: false` here would make the update gate treat a live agent as
    // "records unreadable" and demand a manual state.json restore.
    await expect(readAgentsStateForSafetyCheck()).resolves.toEqual({
      trusted: true,
      agents: { 'agent-1': { id: 'agent-1', status: 'running', prompt: 'a }{ b' } },
    });
  });

  it('preserves durable merge leases across reloads and does not default malformed ownership', async () => {
    const lease = { kind: 'agent', agentId: 'parent', repository: 'github.com/example/repo', token: 'example-token' };
    writeState({ agents: {}, mergeAdmissions: { [lease.repository]: lease } });
    let store = await freshModule();
    await store.saveState(await store.loadState());
    store = await freshModule();
    expect(await store.readMergeAdmissionStateForSafetyCheck()).toEqual({
      trusted: true, agents: {}, mergeAdmissions: { [lease.repository]: lease },
    });
    writeState({ agents: {}, mergeAdmissions: null });
    expect((await store.readMergeAdmissionStateForSafetyCheck()).mergeAdmissions).toBeNull();
    writeFileSync(STATE_PATH, 'broken');
    expect((await store.readMergeAdmissionStateForSafetyCheck()).trusted).toBe(false);
  });

  // The split's version of what the sidecar used to buy: config lives in its
  // own file, so an unreadable state.json cannot take the settings with it.
  it('keeps config when state.json becomes unreadable', async () => {
    const saved = await freshModule();
    await saved.saveConfig({
      ...(await saved.loadConfig()),
      maxConcurrentAgents: 20,
      maxConcurrentAgentsPerProject: 12,
    });

    // A double-append: two complete objects concatenated. JSON.parse rejects it.
    writeFileSync(STATE_PATH, `${JSON.stringify({ running: true })}${JSON.stringify({ running: true })}`);

    const { loadState, DEFAULT_CONFIG } = await freshModule();
    const recovered = await loadState();

    expect(recovered.config.maxConcurrentAgents).toBe(20);
    expect(recovered.config.maxConcurrentAgentsPerProject).toBe(12);
    // Settings the user never changed still come from the shipped defaults.
    expect(recovered.config.maxTotalProcesses).toBe(DEFAULT_CONFIG.maxTotalProcesses);
    // The bad bytes stay inspectable.
    expect(recovered.agents).toEqual({});
    expect(quarantined('state.json')).toHaveLength(1);
  });
});

describe('CoS config lives in its own file', () => {
  it('never writes config back into state.json', async () => {
    writeConfig({ maxConcurrentAgents: 9 });
    writeState({ running: true });
    const { loadState, saveState, getConfig } = await freshModule();
    await seedAgents({ a1: { status: 'running' } });

    const state = await loadState();
    expect(state.config.maxConcurrentAgents).toBe(9);
    // Absent keys still fall back to the shipped defaults.
    expect(state.config.maxConcurrentAgentsPerProject).toBe(2);
    await expect(getConfig()).resolves.toBe(state.config);

    state.agents.a2 = { status: 'running' };
    await saveState(state);

    const persisted = readJson(STATE_PATH);
    expect(persisted.config).toBeUndefined();
    expect(persisted.agents).toBeUndefined();
    expect(Object.keys(await storedAgents())).toEqual(['a1', 'a2']);
    // config.json is untouched by a runtime-record write.
    expect(readJson(CONFIG_PATH)).toEqual({ maxConcurrentAgents: 9 });
  });

  it('saveConfig writes only config.json and refreshes a live state read', async () => {
    writeState({ running: false, agents: {} });
    const { loadState, loadConfig, saveConfig } = await freshModule();

    const state = await loadState();
    await saveConfig({ ...(await loadConfig()), maxConcurrentAgents: 5 });

    expect(readJson(CONFIG_PATH).maxConcurrentAgents).toBe(5);
    // The already-loaded state object must not go stale behind the write.
    expect(state.config.maxConcurrentAgents).toBe(5);
    expect(readJson(STATE_PATH).config).toBeUndefined();
  });

  // The shipped default is the ONLY thing stopping a never-configured install
  // from auto-starting CoS (server/services/cos.js reads
  // `alwaysOn || autoStart || state.running` at boot — and a fresh install's
  // state.running is false) and with it every work-generation flag that defaults
  // on. That used to be enforced by a data.reference/cos/config.json seed, which
  // was deleted in #6182's repair (migration 340) — so nothing but this literal
  // enforces AGENTS.md's "No cold-bootstrap LLM calls" for a fresh install now.
  it('defaults alwaysOn off so a fresh install never auto-starts CoS', async () => {
    const { DEFAULT_CONFIG } = await freshModule();
    expect(DEFAULT_CONFIG.alwaysOn).toBe(false);
    expect(DEFAULT_CONFIG.autoStart).toBe(false);
  });

  // Back-compat: an un-upgraded peer, or a restored pre-split backup, still
  // carries `config` inside state.json.
  it('falls back to a legacy config slice still sitting in state.json', async () => {
    // alwaysOn is stored as `true` on purpose: DEFAULT_CONFIG ships `false`, so a
    // stored `false` would assert nothing — it would pass identically if the
    // legacy fallback were deleted outright.
    writeState({ running: false, config: { maxConcurrentAgents: 11, alwaysOn: true }, agents: {} });
    const { getConfig } = await freshModule();

    const config = await getConfig();
    expect(config.maxConcurrentAgents).toBe(11);
    expect(config.alwaysOn).toBe(true);
  });

  it('prefers config.json over a stale legacy slice when both exist', async () => {
    writeConfig({ maxConcurrentAgents: 4 });
    writeState({ running: false, config: { maxConcurrentAgents: 99 }, agents: {} });
    const { loadState } = await freshModule();

    expect((await loadState()).config.maxConcurrentAgents).toBe(4);
  });

  // A recovered legacy slice exists only in memory; the very next saveState
  // strips `config` out of state.json, so failing to complete the split here
  // destroys the user's settings on the following restart.
  it('completes the split when it recovers config from a legacy state.json', async () => {
    writeState({ running: false, config: { maxConcurrentAgents: 11 }, agents: {} });
    const { loadState, saveState } = await freshModule();

    const state = await loadState();
    expect(readJson(CONFIG_PATH).maxConcurrentAgents).toBe(11);

    await saveState(state);
    expect(readJson(STATE_PATH).config).toBeUndefined();
    // Survives the restart that the strip above would otherwise have broken.
    const { getConfig } = await freshModule();
    expect((await getConfig()).maxConcurrentAgents).toBe(11);
  });

  // Config is owned by config.json. A state snapshot taken before a concurrent
  // updateConfig carries a stale copy; publishing it from saveState would
  // silently roll the user's settings back.
  it('never lets a stale state.config clobber config.json', async () => {
    writeConfig({ maxConcurrentAgents: 3 });
    writeState({ running: false, agents: {} });
    const { loadState, loadConfig, saveConfig, saveState } = await freshModule();

    const snapshot = { ...(await loadState()) };
    await saveConfig({ ...(await loadConfig()), maxConcurrentAgents: 8 });

    await saveState(snapshot);

    expect(readJson(CONFIG_PATH).maxConcurrentAgents).toBe(8);
    expect(readJson(STATE_PATH).config).toBeUndefined();
    // The re-anchored snapshot reports the live config, not its stale copy.
    expect(snapshot.config.maxConcurrentAgents).toBe(8);
  });

  // saveState() caches whatever it is handed; a state built without `config`
  // would otherwise leave every later `state.config.…` reader on undefined.
  it('re-anchors config when handed a state that carries none', async () => {
    writeConfig({ maxConcurrentAgents: 3 });
    const { saveState, loadState } = await freshModule();

    await saveState({ running: true, agents: {} });

    expect((await loadState()).config.maxConcurrentAgents).toBe(3);
  });
});

describe('config recovery', () => {
  it('quarantines a truncated config.json and moves it out of the active path', async () => {
    writeFileSync(CONFIG_PATH, '{"maxConcurrentAgents": 3');
    const { getConfig, DEFAULT_CONFIG } = await freshModule();

    expect((await getConfig()).maxConcurrentAgents).toBe(DEFAULT_CONFIG.maxConcurrentAgents);
    expect(quarantined('config.json')).toHaveLength(1);
    // Moved, not copied — config.json is written only when the user changes a
    // setting, so a copy left in place would be re-quarantined on every boot.
    expect(existsSync(CONFIG_PATH)).toBe(false);
  });

  it('quarantines a config.json that parses as a non-object', async () => {
    writeFileSync(CONFIG_PATH, '["not", "a", "config"]');
    const { getConfig, DEFAULT_CONFIG } = await freshModule();

    expect((await getConfig()).maxConcurrentAgents).toBe(DEFAULT_CONFIG.maxConcurrentAgents);
    expect(quarantined('config.json')).toHaveLength(1);
  });
});

// Warm-process regression: queued writes must use the restored pre-images.
describe('live CoS restore boundary', () => {
  it('drains older writes and merges queued mutations over restored files', async () => {
    writeConfig({ persistentMindPrompt: { instructions: 'Before restore' } });
    writeState({ agents: {}, stats: { tasksCompleted: 2 } });
    const store = await freshModule();
    const staleState = { ...(await store.loadState()) };
    const staleConfig = { ...(await store.loadConfig()) };
    const changed = vi.fn();
    (await import('./cosEvents.js')).cosEvents.once('config:changed', changed);
    let finishOldWrite;
    const oldWriteGate = new Promise(resolve => { finishOldWrite = resolve; });
    const oldWrite = store.withStateLock(async () => {
      const state = await store.loadState();
      await oldWriteGate;
      state.stats.tasksCompleted = 3;
      await store.saveState(state);
    });
    let finishTransfer;
    let transferStarted;
    const started = new Promise(resolve => { transferStarted = resolve; });
    const transferGate = new Promise(resolve => { finishTransfer = resolve; });
    const restore = store.withLiveCosRestore(async () => {
      expect(readJson(STATE_PATH).stats.tasksCompleted).toBe(3);
      writeConfig({ persistentMindPrompt: { instructions: 'Restored instructions' } });
      writeState({ agents: {}, stats: { tasksCompleted: 42 } });
      transferStarted();
      await transferGate;
      return 'restored';
    });
    finishOldWrite();
    await oldWrite;
    await started;
    const configWrite = store.withConfigLock(async () => {
      await store.saveConfig({ ...(await store.loadConfig()), maxConcurrentAgents: 7 });
    });
    const stateWrite = store.withStateLock(async () => {
      const state = await store.loadState();
      state.stats.tasksFailed = 1;
      await store.saveState(state);
    });
    finishTransfer();
    await expect(restore).resolves.toBe('restored');
    await Promise.all([configWrite, stateWrite]);
    expect((await store.getConfig()).persistentMindPrompt.instructions).toBe('Restored instructions');
    expect(readJson(CONFIG_PATH)).toMatchObject({ maxConcurrentAgents: 7, persistentMindPrompt: { instructions: 'Restored instructions' } });
    expect(readJson(STATE_PATH).stats).toMatchObject({ tasksCompleted: 42, tasksFailed: 1 });
    await expect(store.withStateLock(() => store.saveState(staleState))).rejects.toMatchObject({ code: 'COS_RESTORE_STALE_WRITE' });
    await expect(store.withConfigLock(() => store.saveConfig(staleConfig))).rejects.toMatchObject({ code: 'COS_RESTORE_STALE_WRITE' });
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ persistentMindPrompt: expect.objectContaining({ instructions: 'Restored instructions' }) }));
  });

  it.each([false, true])('reloads a warm archive index after transfer (partial failure: %s)', async fails => {
    writeState({ agents: {} });
    const store = await freshModule();
    const index = await import('./cosAgentIndex.js');
    const { acquireBackupSnapshotCut } = await import('../lib/backupSnapshotBoundary.js');
    const indexPath = join(COS_DIR, 'agents', 'index.json');
    mkdirSync(join(COS_DIR, 'agents'), { recursive: true });
    writeFileSync(indexPath, JSON.stringify({ 'agent-example': '2026-01-01' }));
    await index.loadAgentIndex();
    expect(index.getAgentDir('agent-example')).toBe(join(COS_DIR, 'agents', '2026-01-01', 'agent-example'));
    const release = await acquireBackupSnapshotCut();
    try {
      const transfer = store.withLiveCosRestore(async () => {
        writeFileSync(indexPath, JSON.stringify({ 'agent-example': '2026-02-02' }));
        if (fails) throw new Error('partial transfer');
      });
      if (fails) await expect(transfer).rejects.toThrow('partial transfer');
      else await transfer;
      expect(index.getAgentDir('agent-example')).toBe(join(COS_DIR, 'agents', '2026-02-02', 'agent-example'));
      expect((await index.loadAgentIndex()).get('agent-example')).toBe('2026-02-02');
    } finally { release(); }
  });

  it('lets an archive publication queued behind restore use the restored index', async () => {
    writeState({ agents: {} });
    const store = await freshModule();
    const index = await import('./cosAgentIndex.js');
    const { acquireBackupSnapshotCut, withBackupAssetPublication } = await import('../lib/backupSnapshotBoundary.js');
    const indexPath = join(COS_DIR, 'agents', 'index.json');
    mkdirSync(join(COS_DIR, 'agents'), { recursive: true });
    writeFileSync(indexPath, JSON.stringify({ 'agent-old': '2026-01-01' }));
    await index.loadAgentIndex();
    const release = await acquireBackupSnapshotCut();
    let entered = false;
    const writer = withBackupAssetPublication(async () => {
      entered = true;
      return index.addAgentArchivesToIndex([{ agentId: 'agent-new', date: '2026-03-03' }]);
    });
    try {
      await store.withLiveCosRestore(async () => {
        writeFileSync(indexPath, JSON.stringify({ 'agent-restored': '2026-02-02' }));
      });
      expect(entered).toBe(false);
    } finally { release(); }
    await writer;
    expect(readJson(indexPath)).toEqual({ 'agent-restored': '2026-02-02', 'agent-new': '2026-03-03' });
  });

  it('clears a removed index without running migration behind the restore cut', async () => {
    writeState({ agents: {} });
    const store = await freshModule();
    const index = await import('./cosAgentIndex.js');
    const { acquireBackupSnapshotCut } = await import('../lib/backupSnapshotBoundary.js');
    const indexPath = join(COS_DIR, 'agents', 'index.json');
    mkdirSync(join(COS_DIR, 'agents'), { recursive: true });
    writeFileSync(indexPath, JSON.stringify({ 'agent-example': '2026-01-01' }));
    await index.loadAgentIndex();
    const release = await acquireBackupSnapshotCut();
    try {
      await store.withLiveCosRestore(async () => { rmSync(indexPath); });
      expect(existsSync(indexPath)).toBe(false);
      expect(index.getAgentDir('agent-example')).toBe(join(COS_DIR, 'agents', 'agent-example'));
    } finally { release(); }
    expect((await index.loadAgentIndex()).size).toBe(0);
    expect(existsSync(indexPath)).toBe(true);
  });

  it('reloads partial transfer results while preserving the transfer failure', async () => {
    writeConfig({ persistentMindPrompt: { instructions: 'Old' } });
    writeState({ agents: {} });
    const store = await freshModule();
    await store.loadState();
    const failure = new Error('rsync failed');
    await expect(store.withLiveCosRestore(async () => {
      writeConfig({ persistentMindPrompt: { instructions: 'Partial restore' } });
      throw failure;
    })).rejects.toBe(failure);
    await store.withConfigLock(async () => store.saveConfig({ ...(await store.loadConfig()), maxConcurrentAgents: 8 }));
    expect(readJson(CONFIG_PATH).persistentMindPrompt.instructions).toBe('Partial restore');
  });

  // A pre-#6182 snapshot keeps its config in state.json and ships no
  // config.json, so the live config.json is newer than the restore point.
  it.each([
    { name: 'first restore', liveSlice: null, landed: true, legacy: true, expected: 7, parked: true },
    { name: 'repeat restore', liveSlice: { maxConcurrentAgents: 7 }, landed: true, legacy: true, expected: 7, parked: true },
    // 339 can leave a config-first copy in both files; a failed transfer installed nothing.
    { name: 'failed transfer over a matching live slice', liveSlice: { maxConcurrentAgents: 7 }, landed: false, legacy: true, expected: 3, parked: false },
    { name: 'snapshot has config.json', liveSlice: null, landed: true, legacy: false, expected: 5, parked: false },
  ])('restores the snapshot config over a newer config.json: $name', async ({ liveSlice, landed, legacy, expected, parked }) => {
    writeConfig({ maxConcurrentAgents: 3 });
    writeState(liveSlice ? { agents: {}, config: liveSlice } : { agents: {} });
    const store = await freshModule();
    const restore = store.withLiveCosRestore(async () => {
      if (!landed) throw new Error('rsync failed');
      if (!legacy) writeConfig({ maxConcurrentAgents: 5 });
      writeState({ agents: {}, config: { maxConcurrentAgents: 7 } });
    }, { snapshotLegacyConfig: legacy ? { maxConcurrentAgents: 7 } : null });
    if (landed) await restore;
    else await expect(restore).rejects.toThrow('rsync failed');
    expect((await store.getConfig()).maxConcurrentAgents).toBe(expected);
    expect(readJson(CONFIG_PATH).maxConcurrentAgents).toBe(expected);
    const aside = readdirSync(COS_DIR).filter(f => f.startsWith('config.pre-restore-'));
    expect(aside).toHaveLength(parked ? 1 : 0);
    if (parked) expect(readJson(join(COS_DIR, aside[0]))).toEqual({ maxConcurrentAgents: 3 });
  });

  it.each([
    { running: true, agents: {} },
    { agents: { example: { status: 'running' } } },
    { agents: { example: { status: 'paused' } } },
    { agents: {}, persistentMind: { started: true } },
    { agents: {}, persistentMind: { activeTurn: { id: 'example-turn' } } },
  ])('refuses unsafe ownership before transferring: %j', async ({ agents, ...state }) => {
    writeState(state);
    const store = await freshModule();
    await seedAgents(agents);
    const transfer = vi.fn();
    await expect(store.withLiveCosRestore(transfer)).rejects.toMatchObject({ code: 'COS_RESTORE_BUSY' });
    expect(transfer).not.toHaveBeenCalled();
    expect(readJson(STATE_PATH)).toEqual(state);
    expect(await storedAgents()).toEqual(agents);
  });

  it('refuses unreadable runtime records without overwriting them', async () => {
    writeFileSync(STATE_PATH, '{broken');
    const store = await freshModule();
    const transfer = vi.fn();
    await expect(store.withLiveCosRestore(transfer)).rejects.toMatchObject({ code: 'COS_RESTORE_BUSY' });
    expect(transfer).not.toHaveBeenCalled();
    expect(readFileSync(STATE_PATH, 'utf8')).toBe('{broken');
  });
});

// #12329: a slow state operation must separate durable-write stages and
// event-loop lag, logging only bounded numbers.
describe('state operation slow diagnostics', () => {
  it('reports each persistence stage, splits a slow write into I/O wait and loop lag, and attributes only lag over 1 s', async () => {
    const store = await freshModule();
    const clock = __createManualClock();
    // Process/host counters a test moves by hand alongside the clock (#12852).
    const counters = { cpuUs: 0, gcMs: 0, switches: 0 };
    const resources = {
      cpuUsage: () => ({ user: counters.cpuUs, system: 0 }),
      loadavg: () => [7.5, 6, 5],
      cpus: () => 8,
      involuntaryContextSwitches: () => counters.switches,
      gc: { begin: () => { const since = counters.gcMs; return { ms: () => counters.gcMs - since, end: () => {} }; } },
    };
    store.__setCosStateDiagnosticsClockForTests(clock, resources);
    const warn = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const stages = [];
      await store.saveState(await store.loadState(), { onStage: (stage) => {
        stages.push(stage);
        if (stage === 'write') clock.advance(1500);
        if (stage === 'dirSync') clock.stall(600);
      } });
      expect(stages).toEqual(['prepare', 'agents', 'serialize', 'write', 'replace', 'dirSync']);
      expect(readJson(STATE_PATH).agents).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/^🐢 CoS state write slow outcome=saved totalMs=2100 prepareMs=0 agentsMs=0 serializeMs=0 writeMs=1500 replaceMs=0 dirSyncMs=600 loopLagMs=500 loopLagMaxMs=500 sizeKiB=\d+$/);

      warn.mockClear();
      await store.withStateLock(async () => clock.advance(200));
      expect(warn).not.toHaveBeenCalled();
      // Over 1 s of lag, the line attributes it: here the process itself was
      // busy (cpuMs near heldMs), a quarter of it in GC.
      await store.withStateLock(async () => {
        clock.stall(1200);
        Object.assign(counters, { cpuUs: counters.cpuUs + 1_150_000, gcMs: counters.gcMs + 300, switches: counters.switches + 42 });
      });
      expect(warn.mock.calls.map(([line]) => line)).toEqual(['🐢 CoS state queue slow hold heldMs=1200 waitMs=0 loopLagMs=1100 loopLagMaxMs=1100 cpuMs=1150 load1=7.5 cpus=8 gcMs=300 invCtx=42']);
    } finally {
      store.__setCosStateDiagnosticsClockForTests(null);
      warn.mockRestore();
    }
  });
});

// #12738: agent records are cos_agents rows, written per changed row.
describe('agent records in cos_agents', () => {
  const agent = (n, extra = {}) => ({ id: `agent-example-${n}`, taskId: `task-example-${n}`, status: 'running', output: [], ...extra });

  it('loses no concurrent update and writes only the changed row per update', async () => {
    const store = await freshModule();
    const repo = await import('./cosAgentRepository.js');
    const agents = Object.fromEntries(Array.from({ length: 8 }, (_, n) => [agent(n).id, agent(n)]));
    await seedAgents(agents);
    await store.saveState(await store.loadState());
    const fileWrite = statSync(STATE_PATH).mtimeMs;
    repo.applyAgentSave.mockClear();

    await Promise.all(Object.keys(agents).map((agentId, n) => store.withStateLock(async () => {
      const state = await store.loadState();
      state.agents[agentId] = { ...state.agents[agentId], status: 'completed', output: [`line ${n}`] };
      await store.saveState(state);
    })));

    const stored = await storedAgents();
    expect(Object.values(stored).map((record) => record.status)).toEqual(Array(8).fill('completed'));
    expect(stored[agent(3).id].output).toEqual(['line 3']);
    const writes = repo.applyAgentSave.mock.calls.map(([plan]) => plan);
    expect(writes).toHaveLength(8);
    expect(writes.every((plan) => plan.upserts.length === 1 && plan.deletes.length === 0)).toBe(true);
    // Nothing outside the agent map changed, so state.json was not rewritten.
    expect(statSync(STATE_PATH).mtimeMs).toBe(fileWrite);
    expect(readJson(STATE_PATH).agents).toBeUndefined();
  });

  it('keeps agent records when state.json becomes unreadable', async () => {
    const store = await freshModule();
    await seedAgents({ [agent(1).id]: agent(1) });
    writeFileSync(STATE_PATH, '{broken');
    expect((await store.loadState()).agents).toEqual({ [agent(1).id]: agent(1) });
  });

  it('ignores a legacy agents map left in state.json and drops it on the next save', async () => {
    writeState({ running: false, agents: { [agent(1).id]: agent(1) } });
    const store = await freshModule();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const state = await store.loadState();
      expect(state.agents).toEqual({});
      expect(warn.mock.calls.some(([line]) => line.includes('legacy agents map'))).toBe(true);
      await store.saveState(state);
      expect(readJson(STATE_PATH)).not.toHaveProperty('agents');
    } finally {
      warn.mockRestore();
    }
  });

  it('refuses a save planned on a cache the store has moved past, then reloads from the store', async () => {
    const store = await freshModule();
    await seedAgents({ [agent(1).id]: agent(1) });
    const state = await store.loadState();
    // The store changes underneath the cache (a database restore, say).
    await seedAgents({ [agent(2).id]: agent(2) });
    state.agents[agent(1).id].status = 'completed';
    await expect(store.saveState(state)).rejects.toMatchObject({ code: 'COS_AGENTS_STALE' });
    expect(await storedAgents()).toEqual({ [agent(2).id]: agent(2) });
    expect(Object.keys((await store.loadState()).agents)).toEqual([agent(2).id]);
  });

  it('serializes only hinted records on saveState with changedAgentIds', async () => {
    const store = await freshModule();
    const agents = Object.fromEntries(Array.from({ length: 5 }, (_, n) => [agent(n).id, agent(n)]));
    await seedAgents(agents);
    const state = await store.loadState();
    await store.saveState(state);

    state.agents[agent(2).id] = { ...state.agents[agent(2).id], output: ['hinted-line'] };
    const stringifySpy = vi.spyOn(JSON, 'stringify');

    try {
      await store.saveState(state, { changedAgentIds: [agent(2).id] });
      const serializedAgentIds = stringifySpy.mock.calls
        .map(([arg]) => arg?.id)
        .filter((id) => typeof id === 'string' && id.startsWith('agent-example-'));
      expect(serializedAgentIds).toEqual([agent(2).id]);
    } finally {
      stringifySpy.mockRestore();
    }

    const stored = await storedAgents();
    expect(stored[agent(2).id].output).toEqual(['hinted-line']);
  });

  it('preserves an omitted changed agent across a hinted save so the next unhinted save detects it', async () => {
    const store = await freshModule();
    await seedAgents({ [agent(1).id]: agent(1), [agent(2).id]: agent(2) });
    const state = await store.loadState();
    await store.saveState(state);

    // Both are modified in memory
    state.agents[agent(1).id] = { ...state.agents[agent(1).id], status: 'completed' };
    state.agents[agent(2).id] = { ...state.agents[agent(2).id], status: 'failed' };

    // Hinted save omits agent(2)
    await store.saveState(state, { changedAgentIds: [agent(1).id] });
    let stored = await storedAgents();
    expect(stored[agent(1).id].status).toBe('completed');
    expect(stored[agent(2).id].status).toBe('running'); // not saved yet!

    // Next save runs unhinted: detects the previously omitted agent(2) change
    await store.saveState(state);
    stored = await storedAgents();
    expect(stored[agent(2).id].status).toBe('failed');
  });

  it('scales efficiently with a synthetic 219-agent fixture: serializes only the hinted record', async () => {
    const store = await freshModule();
    const agents = Object.fromEntries(Array.from({ length: 219 }, (_, n) => [
      agent(n).id,
      agent(n, { output: Array.from({ length: 50 }, (_, i) => `line ${i} for agent ${n} with padding text`) }),
    ]));
    await seedAgents(agents);
    const state = await store.loadState();
    await store.saveState(state);

    const targetId = agent(42).id;
    state.agents[targetId] = { ...state.agents[targetId], output: ['new output line'] };

    const stringifySpy = vi.spyOn(JSON, 'stringify');
    try {
      await store.saveState(state, { changedAgentIds: [targetId] });
      const serializedAgentIds = stringifySpy.mock.calls
        .map(([arg]) => arg?.id)
        .filter((id) => typeof id === 'string' && id.startsWith('agent-example-'));
      // Only the single hinted agent was serialized, NOT all 219 agents
      expect(serializedAgentIds).toEqual([targetId]);
    } finally {
      stringifySpy.mockRestore();
    }

    const stored = await storedAgents();
    expect(stored[targetId].output).toEqual(['new output line']);
  });

  it('sweeps stale state.json temp files from other processes, never its own or a fresh one', async () => {
    const uuid = '0123abcd-0123-4567-89ab-0123456789ab';
    const names = {
      stale: `state.json.${process.pid + 1}.1000.${uuid}.tmp`,
      own: `state.json.${process.pid}.1000.${uuid}.tmp`,
      fresh: `state.json.${process.pid + 2}.1000.${uuid}.tmp`,
      unrelated: `config.json.${process.pid + 1}.1000.${uuid}.tmp`,
    };
    for (const name of Object.values(names)) writeFileSync(join(COS_DIR, name), '{}');
    const old = new Date(Date.now() - 5 * 60_000);
    for (const key of ['stale', 'own', 'unrelated']) utimesSync(join(COS_DIR, names[key]), old, old);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const store = await freshModule();
      await store.loadState();
      const left = readdirSync(COS_DIR);
      expect(left).not.toContain(names.stale);
      expect(left).toEqual(expect.arrayContaining([names.own, names.fresh, names.unrelated]));
    } finally {
      log.mockRestore();
    }
  });
});

// Boot starts CoS before the database phase runs db-migrations 020/021.
describe('agent migration boot gate', () => {
  const legacy = { 'agent-example-1': { id: 'agent-example-1', status: 'completed' } };

  it('holds a read of a legacy agents map until the migrations settle, so no save can drop it first', async () => {
    writeState({ running: false, agents: legacy });
    backendMode.postgres = true;
    const store = await freshModule();
    let loaded = null;
    const load = store.loadState().then((state) => { loaded = state; });
    const save = store.saveState({ running: true, agents: {} });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(loaded).toBeNull();
    // Nothing touched the file while the import was pending.
    expect(readJson(STATE_PATH).agents).toEqual(legacy);

    // What 020 + 021 leave behind: the rows, and a file without the map.
    await seedAgents(legacy);
    writeState({ running: false });
    store.markCosAgentMigrationsSettled();
    await Promise.all([load, save]);
    expect(loaded.agents).toEqual(legacy);
  });

  it('never waits once the map is gone', async () => {
    writeState({ running: false });
    backendMode.postgres = true;
    const store = await freshModule();
    await seedAgents(legacy);
    expect((await store.loadState()).agents).toEqual(legacy);
  });
});
