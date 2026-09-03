import { beforeEach, describe, expect, it } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';

import {
  loadVideoGenPage,
  renderVideoGenPage,
  resetVideoGenMockState,
  state,
  videoGenModel,
  videoGenStatus,
} from '../test/videoGenPageMocks.jsx';

/**
 * The Model picker paints before /status lands.
 *
 * /status shells out to python and rebuilds the hardware-aware model list on
 * every call, so the field used to be absent for a second or two and then pop
 * into the middle of the form. It now holds its place with a loading
 * placeholder, and a session-cached payload paints the real list immediately —
 * while every connectivity claim keeps waiting for the live probe.
 */
const MODEL_ONE = videoGenModel('example-one');
const MODEL_TWO = videoGenModel('example-two');
const statusPayload = (overrides = {}) => videoGenStatus([MODEL_ONE, MODEL_TWO], overrides);

await loadVideoGenPage();
const { VIDEO_GEN_STATUS_CACHE_KEY } = await import('../lib/videoGenStatusCache.js');

// A /status call the test settles by hand, so the page can be asserted mid-probe.
const deferredStatus = () => {
  let settle;
  state.getVideoGenStatus.mockReturnValue(new Promise((resolve) => { settle = resolve; }));
  return async (payload) => { await act(async () => { settle(payload); }); };
};

describe('VideoGen model picker while /status is in flight', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    resetVideoGenMockState();
    state.getVideoGenStatus.mockResolvedValue(statusPayload());
    state.attach.mockResolvedValue({ filename: 'example.mp4' });
  });

  it('keeps the Model field with a loading placeholder until the model list lands', async () => {
    const resolveStatus = deferredStatus();
    await renderVideoGenPage();

    const field = screen.getByLabelText('Model');
    expect(field).toBeDisabled();
    expect(field).toHaveTextContent('Loading models…');

    await resolveStatus(statusPayload());

    await waitFor(() => expect(screen.getByLabelText('Model')).toHaveValue(MODEL_ONE.id));
    expect(screen.getByLabelText('Model')).toBeEnabled();
  });

  it('paints the cached model list on the next load instead of waiting for the probe', async () => {
    const first = await renderVideoGenPage();
    await waitFor(() => expect(screen.getByLabelText('Model')).toHaveValue(MODEL_ONE.id));
    // Only the model-shaping slice is persisted — python health never is.
    expect(Object.keys(JSON.parse(sessionStorage.getItem(VIDEO_GEN_STATUS_CACHE_KEY))).sort())
      .toEqual(['defaultModel', 'models', 'systemMemoryGb']);
    first.unmount();

    const resolveStatus = deferredStatus();
    await renderVideoGenPage();

    const field = screen.getByLabelText('Model');
    expect(field).toBeEnabled();
    expect(field).toHaveValue(MODEL_ONE.id);
    await resolveStatus(statusPayload());
  });

  it('never reports python health from a cached entry', async () => {
    // A hand-written entry carrying a FAILED probe — the belt to the
    // projection's braces. The model list may come from storage; the diagnosis
    // may not, because the interpreter can have been fixed since.
    sessionStorage.setItem(VIDEO_GEN_STATUS_CACHE_KEY, JSON.stringify(statusPayload({
      connected: false,
      reason: 'Python probe failed',
      missingPackages: ['torch'],
    })));
    const resolveStatus = deferredStatus();
    await renderVideoGenPage();

    expect(screen.getByLabelText('Model')).toHaveValue(MODEL_ONE.id);
    expect(screen.getByText('Checking…')).toBeInTheDocument();
    expect(screen.queryByText(/Install missing Python packages/)).toBeNull();
    expect(screen.queryByText(/Python probe failed/)).toBeNull();

    await resolveStatus(statusPayload({ connected: true, pythonVersion: '3.12.1' }));
    await waitFor(() => expect(screen.getByText('Python 3.12.1')).toBeInTheDocument());
  });
});
