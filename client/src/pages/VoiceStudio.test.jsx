import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate, useLocation } from 'react-router';
import VoiceStudio from './VoiceStudio';
import useContainerWidth from '../hooks/useContainerWidth';
vi.mock('../hooks/useContainerWidth', () => ({ default: vi.fn(() => [{ current: null }, 390]) }));
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
function HistoryControls() {
  const navigate = useNavigate();
  const location = useLocation();
  return <><output aria-label="Current URL">{location.pathname}{location.search}</output>
    <button onClick={() => navigate(-1)}>Back</button><button onClick={() => navigate(1)}>Forward</button></>;
}
const open = path => render(<MemoryRouter initialEntries={[path]}><HistoryControls /><Routes>
  <Route path="/voices" element={<VoiceStudio />} /><Route path="/voices/:profileId" element={<VoiceStudio />} />
</Routes></MemoryRouter>);
beforeEach(() => {
  vi.clearAllMocks();
  useContainerWidth.mockReturnValue([{ current: null }, 390]);
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
  it('chooses a voice from compact navigation, retaining pagination, URL context and history without side effects', async () => {
    const voices = Array.from({ length: 30 }, (_, i) => ({ ...profile, id: `voice-${i}`, label: `Long voice name ${i} with detailed character direction` }));
    api.listStudioVoices.mockResolvedValueOnce({ items: voices, total: 31, nextCursor: 'next-page' })
      .mockResolvedValue({ items: [{ ...profile, id: 'voice-last', label: 'Last voice' }], total: 31, nextCursor: null });
    api.getStudioVoice.mockImplementation(async id => ({ profile: { ...profile, id } }));
    open('/voices/new?universeId=u1&characterId=c1');
    expect(await screen.findByLabelText('Voice name')).toHaveValue('Example Character voice');
    expect(screen.queryByRole('region', { name: 'Voice library' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Choose voice' }));
    const drawer = screen.getByRole('dialog', { name: 'Choose voice' });
    expect(await within(drawer).findAllByRole('link')).toHaveLength(30);
    fireEvent.click(within(drawer).getByRole('button', { name: 'Load more voices' }));
    const lastVoice = await within(drawer).findByRole('link', { name: /Last voice/ });
    expect(api.listStudioVoices).toHaveBeenLastCalledWith({ cursor: 'next-page', limit: 30 }, expect.objectContaining({ silent: true }));
    fireEvent.click(lastVoice);
    expect(await screen.findByLabelText('Voice preview')).toHaveAttribute('src', '/data/voice-profiles/voice-last/source/reference.wav');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Current URL')).toHaveTextContent('/voices/voice-last?universeId=u1&characterId=c1');
    expect(screen.getByRole('button', { name: 'Use for Example Character' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByLabelText('Voice name')).toHaveValue('Example Character voice');
    fireEvent.click(screen.getByRole('button', { name: 'Forward' }));
    expect(await screen.findByLabelText('Voice preview')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Choose voice' }));
    expect(within(screen.getByRole('dialog')).getAllByRole('link')).toHaveLength(31);
    fireEvent.click(screen.getByRole('button', { name: 'Close voice library' }));
    expect(screen.getByRole('button', { name: 'Choose voice' })).toHaveAttribute('aria-expanded', 'false');
    expect(api.setupVoiceStudio).not.toHaveBeenCalled();
    expect(api.designStudioVoice).not.toHaveBeenCalled();
    expect(api.assignStudioVoice).not.toHaveBeenCalled();
  });
  it('keeps the library alongside the work in wide containers and switches without losing form edits', async () => {
    useContainerWidth.mockReturnValue([{ current: null }, 1000]);
    const view = open('/voices/new');
    const name = await screen.findByLabelText('Voice name');
    fireEvent.change(name, { target: { value: 'Unsaved direction' } });
    expect(await screen.findByRole('region', { name: 'Voice library' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Choose voice' })).not.toBeInTheDocument();
    useContainerWidth.mockReturnValue([{ current: null }, 320]);
    view.rerender(<MemoryRouter initialEntries={['/voices/new']}><HistoryControls /><Routes>
      <Route path="/voices/:profileId" element={<VoiceStudio />} />
    </Routes></MemoryRouter>);
    expect(screen.getByLabelText('Voice name')).toHaveValue('Unsaved direction');
    expect(screen.queryByRole('region', { name: 'Voice library' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Choose voice' }));
    expect(screen.getByRole('dialog', { name: 'Choose voice' })).toBeInTheDocument();
  });
  it.each(['loading', 'empty', 'error'])('keeps an audition accessible with a %s library', async state => {
    if (state === 'loading') api.listStudioVoices.mockReturnValue(new Promise(() => {}));
    if (state === 'empty') api.listStudioVoices.mockResolvedValue({ items: [], total: 0, nextCursor: null });
    if (state === 'error') api.listStudioVoices.mockRejectedValue(new Error('Library unavailable'));
    open('/voices/voice-1');
    expect(await screen.findByLabelText('Voice preview')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Choose voice' }));
    const drawer = within(screen.getByRole('dialog'));
    if (state === 'loading') expect(drawer.getByText('Loading voice library…')).toBeInTheDocument();
    if (state === 'empty') expect(drawer.getByText(/No voices yet/)).toBeInTheDocument();
    if (state === 'error') expect(await drawer.findByRole('button', { name: 'Retry loading' })).toBeEnabled();
  });

});
