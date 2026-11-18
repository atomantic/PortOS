import { describe, it, expect, vi, beforeEach } from 'vitest';

// Same collaborators agentCliSpawning.test.js doubles: state writes, the run
// ledger and the transcript file are spies, so the pipeline runs without a
// database or a data directory. The parsers, ANSI strippers and the fallback
// detector are the real ones.
vi.mock('../cos/cosEvents.js', () => ({ cosEvents: { emit: vi.fn() }, emitLog: vi.fn() }));
vi.mock('../cos/cosAgentLifecycle.js', () => {
  const appendAgentOutputLines = vi.fn().mockResolvedValue(undefined);
  const createAgentOutputBatcher = vi.fn((agentId, { flushBatch }) => {
    let pending = [];
    return {
      push(lineOrLines) { pending.push(...[].concat(lineOrLines)); },
      async flush() {
        if (!pending.length) return;
        const batch = pending;
        pending = [];
        await flushBatch(batch);
      },
    };
  });
  return { updateAgent: vi.fn().mockResolvedValue(undefined), appendAgentOutputLines, createAgentOutputBatcher };
});
const { appendRunEvent } = vi.hoisted(() => ({ appendRunEvent: vi.fn(async () => ({ appended: true })) }));
vi.mock('./agentRunEventLog.js', () => ({ appendRunEvent }));
vi.mock('../../lib/fileUtils.js', () => ({ writeFileGuarded: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../lib/backupSnapshotBoundary.js', () => ({ withBackupAssetPublication: (fn) => fn() }));

import { createCliOutputPipeline } from './agentCliOutputStream.js';
import { updateAgent, appendAgentOutputLines } from '../cos/cosAgentLifecycle.js';
import { writeFileGuarded } from '../../lib/fileUtils.js';
import { emitLog } from '../cos/cosEvents.js';

const delta = (text) => `${JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } })}\n`;
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

function build({ streamFormat, providerId = 'claude-code', killed = false } = {}) {
  const stopProcess = vi.fn();
  const pipeline = createCliOutputPipeline({
    agentId: 'agent-1',
    task: { id: 'task-1' },
    runId: 'run-1',
    provider: { id: providerId, name: providerId },
    cliConfig: { streamFormat },
    prompt: 'do the thing',
    agentDir: '/agents/agent-1',
    isProcessStopped: () => killed,
    stopProcess,
  });
  return { pipeline, stopProcess };
}

describe('createCliOutputPipeline', () => {
  beforeEach(() => vi.clearAllMocks());

  it('parses stream-json stdout into display lines and keeps the raw stream for error analysis', async () => {
    const { pipeline } = build({ streamFormat: 'stream-json' });
    pipeline.onStdout(Buffer.from(delta('hello\n')));
    await pipeline.finish();
    const snap = pipeline.snapshot();
    expect(snap.outputBuffer).toContain('hello');
    expect(snap.rawStreamBuffer).toContain('content_block_delta');
    expect(snap.immediateFallbackAnalysis).toBeNull();
    // finish() persists the final transcript to output.txt
    expect(writeFileGuarded).toHaveBeenLastCalledWith('/agents/agent-1/output.txt', snap.outputBuffer);
  });

  it('replaces the streamed progress with the parser result at finish', async () => {
    const { pipeline } = build({ streamFormat: 'stream-json' });
    pipeline.onStdout(Buffer.from(delta('progress\n')));
    pipeline.onStdout(Buffer.from(`${JSON.stringify({ type: 'result', result: 'Final answer.' })}\n`));
    await pipeline.finish();
    const snap = pipeline.snapshot();
    expect(snap.outputBuffer).toBe('Final answer.');
    expect(snap.finalSummary).toBe('Final answer.');
  });

  it('passes plain stdout through decolored, keeping blank lines and dropping pure control chunks', async () => {
    const { pipeline } = build();
    pipeline.onStdout(Buffer.from('\x1b[32mgreen\x1b[0m\n'));
    pipeline.onStdout(Buffer.from('\n'));
    pipeline.onStdout(Buffer.from('\x1b[0m'));
    await pipeline.finish();
    expect(pipeline.snapshot().outputBuffer).toBe('green\n\n');
    expect(pipeline.snapshot().rawStreamBuffer).toBe('');
  });

  it('tags stderr with [stderr] and drops whitespace-only chunks', async () => {
    const { pipeline } = build();
    pipeline.onStderr(Buffer.from('warning: something\n'));
    pipeline.onStderr(Buffer.from('\x1b[0m'));
    pipeline.onStderr(Buffer.from('   \n'));
    await pipeline.finish();
    expect(pipeline.snapshot().outputBuffer).toBe('[stderr] warning: something\n');
  });

  it('stops the provider synchronously on a fallback signal and exposes the analysis', async () => {
    const { pipeline, stopProcess } = build();
    pipeline.onStdout(Buffer.from('Now using extra usage\n'));
    // Fired in the listener itself, before the serialized write chain runs.
    expect(stopProcess).toHaveBeenCalledTimes(1);
    expect(emitLog).toHaveBeenCalledWith('warn', expect.stringContaining('provider fallback signal'), expect.any(Object));
    await pipeline.finish();
    expect(pipeline.snapshot().immediateFallbackAnalysis).toMatchObject({ category: expect.any(String) });
  });

  it('ignores a fallback signal once the process is already stopped', async () => {
    const { pipeline, stopProcess } = build({ killed: true });
    pipeline.onStderr(Buffer.from('Now using extra usage\n'));
    await pipeline.finish();
    expect(stopProcess).not.toHaveBeenCalled();
    expect(pipeline.snapshot().immediateFallbackAnalysis).toBeNull();
  });

  it('records the first output once across both streams and flips the agent to working once', async () => {
    const { pipeline } = build();
    pipeline.onStdout(Buffer.from('a'));
    pipeline.onStderr(Buffer.from('b\n'));
    pipeline.onStdout(Buffer.from('c'));
    await pipeline.finish();
    expect(appendRunEvent).toHaveBeenCalledTimes(1);
    expect(appendRunEvent.mock.calls[0][0]).toMatchObject({ kind: 'run.output', data: { source: 'cli-stdout', firstChunkChars: 1 } });
    expect(updateAgent).toHaveBeenCalledTimes(1);
  });

  it('does not let the initialization timeout path re-announce a run that already started working', async () => {
    const { pipeline } = build();
    pipeline.onStdout(Buffer.from('x'));
    await settle();
    await pipeline.markWorking('late');
    expect(updateAgent).toHaveBeenCalledTimes(1);
  });

  it('batches pushed lines into the state stream on flush', async () => {
    const { pipeline } = build();
    pipeline.push('note');
    await pipeline.flushOutput();
    expect(appendAgentOutputLines).toHaveBeenCalledWith('agent-1', ['note']);
  });

  it('caps the raw stream buffer at 512KB, keeping the tail', async () => {
    const { pipeline } = build({ streamFormat: 'stream-json' });
    pipeline.onStdout(Buffer.from(`${'x'.repeat(600 * 1024)}END`));
    await pipeline.flushOutput();
    const { rawStreamBuffer } = pipeline.snapshot();
    expect(rawStreamBuffer.length).toBe(512 * 1024);
    expect(rawStreamBuffer.endsWith('END')).toBe(true);
  });
});
