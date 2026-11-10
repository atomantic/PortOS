import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import SharedTakeOffers from './SharedTakeOffers.jsx';

const scenes = [0, 1, 2].map((n) => ({ sceneId: `s${n}`, startSec: n, endSec: n + 1, framePrompt: 'A held wide shot', shotSheet: { cameraId: 'cam', location: 'Set' } }));

// Uniquely catches overlapping sequence saves and a false-return save silently continuing after partial application.
it('disables overlapping offers and reports a partially saved sequence', async () => {
  let finish;
  const onSave = vi.fn().mockReturnValueOnce(new Promise((resolve) => { finish = resolve; })).mockResolvedValueOnce(false);
  const { rerender } = render(<SharedTakeOffers scenes={scenes} onSave={onSave} />);
  const button = screen.getByRole('button', { name: 'Render 3 adjacent shots as one clip' });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(button).toBeDisabled();
  expect(onSave).toHaveBeenCalledTimes(1);
  await act(async () => finish(true));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('1 shot saved before the failure'));
  expect(onSave).toHaveBeenCalledTimes(2);
  expect(button).not.toBeDisabled();
  // Optimistic local updates can remove the offer before the failed save answers.
  rerender(<SharedTakeOffers scenes={scenes.map((scene) => ({ ...scene, coverage: 'sequence' }))} onSave={onSave} />);
  expect(screen.getByRole('alert').textContent).toContain('1 shot saved before the failure');
  onSave.mockResolvedValue(true);
  fireEvent.click(screen.getByRole('button', { name: 'Retry shared take' }));
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(5));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
});
