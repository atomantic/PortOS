import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './238-video-finish-profiles.js';
import { VIDEO_FINISH_PROFILES } from '../../server/lib/videoFinishProfiles.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

const DRAFT_ID = 'wan22_t2v_a14b_lightning';
const DELIVERY_ID = 'wan22_t2v_a14b';
const SHIPPED_REPO = VIDEO_FINISH_PROFILES[DRAFT_ID].shippedRepo;

// The pair as an existing install stores it, pre-migration: same repo, same
// runtime, same modes — differing only in step budget and sampler.
const baseRegistry = (draftOverrides = {}) => ({
  video: {
    macos: [
      { id: DELIVERY_ID, name: 'Wan 2.2 T2V A14B', repo: SHIPPED_REPO, runtime: 'wan22', supportedModes: ['text'], steps: 20 },
      { id: DRAFT_ID, name: 'Wan 2.2 T2V A14B Lightning', repo: SHIPPED_REPO, runtime: 'wan22', supportedModes: ['text'], steps: 4, samplerLocked: true, ...draftOverrides },
      { id: 'my_custom_model', name: 'My Custom Model', repo: 'example-org/example-video', source: 'user' },
    ],
    windows: [{ id: 'ltx_video', name: 'LTX-Video 0.9.5', runtime: 'mlx_video', steps: 25 }],
    defaultMacos: DELIVERY_ID,
  },
});

const findMacos = (path, id) => readJson(path).video.macos.find((e) => e.id === id);

describe('migration 238 — video finish profiles', () => {
  let rootDir;
  let path;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-238-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    path = join(rootDir, 'data', 'media-models.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('links the shipped draft entry to its delivery model', async () => {
    writeJson(path, baseRegistry());
    await migration.up({ rootDir });
    expect(findMacos(path, DRAFT_ID).finishModelId).toBe(DELIVERY_ID);
  });

  it('preserves canonical fields and entry order', async () => {
    writeJson(path, baseRegistry());
    await migration.up({ rootDir });
    const got = readJson(path);
    expect(got.video.macos.map((e) => e.id)).toEqual([DELIVERY_ID, DRAFT_ID, 'my_custom_model']);
    const draft = findMacos(path, DRAFT_ID);
    expect(draft.repo).toBe(SHIPPED_REPO);
    expect(draft.steps).toBe(4);
    expect(draft.samplerLocked).toBe(true);
    expect(got.video.defaultMacos).toBe(DELIVERY_ID);
  });

  it('does not link the delivery model or a custom model to anything', async () => {
    writeJson(path, baseRegistry());
    await migration.up({ rootDir });
    expect('finishModelId' in findMacos(path, DELIVERY_ID)).toBe(false);
    expect('finishModelId' in findMacos(path, 'my_custom_model')).toBe(false);
  });

  it('preserves a user override (including an intentional null)', async () => {
    writeJson(path, baseRegistry({ finishModelId: null }));
    await migration.up({ rootDir });
    expect(findMacos(path, DRAFT_ID).finishModelId).toBe(null);
  });

  it('skips an entry whose repo was re-pointed at a fork', async () => {
    writeJson(path, baseRegistry({ repo: 'example-org/wan2.2-fork' }));
    await migration.up({ rootDir });
    expect('finishModelId' in findMacos(path, DRAFT_ID)).toBe(false);
  });

  it('does not write an edge whose target the user already deleted', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    writeJson(path, {
      video: {
        macos: [{ id: DRAFT_ID, repo: SHIPPED_REPO, runtime: 'wan22', supportedModes: ['text'], steps: 4 }],
        windows: [],
      },
    });
    await migration.up({ rootDir });
    expect('finishModelId' in findMacos(path, DRAFT_ID)).toBe(false);
  });

  it('does not recreate entries the user deleted', async () => {
    writeJson(path, { video: { macos: [{ id: DELIVERY_ID, repo: SHIPPED_REPO }], windows: [] } });
    await migration.up({ rootDir });
    expect(readJson(path).video.macos.map((e) => e.id)).toEqual([DELIVERY_ID]);
  });

  it('is idempotent — a second run rewrites nothing', async () => {
    writeJson(path, baseRegistry());
    await migration.up({ rootDir });
    const after = readFileSync(path, 'utf-8');
    await migration.up({ rootDir });
    expect(readFileSync(path, 'utf-8')).toBe(after);
  });

  it('skips silently when data/media-models.json is missing (fresh install)', async () => {
    await migration.up({ rootDir });
    expect(existsSync(path)).toBe(false);
  });

  it('skips when the video section is missing entirely', async () => {
    writeJson(path, { image: [] });
    await migration.up({ rootDir });
    expect(readJson(path)).toEqual({ image: [] });
  });

  it('throws a clear error on invalid JSON', async () => {
    writeFileSync(path, '{ not json');
    await expect(migration.up({ rootDir })).rejects.toThrow(/invalid JSON/);
  });
});
