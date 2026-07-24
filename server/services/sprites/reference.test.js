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
import { writeCandidatePng, placeCandidate as placeCandidateFixture } from './spriteTestFixtures.js';

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
  listReferenceSources, listSpriteThumbnails, forkSprite,
} = await import('./reference.js');

let seq = 0;
const newId = () => `hero-${++seq}`;

async function createCharacter(id, input = {}) {
  return records.createRecord({ kind: 'character', name: 'Hero', ...input }, id);
}

const placeCandidate = (recordId, target, name, opts) => placeCandidateFixture(TEST_ROOT, recordId, target, name, opts);

async function lockTurnaround(recordId) {
  const rel = await placeCandidate(recordId, 'turnaround', 'turnaround-candidate-01.png');
  return lockReference(recordId, { target: 'turnaround', candidate: rel });
}

// Walks the turnaround-first order (#2979): the sheet freezes the key, then the
// main descends from it. Anchor tests start from here.
async function lockMain(recordId) {
  await lockTurnaround(recordId);
  const rel = await placeCandidate(recordId, 'main', 'walk-south-candidate-01.png');
  return lockReference(recordId, { target: 'main', candidate: rel });
}

// A pre-#2979 manifest: main-first (schemaVersion 1, no turnaround block),
// nothing locked — written straight to disk the way an install upgraded from
// phase 2 would have it mid-workflow.
async function writeLegacyManifest(recordId) {
  const dir = join(TEST_ROOT, 'sprites', recordId, 'reference');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${recordId}-reference-set-v1.json`), JSON.stringify({
    schemaVersion: 1,
    manifestId: `${recordId}-reference-set-v1`,
    status: 'needs-main-reference',
    characterFamily: recordId,
    chromaKey: null,
    mainReference: { path: null, role: 'immutable-root', background: 'chroma-key', locked: false },
    anchors: ['south', 'south-east', 'east', 'north-east', 'north', 'north-west', 'west', 'south-west']
      .map((direction) => ({ id: `walk-${direction}`, kind: 'walk-anchor', direction, status: 'pending' })),
  }));
}

// …and the same record with its main locked through the legacy main-first path.
async function legacyLockedMain(recordId) {
  await writeLegacyManifest(recordId);
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

  it('requires a design prompt or upload for the turnaround target', async () => {
    const id = newId();
    await createCharacter(id);
    await expect(startReferenceGeneration(id, { target: 'turnaround' }))
      .rejects.toMatchObject({ code: 'DESIGN_INPUT_REQUIRED' });
  });

  it('queues a turnaround render with the sprite tag and seeds the manifest', async () => {
    const id = newId();
    await createCharacter(id);
    const result = await startReferenceGeneration(id, { target: 'turnaround', designPrompt: 'a wiry ranger' });
    expect(result).toMatchObject({ jobId: 'job-1234567890', mode: 'codex', target: 'turnaround', anchorId: 'turnaround' });

    const call = enqueueJob.mock.calls[0][0];
    expect(call.kind).toBe('image');
    expect(call.params.mode).toBe('codex');
    expect(call.params.model).toBe('gpt-5.6-luna');
    expect(call.params.prompt).toContain('named Hero');
    expect(call.params.prompt).toContain('a wiry ranger');
    expect(call.params.prompt).toContain('magenta (#FF00FF)');
    // The panels, in order, and the constraint the sheet exists to enforce.
    expect(call.params.prompt).toContain('1) facing the viewer (front)');
    expect(call.params.prompt).toContain('3) facing directly away from the viewer');
    expect(call.params.prompt).toContain('SAME anatomical side');
    expect(call.params.spriteRef).toMatchObject({
      recordId: id, target: 'turnaround', anchorId: 'turnaround', chromaKey: '#FF00FF',
      // Provenance records the model the provider will actually run, not
      // null on the default path.
      model: 'gpt-5.6-luna',
    });

    const { manifest } = await getReferenceSet(id);
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.status).toBe('needs-turnaround');
    expect(manifest.anchors).toHaveLength(8);
    expect(manifest.designPrompt).toBe('a wiry ranger');
  });

  it('persists an uploaded design reference and records it in the tag provenance', async () => {
    const id = newId();
    await createCharacter(id);
    const tmp = join(TEST_ROOT, 'upload-tmp.png');
    await writeCandidatePng(tmp);
    await startReferenceGeneration(id, { target: 'turnaround' }, { tempPath: tmp, originalname: 'concept.png' });
    const call = enqueueJob.mock.calls[0][0];
    expect(call.params.spriteRef.designReferencePath).toMatch(/^reference\/uploads\/.+concept\.png$/);
    expect(call.params.initImagePath).toContain('/reference/uploads/');
    expect(call.params.initImageStrength).toBe(0.65);
  });

  it('refuses the main and anchors before the turnaround is locked, and south always', async () => {
    const id = newId();
    await createCharacter(id);
    await startReferenceGeneration(id, { target: 'turnaround', designPrompt: 'x' });
    await expect(startReferenceGeneration(id, { target: 'main', designPrompt: 'x' }))
      .rejects.toMatchObject({ code: 'TURNAROUND_NOT_LOCKED', status: 409 });
    await expect(startReferenceGeneration(id, { target: 'east' }))
      .rejects.toMatchObject({ code: 'TURNAROUND_NOT_LOCKED', status: 409 });
    // 'south' is not a valid anchor target at all (schema also blocks it).
    await expect(startReferenceGeneration(id, { target: 'south' }))
      .rejects.toMatchObject({ code: 'INVALID_TARGET' });
  });

  it('refuses anchors between the turnaround lock and the main lock', async () => {
    const id = newId();
    await createCharacter(id);
    await lockTurnaround(id);
    await expect(startReferenceGeneration(id, { target: 'east' }))
      .rejects.toMatchObject({ code: 'MAIN_NOT_LOCKED', status: 409 });
  });

  it('derives the main from the locked turnaround via i2i', async () => {
    const id = newId();
    await createCharacter(id);
    await startReferenceGeneration(id, { target: 'turnaround', designPrompt: 'a wiry ranger' });
    enqueueJob.mockClear();
    await lockTurnaround(id);
    const result = await startReferenceGeneration(id, { target: 'main' });
    expect(result.anchorId).toBe('walk-south');
    const call = enqueueJob.mock.calls[0][0];
    expect(call.params.initImagePath).toContain(`${id}-turnaround-v1.png`);
    expect(call.params.initImageStrength).toBe(0.8);
    expect(call.params.prompt).toContain('turnaround model sheet');
    expect(call.params.prompt).toContain('facing the viewer (front)');
    // The design prompt persists from the turnaround step — the main render
    // still describes the character even though the body carried no prompt.
    expect(call.params.prompt).toContain('a wiry ranger');
  });

  it('400s a seed image sent with the main target once the sheet is locked', async () => {
    // The sheet IS the seed there, so a supplied one would be silently dropped
    // (the route allows an upload for `main` because a legacy record takes one).
    const id = newId();
    await createCharacter(id);
    await lockTurnaround(id);
    const galleryName = 'fork-seed.png';
    await writeCandidatePng(join(TEST_ROOT, 'images', galleryName));
    await expect(startReferenceGeneration(id, { target: 'main', initImageGalleryFile: galleryName }))
      .rejects.toMatchObject({ code: 'SEED_NOT_APPLICABLE', status: 400 });
    const tmp = join(TEST_ROOT, 'main-seed-tmp.png');
    await writeCandidatePng(tmp);
    await expect(startReferenceGeneration(id, { target: 'main' }, { tempPath: tmp, originalname: 'concept.png' }))
      .rejects.toMatchObject({ code: 'SEED_NOT_APPLICABLE', status: 400 });
    // A legacy record's main still accepts one — the gate is sheet-conditional,
    // not a blanket ban on seeding the main.
    const legacy = newId();
    await createCharacter(legacy);
    await writeLegacyManifest(legacy);
    enqueueJob.mockClear();
    await startReferenceGeneration(legacy, { target: 'main', designPrompt: 'x', initImageGalleryFile: galleryName });
    expect(enqueueJob.mock.calls[0][0].params.initImagePath).toBe(join(TEST_ROOT, 'images', galleryName));
  });

  it('derives anchors from the locked turnaround via i2i with the selected key in the prompt', async () => {
    const id = newId();
    await createCharacter(id);
    await lockMain(id);
    enqueueJob.mockClear();
    const result = await startReferenceGeneration(id, { target: 'east' });
    expect(result.anchorId).toBe('walk-east');
    const call = enqueueJob.mock.calls[0][0];
    expect(call.params.initImagePath).toContain(`${id}-turnaround-v1.png`);
    expect(call.params.prompt).toContain('turnaround model sheet');
    expect(call.params.prompt).toContain('not multiple figures and not panels');
    // The queue's providers re-validate initImagePath through the approved
    // image-input roots — a sprite path must survive that gate or the i2i
    // silently degrades to text-to-image (identity drift).
    const { resolveImageInputPath } = await import('../../lib/fileUtils.js');
    expect(resolveImageInputPath(call.params.initImagePath)).toBe(call.params.initImagePath);
    expect(call.params.initImageStrength).toBe(0.8);
    expect(call.params.prompt).toContain('strict right-facing side profile');
    expect(call.params.prompt).toContain('magenta (#FF00FF)'); // green char kept magenta
  });

  it('threads a correction prompt into the anchor prompt and provenance tag', async () => {
    const id = newId();
    await createCharacter(id);
    await lockMain(id);
    await startReferenceGeneration(id, { target: 'north-east', correctionPrompt: '  no pocket on the right sleeve  ' });
    const call = enqueueJob.mock.calls[0][0];
    expect(call.params.prompt).toContain('Important correction — apply this over the attached reference: no pocket on the right sleeve');
    // Trimmed and carried on the tag so the completion hook's sidecar records it.
    expect(call.params.spriteRef.correctionPrompt).toBe('no pocket on the right sleeve');
  });

  it('omits the correction from the tag when blank', async () => {
    const id = newId();
    await createCharacter(id);
    await lockMain(id);
    await startReferenceGeneration(id, { target: 'east', correctionPrompt: '   ' });
    const call = enqueueJob.mock.calls[0][0];
    expect(call.params.prompt).not.toContain('Important correction');
    expect(call.params.spriteRef).not.toHaveProperty('correctionPrompt');
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

  it('records an anchor correction prompt in the sidecar as provenance', async () => {
    const id = newId();
    await createCharacter(id);
    await mkdir(join(TEST_ROOT, 'images'), { recursive: true });
    await writeCandidatePng(join(TEST_ROOT, 'images', 'render-3.png'));
    await attachReferenceCandidate({
      recordId: id, target: 'north-east', direction: 'north-east', anchorId: 'walk-north-east',
      chromaKey: '#FF00FF', mode: 'codex', model: 'm', jobId: 'j3',
      correctionPrompt: 'no pocket on the right sleeve', filename: 'render-3.png',
    });
    const sidecar = JSON.parse(await readFile(
      join(TEST_ROOT, 'sprites', id, 'reference', 'candidates', 'walk-north-east-candidate-01.generation.json'), 'utf8',
    ));
    expect(sidecar.correctionPrompt).toBe('no pocket on the right sleeve');
  });

  it('omits correctionPrompt from the sidecar when absent', async () => {
    const id = newId();
    await createCharacter(id);
    await mkdir(join(TEST_ROOT, 'images'), { recursive: true });
    await writeCandidatePng(join(TEST_ROOT, 'images', 'render-4.png'));
    await attachReferenceCandidate({
      recordId: id, target: 'east', direction: 'east', anchorId: 'walk-east',
      chromaKey: '#FF00FF', mode: 'codex', model: 'm', jobId: 'j4', filename: 'render-4.png',
    });
    const sidecar = JSON.parse(await readFile(
      join(TEST_ROOT, 'sprites', id, 'reference', 'candidates', 'walk-east-candidate-01.generation.json'), 'utf8',
    ));
    expect(sidecar).not.toHaveProperty('correctionPrompt');
  });

  it('returns null when the gallery file is gone', async () => {
    const id = newId();
    await createCharacter(id);
    expect(await attachReferenceCandidate({
      recordId: id, target: 'main', anchorId: 'walk-south', filename: 'vanished.png',
    })).toBeNull();
  });
});

describe('lockReference — turnaround (#2979)', () => {
  it('locks the sheet: freezes the key off its holistic palette and advances the status', async () => {
    const id = newId();
    await createCharacter(id);
    const result = await lockTurnaround(id);

    expect(result.manifest.turnaround.locked).toBe(true);
    expect(result.manifest.turnaround.path).toBe(`reference/${id}-turnaround-v1.png`);
    expect(result.manifest.turnaround.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.manifest.turnaround.role).toBe('identity-root');
    expect(result.manifest.turnaround.views).toEqual(['south', 'east', 'north', 'west']);
    // The sheet, not the main, is what chooses the canonical key now.
    expect(result.manifest.chromaKey).toBe('#FF00FF'); // green char → magenta kept
    expect(result.manifest.chromaKeyAutoSelected).toBe(true);
    expect(result.manifest.status).toBe('needs-main-reference');
    expect(result.manifest.mainReference.locked).toBe(false);

    const record = await records.getRecord(id);
    expect(record.chromaKey).toBe('#FF00FF');
    expect(record.status).toBe('reference');
  });

  it('re-keys the sheet without reframing it to a single-figure square', async () => {
    const id = newId();
    await createCharacter(id, { chromaKey: '#0000FF' }); // pin, so lock re-keys
    const rel = await placeCandidate(id, 'turnaround', 'turnaround-candidate-01.png');
    await lockReference(id, { target: 'turnaround', candidate: rel });
    // The fixture candidate is 64×64; normalizeFromAnalysis would rebuild it
    // around the 10×30 figure bbox. recompositeOnKey must leave it alone.
    const meta = await sharp(join(TEST_ROOT, 'sprites', id, `reference/${id}-turnaround-v1.png`)).metadata();
    expect([meta.width, meta.height]).toEqual([64, 64]);
  });

  it('409s a clip-risk sheet lock until accepted', async () => {
    const id = newId();
    await createCharacter(id);
    // A magenta-ish character on the magenta generation key: near-key detail is
    // already masked away, so locking it is lossy.
    const rel = await placeCandidate(id, 'turnaround', 'turnaround-candidate-01.png', {
      fg: { r: 255, g: 80, b: 230 }, // pink outfit near the magenta key
    });
    await expect(lockReference(id, { target: 'turnaround', candidate: rel }))
      .rejects.toMatchObject({ status: 409, code: 'CHROMA_CLIP_RISK' });
    const accepted = await lockReference(id, { target: 'turnaround', candidate: rel, acceptClipRisk: true });
    expect(accepted.manifest.turnaround.locked).toBe(true);
  });

  it('409s a relock and enforces the candidate filename prefix', async () => {
    const id = newId();
    await createCharacter(id);
    await lockTurnaround(id);
    const second = await placeCandidate(id, 'turnaround', 'turnaround-candidate-02.png');
    await expect(lockReference(id, { target: 'turnaround', candidate: second }))
      .rejects.toMatchObject({ status: 409, code: 'REFERENCE_LOCKED' });

    const other = newId();
    await createCharacter(other);
    const mismatched = await placeCandidate(other, 'turnaround', 'walk-east-candidate-01.png');
    await expect(lockReference(other, { target: 'turnaround', candidate: mismatched }))
      .rejects.toMatchObject({ status: 400, code: 'CANDIDATE_TARGET_MISMATCH' });
  });

  it('does not reselect the key when the main lock already froze one (legacy backfill)', async () => {
    const id = newId();
    await createCharacter(id);
    await legacyLockedMain(id);
    const before = await getReferenceSet(id);
    expect(before.manifest.schemaVersion).toBe(1);
    expect(before.manifest.chromaKey).toBe('#FF00FF');
    const recordBefore = await records.getRecord(id);

    const result = await lockTurnaround(id);
    expect(result.manifest.turnaround.locked).toBe(true);
    // Key stays exactly as the main lock froze it, and the legacy manifest is
    // NOT silently upgraded to the turnaround-first schema.
    expect(result.manifest.chromaKey).toBe('#FF00FF');
    expect(result.manifest.schemaVersion).toBe(1);
    // A backfill has nothing to say about the record — the main lock set it.
    const recordAfter = await records.getRecord(id);
    expect(recordAfter.chromaKey).toBe(recordBefore.chromaKey);
    expect(recordAfter.status).toBe(recordBefore.status);
  });

  it('unblocks anchor derivation on a legacy record once the sheet is backfilled', async () => {
    const id = newId();
    await createCharacter(id);
    await legacyLockedMain(id);
    await expect(startReferenceGeneration(id, { target: 'east' }))
      .rejects.toMatchObject({ code: 'TURNAROUND_NOT_LOCKED', status: 409 });
    await lockTurnaround(id);
    enqueueJob.mockClear();
    await startReferenceGeneration(id, { target: 'east' });
    const call = enqueueJob.mock.calls[0][0];
    expect(call.params.initImagePath).toContain(`${id}-turnaround-v1.png`);
    expect(call.params.prompt).toContain('turnaround model sheet');
  });

  it('freezes the key against a post-turnaround repin', async () => {
    const id = newId();
    await createCharacter(id);
    await lockTurnaround(id);
    await expect(patchSpriteRecord(id, { chromaKey: '#00FF00' }))
      .rejects.toMatchObject({ status: 409, code: 'CHROMA_KEY_LOCKED' });
  });

  it('groups a sidecarless turnaround candidate under its own target', async () => {
    const id = newId();
    await createCharacter(id);
    const candDir = join(TEST_ROOT, 'sprites', id, 'reference', 'candidates');
    await mkdir(candDir, { recursive: true });
    await writeCandidatePng(join(candDir, 'turnaround-candidate-01.png')); // no sidecar
    const { candidates } = await getReferenceSet(id);
    expect(candidates.find((c) => c.path.endsWith('turnaround-candidate-01.png')).target).toBe('turnaround');
  });
});

describe('lockReference', () => {
  it('does not reselect the key when the sheet already froze one', async () => {
    const id = newId();
    await createCharacter(id);
    await lockTurnaround(id);
    // A magenta-ish main would auto-select AWAY from magenta if the main lock
    // still ran selection — it must inherit the sheet's frozen key instead.
    const rel = await placeCandidate(id, 'main', 'walk-south-candidate-01.png', {
      fg: { r: 255, g: 80, b: 230 },
    });
    const result = await lockReference(id, { target: 'main', candidate: rel, acceptClipRisk: true });
    expect(result.manifest.chromaKey).toBe('#FF00FF');
    expect(result.manifest.mainReference.clipWarning).toMatch(/generation key #FF00FF/);
  });

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

  it('honors a legacy lowercase pinned key at lock time (phase-1 records)', async () => {
    const id = newId();
    await createCharacter(id);
    await records.updateRecord(id, { chromaKey: '#0000ff' }); // phase-1 stored any-case hex
    const result = await lockMain(id);
    expect(result.manifest.chromaKey).toBe('#0000FF');
    expect(result.manifest.chromaKeyAutoSelected).toBe(false);
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
    await startReferenceGeneration(id, { target: 'turnaround', designPrompt: 'x', mode: 'local' });
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

    // An imported record is main-first with no sheet, so anchors are gated on
    // the backfill — which must resolve the REBASED main as its i2i init.
    await expect(startReferenceGeneration(id, { target: 'east' }))
      .rejects.toMatchObject({ code: 'TURNAROUND_NOT_LOCKED', status: 409 });
    const result = await startReferenceGeneration(id, { target: 'turnaround' });
    expect(result.anchorId).toBe('turnaround');
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

describe('turnaround i2i seed sources', () => {
  it('seeds the turnaround from a gallery image (initImageGalleryFile)', async () => {
    const id = newId();
    await createCharacter(id);
    // resolveGalleryImage resolves a basename under PATHS.images (the test root).
    const galleryName = 'render-history-pick.png';
    await writeCandidatePng(join(TEST_ROOT, 'images', galleryName));
    await startReferenceGeneration(id, { target: 'turnaround', designPrompt: 'red coat', initImageGalleryFile: galleryName });
    const call = enqueueJob.mock.calls[0][0];
    expect(call.params.initImagePath).toBe(join(TEST_ROOT, 'images', galleryName));
    expect(call.params.initImageStrength).toBe(0.65);
    expect(call.params.spriteRef.designReferencePath).toBe(`gallery:${galleryName}`);
  });

  it('400s a gallery pick that is not in the gallery', async () => {
    const id = newId();
    await createCharacter(id);
    await expect(startReferenceGeneration(id, { target: 'turnaround', designPrompt: 'x', initImageGalleryFile: 'ghost.png' }))
      .rejects.toMatchObject({ code: 'INIT_IMAGE_NOT_FOUND', status: 400 });
  });

  it('seeds from another sprite\'s locked turnaround, preferring the sheet over its main', async () => {
    const source = newId();
    await createCharacter(source);
    await lockMain(source); // locks the sheet AND the main
    const dest = newId();
    await createCharacter(dest);
    enqueueJob.mockClear();
    await startReferenceGeneration(dest, { target: 'turnaround', designPrompt: 'now with a hat', initImageSpriteId: source });
    const call = enqueueJob.mock.calls[0][0];
    // The sheet carries every side, so a derive inherits accessory placement.
    expect(call.params.initImagePath).toBe(join(TEST_ROOT, 'sprites', source, `reference/${source}-turnaround-v1.png`));
    expect(call.params.spriteRef.designReferencePath).toBe(`sprite:${source}/reference/${source}-turnaround-v1.png`);
  });

  it('falls back to a legacy source\'s locked main when it has no sheet', async () => {
    const source = newId();
    await createCharacter(source);
    await legacyLockedMain(source);
    const dest = newId();
    await createCharacter(dest);
    enqueueJob.mockClear();
    await startReferenceGeneration(dest, { target: 'turnaround', designPrompt: 'x', initImageSpriteId: source });
    const call = enqueueJob.mock.calls[0][0];
    expect(call.params.initImagePath).toBe(join(TEST_ROOT, 'sprites', source, `reference/${source}-walk-south-v1.png`));
  });

  it('400s seeding from a source with no locked reference', async () => {
    const source = newId();
    await createCharacter(source); // never locked
    const dest = newId();
    await createCharacter(dest);
    await expect(startReferenceGeneration(dest, { target: 'turnaround', designPrompt: 'x', initImageSpriteId: source }))
      .rejects.toMatchObject({ code: 'SOURCE_REFERENCE_MISSING', status: 400 });
  });
});

describe('listReferenceSources', () => {
  it('returns characters with a locked reference, preferring the turnaround sheet', async () => {
    const locked = newId();
    await createCharacter(locked, { name: 'Locked One' });
    await lockMain(locked);
    const legacy = newId();
    await createCharacter(legacy, { name: 'Legacy One' });
    await legacyLockedMain(legacy);
    const draft = newId();
    await createCharacter(draft, { name: 'Draft One' }); // nothing locked
    const sources = await listReferenceSources();
    const ids = sources.map((s) => s.id);
    expect(ids).toContain(locked);
    expect(ids).toContain(legacy);
    expect(ids).not.toContain(draft);
    const entry = sources.find((s) => s.id === locked);
    expect(entry).toMatchObject({ id: locked, name: 'Locked One', kind: 'character' });
    expect(entry.path).toContain(`${locked}-turnaround-v1.png`);
    expect(entry.turnaroundPath).toContain(`${locked}-turnaround-v1.png`);
    // A legacy source is still seedable — it just has no sheet to advertise.
    const legacyEntry = sources.find((s) => s.id === legacy);
    expect(legacyEntry.path).toContain(`${legacy}-walk-south-v1.png`);
    expect(legacyEntry.turnaroundPath).toBeNull();
  });
});

describe('listSpriteThumbnails', () => {
  it('uses a locked character main, an on-disk asset for other kinds, and omits imageless records', async () => {
    // Character with a locked main → its canonical main-reference path (no
    // asset scan needed).
    const hero = newId();
    await createCharacter(hero, { name: 'Hero One' });
    await lockMain(hero);

    // A place with an on-disk previewable image → that asset.
    const place = 'saloon-thumb';
    await records.createRecord({ kind: 'place', name: 'Saloon' }, place);
    await mkdir(join(TEST_ROOT, 'sprites', place), { recursive: true });
    await writeCandidatePng(join(TEST_ROOT, 'sprites', place, 'establishing.png'));

    // A character with NO locked main but an asset → falls back to the asset.
    const drafted = newId();
    await createCharacter(drafted, { name: 'Draft Two' });
    await mkdir(join(TEST_ROOT, 'sprites', drafted), { recursive: true });
    await writeCandidatePng(join(TEST_ROOT, 'sprites', drafted, 'sketch.png'));

    // An object with no image at all → omitted entirely.
    const empty = 'crate-thumb';
    await records.createRecord({ kind: 'object', name: 'Crate' }, empty);

    const thumbs = await listSpriteThumbnails();
    const byId = Object.fromEntries(thumbs.map((t) => [t.id, t.path]));

    expect(byId[hero]).toContain(`${hero}-walk-south-v1.png`);
    expect(byId[place]).toBe('establishing.png');
    expect(byId[drafted]).toBe('sketch.png');
    expect(byId).not.toHaveProperty(empty);
  });
});

describe('forkSprite', () => {
  it('creates a new character and queues its turnaround seeded from the source sheet', async () => {
    const source = newId();
    await createCharacter(source, { name: 'Origin' });
    await lockMain(source);
    enqueueJob.mockClear();
    const { record, jobId, target } = await forkSprite(source, { name: 'Origin Fork', designPrompt: 'wearing a red coat' });
    // A fork enters the same turnaround-first workflow every new character does.
    expect(target).toBe('turnaround');
    expect(jobId).toBe('job-1234567890');
    expect(record.kind).toBe('character');
    expect(record.name).toBe('Origin Fork');
    // The new record exists and the render was seeded from the source's ref.
    expect(await records.getRecord(record.id)).toBeTruthy();
    const call = enqueueJob.mock.calls[0][0];
    expect(call.params.spriteRef.recordId).toBe(record.id);
    expect(call.params.initImagePath).toBe(join(TEST_ROOT, 'sprites', source, `reference/${source}-turnaround-v1.png`));
  });

  it('400s forking a source with no locked main and creates no orphan record', async () => {
    const source = newId();
    await createCharacter(source);
    const before = (await records.listRecords()).length;
    await expect(forkSprite(source, { name: 'Bad Fork', designPrompt: 'x' }))
      .rejects.toMatchObject({ code: 'SOURCE_REFERENCE_MISSING', status: 400 });
    // The invariant this test names: the source is resolved BEFORE the record is
    // created, so a rejected fork leaves no orphan character behind.
    expect((await records.listRecords()).length).toBe(before);
  });
});
