import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';

const { tempRoot, makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'cos-state-test-' });

vi.mock('../lib/fileUtils.js', async (importOriginal) => makeProxy(await importOriginal()));

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
const writeConfig = (config) => writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));
const quarantined = (prefix) => readdirSync(COS_DIR).filter(f => f.startsWith(`${prefix}.corrupted.`));

beforeEach(() => {
  rmSync(COS_DIR, { recursive: true, force: true });
  mkdirSync(COS_DIR, { recursive: true });
});

describe('cosState persistence', () => {
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
      agents: {
        'agent-1': {
          id: 'agent-1',
          // Verbatim shape of the text that triggered the false positive.
          prompt: 'Using saved defaults: --review-with={value}{, --review-iterations=…}{ — project|global}',
        },
      },
    });

    const { loadState } = await freshModule();
    const state = await loadState();

    expect(state.config.maxConcurrentAgents).toBe(20);
    expect(state.config.maxConcurrentAgentsPerProject).toBe(12);
    expect(state.agents['agent-1']).toBeDefined();
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
    writeState({ agents: { 'agent-1': { id: 'agent-1', status: 'running', prompt: 'a }{ b' } } });

    const { readAgentsStateForSafetyCheck } = await freshModule();

    // `trusted: false` here would make the update gate treat a live agent as
    // "records unreadable" and demand a manual state.json restore.
    await expect(readAgentsStateForSafetyCheck()).resolves.toEqual({
      trusted: true,
      agents: { 'agent-1': { id: 'agent-1', status: 'running', prompt: 'a }{ b' } },
    });
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
    // Agent records are genuinely lost — but the bad bytes stay inspectable.
    expect(recovered.agents).toEqual({});
    expect(quarantined('state.json')).toHaveLength(1);
  });
});

describe('CoS config lives in its own file', () => {
  it('never writes config back into state.json', async () => {
    writeConfig({ maxConcurrentAgents: 9 });
    writeState({ running: true, agents: { a1: { status: 'running' } } });
    const { loadState, saveState, getConfig } = await freshModule();

    const state = await loadState();
    expect(state.config.maxConcurrentAgents).toBe(9);
    // Absent keys still fall back to the shipped defaults.
    expect(state.config.maxConcurrentAgentsPerProject).toBe(2);
    await expect(getConfig()).resolves.toBe(state.config);

    state.agents.a2 = { status: 'running' };
    await saveState(state);

    const persisted = readJson(STATE_PATH);
    expect(persisted.config).toBeUndefined();
    expect(Object.keys(persisted.agents)).toEqual(['a1', 'a2']);
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

  // Back-compat: an un-upgraded peer, or a restored pre-split backup, still
  // carries `config` inside state.json.
  it('falls back to a legacy config slice still sitting in state.json', async () => {
    writeState({ running: false, config: { maxConcurrentAgents: 11, alwaysOn: false }, agents: {} });
    const { getConfig } = await freshModule();

    const config = await getConfig();
    expect(config.maxConcurrentAgents).toBe(11);
    expect(config.alwaysOn).toBe(false);
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
