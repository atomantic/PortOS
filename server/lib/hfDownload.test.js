import { describe, expect, it } from 'vitest';
import { buildHfDownloadArgs, parseHfDownloadLine } from './hfDownload.js';

describe('parseHfDownloadLine', () => {
  it('treats an empty line as ignore', () => {
    expect(parseHfDownloadLine('')).toEqual({ type: 'ignore' });
    expect(parseHfDownloadLine('   \n')).toEqual({ type: 'ignore' });
  });

  it('places file-start progress at the beginning of that file, not 100% of 1/1', () => {
    expect(parseHfDownloadLine(
      'STAGE:download:1/1:qwen3vl_32b_h3_ultra_uncensored_heretic_bf16.safetensors',
    )).toEqual({
      type: 'event',
      event: {
        type: 'progress',
        stage: 'download',
        progress: 0,
        step: 1,
        total: 1,
        file: 'qwen3vl_32b_h3_ultra_uncensored_heretic_bf16.safetensors',
      },
    });
  });

  it('places a mid-repo file start at (n-1)/total', () => {
    expect(parseHfDownloadLine('STAGE:download:3/47:model-00003-of-00047.safetensors').event)
      .toMatchObject({ progress: 2 / 47, step: 3, total: 47 });
  });

  it('decodes byte progress for a single-file pull', () => {
    const downloaded = 26843545600;
    const totalBytes = 51506295440;
    const parsed = parseHfDownloadLine(
      `STAGE:bytes:1/1:${downloaded}/${totalBytes}:qwen3vl_32b.safetensors`,
    );
    expect(parsed.type).toBe('event');
    expect(parsed.event).toMatchObject({
      type: 'progress',
      stage: 'download',
      step: 1,
      total: 1,
      downloaded,
      totalBytes,
      file: 'qwen3vl_32b.safetensors',
    });
    expect(parsed.event.progress).toBeCloseTo(downloaded / totalBytes);
  });

  it('folds the current file\'s byte fraction into a multi-file bar', () => {
    const parsed = parseHfDownloadLine('STAGE:bytes:2/4:50/100:shard-00002.safetensors');
    expect(parsed.event.progress).toBeCloseTo((1 + 0.5) / 4);
  });

  it('treats a zero-size total as no file fraction (still reports downloaded)', () => {
    expect(parseHfDownloadLine('STAGE:bytes:1/1:4096/0:weights.safetensors').event)
      .toMatchObject({ progress: 0, downloaded: 4096, totalBytes: 0 });
  });

  it('decodes the post-transfer verify stage as a completed-file bar', () => {
    expect(parseHfDownloadLine('STAGE:verify:1/1:weights.safetensors')).toEqual({
      type: 'event',
      event: {
        type: 'progress',
        stage: 'verify',
        progress: 1,
        step: 1,
        total: 1,
        file: 'weights.safetensors',
      },
    });
  });

  it('records STAGE:complete bytes without emitting an event', () => {
    expect(parseHfDownloadLine('STAGE:complete:51506295440'))
      .toEqual({ type: 'complete', sizeBytes: 51506295440 });
  });

  it('falls through unknown stages as a generic stage event', () => {
    expect(parseHfDownloadLine('STAGE:list')).toEqual({
      type: 'event',
      event: { type: 'stage', stage: 'list', detail: '' },
    });
  });

  it('captures USER_ERROR kind and prose error messages', () => {
    expect(parseHfDownloadLine('USER_ERROR:gated_repo:org/model'))
      .toEqual({ type: 'user_error', errorKind: 'gated_repo' });
    expect(parseHfDownloadLine('❌ Access to org/model is gated.'))
      .toEqual({ type: 'error_message', message: 'Access to org/model is gated.' });
  });

  it('ignores the redundant DOWNLOAD: mirror line', () => {
    expect(parseHfDownloadLine('DOWNLOAD:1/1:weights.safetensors')).toEqual({ type: 'ignore' });
  });

  it('passes unknown prose through as a log event', () => {
    expect(parseHfDownloadLine('still going')).toEqual({
      type: 'event',
      event: { type: 'log', message: 'still going' },
    });
  });
});

describe('buildHfDownloadArgs', () => {
  const flags = (opts) => buildHfDownloadArgs(opts).args.slice(1); // drop the helper path

  it('passes ignore globs through for a snapshot pull', () => {
    expect(flags({ repo: 'org/bundle', ignore: ['extra/*', 'legacy.pth'] })).toEqual([
      '--repo', 'org/bundle', '--token-env', 'HF_TOKEN',
      '--ignore', 'extra/*', '--ignore', 'legacy.pth',
    ]);
  });

  // scripts/hf_download_repo.py hard-errors on the two together (--only never
  // enumerates the repo, so there is nothing for a glob to filter), so an argv
  // carrying both would fail the download outright.
  it('drops ignore when only is set, rather than emitting both', () => {
    const { args, onlyFiles } = buildHfDownloadArgs({ repo: 'org/bundle', only: ['weight.safetensors'], ignore: ['extra/*'] });
    expect(args).toContain('--only');
    expect(args).not.toContain('--ignore');
    expect(onlyFiles).toEqual(['weight.safetensors']);
  });

  it('skips empty and non-string entries in both lists', () => {
    expect(flags({ repo: 'org/x', only: ['', null, 'a.bin'] })).toEqual([
      '--repo', 'org/x', '--token-env', 'HF_TOKEN', '--only', 'a.bin',
    ]);
    expect(flags({ repo: 'org/x', ignore: ['', undefined] })).toEqual([
      '--repo', 'org/x', '--token-env', 'HF_TOKEN',
    ]);
  });

  it('adds --revision only when one is pinned', () => {
    expect(flags({ repo: 'org/x', revision: 'abc123' })).toContain('--revision');
    expect(flags({ repo: 'org/x' })).not.toContain('--revision');
  });
});
