/**
 * Cast & Sets background failure reporting — when a background stage throws and
 * the failure cannot be recorded on the project either, the operator still gets
 * an error line naming the project, the stage and the secondary error, while the
 * original failure line stays intact.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./projects.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getProject: vi.fn(),
  mutateProjectRecord: vi.fn(),
}));

const projects = await import('./projects.js');
const service = await import('./castAndSetsService.js');

const PROJECT_ID = 'mv-0123456789abcdef';
const project = { id: PROJECT_ID, audioAnalysis: { sections: [{ start: 0, end: 10 }] } };

describe('Cast & Sets background failure reporting', () => {
  let errorSpy;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    await service.__settleCastAndSetsForTests();
    vi.restoreAllMocks();
    projects.getProject.mockReset();
    projects.mutateProjectRecord.mockReset();
  });

  it('logs the secondary error when recording a background failure also rejects', async () => {
    // startCastAndSets: the project loads, the start transition persists.
    projects.getProject.mockResolvedValueOnce(project);
    projects.mutateProjectRecord.mockResolvedValueOnce({
      project,
      stage: { revision: 1, status: 'directing' },
    });
    // The background direction pass fails to load the project...
    projects.getProject.mockRejectedValueOnce(new Error('project store offline'));
    // ...and then the failure record cannot be written either.
    projects.mutateProjectRecord.mockRejectedValueOnce(new Error('record write refused'));

    await service.startCastAndSets(PROJECT_ID, {});
    await service.__settleCastAndSetsForTests();

    const lines = errorSpy.mock.calls.map(([line]) => String(line));
    const original = lines.find((l) => l.includes('The creative direction failed: project store offline'));
    const secondary = lines.find((l) => l.includes('could not be recorded'));

    expect(original).toBeDefined();
    expect(secondary).toBe(
      `❌ Music Video Cast & Sets ${PROJECT_ID} The creative direction failed and its failure could not be recorded: record write refused`,
    );
    // Single-line, emoji-prefixed, on the stderr stream.
    expect(secondary.includes('\n')).toBe(false);
  });
});
