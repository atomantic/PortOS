import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Replace the disk + state + config deps so the spooler's batching/spooling
// wiring can be asserted in isolation. Tiny caps trip the truncation paths
// without pushing MB through the pipeline.
vi.mock('fs/promises', () => ({
  appendFile: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../cosAgentLifecycle.js', () => ({
  appendAgentOutputLines: vi.fn().mockResolvedValue(undefined),
  updateAgent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../lib/tuiHandshake.js', () => ({
  OUTPUT_BUFFER_HEADROOM: 100,
  OUTPUT_BUFFER_CAP: 50,
  RAW_SPOOL_MAX_BYTES: 100,
}));

import { appendFile, writeFile } from 'fs/promises';
import { appendAgentOutputLines, updateAgent } from '../cosAgentLifecycle.js';
import { createOutputSpooler, createTranscriptWriteReporter } from './outputSpooler.js';

const OUTPUT_FILE = '/tmp/agent/output.txt';
const RAW_FILE = '/tmp/agent/raw.txt';

const makeSpooler = () => createOutputSpooler({ agentId: 'agent-1', outputFile: OUTPUT_FILE, rawFile: RAW_FILE });

describe('createOutputSpooler', () => {
  let warnSpy;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    warnSpy.mockRestore();
  });

  it('appendLine flushes to output.txt AND the agent state stream on drain', async () => {
    const s = makeSpooler();
    s.appendLine('hello world');
    await s.drainLines();

    expect(appendAgentOutputLines).toHaveBeenCalledWith('agent-1', ['hello world']);
    expect(appendFile).toHaveBeenCalledWith(OUTPUT_FILE, 'hello world\n');
    expect(s.getOutputBuffer()).toBe('hello world\n');
  });

  it('dedupes an immediately-repeated line and ignores blank lines', async () => {
    const s = makeSpooler();
    s.appendLine('same');
    s.appendLine('same');   // consecutive duplicate → dropped
    s.appendLine('   ');    // blank after trim → dropped
    s.appendLine('next');
    await s.drainLines();

    expect(appendAgentOutputLines).toHaveBeenCalledWith('agent-1', ['same', 'next']);
    expect(s.getOutputBuffer()).toBe('same\nnext\n');
  });

  it('warns once and flags metadata when the output buffer overflows HEADROOM', async () => {
    const s = makeSpooler();
    s.appendLine('x'.repeat(200)); // > HEADROOM (100) → truncate to CAP (50)
    s.appendLine('y'.repeat(200)); // trips again, but warn/metadata fire only once

    const warns = warnSpy.mock.calls.filter(a => String(a[0]).includes('parsed-output buffer exceeded'));
    expect(warns).toHaveLength(1);
    const metaCalls = vi.mocked(updateAgent).mock.calls.filter(([, p]) => p?.metadata?.outputBufferTruncated === true);
    expect(metaCalls).toHaveLength(1);
    // Buffer is kept at the CAP tail, never unbounded.
    expect(s.getOutputBuffer().length).toBeLessThanOrEqual(50);
  });

  it('pushRaw appends raw chunks to raw.txt on drain', async () => {
    const s = makeSpooler();
    s.pushRaw('abc');
    await s.drainRaw();
    expect(appendFile).toHaveBeenCalledWith(RAW_FILE, 'abc');
  });

  it('truncates the raw spool (writeFile) once it crosses the cap, warning + flagging once', async () => {
    const s = makeSpooler();
    s.pushRaw('a'.repeat(80)); // under cap (100) → appendFile
    await s.drainRaw();
    s.pushRaw('b'.repeat(80)); // 80 + 80 = 160 > cap → writeFile safety valve
    await s.drainRaw();

    const rawWrites = vi.mocked(writeFile).mock.calls.filter(([p]) => p === RAW_FILE);
    expect(rawWrites.length).toBeGreaterThan(0);

    const warns = warnSpy.mock.calls.filter(a => String(a[0]).includes('raw PTY spool reached'));
    expect(warns).toHaveLength(1);
    const metaCalls = vi.mocked(updateAgent).mock.calls.filter(([, p]) => p?.metadata?.rawSpoolTruncated === true);
    expect(metaCalls).toHaveLength(1);
  });

  it('drainLines / drainRaw are no-ops when nothing is pending', async () => {
    const s = makeSpooler();
    await s.drainLines();
    await s.drainRaw();
    expect(appendFile).not.toHaveBeenCalled();
    expect(appendAgentOutputLines).not.toHaveBeenCalled();
  });

  it('reports output.txt write failures once per file', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = makeSpooler();
    const err = new Error('ENOSPC: no space');
    err.code = 'ENOSPC';
    vi.mocked(appendFile).mockRejectedValueOnce(err);

    s.appendLine('line 1');
    await s.drainLines();

    // First failure should be logged
    const logs = errorSpy.mock.calls.filter(([msg]) => msg.includes('output.txt write failed'));
    expect(logs).toHaveLength(1);
    expect(logs[0][0]).toContain('ENOSPC');

    // Metadata should be updated
    const metaCalls = vi.mocked(updateAgent).mock.calls.filter(
      ([, p]) => p?.metadata?.transcriptWriteFailed?.file === 'output.txt'
    );
    expect(metaCalls).toHaveLength(1);

    errorSpy.mockRestore();
  });

  it('reports raw.txt write failures once per file', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = makeSpooler();
    const err = new Error('EACCES: permission denied');
    err.code = 'EACCES';
    vi.mocked(appendFile).mockRejectedValueOnce(err);

    s.pushRaw('chunk 1');
    await s.drainRaw();

    // First failure should be logged
    const logs = errorSpy.mock.calls.filter(([msg]) => msg.includes('raw.txt write failed'));
    expect(logs).toHaveLength(1);
    expect(logs[0][0]).toContain('EACCES');

    errorSpy.mockRestore();
  });
});

