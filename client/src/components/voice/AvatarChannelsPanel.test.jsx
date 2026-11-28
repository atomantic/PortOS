import { beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const mocks = vi.hoisted(() => {
  const handlers = new Map();
  return {
    handlers,
    socket: {
      on: vi.fn((event, handler) => handlers.set(event, handler)),
      off: vi.fn(),
      emit: vi.fn(),
      connected: true,
    },
  };
});

vi.mock('../../services/socket', () => ({ default: mocks.socket }));
vi.mock('../../services/apiVoiceAvatar', () => ({
  fetchAvatarLibrary: vi.fn(),
  addAvatarToLibrary: vi.fn(),
  removeAvatarFromLibrary: vi.fn(),
  saveAvatarChannels: vi.fn(),
}));
vi.mock('../../services/apiSystem.js', () => ({ generateImage: vi.fn() }));
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
// The job thumb reports the finished render's filename as the real one does on completion.
vi.mock('../pipeline/MediaJobThumb', () => ({
  default: ({ jobId, onFilename }) => (
    <button type="button" onClick={() => onFilename?.('rendered.png')}>{`job ${jobId}`}</button>
  ),
}));
vi.mock('../imageGen/GalleryImagePicker', () => ({
  default: ({ open, onSelect }) => (open
    ? <button type="button" onClick={() => onSelect({ filename: 'gallery.png' })}>Pick gallery.png</button>
    : null),
}));

import AvatarChannelsPanel from './AvatarChannelsPanel';
import {
  addAvatarToLibrary, fetchAvatarLibrary, removeAvatarFromLibrary, saveAvatarChannels,
} from '../../services/apiVoiceAvatar';
import { generateImage } from '../../services/apiSystem.js';

const library = (overrides = {}) => ({
  collectionId: 'avatars',
  collectionName: 'Avatars',
  avatars: [{ filename: 'face.png', addedAt: '2026-11-27T00:00:00.000Z' }],
  active: 0,
  channels: Array.from({ length: 6 }, () => ({ label: '', avatar: null })),
  ...overrides,
});

const renderPanel = () => render(<MemoryRouter><AvatarChannelsPanel /></MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  fetchAvatarLibrary.mockResolvedValue(library());
});

it('assigns an avatar, names a channel and puts it on air', async () => {
  saveAvatarChannels.mockImplementation(async (patch) => library({
    active: patch.active ?? 0,
    channels: patch.channels ?? library().channels,
  }));
  renderPanel();
  const channels = await screen.findByRole('list', { name: 'Transceiver channels' });
  expect(within(channels).getAllByRole('listitem')).toHaveLength(6);

  fireEvent.click(screen.getByRole('button', { name: 'Choose the avatar for channel 3' }));
  const picker = screen.getByRole('group', { name: 'Avatars for channel 3' });
  fireEvent.click(within(picker).getByRole('button', { name: 'Assign avatar 1' }));
  await waitFor(() => expect(saveAvatarChannels).toHaveBeenCalledTimes(1));
  const assigned = saveAvatarChannels.mock.calls[0][0].channels;
  expect(assigned[2]).toEqual({ label: '', avatar: 'face.png' });
  expect(assigned.filter((channel) => channel.avatar)).toHaveLength(1);

  const name = screen.getByLabelText('Channel 3 name');
  fireEvent.change(name, { target: { value: 'Scout' } });
  fireEvent.blur(name);
  await waitFor(() => expect(saveAvatarChannels).toHaveBeenCalledTimes(2));
  expect(saveAvatarChannels.mock.calls[1][0].channels[2]).toEqual({ label: 'Scout', avatar: 'face.png' });

  fireEvent.click(screen.getByRole('button', { name: 'CH3' }));
  await waitFor(() => expect(saveAvatarChannels).toHaveBeenLastCalledWith({ active: 2 }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'CH3' })).toHaveAttribute('aria-pressed', 'true'));
});

