/**
 * Reference workflow orchestration (#2896): generate → candidates → lock,
 * against the file record backend + a tmpdir asset tree. The media-job queue
 * and image-gen dispatcher are mocked — this suite covers the workflow
 * contracts (prompt/tag/param shaping, manifest lifecycle, immutability
 * 409s, dynamic chroma-key selection at lock).
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';
import { mkdir, writeFile, readFile } from 'fs/promises';

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'sprite-reference-test-'));

// MUTATE actual.PATHS (don't replace the object): fileUtils' internal
// resolvers (resolveImageInputPath / resolveSpriteImageInput) close over the
// module-level PATHS reference, and the initImagePath assertion below needs
// them to see the test roots.
vi.mock('../../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  Object.assign(actual.PATHS, {
    data: TEST_ROOT,
    sprites: join(TEST_ROOT, 'sprites'),
    images: join(TEST_ROOT, 'images'),
  });
  return actual;
});

const enqueueJob = vi.fn(() => ({ jobId: 'job-1234567890', position: 0, status: 'queued' }));
vi.mock('../mediaJobQueue/index.js', () => ({
  enqueueJob: (...args) => enqueueJob(...args),
  mediaJobEvents: { on: () => {}, off: () => {} },
}));

vi.mock('../imageGen/index.js', () => ({
  resolveImageCleaners: () => ({ cleanC2PA: false, denoise: false }),
}));

const settings = {
  imageGen: {
    mode: 'codex',
    codex: { enabled: true, codexPath: '/usr/local/bin/codex', model: 'gpt-5.6-luna', effort: 'low' },
    grok: { enabled: true, grokPath: '/usr/local/bin/grok', aspectRatio: '1:1' },
    local: { pythonPath: '/usr/bin/python3', modelId: 'flux-dev-4bit' },
  },
};
vi.mock('../settings.js', () => ({ getSettings: async () => settings }));

const records = await import('./records.js');
const {
  getReferenceSet, startReferenceGeneration, attachReferenceCandidate, lockReference, patchSpriteRecord,
} = await import('./reference.js');

let seq = 0;
const newId = () => `hero-${++seq}`;

async function createCharacter(id, input = {}) {
  return records.createRecord({ kind: 'character', name: 'Hero', ...input }, id);
}

// A green character rectangle on a magenta background — the legacy Pioneer
// shape, so auto-selection should keep magenta.
async function writeCandidatePng(path, { bg = { r: 255, g: 0, b: 255 }, fg = { r: 23, g: 107, b: 101 } } = {}) {
  const w = 64; const h = 64;
  const buf = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inRect = x >= 20 && x < 30 && y >= 10 && y < 40;
      const c = inRect ? fg : bg;
      const i = (y * w + x) * 3;
      buf[i] = c.r; buf[i + 1] = c.g; buf[i + 2] = c.b;
    }
  }
  await mkdir(join(path, '..'), { recursive: true });
  await sharp(buf, { raw: { width: w, height: h, channels: 3 } }).png().toFile(path);
}

async function placeCandidate(recordId, target, name, opts = {}) {
  const candDir = join(TEST_ROOT, 'sprites', recordId, 'reference', 'candidates');
  await mkdir(candDir, { recursive: true });
  await writeCandidatePng(join(candDir, name), opts);
  await writeFile(join(candDir, `${name.replace(/\.png$/, '')}.generation.json`), JSON.stringify({
    schemaVersion: 1, target, chromaKey: opts.sidecarKey ?? '#FF00FF',
  }));
  return `reference/candidates/${name}`;
}

async function lockMain(recordId) {
  const rel = await placeCandidate(recordId, 'main', 'walk-south-candidate-01.png');
  return lockReference(recordId, { target: 'main', candidate: rel });
}

beforeEach(() => {
  enqueueJob.mockClear();
  rmSync(join(TEST_ROOT, 'sprite-records.json'), { force: true });
});
afterAll(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

describe('startReferenceGeneration', () => {
  it('404s an unknown record and 400s a props record', async () => {
    await expect(startReferenceGeneration('nope', { target: 'main', designPrompt: 'x' }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    await records.createRecord({ kind: 'props', name: 'Crates' }, 'crates');
    await expect(startReferenceGeneration('crates', { target: 'main', designPrompt: 'x' }))
      .rejects.toMatchObject({ code: 'NOT_A_CHARACTER' });
  });

  it('requires a design prompt or upload for the main target', async () => {
    const id = newId();
    await createCharacter(id);
    await expect(startReferenceGeneration(id, { target: 'main' }))
      .rejects.toMatchObject({ code: 'DESIGN_INPUT_REQUIRED' });
  });

  it('queues a main render with the sprite tag and seeds the manifest', async () => {
    const id = newId();
    await createCharacter(id);
    const result = await startReferenceGeneration(id, { target: 'main', designPrompt: 'a wiry ranger' });
    expect(result).toMatchObject({ jobId: 'job-1234567890', mode: 'codex', target: 'main', anchorId: 'walk-south' });

    const call = enqueueJob.mock.calls[0][0];
    expect(call.kind).toBe('image');
    expect(call.params.mode).toBe('codex');
    expect(call.params.model).toBe('gpt-5.6-luna');
    expect(call.params.prompt).toContain('named Hero');
    expect(call.params.prompt).toContain('a wiry ranger');
    expect(call.params.prompt).toContain('magenta (#FF00FF)');
    expect(call.params.spriteRef).toMatchObject({
      recordId: id, target: 'main', anchorId: 'walk-south', chromaKey: '#FF00FF',
      // Provenance records the model the provider will actually run, not
      // null on the default path.
      model: 'gpt-5.6-luna',
    });

    const { manifest } = await getReferenceSet(id);
    expect(manifest.status).toBe('needs-main-reference');
    expect(manifest.anchors).toHaveLength(8);
    expect(manifest.designPrompt).toBe('a wiry ranger');
  });

  it('refuses anchors before the main is locked, and south always', async () => {
    const id = newId();
    await createCharacter(id);
    await startReferenceGeneration(id, { target: 'main', designPrompt: 'x' });
    await expect(startReferenceGeneration(id, { target: 'east' }))
      .rejects.toMatchObject({ code: 'MAIN_NOT_LOCKED' });
    // 'south' is not a valid anchor target at all (schema also blocks it).
    await expect(startReferenceGeneration(id, { target: 'south' }))
      .rejects.toMatchObject({ code: 'INVALID_TARGET' });
  });

  it('derives anchors from the locked main via i2i with the selected key in the prompt', async () => {
    const id = newId();
    await createCharacter(id);
    await lockMain(id);
    const result = await startReferenceGeneration(id, { target: 'east' });
    expect(result.anchorId).toBe('walk-east');
    const call = enqueueJob.mock.calls[0][0];
    expect(call.params.initImagePath).toContain(`${id}-walk-south-v1.png`);
    // The queue's providers re-validate initImagePath through the approved
    // image-input roots — a sprite path must survive that gate or the i2i
    // silently degrades to text-to-image (identity drift).
    const { resolveImageInputPath } = await import('../../lib/fileUtils.js');
    expect(resolveImageInputPath(call.params.initImagePath)).toBe(call.params.initImagePath);
    expect(call.params.initImageStrength).toBe(0.8);
    expect(call.params.prompt).toContain('strict right-facing side profile');
    expect(call.params.prompt).toContain('magenta (#FF00FF)'); // green char kept magenta
  });

  it('409s generation for a locked target', async () => {
    const id = newId();
    await createCharacter(id);
    await lockMain(id);
    await expect(startReferenceGeneration(id, { target: 'main', designPrompt: 'x' }))
      .rejects.toMatchObject({ code: 'REFERENCE_LOCKED', status: 409 });

    const rel = await placeCandidate(id, 'east', 'walk-east-candidate-01.png');
    await lockReference(id, { target: 'east', candidate: rel });
    await expect(startReferenceGeneration(id, { target: 'east' }))
      .rejects.toMatchObject({ code: 'REFERENCE_LOCKED', status: 409 });
  });
});

describe('attachReferenceCandidate', () => {
  it('copies the render into candidates/ with a numbered name and sidecar', async () => {
    const id = newId();
    await createCharacter(id);
    await mkdir(join(TEST_ROOT, 'images'), { recursive: true });
    await writeCandidatePng(join(TEST_ROOT, 'images', 'render-1.png'));

    const ctx = {
      recordId: id, target: 'main', direction: 'south', anchorId: 'walk-south',
      chromaKey: '#FF00FF', mode: 'codex', model: 'm', jobId: 'j1',
      designPrompt: 'a ranger', filename: 'render-1.png',
    };
    const first = await attachReferenceCandidate(ctx);
    expect(first.candidatePath).toBe('reference/candidates/walk-south-candidate-01.png');
    const second = await attachReferenceCandidate(ctx);
    expect(second.candidatePath).toBe('reference/candidates/walk-south-candidate-02.png');

    const sidecar = JSON.parse(await readFile(
      join(TEST_ROOT, 'sprites', id, 'reference', 'candidates', 'walk-south-candidate-01.generation.json'), 'utf8',
    ));
    expect(sidecar).toMatchObject({
      kind: 'sprite-reference-generation', characterId: id, target: 'main',
      anchorId: 'walk-south', chromaKey: '#FF00FF', jobId: 'j1', designPrompt: 'a ranger',
    });
    expect(sidecar.model).toBe('m'); // tag model when the job carries none
    expect(sidecar.candidateSha256).toMatch(/^[0-9a-f]{64}$/);

    const { candidates } = await getReferenceSet(id);
    expect(candidates).toHaveLength(2);
    expect(candidates[0].target).toBe('main');
  });

  it('prefers the completed job\'s live model over the tag (Edit & Retry provenance)', async () => {
    const id = newId();
    await createCharacter(id);
    await mkdir(join(TEST_ROOT, 'images'), { recursive: true });
    await writeCandidatePng(join(TEST_ROOT, 'images', 'render-2.png'));
    await attachReferenceCandidate({
      recordId: id, target: 'main', direction: 'south', anchorId: 'walk-south',
      chromaKey: '#FF00FF', mode: 'codex', model: 'stale-tag-model', jobId: 'j2',
      filename: 'render-2.png', job: { params: { model: 'retried-model' } },
    });
    const sidecar = JSON.parse(await readFile(
      join(TEST_ROOT, 'sprites', id, 'reference', 'candidates', 'walk-south-candidate-01.generation.json'), 'utf8',
    ));
    expect(sidecar.model).toBe('retried-model');
  });

  it('returns null when the gallery file is gone', async () => {
    const id = newId();
    await createCharacter(id);
    expect(await attachReferenceCandidate({
      recordId: id, target: 'main', anchorId: 'walk-south', filename: 'vanished.png',
    })).toBeNull();
  });
});

describe('lockReference', () => {
  it('locks the main: normalizes, auto-selects the chroma key, freezes the manifest + record', async () => {
    const id = newId();
    await createCharacter(id);
    const result = await lockMain(id);

    expect(result.manifest.mainReference.locked).toBe(true);
    expect(result.manifest.mainReference.path).toBe(`reference/${id}-walk-south-v1.png`);
    expect(result.manifest.mainReference.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.manifest.chromaKey).toBe('#FF00FF'); // green char → magenta kept
    expect(result.manifest.chromaKeyAutoSelected).toBe(true);
    expect(result.manifest.status).toBe('in-progress');
    const south = result.manifest.anchors.find((a) => a.id === 'walk-south');
    expect(south.status).toBe('locked');

    const record = await records.getRecord(id);
    expect(record.chromaKey).toBe('#FF00FF');
    expect(record.status).toBe('reference');
  });

  it('409s a clip-risk main lock until accepted, then selects away from the clashing key', async () => {
    const id = newId();
    await createCharacter(id);
    const rel = await placeCandidate(id, 'main', 'walk-south-candidate-01.png', {
      fg: { r: 255, g: 80, b: 230 }, // pink/magenta outfit near the magenta key
    });
    // The freeze is irreversible — a clip-risk lock must be refused until
    // the user explicitly locks through it.
    await expect(lockReference(id, { target: 'main', candidate: rel }))
      .rejects.toMatchObject({ status: 409, code: 'CHROMA_CLIP_RISK' });
    let manifest = (await getReferenceSet(id)).manifest;
    expect(manifest?.mainReference?.locked ?? false).toBe(false);

    const result = await lockReference(id, { target: 'main', candidate: rel, acceptClipRisk: true });
    expect(result.manifest.mainReference.locked).toBe(true);
    expect(result.manifest.chromaKey).not.toBe('#FF00FF');
    const record = await records.getRecord(id);
    expect(record.chromaKey).toBe(result.manifest.chromaKey);
    // The accepted risk stays visible on the manifest.
    expect(result.manifest.chromaKeyWarning).toMatch(/generation key #FF00FF/);
  });

  it('409s a lock whose PINNED key collides with the surviving palette', async () => {
    const id = newId();
    await createCharacter(id);
    // Leaf-green clothing (hue ~138 after quantization) + user pins the
    // green key (hue 120): compositing onto green would make runtime keying
    // eat the clothing.
    await records.updateRecord(id, { chromaKey: '#00FF00' });
    const rel = await placeCandidate(id, 'main', 'walk-south-candidate-01.png', {
      fg: { r: 40, g: 200, b: 80 }, // green clothing on the magenta gen key
    });
    await expect(lockReference(id, { target: 'main', candidate: rel }))
      .rejects.toMatchObject({ status: 409, code: 'CHROMA_CLIP_RISK' });
    const accepted = await lockReference(id, { target: 'main', candidate: rel, acceptClipRisk: true });
    expect(accepted.manifest.chromaKey).toBe('#00FF00');
    expect(accepted.manifest.chromaKeyWarning).toMatch(/selected key #00FF00/);
  });

  it('gates anchor locks on clip risk against the canonical key', async () => {
    const id = newId();
    await createCharacter(id);
    await lockMain(id); // teal char → magenta key
    // This facing reveals a pink feature near the magenta generation key.
    const rel = await placeCandidate(id, 'east', 'walk-east-candidate-01.png', {
      fg: { r: 255, g: 80, b: 230 },
    });
    await expect(lockReference(id, { target: 'east', candidate: rel }))
      .rejects.toMatchObject({ status: 409, code: 'CHROMA_CLIP_RISK' });
    const accepted = await lockReference(id, { target: 'east', candidate: rel, acceptClipRisk: true });
    const east = accepted.manifest.anchors.find((a) => a.id === 'walk-east');
    expect(east.status).toBe('locked');
    expect(east.clipWarning).toMatch(/generation key #FF00FF/);
  });

  it('threads the saved local model into local-mode renders and provenance', async () => {
    const id = newId();
    await createCharacter(id);
    await startReferenceGeneration(id, { target: 'main', designPrompt: 'x', mode: 'local' });
    const call = enqueueJob.mock.calls[0][0];
    expect(call.params.mode).toBe('local');
    expect(call.params.modelId).toBe('flux-dev-4bit');
    expect(call.params.spriteRef.model).toBe('flux-dev-4bit');
  });

  it('rebases legacy repo-root manifest paths from a phase-1 import', async () => {
    const id = newId();
    await createCharacter(id);
    const refDir = join(TEST_ROOT, 'sprites', id, 'reference');
    await mkdir(refDir, { recursive: true });
    await writeCandidatePng(join(refDir, `${id}-walk-south-v1.png`));
    await writeFile(join(refDir, `${id}-reference-set-v1.json`), JSON.stringify({
      schemaVersion: 1,
      status: 'in-progress',
      chromaKey: '#FF00FF',
      mainReference: { path: `art-source/sprites/${id}/reference/${id}-walk-south-v1.png`, locked: true },
      anchors: [
        { id: 'walk-south', direction: 'south', status: 'locked', path: `art-source/sprites/${id}/reference/${id}-walk-south-v1.png` },
        { id: 'walk-east', direction: 'east', status: 'pending', source: 'derive-from-main' },
      ],
    }));

    const { manifest } = await getReferenceSet(id);
    expect(manifest.mainReference.path).toBe(`reference/${id}-walk-south-v1.png`);
    expect(manifest.anchors[0].path).toBe(`reference/${id}-walk-south-v1.png`);

    // Anchor derivation must resolve the rebased main as its i2i init.
    const result = await startReferenceGeneration(id, { target: 'east' });
    expect(result.anchorId).toBe('walk-east');
    expect(enqueueJob.mock.calls[0][0].params.initImagePath).toBe(join(TEST_ROOT, 'sprites', id, `reference/${id}-walk-south-v1.png`));
  });

  it('respects a user-pinned key instead of auto-selecting', async () => {
    const id = newId();
    await createCharacter(id);
    await records.updateRecord(id, { chromaKey: '#0000FF' });
    const result = await lockMain(id);
    expect(result.manifest.chromaKey).toBe('#0000FF');
    expect(result.manifest.chromaKeyAutoSelected).toBe(false);
  });

  it('409s a relock and enforces candidate/target agreement', async () => {
    const id = newId();
    await createCharacter(id);
    await lockMain(id);
    const rel = await placeCandidate(id, 'main', 'walk-south-candidate-02.png');
    await expect(lockReference(id, { target: 'main', candidate: rel }))
      .rejects.toMatchObject({ code: 'REFERENCE_LOCKED', status: 409 });

    const eastRel = await placeCandidate(id, 'east', 'walk-east-candidate-01.png');
    await expect(lockReference(id, { target: 'west', candidate: eastRel }))
      .rejects.toMatchObject({ code: 'CANDIDATE_TARGET_MISMATCH' });
  });

  it('refuses a sidecarless candidate whose filename does not match the target', async () => {
    const id = newId();
    await createCharacter(id);
    // Crash between PNG copy and sidecar write: PNG exists, no provenance.
    const candDir = join(TEST_ROOT, 'sprites', id, 'reference', 'candidates');
    await mkdir(candDir, { recursive: true });
    await writeCandidatePng(join(candDir, 'walk-east-candidate-01.png'));
    await expect(lockReference(id, { target: 'main', candidate: 'reference/candidates/walk-east-candidate-01.png' }))
      .rejects.toMatchObject({ code: 'CANDIDATE_TARGET_MISMATCH' });
    // And the reference-set view infers its target from the filename so the
    // client can't group it under main.
    const { candidates } = await getReferenceSet(id);
    expect(candidates[0].target).toBe('east');
  });

  it('refuses candidates outside reference/candidates/ and traversal paths', async () => {
    const id = newId();
    await createCharacter(id);
    await expect(lockReference(id, { target: 'main', candidate: 'runtime/sneaky.png' }))
      .rejects.toMatchObject({ code: 'INVALID_CANDIDATE' });
    await expect(lockReference(id, { target: 'main', candidate: 'reference/candidates/../../../escape.png' }))
      .rejects.toMatchObject({ code: 'INVALID_ASSET_PATH' });
  });

  it('patchSpriteRecord allows a key change pre-lock and 409s it post-lock', async () => {
    const id = newId();
    await createCharacter(id);
    const patched = await patchSpriteRecord(id, { chromaKey: '#0000FF' });
    expect(patched.chromaKey).toBe('#0000FF');
    await patchSpriteRecord(id, { chromaKey: null }); // back to auto so lockMain selects
    await lockMain(id);
    await expect(patchSpriteRecord(id, { chromaKey: '#00FF00' }))
      .rejects.toMatchObject({ status: 409, code: 'CHROMA_KEY_LOCKED' });
    // Non-key fields stay patchable after lock.
    const notes = await patchSpriteRecord(id, { notes: 'still editable' });
    expect(notes.notes).toBe('still editable');
  });

  it('refuses to recreate a character over a tombstoned id', async () => {
    const id = newId();
    await records.createCharacter({ id, name: 'Hero' });
    await records.deleteRecord(id);
    await expect(records.createCharacter({ id, name: 'Hero' }))
      .rejects.toMatchObject({ status: 409, code: 'ID_TOMBSTONED' });
  });

  it('never overwrites an existing versioned artifact (crash-recovery lands on v2)', async () => {
    const id = newId();
    await createCharacter(id);
    // Simulate a crash that wrote v1 but never updated the manifest.
    const refDir = join(TEST_ROOT, 'sprites', id, 'reference');
    await mkdir(refDir, { recursive: true });
    await writeFile(join(refDir, `${id}-walk-south-v1.png`), 'stale-bytes');
    const result = await lockMain(id);
    expect(result.manifest.mainReference.path).toBe(`reference/${id}-walk-south-v2.png`);
    expect(await readFile(join(refDir, `${id}-walk-south-v1.png`), 'utf8')).toBe('stale-bytes');
  });

  it('completes the set when the last anchor locks', async () => {
    const id = newId();
    await createCharacter(id);
    await lockMain(id);
    const { ANCHOR_DIRECTIONS } = await import('./prompts.js');
    for (const direction of ANCHOR_DIRECTIONS) {
      const rel = await placeCandidate(id, direction, `walk-${direction}-candidate-01.png`);
      await lockReference(id, { target: direction, candidate: rel });
    }
    const { manifest } = await getReferenceSet(id);
    expect(manifest.status).toBe('complete');
    expect(manifest.anchors.every((a) => a.status === 'locked')).toBe(true);
    const record = await records.getRecord(id);
    expect(record.status).toBe('reference-complete');
  });
});
