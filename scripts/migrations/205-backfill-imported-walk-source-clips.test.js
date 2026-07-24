/**
 * Migration 205 — backfill the source clip for walk runs imported before the
 * importer copied it (#2984). Builds a sprite record holding three runs in the
 * three states the migration must distinguish — clip reachable only under the
 * twin run-dir layout, clip already in place, clip nowhere inside the record —
 * and asserts it copies exactly the first, leaves the second untouched, and
 * treats the third as a silent skip rather than a failure.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { mkdir, writeFile, readFile, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import migration from './205-backfill-imported-walk-source-clips.js';

let ROOT;
const sprites = () => join(ROOT, 'data', 'sprites');
const exists = (abs) => stat(abs).then(() => true, () => false);

const ID = 'example-walker';
const CLIP_BYTES = 'CLIP-BYTES';

// One run record in the shape the importer leaves behind: no `id`, every
// embedded path anchored at the SOURCE repo root.
// `native: true` instead stamps the shape PortOS writes for its own runs — an
// `id` and a record-relative clip path — which the migration must NOT count as
// awaiting a re-import.
async function writeRun(base, runId, { sourceVideoPath, clipAt, native = false } = {}) {
  const runDir = join(sprites(), ID, base, runId);
  await mkdir(join(runDir, 'generated'), { recursive: true });
  await writeFile(join(runDir, 'animation-run.json'), JSON.stringify({
    kind: 'grok-walk-animation-run',
    status: native ? 'rendering' : 'approved',
    characterId: ID,
    direction: 'south',
    ...(native ? { id: runId } : {}),
    ...(sourceVideoPath ? { sourceVideoPath } : {}),
  }));
  if (clipAt) {
    const clipAbs = join(sprites(), ID, clipAt);
    await mkdir(dirname(clipAbs), { recursive: true });
    await writeFile(clipAbs, CLIP_BYTES);
  }
}

beforeEach(async () => {
  ROOT = mkdtempSync(join(tmpdir(), 'migration-205-'));
  await mkdir(sprites(), { recursive: true });
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe('migration 205 — backfill imported walk source clips', () => {
  it('copies a clip reachable under the twin run layout, skips one already present, and leaves an unreachable run alone', async () => {
    // Run A: record + manifest under runs/, clip only under the grok/ twin.
    await writeRun('runs', 'walk-south-aaaa1111', {
      sourceVideoPath: `art-source/sprites/${ID}/runs/walk-south-aaaa1111/generated/source-video.mp4`,
      clipAt: 'grok/walk-south-aaaa1111/generated/source-video.mp4',
    });
    // Run B: clip already sitting where it belongs.
    await writeRun('runs', 'walk-east-bbbb2222', {
      clipAt: 'runs/walk-east-bbbb2222/generated/source-video.mp4',
    });
    // Run C: no clip anywhere inside the record — a re-import is the remedy.
    await writeRun('runs', 'walk-west-cccc3333', {});
    // Run D: stored under the legacy grok/ layout (so the scan must cover both
    // dirs), with the record naming a clip that is already exactly there — the
    // record's declared path wins over the conventional one.
    await writeRun('grok', 'walk-north-dddd4444', {
      sourceVideoPath: `art-source/sprites/${ID}/runs/walk-north-dddd4444/generated/source-video.mp4`,
      clipAt: 'runs/walk-north-dddd4444/generated/source-video.mp4',
    });

    // Run E: a NATIVE run still rendering — no clip yet, and a re-import would
    // not produce one, so it must stay out of the "needs a re-import" tally.
    await writeRun('runs', 'walk-north-east-eeee5555', { native: true });

    const result = await migration.up({ rootDir: ROOT });
    // Only run C — the imported, clipless one — counts as missing.
    expect(result).toEqual({ ok: true, migrated: 1, missing: 1 });

    const clipA = join(sprites(), ID, 'runs/walk-south-aaaa1111/generated/source-video.mp4');
    expect(await readFile(clipA, 'utf8')).toBe(CLIP_BYTES);
    // The twin copy is left in place — the migration never moves/removes bytes.
    expect(await exists(join(sprites(), ID, 'grok/walk-south-aaaa1111/generated/source-video.mp4'))).toBe(true);
    expect(await readFile(join(sprites(), ID, 'runs/walk-east-bbbb2222/generated/source-video.mp4'), 'utf8')).toBe(CLIP_BYTES);
    expect(await exists(join(sprites(), ID, 'runs/walk-west-cccc3333/generated/source-video.mp4'))).toBe(false);
    // Run D was already satisfied at its DECLARED path — nothing copied into
    // the grok/ directory the run record itself lives in.
    expect(await exists(join(sprites(), ID, 'grok/walk-north-dddd4444/generated/source-video.mp4'))).toBe(false);

    // Run records are never rewritten — they are hash-pinned and the read
    // layer re-anchors their paths in memory.
    const record = JSON.parse(await readFile(join(sprites(), ID, 'runs/walk-south-aaaa1111/animation-run.json'), 'utf8'));
    expect(record.sourceVideoPath).toBe(`art-source/sprites/${ID}/runs/walk-south-aaaa1111/generated/source-video.mp4`);
  });

  it('is idempotent — a second pass copies nothing', async () => {
    await writeRun('runs', 'walk-south-aaaa1111', {
      clipAt: 'grok/walk-south-aaaa1111/generated/source-video.mp4',
    });
    expect(await migration.up({ rootDir: ROOT })).toEqual({ ok: true, migrated: 1, missing: 0 });
    expect(await migration.up({ rootDir: ROOT })).toEqual({ ok: true, migrated: 0, missing: 0 });
  });

  it('no-ops on an install with no sprites tree', async () => {
    rmSync(join(ROOT, 'data'), { recursive: true, force: true });
    expect(await migration.up({ rootDir: ROOT })).toEqual({ ok: true, migrated: 0 });
  });
});
