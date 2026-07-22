import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

// git + failure analyzer are mocked; fs/promises stays REAL so readFileTail /
// captureWorktreeDiff are exercised against actual temp files.
vi.mock('../git.js', () => ({
  getStatus: vi.fn(),
  getDiff: vi.fn(),
}));
vi.mock('../agentErrorAnalysis.js', () => ({
  analyzeAgentFailure: vi.fn(),
}));

import * as git from '../git.js';
import { analyzeAgentFailure } from '../agentErrorAnalysis.js';
import {
  readFileTail,
  worktreeHasChanges,
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

  describe('worktreeHasChanges', () => {
    it('is true when git reports an unclean worktree', async () => {
      vi.mocked(git.getStatus).mockResolvedValue({ clean: false });
      expect(await worktreeHasChanges('/tmp/ws')).toBe(true);
    });

    it('is false when git reports a clean worktree', async () => {
      vi.mocked(git.getStatus).mockResolvedValue({ clean: true });
      expect(await worktreeHasChanges('/tmp/ws')).toBe(false);
    });

    it('is falsy (never throws) when getStatus rejects', async () => {
      vi.mocked(git.getStatus).mockRejectedValue(new Error('not a repo'));
      expect(await worktreeHasChanges('/tmp/ws')).toBeFalsy();
    });

    it('is false for a non-string / empty path without touching git', async () => {
      expect(await worktreeHasChanges(null)).toBe(false);
      expect(await worktreeHasChanges('')).toBe(false);
      expect(git.getStatus).not.toHaveBeenCalled();
    });
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
      expect(analyzeAgentFailure).toHaveBeenCalledWith('PTY TAIL OUTPUT', task, 'm');
      expect(result).toEqual({ classification: 'x' });
    });

    it('falls back to the output buffer when the spool is missing (read returns null)', async () => {
      vi.mocked(analyzeAgentFailure).mockReturnValue({ classification: 'fb' });
      const result = await resolveErrorAnalysis({
        finalSuccess: false, rawFile: join(dir, 'missing.txt'), fallbackText: 'BUFFER FALLBACK',
        task: {}, model: 'm',
      });
      // Missing file → readFileTail null → `?? fallbackText` supplies the buffer.
      expect(analyzeAgentFailure).toHaveBeenCalledWith('BUFFER FALLBACK', {}, 'm');
      expect(result).toEqual({ classification: 'fb' });
    });
  });
});
