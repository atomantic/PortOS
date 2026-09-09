import { it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
vi.mock('../../services/apiCreativeDirector.js', () => ({ updateCreativeDirectorScene: vi.fn() }));
vi.mock('../imageGen/GalleryImagePicker.jsx', () => ({ default: ({ open, onSelect, onClose }) => open ? <button onClick={() => { onSelect({ filename: 'example-frame.png' }); onClose(); }}>Example reference</button> : null }));
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
import { updateCreativeDirectorScene } from '../../services/apiCreativeDirector.js';
import toast from '../ui/Toast';
import VideoShotEditor from './VideoShotEditor.jsx';

it('keeps unsaved reference edits after a failed save and submits the displayed revision', async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<VideoShotEditor project={{ id: 'cd-example', status: 'paused' }} scene={{ sceneId: 'shot-2', order: 1, prompt: 'A garden path', workRevision: 3, useContinuationFromPrior: true }} onChange={onChange} />);
  await user.click(screen.getByRole('button', { name: 'Choose reference frame' }));
  await user.click(screen.getByRole('button', { name: 'Example reference' }));
  expect(screen.getByRole('checkbox', { name: /Continue from/ })).not.toBeChecked();
  updateCreativeDirectorScene.mockRejectedValueOnce(new Error('Unavailable')).mockResolvedValueOnce({});
  await user.click(screen.getByRole('button', { name: 'Save shot' }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Unavailable'));
  expect(onChange).not.toHaveBeenCalled();
  expect(screen.getByRole('img', { name: 'Shot reference frame' })).toHaveAttribute('src', '/data/images/example-frame.png');
  await user.click(screen.getByRole('button', { name: 'Save shot' }));
  await waitFor(() => expect(onChange).toHaveBeenCalledOnce());
  expect(updateCreativeDirectorScene).toHaveBeenLastCalledWith('cd-example', 'shot-2', { prompt: 'A garden path', sourceImageFile: 'example-frame.png', muteAudio: false, useContinuationFromPrior: false, expectedWorkRevision: 3 }, { silent: true });
});


it('saves a mute-only repair with the displayed shot revision', async () => {
  const user = userEvent.setup();
  updateCreativeDirectorScene.mockClear().mockResolvedValue({});
  render(<VideoShotEditor project={{ id: 'cd-example', status: 'paused' }} scene={{ sceneId: 'shot-3', order: 2, prompt: 'An empty garden', workRevision: 4 }} />);
  await user.click(screen.getByRole('checkbox', { name: 'Mute generated audio in the final cut' }));
  await user.click(screen.getByRole('button', { name: 'Save shot' }));
  expect(updateCreativeDirectorScene).toHaveBeenCalledWith('cd-example', 'shot-3', expect.objectContaining({ muteAudio: true, expectedWorkRevision: 4 }), { silent: true });
});
