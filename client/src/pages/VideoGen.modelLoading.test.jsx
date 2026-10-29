import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';

import {
  loadVideoGenPage,
  renderVideoGenPage,
  resetVideoGenMockState,
  state,
  videoGenModel,
  videoGenModelContext,
  videoGenStatus,
} from '../test/videoGenPageMocks.jsx';

/**
 * The Model picker does not wait on /status.
 *
 * /status shells out to python on every call, so a cold load used to leave the
 * field absent for a second or two and then pop it into the middle of the form.
 * The list now comes from the probe-free /video-gen/model-context, which lands
 * on its own — while every connectivity claim keeps waiting for the live probe.
 * The loading placeholder remains for the window before either answers.
 */
const MODEL_ONE = videoGenModel('example-one');
const MODEL_TWO = videoGenModel('example-two');
const statusPayload = (overrides = {}) => videoGenStatus([MODEL_ONE, MODEL_TWO], overrides);
const modelContextPayload = (overrides = {}) => videoGenModelContext([MODEL_ONE, MODEL_TWO], overrides);

await loadVideoGenPage();

// A call the test settles by hand, so the page can be asserted mid-flight.
const deferred = (mock) => {
  let settle;
  mock.mockReturnValue(new Promise((resolve) => { settle = resolve; }));
  return async (payload) => { await act(async () => { settle(payload); }); };
};
const deferredStatus = () => deferred(state.getVideoGenStatus);
const deferredModelContext = () => deferred(state.getVideoGenModelContext);

describe('VideoGen model picker vs the /status python probe', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    resetVideoGenMockState();
    state.getVideoGenStatus.mockResolvedValue(statusPayload());
    state.getVideoGenModelContext.mockResolvedValue(modelContextPayload());
  });

  it('keeps the Model field with a loading placeholder until the model list lands', async () => {
    const resolveModelContext = deferredModelContext();
    await renderVideoGenPage();

    const field = screen.getByLabelText('Model');
    expect(field).toBeDisabled();
    expect(field).toHaveTextContent('Loading models…');

    await resolveModelContext(modelContextPayload());

    await waitFor(() => expect(screen.getByLabelText('Model')).toHaveValue(MODEL_ONE.id));
    expect(screen.getByLabelText('Model')).toBeEnabled();
  });

  it('paints the model list on a cold load while every python claim waits', async () => {
    // No prior visit and no priming — the regression this pins is the Model
    // field sitting on its placeholder for the whole /status round trip, and
    // the converse: nothing may report the interpreter before it answers.
    const resolveStatus = deferredStatus();
    await renderVideoGenPage();

    const field = screen.getByLabelText('Model');
    expect(field).toBeEnabled();
    expect(field).toHaveValue(MODEL_ONE.id);
    expect(screen.getByText('Checking…')).toBeInTheDocument();
    expect(screen.queryByText(/Install missing Python packages/)).toBeNull();

    await resolveStatus(statusPayload({ connected: true, pythonVersion: '3.12.1' }));
    await waitFor(() => expect(screen.getByText('Python 3.12.1')).toBeInTheDocument());
  });

  it('retries a failed model list independently of the status probe, including another failure', async () => {
    state.getVideoGenModelContext
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('still offline'))
      .mockResolvedValue(modelContextPayload());
    state.modelStatuses = { [MODEL_ONE.id]: { cached: true } };
    await renderVideoGenPage();
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'a fox watches the rain' } });

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the model list');
    expect(screen.getByRole('button', { name: /^Generate$/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Generate$/ })).toHaveAttribute('title', 'Retry the model list before generating or queueing');
    const statusCalls = state.getVideoGenStatus.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('still offline'));
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.getByLabelText('Model')).toHaveValue(MODEL_ONE.id);
    await waitFor(() => expect(screen.getByRole('button', { name: /^Generate$/ })).toBeEnabled());
    expect(state.getVideoGenModelContext).toHaveBeenCalledTimes(3);
    expect(state.getVideoGenStatus).toHaveBeenCalledTimes(statusCalls);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
    await waitFor(() => expect(state.getVideoGenStatus).toHaveBeenCalledTimes(statusCalls + 1));
    expect(state.getVideoGenModelContext).toHaveBeenCalledTimes(3);
  });

  it('takes the Model field away for a successful empty list without showing a fetch error', async () => {
    state.getVideoGenModelContext.mockResolvedValue(videoGenModelContext([]));
    await renderVideoGenPage();

    await waitFor(() => expect(screen.queryByLabelText('Model')).toBeNull());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('retains successful context and selection through a failed refresh and an in-flight retry', async () => {
    state.modelStatuses = { [MODEL_TWO.id]: { cached: true } };
    await renderVideoGenPage();
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'a fox watches the rain' } });
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: MODEL_TWO.id } });
    state.getVideoGenModelContext.mockRejectedValueOnce(new Error('offline'));
    await act(async () => { state.runtimeInstallComplete(); });

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the model list');
    expect(screen.getByLabelText('Model')).toHaveValue(MODEL_TWO.id);
    expect(screen.getByLabelText('Model')).toBeEnabled();
    await waitFor(() => expect(screen.getByRole('button', { name: /^Generate$/ })).toBeEnabled());
    const resolveContext = deferredModelContext();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.getByRole('button', { name: 'Retrying…' })).toBeDisabled();
    expect(screen.getByLabelText('Model')).toHaveValue(MODEL_TWO.id);
    await resolveContext(modelContextPayload());
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.getByLabelText('Model')).toHaveValue(MODEL_TWO.id);
  });
});
