import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdir, writeFile } from 'fs/promises';
import { createHash } from 'crypto';
import { placeCandidate } from './spriteTestFixtures.js';

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'sprite-ambient-test-'));

vi.mock('../../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  Object.assign(actual.PATHS, {
    data: TEST_ROOT,
    sprites: join(TEST_ROOT, 'sprites'),
    images: join(TEST_ROOT, 'images'),
    videos: join(TEST_ROOT, 'videos'),
  });
  return actual;
});

const executeTuiRun = vi.fn(() => new Promise(() => {}));
vi.mock('../../lib/tuiPromptRunner.js', () => ({
  executeTuiRun: (...args) => executeTuiRun(...args),
}));

vi.mock('../settings.js', () => ({
  getSettings: async () => ({ imageGen: { grok: { grokPath: '/usr/local/bin/grok' } } }),
}));

const prepareWalkAnchorChromaInput = vi.fn(async (_mainAbs, inputAbs) => {
  await mkdir(join(inputAbs, '..'), { recursive: true });
  const bytes = Buffer.from('ambient-chroma-input');
  await writeFile(inputAbs, bytes);
  return {
    preparation: 'composited-over-solid-chroma-matte',
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
});
vi.mock('./walkPostprocess.js', async (importOriginal) => ({
  ...await importOriginal(),
  prepareWalkAnchorChromaInput: (...args) => prepareWalkAnchorChromaInput(...args),
}));

const records = await import('./records.js');
const { lockReference } = await import('./reference.js');
const { getAmbientState, startAmbientGeneration } = await import('./ambient.js');

let sequence = 0;
const newId = () => `ambient-${++sequence}`;

async function placeWithLockedMain(id) {
  await records.createRecord({ kind: 'place', name: 'Willow' }, id);
  const candidate = await placeCandidate(TEST_ROOT, id, 'main', 'main-candidate-01.png');
  await lockReference(id, { target: 'main', candidate });
  return id;
}

beforeEach(() => {
  executeTuiRun.mockClear();
  executeTuiRun.mockImplementation(() => new Promise(() => {}));
  prepareWalkAnchorChromaInput.mockClear();
  rmSync(join(TEST_ROOT, 'sprite-records.json'), { force: true });
});
afterAll(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

describe('ambient animation track', () => {
  it('is provider-silent on reads, then starts one explicit non-directional image-to-video loop', async () => {
    const id = await placeWithLockedMain(newId());

    const initial = await getAmbientState(id);
    expect(initial).toMatchObject({
      track: 'ambient',
      bounds: { minFrameCount: 2, maxFrameCount: 6, defaultFrameCount: 3, defaultFps: 4 },
      runs: [],
    });
    expect(executeTuiRun).not.toHaveBeenCalled();

    const result = await startAmbientGeneration(id, {});
    expect(result).toMatchObject({ duration: 6 });
    expect(result.runId).toMatch(/^ambient-[0-9a-f]{8}$/);
    expect(result.shellSession).toBe(result.runId);
    expect(executeTuiRun).toHaveBeenCalledOnce();
    expect(executeTuiRun.mock.calls[0][0]).toMatchObject({
      runId: result.runId,
      workspacePath: join(TEST_ROOT, 'sprites', id, 'runs', result.runId, 'generated'),
    });
    expect(executeTuiRun.mock.calls[0][0].prompt).toContain('image_to_video');

    expect((await getAmbientState(id)).runs).toMatchObject([{
      id: result.runId,
      track: 'ambient',
      status: 'rendering',
      frameCount: 3,
      fps: 4,
      direction: 'south',
    }]);
  });
});
