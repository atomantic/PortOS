import { describe, expect, it, vi } from 'vitest';
import { extractErrorFromOutput } from './agentRunTracking.js';

// The lifecycle ledger is a real file writer (data/cos/run-events.jsonl). Mocked
// so these suites do not append test telemetry to the developing install's
// ledger — and so the boundary assertion below can read the envelope.
const { appendRunEvent } = vi.hoisted(() => ({ appendRunEvent: vi.fn(async () => ({ appended: true })) }));
vi.mock('./agentRunEventLog.js', () => ({ appendRunEvent }));

// extractErrorFromOutput is the real home of the exit-code → message mapping
// and the output error-pattern scan. subAgentSpawner.test.js used to assert an
// inline `exitCodeMessages` literal copy that exercised no production code.
describe('extractErrorFromOutput', () => {
  describe('empty output — exit-code mapping', () => {
    it.each([
      [1, 'General error (exit code 1)', 'unknown'],
      [2, 'Misuse of shell command (exit code 2)', 'unknown'],
      [126, 'Command invoked cannot execute (permission or not executable) (exit code 126)', 'unknown'],
      [127, 'Command not found (exit code 127)', 'unknown'],
      [130, 'Script terminated by Ctrl+C (exit code 130)', 'unknown'],
      [137, 'Process killed (SIGKILL) (exit code 137)', 'unknown'],
      [143, 'Process terminated (SIGTERM - likely timeout) (exit code 143)', 'timeout']
    ])('maps exit code %i to a readable message and category', (code, message, category) => {
      const result = extractErrorFromOutput('', code);
      expect(result.message).toBe(message);
      expect(result.category).toBe(category);
      expect(result.details).toBe(`Process exited with code ${code}. No output was captured.`);
    });

    it('falls back to "Unknown error" for an unmapped exit code', () => {
      const result = extractErrorFromOutput('', 99);
      expect(result.message).toBe('Unknown error (exit code 99)');
      expect(result.category).toBe('unknown');
    });

    it('treats whitespace-only output as empty', () => {
      const result = extractErrorFromOutput('   \n  \t\n', 1);
      expect(result.message).toBe('General error (exit code 1)');
    });
  });

  describe('non-empty output — error-pattern extraction', () => {
    it('categorizes an API error line', () => {
      const result = extractErrorFromOutput('starting up\nAPI Error: 429 too many requests', 1);
      expect(result.category).toBe('api-error');
      expect(result.message).toContain('API Error: 429');
    });

    it('categorizes a permission-denied line', () => {
      const result = extractErrorFromOutput('running task\npermission denied: /etc/shadow', 126);
      expect(result.category).toBe('permission');
      expect(result.message).toContain('permission denied');
    });

    it('categorizes a connection-refused line', () => {
      const result = extractErrorFromOutput('working\nconnection refused by upstream service', 1);
      expect(result.category).toBe('connection');
    });

    it('categorizes a timeout line', () => {
      const result = extractErrorFromOutput('working\noperation timeout after 600s', 1);
      expect(result.category).toBe('timeout');
    });

    it('keeps category "unknown" and returns the output when nothing matches', () => {
      const result = extractErrorFromOutput('all quiet on the western front today', 1);
      expect(result.category).toBe('unknown');
      expect(result.message).toBe('all quiet on the western front today');
    });
  });
});

