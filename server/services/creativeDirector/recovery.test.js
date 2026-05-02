import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocks must be declared before importing the module under test.
const mockListProjects = vi.fn();
const mockUpdateScene = vi.fn();
const mockAdvance = vi.fn();

vi.mock('./local.js', () => ({
  listProjects: (...args) => mockListProjects(...args),
  updateScene: (...args) => mockUpdateScene(...args),
}));

vi.mock('./completionHook.js', () => ({
  advanceAfterSceneSettled: (...args) => mockAdvance(...args),
}));

const { recoverInFlightProjects } = await import('./recovery.js');

beforeEach(() => {
  mockListProjects.mockReset();
  mockUpdateScene.mockReset().mockResolvedValue(undefined);
  mockAdvance.mockReset().mockResolvedValue(undefined);
});

describe('recoverInFlightProjects', () => {
  it('skips terminal and draft projects', async () => {
    mockListProjects.mockResolvedValue([
      { id: 'cd-1', status: 'complete', treatment: { scenes: [{ sceneId: 's1', status: 'accepted' }] } },
      { id: 'cd-2', status: 'failed', treatment: { scenes: [{ sceneId: 's1', status: 'failed' }] } },
      { id: 'cd-3', status: 'draft', treatment: null },
      { id: 'cd-4', status: 'paused', treatment: null },
    ]);
    const result = await recoverInFlightProjects();
    expect(result.resumed).toBe(0);
    expect(mockAdvance).not.toHaveBeenCalled();
    expect(mockUpdateScene).not.toHaveBeenCalled();
  });

  it('resets stuck rendering/evaluating scenes to pending and advances', async () => {
    mockListProjects.mockResolvedValue([
      {
        id: 'cd-1',
        status: 'rendering',
        treatment: {
          scenes: [
            { sceneId: 's1', status: 'accepted' },
            { sceneId: 's2', status: 'rendering' },
            { sceneId: 's3', status: 'evaluating' },
            { sceneId: 's4', status: 'pending' },
          ],
        },
      },
    ]);
    const result = await recoverInFlightProjects();
    expect(result.resumed).toBe(1);
    expect(mockUpdateScene).toHaveBeenCalledTimes(2);
    expect(mockUpdateScene).toHaveBeenCalledWith('cd-1', 's2', { status: 'pending' });
    expect(mockUpdateScene).toHaveBeenCalledWith('cd-1', 's3', { status: 'pending' });
    expect(mockAdvance).toHaveBeenCalledWith('cd-1');
  });

  it('resumes planning-state projects (treatment task interrupted)', async () => {
    mockListProjects.mockResolvedValue([
      { id: 'cd-1', status: 'planning', treatment: null },
    ]);
    const result = await recoverInFlightProjects();
    expect(result.resumed).toBe(1);
    expect(mockUpdateScene).not.toHaveBeenCalled();
    expect(mockAdvance).toHaveBeenCalledWith('cd-1');
  });

  it('resumes stitching-state projects (final concat interrupted)', async () => {
    mockListProjects.mockResolvedValue([
      {
        id: 'cd-1',
        status: 'stitching',
        treatment: { scenes: [{ sceneId: 's1', status: 'accepted', renderedJobId: 'job-1' }] },
      },
    ]);
    const result = await recoverInFlightProjects();
    expect(result.resumed).toBe(1);
    expect(mockAdvance).toHaveBeenCalledWith('cd-1');
  });

  it('handles multiple projects independently', async () => {
    mockListProjects.mockResolvedValue([
      {
        id: 'cd-1',
        status: 'rendering',
        treatment: { scenes: [{ sceneId: 's1', status: 'rendering' }] },
      },
      {
        id: 'cd-2',
        status: 'rendering',
        treatment: { scenes: [{ sceneId: 's1', status: 'evaluating' }] },
      },
    ]);
    const result = await recoverInFlightProjects();
    expect(result.resumed).toBe(2);
    expect(mockAdvance).toHaveBeenCalledTimes(2);
    expect(mockAdvance).toHaveBeenCalledWith('cd-1');
    expect(mockAdvance).toHaveBeenCalledWith('cd-2');
  });
});
