import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect } from 'vitest';
import migration from './444-minimax-h3-cuda-lightx2v.js';
import profile from '../../server/lib/minimaxH3Lightx2v.json' with { type: 'json' };

it('upgrades only uncustomized shipped rows across canonical and legacy buckets without changing stock settings', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'portos-h3-profile-'));
  try {
    await mkdir(join(rootDir, 'data'));
    const shipped = { ...profile.model, steps: 8, samplerLocked: true, offloadProfile: 'int8-lean' };
    const untouched = [{ ...shipped, speedProfiles: [] }, { ...shipped, speedProfiles: null },
      { ...shipped, revision: 'a'.repeat(40) }, { ...shipped, id: 'custom' },
      { ...shipped, runtime: 'minimax_h3' }];
    const doc = { video: { cuda: [shipped, ...untouched], windows: [shipped], defaultCuda: 'custom' }, settings: { untouched: true } };
    const path = join(rootDir, 'data/media-models.json');
    await writeFile(path, JSON.stringify(doc));
    await migration.up({ rootDir });
    const result = JSON.parse(await readFile(path, 'utf8'));
    expect(result.video.cuda[0]).toEqual({ ...shipped, speedProfiles: [profile] });
    expect(result.video.cuda.slice(1)).toEqual(untouched);
    expect(result.video.windows[0]).toEqual(result.video.cuda[0]);
    expect(result.settings).toEqual(doc.settings);
    expect(result.video.defaultCuda).toBe('custom');
    const once = await readFile(path, 'utf8');
    await migration.up({ rootDir });
    expect(await readFile(path, 'utf8')).toBe(once);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
