import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Tests for loops.js
 *
 * Mocks: fs/promises (file I/O), runner.js (AI execution), providers.js (provider lookup).
 * Tests: createLoop, stopLoop, triggerLoop, executeIteration error logging.
 */

vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('[]'),
  writeFile: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../lib/fileUtils.js', () => ({
  ensureDir: vi.fn().mockResolvedValue(undefined),
  PATHS: { data: '/fake/data', root: '/fake/root' },
  readJSONFile: vi.fn()
}));

vi.mock('./runner.js', () => ({
  createRun: vi.fn(),
  executeCliRun: vi.fn()
}));

vi.mock('./providers.js', () => ({
  getProviderById: vi.fn(),
  getAllProviders: vi.fn(),
  getActiveProvider: vi.fn()
}));

import { readFile, writeFile } from 'fs/promises';
import { createRun, executeCliRun } from './runner.js';
import { getProviderById, getActiveProvider } from './providers.js';
import {
  createLoop,
  stopLoop,
  triggerLoop,
  getLoops,
  loopEvents
} from './loops.js';

// Convenience aliases after import
const mockCreateRun = createRun;
const mockExecuteCliRun = executeCliRun;
const mockGetProviderById = getProviderById;
const mockGetActiveProvider = getActiveProvider;

const MOCK_PROVIDER = {
  id: 'claude',
  name: 'Claude',
  defaultModel: 'claude-3-sonnet',
  command: 'claude'
};

const MOCK_RUN_RESULT = {
  metadata: { id: 'run-123' },
  provider: MOCK_PROVIDER
};

function setupProviderMocks() {
  mockGetProviderById.mockResolvedValue(MOCK_PROVIDER);
  mockGetActiveProvider.mockResolvedValue(MOCK_PROVIDER);
  mockCreateRun.mockResolvedValue(MOCK_RUN_RESULT);
  // executeCliRun is fire-and-forget in loops.js; mock to resolve immediately
  mockExecuteCliRun.mockResolvedValue(undefined);
}

