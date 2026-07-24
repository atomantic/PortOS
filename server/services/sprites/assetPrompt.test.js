/**
 * Asset-prompt provenance resolver (#sprite-prompt-preview): maps a
 * record-relative asset path to the prompt that generated it — stored literal
 * when captured, deterministic rebuild otherwise — for the preview modals.
 * Mirrors reference.test.js's mock setup (PATHS mutation + queue/imagegen/
 * settings stubs) so importing reference.js doesn't pull the live graph.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdir, writeFile } from 'fs/promises';
import { writeCandidatePng, placeCandidate as placeCandidateFixture } from './spriteTestFixtures.js';

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'sprite-assetprompt-test-'));

vi.mock('../../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  Object.assign(actual.PATHS, {
    data: TEST_ROOT,
    sprites: join(TEST_ROOT, 'sprites'),
    images: join(TEST_ROOT, 'images'),
  });
  return actual;
});

vi.mock('../mediaJobQueue/index.js', () => ({
  enqueueJob: () => ({ jobId: 'job-x', position: 0, status: 'queued' }),
  mediaJobEvents: { on: () => {}, off: () => {} },
}));
vi.mock('../imageGen/index.js', () => ({
  resolveImageCleaners: () => ({ cleanC2PA: false, denoise: false }),
}));
vi.mock('../settings.js', () => ({ getSettings: async () => ({ imageGen: { mode: 'codex' } }) }));

const records = await import('./records.js');
const { lockReference, getReferenceSet } = await import('./reference.js');
const { resolveSpriteAssetPrompt } = await import('./assetPrompt.js');

let seq = 0;
const newId = () => `hero-${++seq}`;
const placeCandidate = (recordId, target, name, opts) => placeCandidateFixture(TEST_ROOT, recordId, target, name, opts);

async function createCharacter(id) {
  return records.createRecord({ kind: 'character', name: 'Hero' }, id);
}

beforeEach(() => {
  rmSync(join(TEST_ROOT, 'sprite-records.json'), { force: true });
  rmSync(join(TEST_ROOT, 'sprites'), { force: true, recursive: true });
});
afterAll(() => rmSync(TEST_ROOT, { force: true, recursive: true }));

describe('resolveSpriteAssetPrompt', () => {
  it('returns the literal prompt stored in a candidate sidecar', async () => {
    const id = newId();
    await createCharacter(id);
    const candDir = join(TEST_ROOT, 'sprites', id, 'reference', 'candidates');
    await writeCandidatePng(join(candDir, 'walk-south-candidate-01.png'));
    await writeFile(join(candDir, 'walk-south-candidate-01.generation.json'), JSON.stringify({
      schemaVersion: 1, target: 'main', chromaKey: '#FF00FF',
      designPrompt: 'a brave knight', prompt: 'THE EXACT PROMPT THAT WAS SENT',
    }));

    const res = await resolveSpriteAssetPrompt(id, 'reference/candidates/walk-south-candidate-01.png');
    expect(res).toEqual({ prompt: 'THE EXACT PROMPT THAT WAS SENT', designPrompt: 'a brave knight', source: 'candidate' });
  });

  it('reconstructs a main-candidate prompt when the sidecar predates prompt capture', async () => {
    const id = newId();
    await createCharacter(id);
    const candDir = join(TEST_ROOT, 'sprites', id, 'reference', 'candidates');
    await writeCandidatePng(join(candDir, 'walk-south-candidate-01.png'));
    await writeFile(join(candDir, 'walk-south-candidate-01.generation.json'), JSON.stringify({
      schemaVersion: 1, target: 'main', chromaKey: '#FF00FF', designPrompt: 'a brave knight',
    }));

    const res = await resolveSpriteAssetPrompt(id, 'reference/candidates/walk-south-candidate-01.png');
    expect(res.source).toBe('candidate-reconstructed');
    expect(res.designPrompt).toBe('a brave knight');
    expect(res.prompt).toContain('named Hero');
    expect(res.prompt).toContain('a brave knight');
    expect(res.prompt).toContain('magenta (#FF00FF)');
  });

  it('reconstructs an anchor-candidate prompt from its direction', async () => {
    const id = newId();
    await createCharacter(id);
    const candDir = join(TEST_ROOT, 'sprites', id, 'reference', 'candidates');
    await writeCandidatePng(join(candDir, 'walk-east-candidate-02.png'));
    await writeFile(join(candDir, 'walk-east-candidate-02.generation.json'), JSON.stringify({
      schemaVersion: 1, target: 'east', direction: 'east', chromaKey: '#00FF00',
    }));

    const res = await resolveSpriteAssetPrompt(id, 'reference/candidates/walk-east-candidate-02.png');
    expect(res.source).toBe('candidate-reconstructed');
    expect(res.prompt).toContain('right-facing side profile');
    expect(res.prompt).toContain('green (#00FF00)');
  });

  it('resolves the locked main reference through the manifest', async () => {
    const id = newId();
    await createCharacter(id);
    await lockReference(id, { target: 'main', candidate: await placeCandidate(id, 'main', 'walk-south-candidate-01.png') });
    const { manifest } = await getReferenceSet(id);

    const res = await resolveSpriteAssetPrompt(id, manifest.mainReference.path);
    expect(res).not.toBeNull();
    expect(res.prompt).toContain('named Hero');
    expect(res.prompt).toContain('walk-south identity reference');
  });

  it('resolves a locked directional anchor through the manifest', async () => {
    const id = newId();
    await createCharacter(id);
    await lockReference(id, { target: 'main', candidate: await placeCandidate(id, 'main', 'walk-south-candidate-01.png') });
    await lockReference(id, { target: 'east', candidate: await placeCandidate(id, 'east', 'walk-east-candidate-01.png') });
    const { manifest } = await getReferenceSet(id);
    const eastAnchor = manifest.anchors.find((a) => a.direction === 'east');

    const res = await resolveSpriteAssetPrompt(id, eastAnchor.path);
    expect(res).not.toBeNull();
    expect(res.prompt.toLowerCase()).toContain('hero');
  });

  it('reconstructs a walk-animation prompt from the run record', async () => {
    const id = newId();
    await createCharacter(id);
    const runRel = 'grok/walk-east-abc12345';
    const runDir = join(TEST_ROOT, 'sprites', id, runRel);
    await mkdir(join(runDir, 'generated'), { recursive: true });
    await writeFile(join(runDir, 'animation-run.json'), JSON.stringify({
      schemaVersion: 1, id: 'walk-east-abc12345', characterId: id, direction: 'east', chromaKey: '#FF00FF',
    }));
    await writeFile(join(runDir, 'generated', 'walk.mp4'), 'fake');

    const res = await resolveSpriteAssetPrompt(id, `${runRel}/generated/walk.mp4`);
    expect(res.source).toBe('walk');
    expect(res.prompt).toContain('walk-in-place loop');
    expect(res.prompt).toContain('Hero');
  });

  it('returns null for an asset with no prompt provenance', async () => {
    const id = newId();
    await createCharacter(id);
    const res = await resolveSpriteAssetPrompt(id, 'atlas/pioneer-atlas.png');
    expect(res).toBeNull();
  });

  it('returns null for an unknown record', async () => {
    const res = await resolveSpriteAssetPrompt('ghost-999', 'reference/candidates/walk-south-candidate-01.png');
    expect(res).toBeNull();
  });

  it('refuses a traversal path', async () => {
    const id = newId();
    await createCharacter(id);
    await expect(resolveSpriteAssetPrompt(id, '../escape.png')).rejects.toThrow();
  });
});