describe('completeAgentRun idempotency', () => {
  it('does not rewrite an already-closed run', async () => {
    vi.resetModules();
    const atomicWrite = vi.fn();
    const writeFile = vi.fn();
    vi.doMock('../lib/fileUtils.js', async (importOriginal) => ({
      ...(await importOriginal()),
      readJSONFile: vi.fn().mockResolvedValue({ id: 'run-closed', endTime: '2026-07-29T00:00:00.000Z' }),
      atomicWrite,
    }));
    vi.doMock('fs/promises', async (importOriginal) => ({
      ...(await importOriginal()),
      writeFile,
    }));
    const { completeAgentRun } = await import('./agentRunTracking.js');

    await completeAgentRun('run-closed', 'output', 1, 100, { message: 'ignored' });

    expect(atomicWrite).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('skips a run whose metadata directory is missing', async () => {
    vi.resetModules();
    const atomicWrite = vi.fn();
    const writeFile = vi.fn();
    vi.doMock('../lib/fileUtils.js', async (importOriginal) => ({
      ...(await importOriginal()),
      readJSONFile: vi.fn().mockResolvedValue(null),
      atomicWrite,
    }));
    vi.doMock('fs/promises', async (importOriginal) => ({
      ...(await importOriginal()),
      writeFile,
    }));
    const { completeAgentRun } = await import('./agentRunTracking.js');

    await expect(completeAgentRun('run-missing', '', 1, 0)).resolves.toBeUndefined();
    expect(atomicWrite).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('writes the transcript before stamping the terminal metadata', async () => {
    vi.resetModules();
    const order = [];
    const atomicWrite = vi.fn().mockImplementation(() => { order.push('metadata'); });
    const writeFile = vi.fn().mockImplementation(() => { order.push('output'); });
    vi.doMock('../lib/fileUtils.js', async (importOriginal) => ({
      ...(await importOriginal()),
      readJSONFile: vi.fn().mockResolvedValue({
        id: 'run-open',
        endTime: null,
        taskId: null,
        providerId: null,
      }),
      atomicWrite,
    }));
    vi.doMock('fs/promises', async (importOriginal) => ({
      ...(await importOriginal()),
      writeFile,
    }));
    const { completeAgentRun } = await import('./agentRunTracking.js');

    await completeAgentRun('run-open', 'output', 1, 100, { message: 'failed' });

    expect(order).toEqual(['output', 'metadata']);
  });

  it('reconciles usage for failed runs as well as successful ones', async () => {
    vi.resetModules();
    const recordCompletedRunUsage = vi.fn();
    vi.doMock('../lib/fileUtils.js', async (importOriginal) => ({
      ...(await importOriginal()),
      readJSONFile: vi.fn().mockResolvedValue({
        id: 'run-failed',
        endTime: null,
        taskId: null,
        providerId: 'codex',
        model: 'example-model',
      }),
      atomicWrite: vi.fn(),
    }));
    vi.doMock('fs/promises', async (importOriginal) => ({
      ...(await importOriginal()),
      writeFile: vi.fn(),
    }));
    vi.doMock('./usageReconciler.js', () => ({ recordCompletedRunUsage }));
    const { completeAgentRun } = await import('./agentRunTracking.js');

    await completeAgentRun('run-failed', 'partial output', 1, 100, { message: 'failed' });

    expect(recordCompletedRunUsage).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'run-failed', success: false }),
      'partial output',
    );
  });
});

// The run record is mutated in place, so after a finalize it can no longer say
// how the run got there. The ledger entry is what preserves that (#4540).
describe('completeAgentRun lifecycle ledger', () => {
  it('records the RESOLVED verdict, not the raw exit code', async () => {
    vi.resetModules();
    appendRunEvent.mockClear();
    vi.doMock('../lib/fileUtils.js', async (importOriginal) => ({
      ...(await importOriginal()),
      readJSONFile: vi.fn().mockResolvedValue({
        id: 'run-overridden',
        endTime: null,
        agentId: 'agent-1',
        taskId: 'task-1',
        startTime: '2026-07-29T00:00:00.000Z',
        providerId: null,
      }),
      atomicWrite: vi.fn(),
    }));
    vi.doMock('fs/promises', async (importOriginal) => ({
      ...(await importOriginal()),
      writeFile: vi.fn(),
    }));
    const { completeAgentRun } = await import('./agentRunTracking.js');

    // Exit 0, but the caller's successOverride says the deliverable never landed
    // (#3358) — the ledger must agree with the run record, not with the process.
    await completeAgentRun('run-overridden', 'output', 0, 4200, null, false);

    expect(appendRunEvent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'run.finalized',
      runId: 'run-overridden',
      agentId: 'agent-1',
      taskId: 'task-1',
      data: expect.objectContaining({
        success: false,
        exitCode: 0,
        durationMs: 4200,
        successOverridden: true,
      }),
    }));
  });

  it('appends nothing for a run that was already closed', async () => {
    vi.resetModules();
    appendRunEvent.mockClear();
    vi.doMock('../lib/fileUtils.js', async (importOriginal) => ({
      ...(await importOriginal()),
      readJSONFile: vi.fn().mockResolvedValue({ id: 'run-closed', endTime: '2026-07-29T00:00:00.000Z' }),
      atomicWrite: vi.fn(),
    }));
    const { completeAgentRun } = await import('./agentRunTracking.js');

    await completeAgentRun('run-closed', 'output', 1, 100);
    await completeAgentRun(null, 'output', 1, 100);

    expect(appendRunEvent).not.toHaveBeenCalled();
  });
});
