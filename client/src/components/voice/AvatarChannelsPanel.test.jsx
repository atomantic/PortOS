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
  patchAvatarChannel: vi.fn(),
}));
// The tuning panel's pickers fetch voices and providers; the panel test only drives its own fields.
vi.mock('./VoicePicker', () => ({
  default: ({ value, onChange, placeholder }) => (
    <button type="button" onClick={() => onChange('piper:test-voice')}>{value || placeholder}</button>
  ),
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
import { mergeChannelAgentPatch } from '../../../../server/lib/voiceChannels.js';
import {
  addAvatarToLibrary, fetchAvatarLibrary, patchAvatarChannel, removeAvatarFromLibrary, saveAvatarChannels,
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

// Mirrors the server: a channel edit merges into the stored channels.
let stored;
const patchStored = async (index, { agent, ...fields }) => {
  stored = {
    ...stored,
    channels: stored.channels.map((channel, i) => (i !== index ? channel : {
      ...channel, ...fields, ...(agent !== undefined && { agent: mergeChannelAgentPatch(channel.agent, agent) }),
    })),
  };
  return stored;
};

it('assigns an avatar, names a channel and puts it on air', async () => {
  stored = library();
  patchAvatarChannel.mockImplementation(patchStored);
  saveAvatarChannels.mockImplementation(async (patch) => ({ ...stored, active: patch.active ?? stored.active }));
  renderPanel();
  const channels = await screen.findByRole('list', { name: 'Transceiver channels' });
  expect(within(channels).getAllByRole('listitem')).toHaveLength(6);

  fireEvent.click(screen.getByRole('button', { name: 'Choose the avatar for channel 3' }));
  const picker = screen.getByRole('group', { name: 'Avatars for channel 3' });
  fireEvent.click(within(picker).getByRole('button', { name: 'Assign avatar 1' }));
  await waitFor(() => expect(patchAvatarChannel).toHaveBeenCalledWith(2, { avatar: 'face.png' }));

  const name = screen.getByLabelText('Channel 3 name');
  fireEvent.change(name, { target: { value: 'Scout' } });
  fireEvent.blur(name);
  await waitFor(() => expect(patchAvatarChannel).toHaveBeenLastCalledWith(2, { label: 'Scout' }));
  await waitFor(() => expect(name).toHaveValue('Scout'));

  fireEvent.click(screen.getByRole('button', { name: 'CH3' }));
  await waitFor(() => expect(saveAvatarChannels).toHaveBeenLastCalledWith({ active: 2 }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'CH3' })).toHaveAttribute('aria-pressed', 'true'));
});

it('sends overlapping edits to different channels as separate merges without waiting on each other', async () => {
  stored = library();
  let finishNameSave;
  patchAvatarChannel.mockImplementationOnce((index, patch) => new Promise((resolve) => {
    finishNameSave = () => resolve(patchStored(index, patch));
  })).mockImplementation(patchStored);

  renderPanel();
  fireEvent.click(await screen.findByRole('button', { name: 'Choose the avatar for channel 2' }));
  const name = screen.getByLabelText('Channel 1 name');
  fireEvent.change(name, { target: { value: 'Scout' } });
  fireEvent.blur(name);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Assign avatar 1' }));
  });
  expect(patchAvatarChannel).toHaveBeenCalledWith(0, { label: 'Scout' });
  expect(patchAvatarChannel).toHaveBeenCalledWith(1, { avatar: 'face.png' });
  await act(async () => { finishNameSave(); });

  expect(name).toHaveValue('Scout');
  fireEvent.click(screen.getByRole('button', { name: 'Choose the avatar for channel 2' }));
  expect(screen.getByRole('button', { name: 'Assign avatar 1' })).toHaveAttribute('aria-pressed', 'true');
});

it('tunes one channel\'s agent and falls back to the defaults', async () => {
  stored = library();
  patchAvatarChannel.mockImplementation(patchStored);
  render(
    <MemoryRouter>
      <AvatarChannelsPanel agentDefaults={{ personality: { name: 'Base', speechStyle: 'brief', traits: ['warm'] }, provider: 'ollama', model: 'auto', voiceLabel: 'base-voice' }} />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Tune the agent on channel 2' }));
  const editor = screen.getByRole('group', { name: 'Agent for channel 2' });
  expect(within(editor).getByLabelText('Name')).toHaveAttribute('placeholder', 'Base');

  fireEvent.click(within(editor).getByRole('button', { name: 'Default (base-voice)' }));
  await waitFor(() => expect(patchAvatarChannel).toHaveBeenLastCalledWith(1, { agent: { voiceId: 'piper:test-voice' } }));

  const styles = within(editor).getByRole('group', { name: 'Speech style for channel 2' });
  fireEvent.click(within(styles).getByRole('button', { name: 'dry and witty' }));
  await waitFor(() => expect(patchAvatarChannel).toHaveBeenLastCalledWith(1, { agent: { speechStyle: 'dry and witty' } }));

  // Tapping a trait while inheriting starts this channel's list from the defaults, and two
  // quick toggles before the first save answers both land.
  // The server applies edits in arrival order and answers in that order.
  const held = [];
  const hold = (index, patch) => {
    const snapshot = patchStored(index, patch);
    return new Promise((resolve) => { held.push(() => resolve(snapshot)); });
  };
  patchAvatarChannel.mockImplementationOnce(hold).mockImplementationOnce(hold);
  const traits = within(editor).getByRole('group', { name: 'Traits for channel 2' });
  fireEvent.click(within(traits).getByRole('button', { name: 'curious' }));
  fireEvent.click(within(traits).getByRole('button', { name: 'witty' }));
  expect(patchAvatarChannel.mock.calls.at(-1)[1]).toEqual({ agent: { traits: ['warm', 'curious', 'witty'] } });
  await act(async () => { held[0](); });
  expect(within(traits).getByRole('button', { name: 'witty' })).toHaveAttribute('aria-pressed', 'true');
  await act(async () => { held[1](); });
  expect(within(traits).getByRole('button', { name: 'witty' })).toHaveAttribute('aria-pressed', 'true');
  expect(await screen.findByRole('button', { name: 'Tune the agent on channel 2' })).toHaveTextContent('3');

  fireEvent.click(within(editor).getByRole('button', { name: 'Use defaults' }));
  await waitFor(() => expect(patchAvatarChannel).toHaveBeenLastCalledWith(1, { agent: null }));
  await waitFor(() => expect(within(editor).queryByRole('button', { name: 'Use defaults' })).toBeNull());
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
