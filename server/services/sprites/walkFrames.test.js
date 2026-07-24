/**
 * verifyPackagedFrames (#3001) — the single definition of "this manifest's
 * packaged frames are valid", shared by the approve gate (existence-only) and
 * the compile gate (existence + sha256 + gait-phase/order, read once). These
 * tests assert the two modes agree on resolution and that the compile mode is a
 * strict superset: it rejects present-but-tampered frames the approve mode lets
 * through, and reads each frame's bytes exactly once.
 */

import { describe, it, expect, vi, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdir, writeFile } from 'fs/promises';
import { createHash } from 'crypto';

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'sprite-frames-test-'));

vi.mock('../../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  Object.assign(actual.PATHS, {
    data: TEST_ROOT,
    sprites: join(TEST_ROOT, 'sprites'),
  });
  return actual;
});

// Count every fs/promises readFile so the compile mode's read-once-verify
// property can be asserted directly. mkdir/writeFile stay real (spread through).
const { readCalls } = vi.hoisted(() => ({ readCalls: [] }));
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readFile: (path, ...rest) => { readCalls.push(String(path)); return actual.readFile(path, ...rest); },
  };
});

const { verifyPackagedFrames } = await import('./walkFrames.js');
const { walkPhaseLabels } = await import('./walkBounds.js');

afterAll(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

let seq = 0;
const newId = () => `frametest-${++seq}`;

/**
 * Write `count` frame PNGs under `<id>/<layout>/<runId>/generated/frames/` and
 * return a manifest whose frames[] declares them, hash-pinned in gait-phase
 * order. `declaredLayout` lets the manifest name a different run-dir spelling
 * than the files live under (drift), and `anchored` prefixes the source repo
 * root so re-anchoring is exercised.
 */
async function makeFrames(id, {
  count = 8, runId = 'run-abcdef', fileLayout = 'grok', declaredLayout = 'grok', anchored = false,
} = {}) {
  const labels = walkPhaseLabels(count);
  const frames = [];
  for (let i = 0; i < count; i++) {
    const bytes = Buffer.from(`frame-${id}-${i}`);
    const fileRel = `${fileLayout}/${runId}/generated/frames/f${i}.png`;
    const abs = join(TEST_ROOT, 'sprites', id, fileRel);
    await mkdir(join(abs, '..'), { recursive: true }); // eslint-disable-line no-await-in-loop
    await writeFile(abs, bytes); // eslint-disable-line no-await-in-loop
    const declaredRel = `${declaredLayout}/${runId}/generated/frames/f${i}.png`;
    frames.push({
      outputIndex: i,
      phase: labels[i],
      path: anchored ? `art-source/sprites/${id}/${declaredRel}` : declaredRel,
      sha256: sha256(bytes),
    });
  }
  return { direction: 'east', characterId: id, frameCount: count, frames };
}

describe('verifyPackagedFrames — existence mode (approve gate)', () => {
  it('passes when every declared frame is on disk', async () => {
    const id = newId();
    const manifest = await makeFrames(id);
    const { total, missing } = await verifyPackagedFrames(id, manifest);
    expect(total).toBe(8);
    expect(missing).toBe(0);
  });

  it('counts an absent frame as missing without changing the declared total', async () => {
    const id = newId();
    const manifest = await makeFrames(id);
    manifest.frames[2].path = manifest.frames[2].path.replace('f2.png', 'gone.png');
    const { total, missing } = await verifyPackagedFrames(id, manifest);
    expect(total).toBe(8);
    expect(missing).toBe(1);
  });

  it('resolves frame paths drift-tolerantly (declared runs/, stored grok/)', async () => {
    const id = newId();
    const manifest = await makeFrames(id, { fileLayout: 'grok', declaredLayout: 'runs' });
    const { total, missing } = await verifyPackagedFrames(id, manifest);
    expect(total).toBe(8);
    expect(missing).toBe(0);
  });

  it('re-anchors a source-repo-anchored frame path before resolving', async () => {
    const id = newId();
    const manifest = await makeFrames(id, { anchored: true });
    const { total, missing } = await verifyPackagedFrames(id, manifest);
    expect(total).toBe(8);
    expect(missing).toBe(0);
  });

  it('reports an un-re-anchorable frame path as a failure, not a silent drop', async () => {
    const id = newId();
    const manifest = await makeFrames(id);
    // A foreign repo-anchored path toRecordRelativeAssetPath returns null for.
    manifest.frames[5].path = 'art-pipeline/scripts/whatever.png';
    const { total, missing } = await verifyPackagedFrames(id, manifest);
    expect(total).toBe(8); // still counted in the declared total
    expect(missing).toBe(1);
  });

  it('treats a manifest with no frames[] as valid (strip sha stays primary)', async () => {
    const id = newId();
    const { total, missing } = await verifyPackagedFrames(id, { direction: 'east' });
    expect(total).toBe(0);
    expect(missing).toBe(0);
  });
});

describe('verifyPackagedFrames — byte mode (compile gate)', () => {
  it('returns the verified bytes and reads each frame exactly once', async () => {
    const id = newId();
    const manifest = await makeFrames(id);
    readCalls.length = 0;
    const { total, missing, frameBytes } = await verifyPackagedFrames(id, manifest, { bytes: true });
    expect(total).toBe(8);
    expect(missing).toBe(0);
    expect(frameBytes).toHaveLength(8);
    expect(frameBytes[0].toString()).toBe(`frame-${id}-0`);
    // Read-once-verify-in-memory: every frame read exactly once, none twice.
    const frameReads = readCalls.filter((p) => p.includes('/frames/'));
    expect(frameReads).toHaveLength(8);
    expect(new Set(frameReads).size).toBe(8);
  });

  it('rejects a present-but-tampered frame (sha mismatch, not just absent)', async () => {
    const id = newId();
    const manifest = await makeFrames(id);
    // The file exists (so the approve/existence gate passes) but its recorded
    // sha no longer matches its bytes — only the byte mode catches it.
    const existence = await verifyPackagedFrames(id, manifest);
    expect(existence.missing).toBe(0);
    manifest.frames[3].sha256 = 'deadbeef';
    await expect(verifyPackagedFrames(id, manifest, { bytes: true }))
      .rejects.toMatchObject({ status: 422, code: 'ATLAS_COMPILE_INVALID' });
  });

  it('rejects a frame out of gait-phase order', async () => {
    const id = newId();
    const manifest = await makeFrames(id);
    manifest.frames[4].outputIndex = 99;
    await expect(verifyPackagedFrames(id, manifest, { bytes: true }))
      .rejects.toMatchObject({ status: 422, code: 'ATLAS_COMPILE_INVALID' });
  });

  it('rejects a missing frame with a compile error', async () => {
    const id = newId();
    const manifest = await makeFrames(id);
    manifest.frames[1].path = manifest.frames[1].path.replace('f1.png', 'gone.png');
    await expect(verifyPackagedFrames(id, manifest, { bytes: true }))
      .rejects.toMatchObject({ status: 422, code: 'ATLAS_COMPILE_INVALID' });
  });
});
