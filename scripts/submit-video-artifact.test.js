import { describe, it, expect, vi } from 'vitest';
vi.mock('../server/services/creativeDirector/local.js', () => ({ getProject: vi.fn(), setTreatment: vi.fn(), setPlan: vi.fn() }));
vi.mock('../server/services/creativeDirector/videoExecution.js', () => ({ assertVideoAttemptDispatch: vi.fn() }));
import { getProject, setTreatment } from '../server/services/creativeDirector/local.js';
import { assertVideoAttemptDispatch } from '../server/services/creativeDirector/videoExecution.js';
import { submitVideoArtifact } from './submit-video-artifact.js';

describe('local Video artifact submission', () => {
  it('validates and persists an authorized treatment, rejecting malformed and retired submissions', async () => {
    getProject.mockResolvedValue({ workspace: 'video', videoExecution: { attempts: [{ id: 'attempt-1', kind: 'treatment' }] } });
    const args = { projectId: 'cd-example', attemptId: 'attempt-1', kind: 'treatment', input: {
      logline: 'A traveler arrives.', synopsis: 'A traveler finds a garden.', script: 'The traveler opens a gate.',
      scenes: [{ sceneId: 'shot-1', order: 0, intent: 'Arrival', prompt: 'A traveler opens a garden gate.', durationSeconds: 6 }],
    } };
    await expect(submitVideoArtifact(args)).resolves.toEqual({ saved: true, kind: 'treatment' });
    expect(setTreatment).toHaveBeenCalledWith('cd-example', expect.objectContaining({ script: args.input.script }));
    setTreatment.mockClear();
    await expect(submitVideoArtifact({ ...args, input: {} })).rejects.toThrow();
    expect(setTreatment).not.toHaveBeenCalled();
    assertVideoAttemptDispatch.mockRejectedValueOnce(new Error('Production is paused'));
    await expect(submitVideoArtifact(args)).rejects.toThrow('Production is paused');
    await expect(submitVideoArtifact({ ...args, attemptId: 'other-attempt' })).rejects.toThrow('No matching');
    expect(setTreatment).not.toHaveBeenCalled();
  });
});
