import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ records: [] }));
vi.mock('../lib/fileUtils.js', () => ({
  PATHS: { data: '/test' },
  readJSONFile: vi.fn(async () => structuredClone(state.records)),
  atomicWrite: vi.fn(async (_path, records) => { state.records = structuredClone(records); }),
}));
import { saveMediaPromptExamination, listMediaPromptExaminations, getMediaPromptExamination } from './mediaPromptHistory.js';

beforeEach(() => { state.records = []; });
describe('saved media examination workflow', () => {
  it('retains both prompts and source across independent and concurrent analyses', async () => {
    const source = { sourceKind: 'image', filename: 'example.png' };
    const result = { imagePrompt: 'Mountains', videoPrompt: 'Drifting clouds', imageNegativePrompt: 'blur', model: 'example-model' };
    const records = await Promise.all([saveMediaPromptExamination(source, result), saveMediaPromptExamination(source, { imagePrompt: 'Another interpretation' })]);
    expect((await listMediaPromptExaminations()).items).toHaveLength(2);
    expect(await getMediaPromptExamination(records[0].id)).toMatchObject({ source, result });
    expect(await getMediaPromptExamination('missing')).toBeUndefined();
  });
  it('pages summaries without returning full prompt bodies', async () => {
    for (let i = 0; i < 22; i++) await saveMediaPromptExamination({ filename: 'example.png' }, { imagePrompt: 'Mountains' });
    const first = await listMediaPromptExaminations();
    expect(first.items).toHaveLength(20);
    expect(first.hasMore).toBe(true);
    expect(first.items[0]).not.toHaveProperty('result');
    expect((await listMediaPromptExaminations(20)).items).toHaveLength(2);
  });
});
