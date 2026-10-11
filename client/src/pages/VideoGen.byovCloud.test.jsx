import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { awaitEnabled } from '../test/enabledBarrier.js';
import {
  loadVideoGenPage, renderVideoGenPage, resetVideoGenMockState, state,
  videoGenModel, videoGenModelContext, videoGenStatus,
} from '../test/videoGenPageMocks.jsx';

// A BYOV model whose runtime venv is not installed on this machine.
const MODEL = videoGenModel('byov-model', { name: 'Example BYOV', runtime: 'example_byov' });
const generate = () => screen.getByRole('button', { name: 'Generate', exact: true });

await loadVideoGenPage();

describe('VideoGen enqueue policy — cloud render with a BYOV local model selected', () => {
  beforeEach(() => {
    localStorage.clear();
    resetVideoGenMockState();
    state.settings = { imageGen: { grok: { enabled: true } } };
    state.getVideoGenModelContext.mockResolvedValue(videoGenModelContext([MODEL]));
    state.getVideoGenStatus.mockResolvedValue(videoGenStatus([MODEL], { byovRuntimes: ['example_byov'] }));
    state.runtimeStatus = { installed: false, label: 'Example BYOV' };
  });

  it('blocks the local render but leaves Grok enabled without the local-runtime title', async () => {
    await renderVideoGenPage();
    fireEvent.change(await screen.findByLabelText('Prompt'), { target: { value: 'a fox in the rain' } });
    await waitFor(() => expect(generate()).toHaveAttribute('title', expect.stringContaining('runtime is not installed')));
    expect(generate()).toBeDisabled();

    fireEvent.click(await screen.findByRole('button', { name: 'Grok', exact: true }));
    await awaitEnabled(generate);
    expect(generate()).not.toHaveAttribute('title');
    expect(screen.getByRole('button', { name: 'Add to queue', exact: true })).toBeEnabled();
  });
});
