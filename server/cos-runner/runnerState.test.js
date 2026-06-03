import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

describe('cos-runner runnerState', () => {
  let tmpDir;

  // STATE_FILE is computed from PATHS.cos at module-load time, so each test
  // points PATHS.cos at a fresh temp dir and re-imports the module.
  // resetModules() MUST run BEFORE importing fileUtils — otherwise the reset
  // discards the mutated instance and runnerState.js re-imports a fresh
  // fileUtils whose PATHS.cos points back at the real data/cos dir, letting the
  // tests read and clobber the live runner-state.json.
  const loadModule = async () => {
    vi.resetModules();
    const fileUtils = await import('../lib/fileUtils.js');
    fileUtils.PATHS.cos = tmpDir;
    return import('./runnerState.js');
  };

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'cos-runner-state-'));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it('returns a fresh default state (a copy, not the shared constant) when no file exists', async () => {
    const { loadState, DEFAULT_STATE } = await loadModule();
    const state = await loadState();
    expect(state).toEqual(DEFAULT_STATE);
    state.stats.spawned = 99;
    expect(DEFAULT_STATE.stats.spawned).toBe(0);
  });

  it('returns fresh default for an empty / whitespace-only file', async () => {
    const { loadState, STATE_FILE } = await loadModule();
    await writeFile(STATE_FILE, '   ');
    expect((await loadState()).stats.spawned).toBe(0);
  });

  it('round-trips state through save and load', async () => {
    const { saveState, loadState } = await loadModule();
    await saveState({ agents: { a1: { pid: 5 } }, stats: { spawned: 3, completed: 1, failed: 0 } });
    const state = await loadState();
    expect(state.agents.a1.pid).toBe(5);
    expect(state.stats).toEqual({ spawned: 3, completed: 1, failed: 0 });
  });

  it('serializes concurrent saves so the file is never a torn write', async () => {
    const { saveState, loadState } = await loadModule();
    await Promise.all([
      saveState({ agents: {}, stats: { spawned: 1, completed: 0, failed: 0 } }),
      saveState({ agents: {}, stats: { spawned: 2, completed: 0, failed: 0 } }),
    ]);
    expect([1, 2]).toContain((await loadState()).stats.spawned);
  });
});
