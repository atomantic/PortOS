import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdir, writeFile } from 'fs/promises';
import { createHash } from 'crypto';
import { lockAllAnchors } from './spriteTestFixtures.js';

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'sprite-scanner-test-'));

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
  getSettings: async () => ({
    imageGen: { grok: { grokPath: '/usr/local/bin/grok' } },
  }),
}));

const prepareWalkAnchorChromaInput = vi.fn(async (_anchorAbs, inputAbs) => {
  await mkdir(join(inputAbs, '..'), { recursive: true });
  const bytes = Buffer.from('scanner-chroma-input');
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
const { getScannerState, startScannerGeneration } = await import('./scanner.js');

let sequence = 0;
const newId = () => `scanner-${++sequence}`;

async function characterWithEastAnchor(id) {
  await records.createRecord({ kind: 'character', name: 'Scanner' }, id);
  await lockAllAnchors(TEST_ROOT, id, { lockReference, directions: ['east'] });
  return id;
}

beforeEach(() => {
  executeTuiRun.mockClear();
  executeTuiRun.mockImplementation(() => new Promise(() => {}));
  prepareWalkAnchorChromaInput.mockClear();
  rmSync(join(TEST_ROOT, 'sprite-records.json'), { force: true });
});
afterAll(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

describe('scanner animation track', () => {
  it('is provider-silent on reads, then starts a user-triggered four-frame scanner render', async () => {
    const id = await characterWithEastAnchor(newId());

    const initial = await getScannerState(id);
    expect(initial).toMatchObject({
      track: 'scanner',
      bounds: { minFrameCount: 2, maxFrameCount: 8, defaultFrameCount: 4, defaultFps: 6 },
      runs: [],
    });
    expect(executeTuiRun).not.toHaveBeenCalled();

    const result = await startScannerGeneration(id, { direction: 'east' });
    expect(result).toMatchObject({ direction: 'east', duration: 6 });
    expect(result.runId).toMatch(/^scanner-east-[0-9a-f]{8}$/);
    expect(result.shellSession).toBe(result.runId);
    expect(executeTuiRun).toHaveBeenCalledOnce();
    expect(executeTuiRun.mock.calls[0][0]).toMatchObject({
      runId: result.runId,
      workspacePath: join(TEST_ROOT, 'sprites', id, 'runs', result.runId, 'generated'),
    });
    expect(executeTuiRun.mock.calls[0][0].prompt).toContain('scanner action');

    expect((await getScannerState(id)).runs).toMatchObject([{
      id: result.runId,
      track: 'scanner',
      status: 'rendering',
      frameCount: 4,
      fps: 6,
      direction: 'east',
    }]);
  });

  it('appends a trimmed correction note to the prompt and stamps it on the run (#3134)', async () => {
    const id = await characterWithEastAnchor(newId());
    const { runId } = await startScannerGeneration(id, {
      direction: 'east', correctionPrompt: '  the sweep never returns to the start pose  ',
    });
    expect(executeTuiRun.mock.calls[0][0].prompt)
      .toContain('Important correction — apply this over the attached source image: the sweep never returns to the start pose');
    const { runs } = await getScannerState(id);
    expect(runs.find((r) => r.id === runId).correctionPrompt).toBe('the sweep never returns to the start pose');
  });

  it('leaves a blank correction note out of the prompt and the run record (#3134)', async () => {
    // The task is `<action prompt>\n\n<per-run paths>` — compare the prompt only.
    const actionPrompt = () => executeTuiRun.mock.calls[0][0].prompt.split('\n\n')[0];
    const plain = await characterWithEastAnchor(newId());
    await startScannerGeneration(plain, { direction: 'east' });
    const blindPrompt = actionPrompt();
    executeTuiRun.mockClear();

    const blank = await characterWithEastAnchor(newId());
    const { runId } = await startScannerGeneration(blank, { direction: 'east', correctionPrompt: ' \n ' });
    expect(actionPrompt()).toBe(blindPrompt);
    const { runs } = await getScannerState(blank);
    expect(runs.find((r) => r.id === runId)).not.toHaveProperty('correctionPrompt');
  });
});
