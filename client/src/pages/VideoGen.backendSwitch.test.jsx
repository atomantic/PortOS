import { beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';

import {
  loadVideoGenPage,
  renderVideoGenPage,
  resetVideoGenMockState,
  state,
  videoGenModel,
  videoGenModelContext,
  videoGenStatus,
} from '../test/videoGenPageMocks.jsx';

const MODEL = videoGenModel('local-model');

await loadVideoGenPage();

describe('VideoGen backend switch — fal.ai/reactor.inc usability', () => {
  beforeEach(() => {
    localStorage.clear();
    resetVideoGenMockState();
    state.getVideoGenModelContext.mockResolvedValue(videoGenModelContext([MODEL]));
  });

  // A key configured only via the FAL_KEY/REACTOR_API_KEY env var (no
  // Settings-form entry) still makes the server's isVideoModeUsable() report
  // true — GET /status must reflect that so the switcher appears without the
  // client ever reading `videoGen.fal.apiKey` / `videoGen.reactor.apiKey`
  // off the settings object.
  it('shows fal.ai and reactor.inc once /status reports them usable, with no settings key stored', async () => {
    state.getVideoGenStatus.mockResolvedValue(videoGenStatus([MODEL], {
      falEnabled: true,
      reactorEnabled: true,
    }));
    await renderVideoGenPage();

    await waitFor(() => expect(screen.getByRole('group', { name: 'Video generation backend' })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'fal.ai' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reactor.inc' })).toBeInTheDocument();
  });

  it('hides the switch entirely when neither backend is usable', async () => {
    state.getVideoGenStatus.mockResolvedValue(videoGenStatus([MODEL], {
      falEnabled: false,
      reactorEnabled: false,
    }));
    await renderVideoGenPage();

    await waitFor(() => expect(screen.getByLabelText('Model')).toHaveValue(MODEL.id));
    expect(screen.queryByRole('group', { name: 'Video generation backend' })).toBeNull();
  });
});
