import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

// git + failure analyzer are mocked; fs/promises stays REAL so readFileTail /
// captureWorktreeDiff are exercised against actual temp files.
vi.mock('../git.js', () => ({
  getDiff: vi.fn(),
}));
vi.mock('../agentErrorAnalysis.js', () => ({
  analyzeAgentFailure: vi.fn(),
}));
// The run-window commit probe moved to lib/gitCommitProbe.js (#3637); finalizeHelpers
// re-exports it, so mock it at its new home.
vi.mock('../../lib/gitCommitProbe.js', () => ({
  commitsSince: vi.fn(),
}));

import * as git from '../git.js';
import { analyzeAgentFailure } from '../agentErrorAnalysis.js';
import { commitsSince as commitsSinceMock } from '../../lib/gitCommitProbe.js';
import {
  readFileTail,
  commitsSince,
  captureWorktreeDiff,
  resolveErrorAnalysis,
  RAW_TAIL_ANALYSIS_BYTES,
} from './finalizeHelpers.js';

describe('finalizeHelpers', () => {
  let dir;

  beforeEach(async () => {
    vi.clearAllMocks();
    dir = await mkdtemp(join(tmpdir(), 'finalize-helpers-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe('readFileTail', () => {
    it('returns null for a missing file (distinct from empty)', async () => {
      expect(await readFileTail(join(dir, 'nope.txt'), 1024)).toBeNull();
    });

    it('returns an empty string for a zero-byte file', async () => {
      const p = join(dir, 'empty.txt');
      await writeFile(p, '');
      expect(await readFileTail(p, 1024)).toBe('');
    });

    it('returns the whole file when maxBytes exceeds its size', async () => {
      const p = join(dir, 'small.txt');
      await writeFile(p, 'hello');
      expect(await readFileTail(p, 1024)).toBe('hello');
    });

    it('returns only the trailing maxBytes when the file is larger', async () => {
      const p = join(dir, 'big.txt');
      await writeFile(p, 'abcdefghij'); // 10 bytes
      expect(await readFileTail(p, 4)).toBe('ghij');
    });

    it('RAW_TAIL_ANALYSIS_BYTES is a sane 1MB bound', () => {
      expect(RAW_TAIL_ANALYSIS_BYTES).toBe(1024 * 1024);
    });
  });

  // The probe's own behavior (git args, exit-code/timeout handling) is covered by
  // server/lib/gitCommitProbe.test.js — its new home (#3637). What matters HERE is
  // that this module's historical entry point still resolves to it.
  it('re-exports the run-window commit probe from its lib home', async () => {
    vi.mocked(commitsSinceMock).mockResolvedValue(3);
    expect(await commitsSince('/tmp/ws', 1)).toBe(3);
    expect(commitsSince).toBe(commitsSinceMock);
  });

  describe('captureWorktreeDiff', () => {
    it('writes a combined staged+unstaged diff and returns it', async () => {
      vi.mocked(git.getDiff).mockImplementation(async (_dir, staged) => (staged ? 'S-DIFF' : 'U-DIFF'));
      const combined = await captureWorktreeDiff('/tmp/ws', dir);
      expect(combined).toContain('### STAGED CHANGES ###');
      expect(combined).toContain('S-DIFF');
      expect(combined).toContain('### UNSTAGED CHANGES ###');
      expect(combined).toContain('U-DIFF');
      // Persisted alongside the agent archive dir for post-mortems.
      expect(await readFile(join(dir, 'worktree-diff.txt'), 'utf8')).toBe(combined);
    });

    it('returns null when there is no diff to capture', async () => {
      vi.mocked(git.getDiff).mockResolvedValue('');
      expect(await captureWorktreeDiff('/tmp/ws', dir)).toBeNull();
    });

    it('returns null for invalid args', async () => {
      expect(await captureWorktreeDiff(null, dir)).toBeNull();
      expect(await captureWorktreeDiff('/tmp/ws', null)).toBeNull();
    });
  });

  describe('resolveErrorAnalysis', () => {
    it('uses the exact post-submission byte suffix while retaining the raw transcript', async () => {
      const p = join(dir, 'raw.txt');
      const prompt = 'A failing guard leaves the PR open with its failing test named.';
      const emitted = 'Real tool output 🌟\ntest failed: expected true to be false';
      const raw = `${prompt}\n${emitted}`;
      await writeFile(p, raw);
      const promptProvenance = { submitted: true, suppliedPrompt: prompt, bytesSinceSubmission: Buffer.byteLength(emitted) };
      await resolveErrorAnalysis({ finalSuccess: false, rawFile: p, fallbackText: '', task: {}, model: 'm', promptProvenance });
      expect(analyzeAgentFailure).toHaveBeenCalledWith(emitted, {}, 'm', expect.objectContaining({ promptProvenance }));
      expect(await readFile(p, 'utf8')).toBe(raw);
    });

    it('returns null on success WITHOUT reading the spool or analyzing', async () => {
      const result = await resolveErrorAnalysis({
        finalSuccess: true, rawFile: join(dir, 'raw.txt'), fallbackText: 'buf', task: {}, model: 'm',
      });
      expect(result).toBeNull();
      expect(analyzeAgentFailure).not.toHaveBeenCalled();
    });

    it('short-circuits to an immediate fallback signal when present', async () => {
      const signal = { message: 'fallback required' };
      const result = await resolveErrorAnalysis({
        finalSuccess: false, rawFile: join(dir, 'raw.txt'), fallbackText: 'buf',
        task: {}, model: 'm', immediateFallbackAnalysis: signal,
      });
      expect(result).toBe(signal);
      expect(analyzeAgentFailure).not.toHaveBeenCalled();
    });

    it('analyzes the raw-spool tail on failure', async () => {
      const p = join(dir, 'raw.txt');
      await writeFile(p, 'PTY TAIL OUTPUT');
      vi.mocked(analyzeAgentFailure).mockReturnValue({ classification: 'x' });
      const task = { id: 't' };
      const result = await resolveErrorAnalysis({
        finalSuccess: false, rawFile: p, fallbackText: 'buf', task, model: 'm',
      });
      expect(analyzeAgentFailure).toHaveBeenCalledWith('PTY TAIL OUTPUT', task, 'm', {
        completionReason: undefined, completionError: undefined,
      });
      expect(result).toEqual({ classification: 'x' });
    });

    it('falls back to the output buffer when the spool is missing (read returns null)', async () => {
      vi.mocked(analyzeAgentFailure).mockReturnValue({ classification: 'fb' });
      const result = await resolveErrorAnalysis({
        finalSuccess: false, rawFile: join(dir, 'missing.txt'), fallbackText: 'BUFFER FALLBACK',
        task: {}, model: 'm',
      });
      // Missing file → readFileTail null → `?? fallbackText` supplies the buffer.
      expect(analyzeAgentFailure).toHaveBeenCalledWith('BUFFER FALLBACK', {}, 'm', {
        completionReason: undefined, completionError: undefined,
      });
      expect(result).toEqual({ classification: 'fb' });
    });

    it('forwards the finalize path\'s own completion verdict to the analyzer', async () => {
      // The finalize path already knows WHY the run ended;
      // that structural signal must reach analyzeAgentFailure so a stray keyword
      // in the transcript can't outrank it.
      const p = join(dir, 'raw.txt');
      await writeFile(p, 'PTY TAIL OUTPUT');
      vi.mocked(analyzeAgentFailure).mockReturnValue({ classification: 'reaped' });
      await resolveErrorAnalysis({
        finalSuccess: false, rawFile: p, fallbackText: 'buf', task: { id: 't' }, model: 'm',
        completionReason: 'idle-no-changes', completionError: 'idled out with zero changes',
      });
      expect(analyzeAgentFailure).toHaveBeenCalledWith('PTY TAIL OUTPUT', { id: 't' }, 'm', {
        completionReason: 'idle-no-changes', completionError: 'idled out with zero changes',
      });
    });
  });
});
