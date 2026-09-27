import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import VoiceStudio from './VoiceStudio';
import * as api from '../services/apiVoice';
import { getUniverse } from '../services/apiUniverseBuilder';
vi.mock('../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn(), emit: vi.fn() } }));
vi.mock('../services/apiVoice', () => ({
  listStudioVoices: vi.fn(), getStudioVoice: vi.fn(), getVoiceStudioStatus: vi.fn(), setupVoiceStudio: vi.fn(), unloadVoiceStudio: vi.fn(),
  designStudioVoice: vi.fn(), assignStudioVoice: vi.fn(),
}));
vi.mock('../services/apiUniverseBuilder', () => ({ listUniverseNames: vi.fn().mockResolvedValue([{ id: 'u1', name: 'Example Universe' }]), getUniverse: vi.fn() }));
vi.mock('../components/ui/Toast', () => ({ default: { error: vi.fn() } }));
const profile = { id: 'voice-1', label: 'Example voice', library: true, engine: 'auk', approval: { status: 'approved' },
  sourceAssets: [{ filename: 'reference.wav', transcript: 'Hello there.' }], inference: { seed: 42, instructions: 'Warm alto' } };
const open = path => render(<MemoryRouter initialEntries={[path]}><Routes>
  <Route path="/voices" element={<VoiceStudio />} /><Route path="/voices/:profileId" element={<VoiceStudio />} />
</Routes></MemoryRouter>);
beforeEach(() => {
  vi.clearAllMocks();
  api.listStudioVoices.mockResolvedValue({ items: [profile], total: 1, nextCursor: null });
  api.getStudioVoice.mockResolvedValue({ profile });
  api.getVoiceStudioStatus.mockResolvedValue({ supported: true, ready: true, state: 'idle' });
  getUniverse.mockResolvedValue({ characters: [{ id: 'c1', name: 'Example Character', speechAccent: 'Warm alto' }] });
});
describe('Voice Studio', () => {
  it('opens a bookmarked audition and assigns only after an explicit action to the linked character', async () => {
    api.assignStudioVoice.mockResolvedValue({ profile: { ...profile, id: 'bound-1', library: false, binding: { universeId: 'u1', characterId: 'c1' } } });
    api.listStudioVoices.mockResolvedValue({ items: [], total: 0, nextCursor: null });
    open('/voices/voice-1?universeId=u1&characterId=c1');
    expect(await screen.findByLabelText('Voice preview')).toHaveAttribute('src', '/data/voice-profiles/voice-1/source/reference.wav');
    expect(api.assignStudioVoice).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(await screen.findByRole('button', { name: 'Use for Example Character' }));
    await waitFor(() => expect(api.assignStudioVoice).toHaveBeenCalledWith('voice-1', { universeId: 'u1', characterId: 'c1', enableInteractive: true }, { silent: true }));
    expect(await screen.findByRole('button', { name: 'Assigned to Example Character' })).toBeDisabled();
  });
  it('generates with explicit controls, navigates to the saved preview, and keeps assignment separate', async () => {
    api.designStudioVoice.mockResolvedValue({ profile });
    open('/voices/new?universeId=u1&characterId=c1');
    const label = await screen.findByLabelText('Voice name');
    expect(label).toHaveValue('Example Character voice');
    fireEvent.change(screen.getByLabelText('Pitch edit: 0 semitones'), { target: { value: '-3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate & save preview' }));
    expect(await screen.findByLabelText('Voice preview')).toBeInTheDocument();
    expect(api.designStudioVoice).toHaveBeenCalledWith(expect.objectContaining({ pitchSemitones: -3, instructions: 'Warm alto' }), { silent: true });
    expect(api.assignStudioVoice).not.toHaveBeenCalled();
  });
  it('never installs or generates on page load and disables generation until setup succeeds', async () => {
    api.getVoiceStudioStatus.mockResolvedValue({ supported: true, ready: false, state: 'idle' });
    open('/voices/new');
    expect(await screen.findByRole('button', { name: 'Set up AuK locally' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Generate & save preview' })).toBeDisabled();
    expect(api.setupVoiceStudio).not.toHaveBeenCalled();
    expect(api.designStudioVoice).not.toHaveBeenCalled();
  });
  it('shows a stale voice URL as missing instead of silently selecting another voice', async () => {
    api.getStudioVoice.mockRejectedValue(new Error('Not found'));
    open('/voices/deleted');
    expect(await screen.findByRole('alert')).toHaveTextContent('Voice not found');
    expect(screen.queryByLabelText('Voice preview')).not.toBeInTheDocument();
  });
});