describe('createTranscriptWriteReporter', () => {
  let errorSpy;

  beforeEach(() => {
    vi.clearAllMocks();
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('logs the first failure for a file with error code and message', async () => {
    const reporter = createTranscriptWriteReporter({ agentId: 'agent-1' });
    const err = new Error('ENOSPC: no space left on device');
    err.code = 'ENOSPC';

    reporter.report('output.txt', err);

    expect(errorSpy).toHaveBeenCalledWith(
      '❌ agent agent-1 output.txt write failed (ENOSPC): ENOSPC: no space left on device'
    );
    expect(vi.mocked(updateAgent)).toHaveBeenCalledWith('agent-1', {
      metadata: { transcriptWriteFailed: { file: 'output.txt', code: 'ENOSPC' } },
    });
  });

  it('logs fallback to error string when err.code is undefined', async () => {
    const reporter = createTranscriptWriteReporter({ agentId: 'agent-1' });
    const err = new Error('unknown failure');

    reporter.report('output.txt', err);

    expect(errorSpy).toHaveBeenCalledWith(
      '❌ agent agent-1 output.txt write failed (error): unknown failure'
    );
    expect(vi.mocked(updateAgent)).toHaveBeenCalledWith('agent-1', {
      metadata: { transcriptWriteFailed: { file: 'output.txt', code: 'unknown' } },
    });
  });

  it('logs only once per file — subsequent failures on the same file are silent', async () => {
    const reporter = createTranscriptWriteReporter({ agentId: 'agent-1' });
    const err = new Error('disk full');
    err.code = 'ENOSPC';

    reporter.report('output.txt', err);
    reporter.report('output.txt', err);
    reporter.report('output.txt', err);

    const logs = errorSpy.mock.calls.filter(([msg]) => msg.includes('output.txt write failed'));
    expect(logs).toHaveLength(1);
    expect(vi.mocked(updateAgent)).toHaveBeenCalledTimes(1);
  });

  it('reports different files independently', async () => {
    const reporter = createTranscriptWriteReporter({ agentId: 'agent-1' });
    const err = new Error('disk full');
    err.code = 'ENOSPC';

    reporter.report('output.txt', err);
    reporter.report('raw.txt', err);
    reporter.report('state', err);

    const logs = errorSpy.mock.calls.filter(([msg]) => msg.includes('write failed'));
    expect(logs).toHaveLength(3);
    expect(vi.mocked(updateAgent)).toHaveBeenCalledTimes(3);
  });

  it('handles state append failures', async () => {
    const reporter = createTranscriptWriteReporter({ agentId: 'agent-1' });
    const err = new Error('state write failed');
    err.code = 'EIO';

    reporter.report('state', err);

    expect(errorSpy).toHaveBeenCalledWith(
      '❌ agent agent-1 state write failed (EIO): state write failed'
    );
  });
});