describe('loops.js', () => {
  // Track IDs of loops created in each test so afterEach can stop them reliably.
  // getLoops() reads from the mocked readFile (which stays '[]'), so we cannot
  // rely on it to discover active loops; instead we intercept writeFile.
  let createdLoopIds = [];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    createdLoopIds = [];
    // Default: file has no saved loops
    readFile.mockResolvedValue('[]');
    writeFile.mockImplementation((path, json) => {
      try {
        const loops = JSON.parse(json);
        if (Array.isArray(loops)) {
          for (const l of loops) {
            if (l.id && !createdLoopIds.includes(l.id)) createdLoopIds.push(l.id);
          }
        }
      } catch { /* ignore non-loop writes */ }
      return Promise.resolve(undefined);
    });
    setupProviderMocks();
  });

  afterEach(async () => {
    // Stop all loops created in this test to clear timers and prevent cross-test interference
    for (const id of createdLoopIds) {
      await stopLoop(id).catch(() => {});
    }
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  // ===========================================================================
  // createLoop
  // ===========================================================================
  describe('createLoop', () => {
    it('creates a loop with the expected shape and status:running', async () => {
      const loop = await createLoop({
        prompt: 'check system health',
        interval: '1m',
        name: 'Health Check',
        runImmediately: false
      });

      expect(loop.prompt).toBe('check system health');
      expect(loop.name).toBe('Health Check');
      expect(loop.status).toBe('running');
      expect(loop.intervalMs).toBe(60_000);
      expect(typeof loop.id).toBe('string');
      expect(loop.id).toHaveLength(8);
    });

    it('persists the loop to disk via writeFile', async () => {
      await createLoop({ prompt: 'test loop', interval: '30s', runImmediately: false });
      expect(writeFile).toHaveBeenCalled();
      const saved = JSON.parse(writeFile.mock.calls[0][1]);
      expect(Array.isArray(saved)).toBe(true);
      expect(saved[0].prompt).toBe('test loop');
    });

    it('emits a created event with the loop data', async () => {
      const emitted = [];
      loopEvents.on('created', (data) => emitted.push(data));

      await createLoop({ prompt: 'emit test', interval: '15s', runImmediately: false });

      expect(emitted).toHaveLength(1);
      expect(emitted[0].loop.prompt).toBe('emit test');
      loopEvents.removeAllListeners('created');
    });

    it('throws when interval is shorter than 10 seconds', async () => {
      await expect(
        createLoop({ prompt: 'fast loop', interval: '5s', runImmediately: false })
      ).rejects.toThrow('Interval must be at least 10 seconds');
    });

    it('throws when prompt is empty', async () => {
      await expect(
        createLoop({ prompt: '   ', interval: '1m', runImmediately: false })
      ).rejects.toThrow('Prompt is required');
    });
  });

  // ===========================================================================
  // stopLoop
  // ===========================================================================
  describe('stopLoop', () => {
    it('removes loop from activeLoops and persists stopped status', async () => {
      const loop = await createLoop({
        prompt: 'stop me',
        interval: '30s',
        runImmediately: false
      });

      // Capture the loop data that was written to disk
      const savedBefore = JSON.parse(writeFile.mock.calls[0][1]);
      readFile.mockResolvedValue(JSON.stringify(savedBefore));

      await stopLoop(loop.id);

      // writeFile called again with updated status
      const lastWriteCall = writeFile.mock.calls[writeFile.mock.calls.length - 1];
      const savedAfter = JSON.parse(lastWriteCall[1]);
      const stoppedEntry = savedAfter.find(l => l.id === loop.id);
      expect(stoppedEntry.status).toBe('stopped');
    });

    it('emits a stopped event with the loop id', async () => {
      const loop = await createLoop({
        prompt: 'emit stop',
        interval: '30s',
        runImmediately: false
      });

      const savedBefore = JSON.parse(writeFile.mock.calls[0][1]);
      readFile.mockResolvedValue(JSON.stringify(savedBefore));

      const emitted = [];
      loopEvents.on('stopped', (data) => emitted.push(data));

      await stopLoop(loop.id);

      expect(emitted).toHaveLength(1);
      expect(emitted[0].id).toBe(loop.id);
      loopEvents.removeAllListeners('stopped');
    });

    it('throws when loop is not running', async () => {
      await expect(stopLoop('nonexistent-id')).rejects.toThrow('not running');
    });
  });

  // ===========================================================================
  // triggerLoop
  // ===========================================================================
  describe('triggerLoop', () => {
    it('returns { triggered: true } immediately', async () => {
      const loop = await createLoop({
        prompt: 'trigger test',
        interval: '30s',
        runImmediately: false
      });

      const savedBefore = JSON.parse(writeFile.mock.calls[0][1]);
      readFile.mockResolvedValue(JSON.stringify(savedBefore));

      const result = await triggerLoop(loop.id);
      expect(result).toEqual({ triggered: true });
    });

    it('throws when loop id does not exist in saved file', async () => {
      readFile.mockResolvedValue('[]');
      await expect(triggerLoop('ghost-id')).rejects.toThrow('not found');
    });

    it('throws when loop is not in activeLoops (not running)', async () => {
      // Write a loop to disk but don't start it in activeLoops
      const loopRecord = [{
        id: 'test-stopped',
        prompt: 'stopped loop',
        intervalMs: 30_000,
        status: 'stopped'
      }];
      readFile.mockResolvedValue(JSON.stringify(loopRecord));
      await expect(triggerLoop('test-stopped')).rejects.toThrow('not running');
    });
  });

  // ===========================================================================
  // executeIteration error logging via triggerLoop
  // ===========================================================================
  describe('error handling in executeIteration', () => {
    it('logs console.error when executeCliRun rejects', async () => {
      const loop = await createLoop({
        prompt: 'error test',
        interval: '30s',
        runImmediately: false
      });

      const savedBefore = JSON.parse(writeFile.mock.calls[0][1]);
      readFile.mockResolvedValue(JSON.stringify(savedBefore));

      // Make executeCliRun reject
      mockExecuteCliRun.mockRejectedValue(new Error('CLI execution failed'));

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await triggerLoop(loop.id);

      // Allow microtasks to settle (the .catch on executeCliRun is async)
      // Flush promise microtask queue
      for (let i = 0; i < 5; i++) await Promise.resolve();

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('CLI execution failed')
      );
      consoleSpy.mockRestore();
    });

    it('logs console.error when createRun rejects', async () => {
      const loop = await createLoop({
        prompt: 'createRun error test',
        interval: '30s',
        runImmediately: false
      });

      const savedBefore = JSON.parse(writeFile.mock.calls[0][1]);
      readFile.mockResolvedValue(JSON.stringify(savedBefore));

      mockCreateRun.mockRejectedValue(new Error('createRun blew up'));
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await triggerLoop(loop.id);
      // Flush promise microtask queue
      for (let i = 0; i < 5; i++) await Promise.resolve();

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('createRun blew up')
      );
      consoleSpy.mockRestore();
    });

    it('emits iteration:error event when no provider is available', async () => {
      mockGetProviderById.mockResolvedValue(null);
      mockGetActiveProvider.mockResolvedValue(null);

      const loop = await createLoop({
        prompt: 'no-provider test',
        interval: '30s',
        runImmediately: false
      });

      const savedBefore = JSON.parse(writeFile.mock.calls[0][1]);
      readFile.mockResolvedValue(JSON.stringify(savedBefore));

      const errors = [];
      loopEvents.on('iteration:error', (data) => errors.push(data));

      await triggerLoop(loop.id);
      // Flush promise microtask queue
      for (let i = 0; i < 5; i++) await Promise.resolve();

      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].error).toBe('No AI provider available');
      loopEvents.removeAllListeners('iteration:error');
    });
  });
});
