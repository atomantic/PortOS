import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import LoomImageComposer from './LoomImageComposer';
import { previewImagePrompt } from '../../services/api';

vi.mock('../../services/api', () => ({ previewImagePrompt: vi.fn() }));
afterEach(() => vi.useRealTimers());

// Catches a stale server response enabling Render for text that was never previewed.
it('drops an obsolete preview and submits only the currently previewed authored request', async () => {
  vi.useFakeTimers();
  const pending = [];
  previewImagePrompt.mockImplementation(() => new Promise(resolve => pending.push(resolve)));
  const onRender = vi.fn(async () => ({ jobId: 'example-job' }));
  const onClose = vi.fn();
  render(<LoomImageComposer
    loom={{ id: 'example-loom', styleNotes: 'charcoal lines' }}
    episode={{ id: 'example-episode' }} node={{ id: 'example-scene', imagePrompt: 'First scene' }}
    onRender={onRender} onClose={onClose}
  />);
  await act(() => vi.advanceTimersByTimeAsync(500));
  fireEvent.change(screen.getByLabelText('Scene image prompt'), { target: { value: 'Revised scene' } });
  await act(() => vi.advanceTimersByTimeAsync(500));
  await act(async () => pending[0]({ sentPrompt: 'Obsolete compiled scene' }));
  expect(screen.getByRole('button', { name: 'Render', exact: true })).toBeDisabled();
  expect(screen.queryByText('Obsolete compiled scene')).not.toBeInTheDocument();
  await act(async () => pending[1]({
    sentPrompt: 'Revised scene\n\nStyle: charcoal lines',
    promptAdditions: [{ id: 'loom-style', label: 'Loom style', text: 'Style: charcoal lines' }],
  }));
  fireEvent.click(screen.getByRole('button', { name: 'Show full prompt' }));
  expect(screen.getByLabelText('Scene image prompt')).toHaveValue('Revised scene');
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Render', exact: true })));
  expect(onRender).toHaveBeenCalledWith(expect.objectContaining({ imagePrompt: 'Revised scene' }), expect.objectContaining({
    prompt: 'Revised scene\n\nStyle: charcoal lines',
    fableLoom: { loomId: 'example-loom', episodeId: 'example-episode', nodeId: 'example-scene' },
  }));
  expect(onClose).toHaveBeenCalledOnce();
});

it('shows a canon refusal and keeps Render disabled', async () => {
  vi.useFakeTimers();
  previewImagePrompt.mockRejectedValue(new Error('Canon-locked render cannot preserve the declared scene'));
  render(<LoomImageComposer loom={{ id: 'example-loom' }} episode={{ id: 'example-episode' }}
    node={{ id: 'example-scene', imagePrompt: 'A scene' }} onRender={vi.fn()} onClose={vi.fn()} />);
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(screen.getByRole('alert')).toHaveTextContent('Canon-locked render cannot preserve the declared scene');
  expect(screen.getByRole('button', { name: 'Render', exact: true })).toBeDisabled();
});
