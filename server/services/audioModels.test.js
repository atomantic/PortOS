/**
 * User-installed audio model registry — augments the shipped musicGen engine
 * model lists. tmpdir-backed so it never touches real data/audio-models.json.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'audio-models-test-'));

vi.mock('../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, PATHS: { ...actual.PATHS, data: TEST_DATA_ROOT } };
});

const svc = await import('./audioModels.js');
const { ENGINES } = await import('./pipeline/musicGen.js');

function reset() {
  rmSync(join(TEST_DATA_ROOT, 'audio-models.json'), { force: true });
}

beforeEach(reset);
afterAll(() => rmSync(TEST_DATA_ROOT, { recursive: true, force: true }));

describe('audioModels — isValidRepoId', () => {
  it('accepts org/name shapes and rejects junk / traversal', () => {
    expect(svc.isValidRepoId('facebook/musicgen-large')).toBe(true);
    expect(svc.isValidRepoId('ACE-Step/ACE-Step-v1-3.5B')).toBe(true);
    expect(svc.isValidRepoId('no-slash')).toBe(false);
    expect(svc.isValidRepoId('../evil/x')).toBe(false);
    expect(svc.isValidRepoId('a b/c')).toBe(false);
    expect(svc.isValidRepoId('')).toBe(false);
    expect(svc.isValidRepoId(null)).toBe(false);
  });
});

describe('audioModels — add / list / merge / remove', () => {
  it('listEngineModels returns the shipped defaults when no user models exist', async () => {
    const shipped = ENGINES.musicgen.models.map((m) => m.id);
    const listed = (await svc.listEngineModels('musicgen')).map((m) => m.id);
    expect(listed).toEqual(shipped);
    expect((await svc.listEngineModels('musicgen')).every((m) => m.userAdded === false)).toBe(true);
  });

  it('adds a user model and merges it after the shipped ones (marked userAdded)', async () => {
    const entry = await svc.addAudioModel({ engine: 'musicgen', repo: 'facebook/musicgen-large' });
    expect(entry).toEqual({ id: 'facebook/musicgen-large', repo: 'facebook/musicgen-large', name: 'musicgen-large' });
    const listed = await svc.listEngineModels('musicgen');
    const added = listed.find((m) => m.id === 'facebook/musicgen-large');
    expect(added).toBeTruthy();
    expect(added.userAdded).toBe(true);
    // Shipped models stay first + not flagged userAdded.
    expect(listed[0].userAdded).toBe(false);
  });

  it('uses a provided display name and is idempotent on re-add (updates name)', async () => {
    await svc.addAudioModel({ engine: 'acestep', repo: 'someorg/ace-lora', name: 'My LoRA' });
    await svc.addAudioModel({ engine: 'acestep', repo: 'someorg/ace-lora', name: 'My LoRA v2' });
    const user = await svc.listUserModels('acestep');
    expect(user).toHaveLength(1);
    expect(user[0].name).toBe('My LoRA v2');
  });

  it('rejects an unknown engine and an invalid repo', async () => {
    await expect(svc.addAudioModel({ engine: 'nope', repo: 'a/b' })).rejects.toMatchObject({ code: 'AUDIO_MODEL_UNKNOWN_ENGINE' });
    await expect(svc.addAudioModel({ engine: 'musicgen', repo: 'bad' })).rejects.toMatchObject({ code: 'AUDIO_MODEL_INVALID_REPO' });
  });

  it('does not duplicate a shipped model id if a user re-adds it', async () => {
    const shippedId = ENGINES.audioldm2.models[0].id;
    // shipped ids are short slugs (e.g. "audioldm2"), not repo ids, so a user
    // adding the repo id is a DISTINCT entry; verify the shipped one stays single.
    await svc.addAudioModel({ engine: 'audioldm2', repo: 'cvssp/audioldm2-large' });
    const ids = (await svc.listEngineModels('audioldm2')).map((m) => m.id);
    expect(ids.filter((id) => id === shippedId)).toHaveLength(1);
  });

  it('removes a user model (returns true), and is a no-op for an unknown id', async () => {
    await svc.addAudioModel({ engine: 'musicgen', repo: 'facebook/musicgen-large' });
    expect(await svc.removeAudioModel({ engine: 'musicgen', id: 'facebook/musicgen-large' })).toBe(true);
    expect((await svc.listUserModels('musicgen'))).toHaveLength(0);
    expect(await svc.removeAudioModel({ engine: 'musicgen', id: 'not/there' })).toBe(false);
  });
});
