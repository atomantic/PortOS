/**
 * The author-side `evaluate` pass must receive the cast's AUTHORED framework
 * (#6417) so it can report delivery against the plan — and nothing may call a
 * provider before the writer explicitly asks for an analysis.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makePathsProxy } from '../../lib/mockPathsDataRoot.js';

let tempRoot;

vi.mock('../../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../../lib/fileUtils.js');
  return makePathsProxy(actual, { dataRoot: () => tempRoot });
});
vi.mock('../aiProvider.js', () => ({ stripCodeFences: (s) => String(s ?? '') }));
vi.mock('../stageRunner.js', () => ({ runStagedLLM: vi.fn() }));
vi.mock('../bibleExtractor.js', () => ({ extractBible: vi.fn() }));
vi.mock('../sceneExtractor.js', () => ({ extractScenes: vi.fn(), SOURCE_KIND: { PROSE: 'prose' } }));
vi.mock('../mediaCollections.js', () => ({ addItem: vi.fn(), ERR_DUPLICATE: 'DUP' }));

const { runStagedLLM } = await import('../stageRunner.js');
const { runAnalysis, getAnalysis, listAnalyses } = await import('./evaluator.js');
const { createWork, saveDraftBody } = await import('./local.js');
const { createCharacter } = await import('./characters.js');

const EVALUATE_JSON = JSON.stringify({
  logline: 'A salvager buys back what she sold.',
  summary: 'She works the docks.',
  themes: [], strengths: [], issues: [], suggestions: [],
});

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'wr-review-ctx-'));
  vi.mocked(runStagedLLM).mockReset();
  vi.mocked(runStagedLLM).mockResolvedValue({ content: EVALUATE_JSON, model: 'test-model', providerId: 'test-provider' });
});
afterEach(() => {
  if (tempRoot && existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
});

async function seedWork() {
  const work = await createWork({ title: 'Example Work', kind: 'short-story' });
  await saveDraftBody(work.id, 'The dock lights came on before she did.');
  return work.id;
}

describe('writers room evaluate — review variables', () => {
  it('passes the authored framework to the evaluate stage', async () => {
    const workId = await seedWork();
    await createCharacter(workId, {
      name: 'Wren Calloway',
      role: 'protagonist',
      lie: 'I only matter while I am useful.',
      need: 'Being wanted is not the same as being needed.',
      want: 'Buy back the family salvage license.',
      arcType: 'positive',
      secrets: ['Sold the license years ago'],
    });

    await runAnalysis(workId, { kind: 'evaluate' });

    const [stage, variables] = vi.mocked(runStagedLLM).mock.calls[0];
    expect(stage).toBe('writers-room-evaluate');
    const cast = JSON.parse(variables.castFrameworkJson);
    expect(cast).toHaveLength(1);
    expect(cast[0]).toMatchObject({
      name: 'Wren Calloway',
      role: 'protagonist',
      lie: 'I only matter while I am useful.',
      need: 'Being wanted is not the same as being needed.',
      want: 'Buy back the family salvage license.',
      arcType: 'positive',
      secrets: ['Sold the license years ago'],
    });
    // Render-oriented canon stays out of the editorial prompt.
    expect(cast[0].physicalDescription).toBeUndefined();
    expect(cast[0].imageRefs).toBeUndefined();
  });

  it('omits the variable entirely when no character has an authored framework', async () => {
    const workId = await seedWork();
    await createCharacter(workId, { name: 'Wren Calloway', physicalDescription: 'tall, freckles' });

    await runAnalysis(workId, { kind: 'evaluate' });

    const [, variables] = vi.mocked(runStagedLLM).mock.calls[0];
    expect(variables.castFrameworkJson).toBeUndefined();
    expect(variables.draftBody).toContain('dock lights');
  });

  it('starts no AI work merely from opening the work', async () => {
    const workId = await seedWork();
    await createCharacter(workId, { name: 'Wren Calloway', lie: 'I only matter while I am useful.' });

    // Everything a client does when a writer opens a work: read the work, its
    // bible, and its analysis history.
    await listAnalyses(workId);
    await getAnalysis(workId, 'evaluate').catch(() => null);

    expect(vi.mocked(runStagedLLM)).not.toHaveBeenCalled();
  });
});
