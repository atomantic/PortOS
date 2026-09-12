import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

import {
  loadVideoGenPage,
  renderVideoGenPage,
  resetVideoGenMockState,
  state,
  videoGenModel,
  videoGenModelContext,
  videoGenStatus,
} from '../test/videoGenPageMocks.jsx';

const MODEL = videoGenModel('all-modes', {
  runtime: 'ltx2',
  supportedModes: ['text', 'image', 'fflf', 'extend', 'a2v'],
  supportsNegativePrompt: true,
});

await loadVideoGenPage();

describe('VideoGen primary actions', () => {
  beforeEach(() => {
    resetVideoGenMockState();
    state.getVideoGenStatus.mockResolvedValue(videoGenStatus([MODEL]));
    state.getVideoGenModelContext.mockResolvedValue(videoGenModelContext([MODEL]));
    window.matchMedia = vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
  });

  it('keeps prompt and Generate ahead of closed mobile Options', async () => {
    await renderVideoGenPage();

    const prompt = await screen.findByLabelText('Prompt');
    const generate = screen.getByRole('button', { name: /^Generate$/ });
    const options = screen.getByText('Options').closest('details');
    const primaryActions = screen.getByTestId('video-primary-actions');

    expect(options).not.toHaveAttribute('open');
    expect(options).not.toContainElement(prompt);
    expect(options).toContainElement(screen.getByLabelText('Negative Prompt'));
    expect(options).toContainElement(screen.getByTestId('prompt-enhancer'));
    expect(primaryActions).toContainElement(generate);
    expect(primaryActions).toContainElement(screen.getByRole('button', { name: 'Add to queue' }));
    expect(primaryActions.className).toContain('sticky');
    expect(primaryActions.className).toContain('lg:static');
    expect(prompt.compareDocumentPosition(generate) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(generate.compareDocumentPosition(options) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('warns before submitting a display-sleep render with mobile Options closed', async () => {
    const sleepModel = videoGenModel('sleep-model', { sleepsDisplayDuringRender: true });
    state.getVideoGenStatus.mockResolvedValue(videoGenStatus([sleepModel], { displaySleepOnRender: true }));
    state.getVideoGenModelContext.mockResolvedValue(videoGenModelContext([sleepModel]));
    await renderVideoGenPage();

    const warning = await screen.findByText(/This render will put your display to sleep/);
    const options = screen.getByText('Options').closest('details');
    expect(options).not.toHaveAttribute('open');
    expect(options).not.toContainElement(warning);
    expect(screen.getByTestId('video-primary-actions')).toContainElement(warning);
  });

  it('uses the same primary action bar for every video mode', async () => {
    await renderVideoGenPage();
    await waitFor(() => expect(screen.getByLabelText('Model')).toHaveValue(MODEL.id));

    const primaryActions = screen.getByTestId('video-primary-actions');
    for (const mode of ['Text', 'Image', 'FFLF', 'Extend', 'Audio']) {
      fireEvent.click(screen.getByRole('button', { name: mode }));
      const generate = screen.getByRole('button', { name: /^Generate$/ });
      expect(primaryActions).toContainElement(generate);
      expect(generate).toHaveAttribute('type', 'submit');
    }
  });

  it('opens Options and shows the blocking remedy for a mode with required inputs', async () => {
    await renderVideoGenPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Extend' }));

    expect(screen.getByText('Options').closest('details')).toHaveAttribute('open');
    expect(screen.getByRole('status')).toHaveTextContent('Open Options');
  });

  it('opens Options by default at desktop width', async () => {
    window.matchMedia = vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));

    await renderVideoGenPage();

    expect((await screen.findByText('Options')).closest('details')).toHaveAttribute('open');
  });

  it('keeps Options reachable when matchMedia is unavailable', async () => {
    window.matchMedia = undefined;

    await renderVideoGenPage();

    expect((await screen.findByText('Options')).closest('details')).toHaveAttribute('open');
  });
});
