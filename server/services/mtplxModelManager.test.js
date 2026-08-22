import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  isMtplxRepoId,
  parseMtplxPullFrame,
  pullMtplxModel,
  removeMtplxModel,
  searchMtplxCatalog,
} from './mtplxModelManager.js';
import * as bufferedSpawnModule from '../lib/bufferedSpawn.js';
import * as mtplxModels from '../lib/mtplxModels.js';
import * as processEnv from '../lib/processEnv.js';
import * as streamingSpawn from '../lib/streamingSpawn.js';
import * as hfCatalog from './huggingFaceCatalog.js';

const BINARY = '/opt/homebrew/bin/mtplx';

const spawnOk = (stdout) => ({ success: true, code: 0, stdout, stderr: '', timedOut: false });

describe('mtplxModelManager', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue(BINARY);
    vi.spyOn(mtplxModels, 'listMtplxCachedModels').mockResolvedValue({ models: [], error: null });
    // Publish dates come from the Hub — no suite may reach it.
    vi.spyOn(hfCatalog, 'fetchRepoPublishedDates').mockResolvedValue({});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  describe('isMtplxRepoId', () => {
    it('accepts owner/name and rejects anything that could become a flag or a path', () => {
      expect(isMtplxRepoId('Example/Qwen-MTP')).toBe(true);
      // A leading dash would be read as an option by MTPLX's own argparse, and a
      // bare name / URL is not something the search results ever produce.
      expect(isMtplxRepoId('-rf')).toBe(false);
      expect(isMtplxRepoId('Qwen-MTP')).toBe(false);
      expect(isMtplxRepoId('https://huggingface.co/Example/Qwen-MTP')).toBe(false);
      expect(isMtplxRepoId('../../etc/passwd')).toBe(false);
      // Each segment must START alphanumeric — the same rule the route schema
      // enforces, so the two guards cannot drift apart.
      expect(isMtplxRepoId('Example/..')).toBe(false);
      expect(isMtplxRepoId('Example/-flag')).toBe(false);
    });
  });

  describe('searchMtplxCatalog', () => {
    it('maps discover cards and omits --query when nothing was typed', async () => {
      const spawn = vi.spyOn(bufferedSpawnModule, 'bufferedSpawn').mockResolvedValue(spawnOk(JSON.stringify([
        { repo: 'Example/Qwen-MTP', branded_name: 'Qwen MTP', owner: 'Example', downloads: 42, license: 'apache-2.0' },
        { branded_name: 'No repo id — dropped' },
      ])));

      const result = await searchMtplxCatalog({});

      expect(result).toEqual({
        models: [{ repo: 'Example/Qwen-MTP', name: 'Qwen MTP', owner: 'Example', downloads: 42, license: 'apache-2.0', publishedAt: null }],
        error: null,
      });
      // An empty `--query ''` would search for the empty string instead of
      // falling through to upstream's default listing.
      expect(spawn.mock.calls[0][1]).not.toContain('--query');
    });

    it('passes a typed query through as its own argv element', async () => {
      const spawn = vi.spyOn(bufferedSpawnModule, 'bufferedSpawn').mockResolvedValue(spawnOk('[]'));
      await searchMtplxCatalog({ query: 'qwen coder', limit: 5 });
      const args = spawn.mock.calls[0][1];
      expect(args[args.indexOf('--query') + 1]).toBe('qwen coder');
      expect(args[args.indexOf('--limit') + 1]).toBe('5');
      expect(spawn.mock.calls[0][2]).toMatchObject({ shell: false });
    });

    it('reports MTPLX\'s own reason rather than an empty list that reads as "none exist"', async () => {
      vi.spyOn(bufferedSpawnModule, 'bufferedSpawn').mockResolvedValue({
        success: false, code: 1, stdout: '', stderr: 'error: huggingface.co unreachable', timedOut: false,
      });
      expect(await searchMtplxCatalog({})).toEqual({ models: [], error: 'error: huggingface.co unreachable' });
    });

    it("carries each repo's Hub publish date so a card can say how old the checkpoint is", async () => {
      vi.spyOn(bufferedSpawnModule, 'bufferedSpawn').mockResolvedValue(spawnOk(JSON.stringify([
        { repo: 'Example/Qwen-MTP', downloads: 42 },
        { repo: 'Example/Unlisted', downloads: 1 },
      ])));
      hfCatalog.fetchRepoPublishedDates.mockResolvedValue({ 'Example/Qwen-MTP': '2026-01-02T00:00:00.000Z' });

      const { models } = await searchMtplxCatalog({});

      expect(models[0].publishedAt).toBe('2026-01-02T00:00:00.000Z');
      // A repo the Hub has no answer for still lists — the card just omits the age.
      expect(models[1].publishedAt).toBeNull();
      expect(hfCatalog.fetchRepoPublishedDates).toHaveBeenCalledWith(['Example/Qwen-MTP', 'Example/Unlisted']);
    });

    it('refuses before spawning when MTPLX is not installed', async () => {
      processEnv.findCommandOnPath.mockReturnValue(null);
      await expect(searchMtplxCatalog({})).rejects.toThrow(/not found on PATH/);
    });
  });

  describe('parseMtplxPullFrame', () => {
    it('normalises a structured progress event', () => {
      expect(parseMtplxPullFrame(
        JSON.stringify({ event: 'progress', repo_id: 'Example/Qwen-MTP', size_bytes: 10, total_bytes: 100, message: 'Downloading model files' }),
        'Example/Qwen-MTP',
      )).toEqual({ event: 'progress', model: 'Example/Qwen-MTP', received: 10, total: 100, message: 'Downloading model files' });
    });

    it('maps `failed` onto the error event the client clears the bar on', () => {
      expect(parseMtplxPullFrame(JSON.stringify({ event: 'failed', message: 'pull failed' }), 'Example/A'))
        .toMatchObject({ event: 'error', message: 'pull failed' });
    });

    it('keeps an unparseable line as a message instead of dropping it', () => {
      // A download that goes quiet for an hour is indistinguishable from one
      // that hung, so a banner line still surfaces.
      expect(parseMtplxPullFrame('Bootstrapping with pip...', 'Example/A'))
        .toEqual({ event: 'progress', model: 'Example/A', message: 'Bootstrapping with pip...' });
      expect(parseMtplxPullFrame('   ', 'Example/A')).toBeNull();
    });

    it('reports a missing total as null so the bar stays indeterminate, not 0%', () => {
      expect(parseMtplxPullFrame(JSON.stringify({ event: 'start', size_bytes: 0, total_bytes: 0 }), 'Example/A'))
        .toMatchObject({ received: 0, total: null });
    });
  });

  describe('pullMtplxModel', () => {
    it('pulls MTPLX\'s own default when no model is named', async () => {
      const run = vi.spyOn(streamingSpawn, 'runStreamingCommand').mockResolvedValue({ success: true });
      const frames = [];

      const result = await pullMtplxModel({ onProgress: (f) => frames.push(f) });

      expect(run.mock.calls[0][1]).toEqual(['pull', '--progress-json']);
      expect(result).toMatchObject({ success: true, model: null });
      expect(frames.at(-1)).toMatchObject({ event: 'complete' });
    });

    it('names the requested repo id on the command line', async () => {
      const run = vi.spyOn(streamingSpawn, 'runStreamingCommand').mockResolvedValue({ success: true });
      await pullMtplxModel({ model: 'Example/Qwen-MTP' });
      expect(run.mock.calls[0][1]).toEqual(['pull', 'Example/Qwen-MTP', '--progress-json']);
    });

    it('rejects a model that is not a repo id before it reaches argv', async () => {
      const run = vi.spyOn(streamingSpawn, 'runStreamingCommand').mockResolvedValue({ success: true });
      await expect(pullMtplxModel({ model: '--cache-dir=/etc' })).rejects.toThrow(/Hugging Face repo id/);
      expect(run).not.toHaveBeenCalled();
    });

    it('resolves (never throws) with the downloader\'s reason on failure', async () => {
      vi.spyOn(streamingSpawn, 'runStreamingCommand').mockResolvedValue({ success: false, error: 'disk full' });
      const frames = [];
      const result = await pullMtplxModel({ model: 'Example/Qwen-MTP', onProgress: (f) => frames.push(f) });
      expect(result).toEqual({ success: false, model: 'Example/Qwen-MTP', error: 'disk full' });
      expect(frames.at(-1)).toMatchObject({ event: 'error', message: 'disk full' });
    });

    it('forwards progress lines but swallows upstream\'s own terminal frames', async () => {
      vi.spyOn(streamingSpawn, 'runStreamingCommand').mockImplementation(async (_cmd, _args, onLine) => {
        onLine(JSON.stringify({ event: 'progress', size_bytes: 5, total_bytes: 10 }));
        // Upstream emits its own `complete`/`result` before the process exits —
        // letting those through would tear the bar down early.
        onLine(JSON.stringify({ event: 'complete', size_bytes: 10, total_bytes: 10 }));
        return { success: true };
      });
      const frames = [];
      await pullMtplxModel({ model: 'Example/Qwen-MTP', onProgress: (f) => frames.push(f) });
      expect(frames.filter((f) => f.event === 'complete')).toHaveLength(1);
      expect(frames.some((f) => f.event === 'progress' && f.received === 5)).toBe(true);
    });

    it('reports what actually landed in the cache, not what was asked for', async () => {
      vi.spyOn(streamingSpawn, 'runStreamingCommand').mockResolvedValue({ success: true });
      mtplxModels.listMtplxCachedModels.mockResolvedValue({
        models: [{ repo_id: 'Example/Qwen-MTP' }], error: null,
      });
      const result = await pullMtplxModel({ model: 'Example/Qwen-MTP' });
      expect(result.cachedModels).toEqual(['Example/Qwen-MTP']);
    });
  });

  describe('removeMtplxModel', () => {
    it('delegates deletion to `mtplx remove` and reports the freed bytes', async () => {
      const spawn = vi.spyOn(bufferedSpawnModule, 'bufferedSpawn').mockResolvedValue(
        spawnOk(JSON.stringify({ repo_id: 'Example/Qwen-MTP', removed: true, size_bytes_removed: 2048 })),
      );

      const result = await removeMtplxModel('Example/Qwen-MTP');

      // Never an unlink of a path PortOS assembled itself — the cache layout is
      // upstream's, and guessing it would be a data-loss bug on the first change.
      expect(spawn.mock.calls[0][1]).toEqual(['remove', 'Example/Qwen-MTP', '--json']);
      expect(result).toEqual({ success: true, model: 'Example/Qwen-MTP', removed: true, bytesFreed: 2048 });
    });

    it('refuses anything that is not a repo id', async () => {
      const spawn = vi.spyOn(bufferedSpawnModule, 'bufferedSpawn').mockResolvedValue(spawnOk('{}'));
      await expect(removeMtplxModel('--cache-dir')).rejects.toThrow(/Hugging Face repo id/);
      expect(spawn).not.toHaveBeenCalled();
    });

    it('reports "not cached" from the JSON payload, not the bare `}` on stdout', async () => {
      // `mtplx remove --json` prints its payload to stdout even on exit 1, so a
      // last-stdout-line heuristic would surface a closing brace as the reason.
      vi.spyOn(bufferedSpawnModule, 'bufferedSpawn').mockResolvedValue({
        success: false,
        code: 1,
        stdout: JSON.stringify({ repo_id: 'Example/Qwen-MTP', removed: false }, null, 2),
        stderr: '',
        timedOut: false,
      });
      const err = await removeMtplxModel('Example/Qwen-MTP').catch((e) => e);
      expect(err.status).toBe(404);
      expect(err.message).toMatch(/not in MTPLX's cache/);
    });

    it('surfaces MTPLX\'s stderr when the removal fails', async () => {
      vi.spyOn(bufferedSpawnModule, 'bufferedSpawn').mockResolvedValue({
        success: false, code: 1, stdout: '', stderr: 'error: model not cached', timedOut: false,
      });
      await expect(removeMtplxModel('Example/Qwen-MTP')).rejects.toThrow(/error: model not cached/);
    });
  });
});
