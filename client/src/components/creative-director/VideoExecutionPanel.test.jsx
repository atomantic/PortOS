import { beforeEach, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
vi.mock('../../services/apiCreativeDirector.js', () => ({ getCreativeDirectorVideoExecution: vi.fn(), startCreativeDirectorVideoExecution: vi.fn() }));
import { getCreativeDirectorVideoExecution, startCreativeDirectorVideoExecution } from '../../services/apiCreativeDirector.js';
import VideoExecutionPanel from './VideoExecutionPanel.jsx';
const preview = { canStart: true, blockers: [], configurationRevision: 'a'.repeat(32), choices: { video: { mode: 'reactor', modelDescription: 'fast-h3' }, treatment: { providerId: 'example-agent', model: 'example-model' }, audio: {} }, costNotice: 'Provider prices are unknown.', limits: { maxClips: 60, maxRetries: 1, maxReplans: 2, maxAgentCalls: 100, spendCapUsd: null }, execution: null };
beforeEach(() => {
  vi.resetAllMocks();
  getCreativeDirectorVideoExecution.mockResolvedValue(preview);
  startCreativeDirectorVideoExecution.mockResolvedValue({});
});
const show = status => render(<MemoryRouter><VideoExecutionPanel project={{ id: 'example-video', status }} basePath="/video/productions" /></MemoryRouter>);
it('shows reviewed choices and submits explicit limits with the displayed configuration revision', async () => {
  const user = userEvent.setup();
  show('draft');
  expect(await screen.findByText('reactor · fast-h3')).toBeInTheDocument();
  expect(startCreativeDirectorVideoExecution).not.toHaveBeenCalled();
  await user.clear(screen.getByLabelText('Maximum clip submissions'));
  expect(screen.getByRole('button', { name: 'Start production' })).toBeDisabled();
  await user.type(screen.getByLabelText('Maximum clip submissions'), '8');
  await user.click(screen.getByRole('button', { name: 'Start production' }));
  expect(startCreativeDirectorVideoExecution).toHaveBeenCalledWith('example-video', { configurationRevision: preview.configurationRevision, limits: { ...preview.limits, maxClips: 8 }, retryAttemptIds: [] }, { silent: true });
});
it('requires explicit acknowledgement of uncertain submissions before Resume', async () => {
  const user = userEvent.setup();
  const attemptId = '00000000-0000-4000-8000-000000000001';
  getCreativeDirectorVideoExecution.mockResolvedValue({ ...preview, execution: { attempts: [{ id: attemptId, kind: 'clip', sceneId: 'opening', status: 'uncertain' }] } });
  show('paused');
  const resume = await screen.findByRole('button', { name: 'Resume production' });
  expect(resume).toBeDisabled();
  await user.click(screen.getByRole('checkbox', { name: /retrying may charge again/ }));
  await user.click(resume);
  expect(startCreativeDirectorVideoExecution).toHaveBeenCalledWith('example-video', expect.objectContaining({ retryAttemptIds: [attemptId] }), { silent: true });
});

it('keeps the Start rejection visible after refreshing provider choices', async () => {
  const user = userEvent.setup();
  startCreativeDirectorVideoExecution.mockRejectedValue(new Error('The dollar cap cannot bound this provider'));
  show('draft');
  await user.click(await screen.findByRole('button', { name: 'Start production' }));
  await waitFor(() => expect(getCreativeDirectorVideoExecution).toHaveBeenCalledTimes(2));
  expect(screen.getByRole('alert')).toHaveTextContent('The dollar cap cannot bound this provider');
});
