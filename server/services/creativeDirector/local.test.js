import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocks declared before importing the module under test.
const mockReadJSONFile = vi.fn();
const mockAtomicWrite = vi.fn();
const mockEnsureDir = vi.fn();

vi.mock('../../lib/fileUtils.js', () => ({
  PATHS: { data: '/fake/data' },
  readJSONFile: (...args) => mockReadJSONFile(...args),
  atomicWrite: (...args) => mockAtomicWrite(...args),
  ensureDir: (...args) => mockEnsureDir(...args),
}));

vi.mock('../mediaCollections.js', () => ({
  createCollection: vi.fn(async () => ({ id: 'col-1' })),
}));

const { setTreatment } = await import('./local.js');

const VALID_TREATMENT = {
  logline: 'A cat finds a hat.',
  synopsis: 'Then puts it on.',
  scenes: [
    {
      sceneId: 'scene-1',
      order: 0,
      intent: 'Cat enters frame',
      prompt: 'A cat walks into view',
      durationSeconds: 4,
    },
  ],
};

beforeEach(() => {
  mockReadJSONFile.mockReset();
  mockAtomicWrite.mockReset().mockResolvedValue(undefined);
  mockEnsureDir.mockReset().mockResolvedValue(undefined);
});

describe('setTreatment — status preservation', () => {
  it('preserves paused status when agent PATCHes treatment on a paused project', async () => {
    mockReadJSONFile.mockResolvedValue([{ id: 'cd-1', status: 'paused', name: 'Test' }]);
    const result = await setTreatment('cd-1', VALID_TREATMENT);
    expect(result.status).toBe('paused');
    const saved = mockAtomicWrite.mock.calls[0][1];
    expect(saved[0].status).toBe('paused');
  });

  it('preserves failed status when agent PATCHes treatment on a failed project', async () => {
    mockReadJSONFile.mockResolvedValue([{ id: 'cd-1', status: 'failed', name: 'Test' }]);
    const result = await setTreatment('cd-1', VALID_TREATMENT);
    expect(result.status).toBe('failed');
    const saved = mockAtomicWrite.mock.calls[0][1];
    expect(saved[0].status).toBe('failed');
  });

  it('flips planning → rendering when agent PATCHes treatment on a planning project', async () => {
    mockReadJSONFile.mockResolvedValue([{ id: 'cd-1', status: 'planning', name: 'Test' }]);
    const result = await setTreatment('cd-1', VALID_TREATMENT);
    expect(result.status).toBe('rendering');
    const saved = mockAtomicWrite.mock.calls[0][1];
    expect(saved[0].status).toBe('rendering');
  });

  it('flips draft → rendering when agent PATCHes treatment on a draft project', async () => {
    mockReadJSONFile.mockResolvedValue([{ id: 'cd-1', status: 'draft', name: 'Test' }]);
    const result = await setTreatment('cd-1', VALID_TREATMENT);
    expect(result.status).toBe('rendering');
  });
});
