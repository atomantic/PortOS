import { expect, it, vi } from 'vitest';
import { HOSTED_VIDEO_SUBMISSIONS } from './hostedSubmission.js';

it('preserves the Higgsfield catalog error code and cleans up rejected inputs', async () => {
  const cleanupStaged = vi.fn(async () => {});

  await expect(HOSTED_VIDEO_SUBMISSIONS.higgsfield.stageInputs({
    body: { prompt: 'A test shot', lastImageFile: 'end.png' },
    uploads: {},
    sourceImagePath: null,
    cleanupStaged,
  })).rejects.toMatchObject({ status: 400, code: 'HIGGSFIELD_VIDEO_INPUT_INVALID' });
  expect(cleanupStaged).toHaveBeenCalledOnce();
});
