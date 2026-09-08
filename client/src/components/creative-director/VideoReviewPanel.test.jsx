import { beforeEach, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
vi.mock('../../services/apiCreativeDirector.js', () => ({ getCreativeDirectorVideoReview: vi.fn(), submitCreativeDirectorVideoReview: vi.fn() }));
import { getCreativeDirectorVideoReview, submitCreativeDirectorVideoReview } from '../../services/apiCreativeDirector.js';
import VideoReviewPanel from './VideoReviewPanel.jsx';
const checkpoint = { stage: 'script-shot-plan', label: 'Script and shot plan', revision: 'a'.repeat(32), ready: true, status: 'awaiting-review' };
const view = { canReview: true, checkpoints: [checkpoint], feedback: [{ stage: checkpoint.stage, revision: 'old', rating: 'down', note: 'Old feedback' }], artifacts: { revision: 3, script: 'The saved script.', shots: [{ sceneId: 'opening', order: 0, intent: 'Example arrival' }], steps: [] } };
beforeEach(() => {
  vi.resetAllMocks();
  getCreativeDirectorVideoReview.mockResolvedValue(view);
  submitCreativeDirectorVideoReview.mockResolvedValue(view);
});
it('saves thumbs feedback separately and approves the exact displayed revision', async () => {
  const user = userEvent.setup();
  render(<VideoReviewPanel project={{ id: 'example-video' }} />);
  await user.click(await screen.findByRole('button', { name: 'Thumbs up Script and shot plan' }));
  expect(screen.getByText('The saved script.')).toBeInTheDocument();
  expect(screen.queryByText(/Old feedback/)).not.toBeInTheDocument();
  expect(screen.getByText(/Artifact revision 3/)).toBeInTheDocument();
  expect(submitCreativeDirectorVideoReview).toHaveBeenLastCalledWith('example-video', { action: 'feedback', stage: checkpoint.stage, revision: checkpoint.revision, rating: 'up' }, { silent: true });
  await user.click(screen.getByRole('button', { name: 'Approve Script and shot plan' }));
  expect(submitCreativeDirectorVideoReview).toHaveBeenLastCalledWith('example-video', { action: 'approve', stage: checkpoint.stage, revision: checkpoint.revision }, { silent: true });
});
it('submits a targeted revision request and disables every control on a replica', async () => {
  const user = userEvent.setup();
  const { rerender } = render(<VideoReviewPanel project={{ id: 'example-video', treatment: { scenes: [{ sceneId: 'opening', order: 0, intent: 'Example arrival' }] } }} />);
  await user.type(await screen.findByLabelText('Revision notes for Script and shot plan'), 'Change the lighting');
  await user.selectOptions(screen.getByLabelText('Revision target for Script and shot plan'), 'scene:opening');
  await user.click(screen.getByRole('button', { name: 'Request revision' }));
  expect(submitCreativeDirectorVideoReview).toHaveBeenLastCalledWith('example-video', expect.objectContaining({ action: 'request-revision', sceneId: 'opening', note: 'Change the lighting', revision: checkpoint.revision }), { silent: true });
  getCreativeDirectorVideoReview.mockResolvedValue({ ...view, canReview: false });
  rerender(<VideoReviewPanel project={{ id: 'example-video', updatedAt: 'later' }} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Approve Script and shot plan' })).toBeDisabled());
});
