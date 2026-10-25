import { expect, it, vi } from 'vitest';
vi.mock('./db.js', () => ({ getRun: vi.fn(), listRuns: vi.fn(), getRunRequired: vi.fn(), deleteRun: vi.fn(), updateRun: vi.fn() }));
vi.mock('../mediaJobQueue/index.js', () => ({ getJob: vi.fn(), mediaJobEvents: { on: vi.fn() } }));
vi.mock('../loraDatasets.js', () => ({ updateDataset: vi.fn() }));
import { startTrainingRun, resumeTrainingRun } from './index.js';
import { updateRun, getRunRequired } from './db.js';
it('refuses fresh launch, manual resume and automatic resume without changing retained records', async () => {
  await expect(startTrainingRun({ datasetId: 'example' })).rejects.toMatchObject({ status: 410, code: 'LORA_TRAINING_RETIRED' });
  await expect(resumeTrainingRun('example')).rejects.toMatchObject({ status: 410, code: 'LORA_TRAINING_RETIRED' });
  await expect(resumeTrainingRun('example', { auto: true })).rejects.toMatchObject({ status: 410, code: 'LORA_TRAINING_RETIRED' });
  expect(updateRun).not.toHaveBeenCalled(); expect(getRunRequired).not.toHaveBeenCalled();
});