it('preserves both edits when a channel name save overlaps another channel’s avatar assignment', async () => {
  let finishNameSave;
  saveAvatarChannels.mockImplementationOnce(({ channels }) => new Promise((resolve) => {
    finishNameSave = () => resolve(library({ channels }));
  })).mockImplementation(async ({ channels }) => library({ channels }));

  renderPanel();
  fireEvent.click(await screen.findByRole('button', { name: 'Choose the avatar for channel 2' }));
  const name = screen.getByLabelText('Channel 1 name');
  fireEvent.change(name, { target: { value: 'Scout' } });
  fireEvent.blur(name);
  await waitFor(() => expect(saveAvatarChannels).toHaveBeenCalledTimes(1));

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Assign avatar 1' }));
  });
  expect(saveAvatarChannels).toHaveBeenCalledTimes(1);
  await act(async () => { finishNameSave(); });

  const expected = library().channels;
  expected[0] = { label: 'Scout', avatar: null };
  expected[1] = { label: '', avatar: 'face.png' };
  expect(saveAvatarChannels).toHaveBeenCalledTimes(2);
  expect(saveAvatarChannels).toHaveBeenLastCalledWith({ channels: expected });
  expect(name).toHaveValue('Scout');
  fireEvent.click(screen.getByRole('button', { name: 'Choose the avatar for channel 2' }));
  expect(screen.getByRole('button', { name: 'Assign avatar 1' })).toHaveAttribute('aria-pressed', 'true');
});

it('generates a square avatar from the prompt as written and files it into the collection', async () => {
  generateImage.mockResolvedValue({ jobId: 'job-1' });
  addAvatarToLibrary.mockResolvedValue(library({
    avatars: [{ filename: 'rendered.png', addedAt: '2026-11-27T01:00:00.000Z' }, ...library().avatars],
  }));
  renderPanel();
  const prompt = await screen.findByLabelText('Create an avatar');
  fireEvent.change(prompt, { target: { value: 'A weathered radio operator' } });
  fireEvent.click(screen.getByRole('button', { name: 'Generate avatar' }));
  await waitFor(() => expect(generateImage).toHaveBeenCalledWith({
    prompt: 'A weathered radio operator', width: 1024, height: 1024, collectionName: 'Avatars',
  }));
  fireEvent.click(await screen.findByRole('button', { name: 'job job-1' }));
  await waitFor(() => expect(addAvatarToLibrary).toHaveBeenCalledWith('rendered.png'));
  expect(await screen.findByRole('heading', { name: 'Avatars (2)' })).toBeInTheDocument();
});

it('adds a gallery image and removes an avatar after an inline confirmation', async () => {
  addAvatarToLibrary.mockResolvedValue(library({
    avatars: [...library().avatars, { filename: 'gallery.png', addedAt: '2026-11-26T00:00:00.000Z' }],
  }));
  removeAvatarFromLibrary.mockResolvedValue(library({ avatars: [] }));
  renderPanel();
  fireEvent.click(await screen.findByRole('button', { name: 'Add from gallery' }));
  fireEvent.click(screen.getByRole('button', { name: 'Pick gallery.png' }));
  await waitFor(() => expect(addAvatarToLibrary).toHaveBeenCalledWith('gallery.png'));
  expect(await screen.findByRole('heading', { name: 'Avatars (2)' })).toBeInTheDocument();

  fireEvent.click(screen.getAllByRole('button', { name: 'Remove avatar from the collection' })[0]);
  expect(removeAvatarFromLibrary).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
  await waitFor(() => expect(removeAvatarFromLibrary).toHaveBeenCalledWith('face.png'));
  expect(await screen.findByRole('heading', { name: 'Avatars (0)' })).toBeInTheDocument();
});

it('guards against duplicate avatar generation submits and keeps confirmation open on remove failure', async () => {
  let resolveGen;
  generateImage.mockImplementation(() => new Promise((resolve) => { resolveGen = resolve; }));
  removeAvatarFromLibrary.mockRejectedValue(new Error('Disk busy'));

  renderPanel();
  const prompt = await screen.findByLabelText('Create an avatar');
  fireEvent.change(prompt, { target: { value: 'Radio operator' } });
  const form = prompt.closest('form');
  fireEvent.submit(form);
  fireEvent.submit(form);
  expect(generateImage).toHaveBeenCalledTimes(1);
  resolveGen({ jobId: 'job-2' });
  await screen.findByRole('button', { name: 'job job-2' });

  fireEvent.click(screen.getAllByRole('button', { name: 'Remove avatar from the collection' })[0]);
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
  await waitFor(() => expect(removeAvatarFromLibrary).toHaveBeenCalledWith('face.png'));
  expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
});
