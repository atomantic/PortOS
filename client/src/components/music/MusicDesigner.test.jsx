import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router';
import MusicDesigner from './MusicDesigner';
import * as api from '../../services/api';

vi.mock('../../services/api', () => ({
  createTrack: vi.fn(),
  describeMusic: vi.fn(),
  generateLyrics: vi.fn(),
  getSettings: vi.fn(),
  getTrack: vi.fn(),
  updateSettings: vi.fn(),
  updateTrack: vi.fn(),
}));

// The render step hosts MusicGenPanel unchanged; stub it to a props readout so
// the wizard's hand-off (prompt = the enriched description, lyrics = possibly
// empty) is directly assertable without the engine-list fetch.
vi.mock('./MusicGenPanel', () => ({
  default: ({ title, prompt, lyrics }) => (
    <div data-testid="gen-panel" data-title={title} data-prompt={prompt} data-lyrics={lyrics} />
  ),
}));

// Stateful stub of useProviderModels: the pin-restore effect calls its setters,
// so they have to actually move the returned selection for the restore path to
// be observable.
const hook = vi.hoisted(() => ({
  providers: [{ id: 'provider-a', name: 'Provider A', models: ['model-a'], defaultModel: 'model-a' }],
  selectedProviderId: 'provider-a',
  selectedModel: 'model-a',
  loading: false,
  setSelectedProviderId: null,
  setSelectedModel: null,
}));
vi.mock('../../hooks/useProviderModels', () => ({
  default: () => ({
    providers: hook.providers,
    selectedProviderId: hook.selectedProviderId,
    selectedModel: hook.selectedModel,
    availableModels: hook.providers.find((p) => p.id === hook.selectedProviderId)?.models || [],
    setSelectedProviderId: hook.setSelectedProviderId,
    setSelectedModel: hook.setSelectedModel,
    loading: hook.loading,
  }),
}));

function LocationDisplay() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

const renderAt = (path) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/music/:tab" element={<><LocationDisplay /><MusicDesigner /></>} />
      <Route path="/music/:tab/:id" element={<><LocationDisplay /><MusicDesigner /></>} />
      <Route path="/music/tracks/:id" element={<LocationDisplay />} />
    </Routes>
  </MemoryRouter>,
);

describe('<MusicDesigner>', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    hook.providers = [{ id: 'provider-a', name: 'Provider A', models: ['model-a'], defaultModel: 'model-a' }];
    hook.selectedProviderId = 'provider-a';
    hook.selectedModel = 'model-a';
    hook.loading = false;
    hook.setSelectedProviderId = vi.fn();
    hook.setSelectedModel = vi.fn();
    api.getSettings.mockResolvedValue({ music: {} });
    api.createTrack.mockResolvedValue({ id: 'track-draft', title: 'Untitled music draft', concept: '', prompt: '', lyrics: '' });
    api.getTrack.mockResolvedValue({ id: 'track-draft', title: 'Untitled music draft', concept: '', prompt: '', lyrics: '' });
    api.updateSettings.mockResolvedValue({});
    api.updateTrack.mockResolvedValue({ id: 'track-draft', title: 'Untitled music draft' });
  });

  afterEach(cleanup);

  describe('step routing', () => {
    it('defaults a bare /music/generate to the concept step', async () => {
      renderAt('/music/generate');
      expect(await screen.findByLabelText(/what do you want to hear/i)).toBeInTheDocument();
    });

    it('renders the step named in the URL', async () => {
      renderAt('/music/generate/lyrics');
      expect(await screen.findByLabelText('Lyrics')).toBeInTheDocument();
      expect(screen.queryByLabelText(/what do you want to hear/i)).toBeNull();
    });

    it('redirects an unknown step to the first step instead of an empty shell', async () => {
      renderAt('/music/generate/bogus');
      await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/music/generate/concept'));
      expect(screen.getByLabelText(/what do you want to hear/i)).toBeInTheDocument();
    });

    it('moves the URL when a step in the step bar is clicked', async () => {
      renderAt('/music/generate/concept');
      await screen.findByLabelText(/what do you want to hear/i);
      fireEvent.click(screen.getByRole('tab', { name: /render/i }));
      expect(screen.getByTestId('location')).toHaveTextContent('/music/generate/render');
    });

    it('creates a persisted draft immediately and uses its id for the wizard', async () => {
      renderAt('/music/generate/concept');

      await screen.findByLabelText(/what do you want to hear/i);
      expect(api.createTrack).toHaveBeenCalledWith({ title: 'Untitled music draft' }, { silent: true });
    });

    it('reopens the active unnamed draft after leaving the Music section', async () => {
      renderAt('/music/generate/concept');
      await screen.findByLabelText(/what do you want to hear/i);
      cleanup();

      renderAt('/music/generate/lyrics');
      await screen.findByLabelText('Lyrics');
      expect(api.getTrack).toHaveBeenCalledWith('track-draft', { silent: true });
    });

    it('hydrates a saved draft when returning through its track id', async () => {
      api.getTrack.mockResolvedValue({
        id: 'track-saved', title: 'Untitled music draft', concept: 'A dusk-time pulse',
        prompt: 'Warm synths and a patient beat.', lyrics: '[verse]\nKeep moving',
      });
      renderAt('/music/generate/lyrics?trackId=track-saved');

      expect(await screen.findByLabelText('Lyrics')).toHaveValue('[verse]\nKeep moving');
      expect(screen.getByLabelText('Lyrics')).toHaveValue('[verse]\nKeep moving');
      expect(api.getTrack).toHaveBeenCalledWith('track-saved', { silent: true });
      expect(api.createTrack).not.toHaveBeenCalled();
    });

    it('keeps an unrelated unnamed draft resumable while designing a saved track', async () => {
      window.localStorage.setItem('portos.musicDesigner.activeDraft', 'track-draft');
      api.getTrack.mockResolvedValue({
        id: 'track-saved', title: 'Named Track', concept: '', prompt: '', lyrics: '',
      });
      renderAt('/music/generate/concept?trackId=track-saved');

      await screen.findByLabelText(/what do you want to hear/i);
      expect(window.localStorage.getItem('portos.musicDesigner.activeDraft')).toBe('track-draft');
    });

    it('keeps the render prompt visible and editable for a saved draft', async () => {
      api.getTrack.mockResolvedValue({
        id: 'track-saved', title: 'Named Track', concept: 'A dusk-time pulse',
        prompt: 'Warm synths and a patient beat.', lyrics: '',
      });
      renderAt('/music/generate/render?trackId=track-saved');

      const prompt = await screen.findByLabelText(/prompt for this render/i);
      expect(prompt).toHaveValue('Warm synths and a patient beat.');
      fireEvent.change(prompt, { target: { value: 'A brighter pulse with hand percussion.' } });
      expect(screen.getByTestId('gen-panel')).toHaveAttribute('data-prompt', 'A brighter pulse with hand percussion.');
      fireEvent.blur(prompt);

      await waitFor(() => expect(api.updateTrack).toHaveBeenCalledWith(
        'track-saved', { prompt: 'A brighter pulse with hand percussion.' }, { silent: true },
      ));
    });

    it('lets a direct render visit supply the prompt before generating', async () => {
      renderAt('/music/generate/render?trackId=track-draft');

      const prompt = await screen.findByLabelText(/prompt for this render/i);
      expect(prompt).toHaveValue('');
      fireEvent.change(prompt, { target: { value: 'A quiet piano loop with tape hiss.' } });

      expect(screen.getByTestId('gen-panel')).toHaveAttribute('data-prompt', 'A quiet piano loop with tape hiss.');
    });
  });

  describe('the describe step', () => {
    it('fires no LLM call on mount — both provider calls need an explicit press', async () => {
      renderAt('/music/generate/concept');
      await screen.findByLabelText(/what do you want to hear/i);
      await waitFor(() => expect(api.getSettings).toHaveBeenCalled());
      expect(api.describeMusic).not.toHaveBeenCalled();
      expect(api.generateLyrics).not.toHaveBeenCalled();
    });

    it('sends the concept, guidance and picker selection, then advances with the result editable', async () => {
      api.describeMusic.mockResolvedValue({ description: 'Lush pads over a broken beat.', llm: { provider: 'provider-a', model: 'model-a' } });
      renderAt('/music/generate/concept');

      fireEvent.change(await screen.findByLabelText(/what do you want to hear/i), { target: { value: 'a rainy downtempo loop' } });
      fireEvent.change(screen.getByLabelText(/extra guidance/i), { target: { value: 'under 100 BPM' } });
      fireEvent.click(screen.getByRole('button', { name: /describe it/i }));

      await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/music/generate/description'));
      expect(api.describeMusic).toHaveBeenCalledWith({
        concept: 'a rainy downtempo loop',
        guidance: 'under 100 BPM',
        template: undefined,
        providerId: 'provider-a',
        model: 'model-a',
        effort: undefined,
      }, { silent: true });

      const box = screen.getByLabelText(/music description/i);
      expect(box).toHaveValue('Lush pads over a broken beat.');
      expect(screen.getByText(/MiniMax structured caption/i)).toBeInTheDocument();
      expect(screen.getByText(/meter or time signature/i)).toBeInTheDocument();
      fireEvent.change(box, { target: { value: 'My own words.' } });
      expect(box).toHaveValue('My own words.');
      await waitFor(() => expect(api.updateTrack).toHaveBeenCalledWith(
        'track-draft', expect.objectContaining({ concept: 'a rainy downtempo loop', prompt: 'Lush pads over a broken beat.' }),
        { silent: true },
      ));
    });

    it('persists the provider pin after a successful describe', async () => {
      api.describeMusic.mockResolvedValue({ description: 'Lush pads.', llm: {} });
      renderAt('/music/generate/concept');
      fireEvent.change(await screen.findByLabelText(/what do you want to hear/i), { target: { value: 'x' } });
      fireEvent.click(screen.getByRole('button', { name: /describe it/i }));

      await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith(
        { music: { designer: { providerId: 'provider-a', model: 'model-a', effort: '' } } },
        { silent: true },
      ));
    });

    it('keeps the user on the concept step when the call fails', async () => {
      api.describeMusic.mockRejectedValue(new Error('no provider'));
      renderAt('/music/generate/concept');
      fireEvent.change(await screen.findByLabelText(/what do you want to hear/i), { target: { value: 'x' } });
      fireEvent.click(screen.getByRole('button', { name: /describe it/i }));

      await waitFor(() => expect(api.describeMusic).toHaveBeenCalled());
      expect(screen.getByTestId('location')).toHaveTextContent('/music/generate/concept');
    });
  });

  describe('the lyrics step', () => {
    it('generates lyrics from the description without leaving the step', async () => {
      api.describeMusic.mockResolvedValue({ description: 'Lush pads over a broken beat.', llm: {} });
      api.generateLyrics.mockResolvedValue({ lyrics: '[verse]\nrain on the window', llm: {} });
      renderAt('/music/generate/concept');

      fireEvent.change(await screen.findByLabelText(/what do you want to hear/i), { target: { value: 'a rainy downtempo loop' } });
      fireEvent.click(screen.getByRole('button', { name: /describe it/i }));
      await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/music/generate/description'));
      fireEvent.click(screen.getByRole('button', { name: /next: lyrics/i }));

      fireEvent.change(screen.getByLabelText(/lyric guidance/i), { target: { value: 'about leaving at dawn' } });
      fireEvent.click(screen.getByRole('button', { name: /generate lyrics/i }));

      await waitFor(() => expect(screen.getByLabelText('Lyrics')).toHaveValue('[verse]\nrain on the window'));
      const lyricsField = screen.getByLabelText('Lyrics');
      const guide = screen.getByText(/manual composition structure/i);
      expect(guide).toBeInTheDocument();
      expect(guide.closest('details')).not.toHaveAttribute('open');
      expect(lyricsField.compareDocumentPosition(guide)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
      fireEvent.click(guide);
      expect(guide.closest('details')).toHaveAttribute('open');
      expect(api.generateLyrics).toHaveBeenCalledWith({
        description: 'Lush pads over a broken beat.',
        guidance: 'about leaving at dawn',
        template: undefined,
        providerId: 'provider-a',
        model: 'model-a',
        effort: undefined,
      }, { silent: true });
      expect(screen.getByTestId('location')).toHaveTextContent('/music/generate/lyrics');
    });

    it('lets the user continue without lyrics while leaving vocal intent for the render step', async () => {
      api.describeMusic.mockResolvedValue({ description: 'Lush pads over a broken beat.', llm: {} });
      renderAt('/music/generate/concept');

      fireEvent.change(await screen.findByLabelText(/what do you want to hear/i), { target: { value: 'a rainy downtempo loop' } });
      fireEvent.click(screen.getByRole('button', { name: /describe it/i }));
      await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/music/generate/description'));
      fireEvent.click(screen.getByRole('button', { name: /next: lyrics/i }));

      expect(screen.getByText(/enable instrumental only to prohibit wordless or background vocals/i)).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /continue without lyrics/i }));

      const panel = await screen.findByTestId('gen-panel');
      expect(panel).toHaveAttribute('data-prompt', 'Lush pads over a broken beat.');
      expect(panel).toHaveAttribute('data-lyrics', '');
      expect(api.generateLyrics).not.toHaveBeenCalled();
    });
  });

  describe('the saved provider pin', () => {
    it('restores a pin that still matches a live provider', async () => {
      hook.providers = [
        { id: 'provider-a', name: 'Provider A', models: ['model-a'], defaultModel: 'model-a' },
        { id: 'provider-b', name: 'Provider B', models: ['model-b'], defaultModel: 'model-b' },
      ];
      api.getSettings.mockResolvedValue({ music: { designer: { providerId: 'provider-b', model: 'model-b' } } });
      renderAt('/music/generate/concept');

      await waitFor(() => expect(hook.setSelectedProviderId).toHaveBeenCalledWith('provider-b'));
      expect(hook.setSelectedModel).toHaveBeenCalledWith('model-b');
    });

    it('degrades to the hook default for a stale provider id', async () => {
      api.getSettings.mockResolvedValue({ music: { designer: { providerId: 'provider-gone', model: 'model-gone' } } });
      renderAt('/music/generate/concept');

      await waitFor(() => expect(api.getSettings).toHaveBeenCalled());
      await waitFor(() => expect(screen.getByLabelText(/what do you want to hear/i)).toBeInTheDocument());
      expect(hook.setSelectedProviderId).not.toHaveBeenCalled();
      expect(hook.setSelectedModel).not.toHaveBeenCalled();
    });

    it('skips a stale MODEL on a provider that still exists', async () => {
      api.getSettings.mockResolvedValue({ music: { designer: { providerId: 'provider-a', model: 'model-removed' } } });
      renderAt('/music/generate/concept');

      await waitFor(() => expect(hook.setSelectedProviderId).toHaveBeenCalledWith('provider-a'));
      expect(hook.setSelectedModel).not.toHaveBeenCalled();
    });
  });

  // A blocked localStorage (Safari private mode, disabled cookies) throws from
  // the accessor. The draft-id read happens in the component RENDER BODY, so
  // before #5689 that throw was a render-phase exception and the whole Music
  // Designer route unmounted — the user lost the page, not a preference.
  describe('blocked storage', () => {
    // `vi.stubGlobal`, not `vi.spyOn`: a method assigned onto jsdom's Storage
    // proxy is swallowed as a stored key, so a spy never installs and the test
    // would pass against the unguarded component it is meant to fail.
    afterEach(() => { vi.unstubAllGlobals(); });

    it('still renders the designer when every storage access throws', async () => {
      const boom = () => { throw new DOMException('The operation is insecure.', 'SecurityError'); };
      vi.stubGlobal('localStorage', {
        getItem: boom, setItem: boom, removeItem: boom, clear: () => {},
      });

      renderAt('/music/generate');

      // The route renders, and the draft is still created — storage only ever
      // held the resume hint, so losing it costs the hint and nothing else.
      expect(await screen.findByLabelText(/what do you want to hear/i)).toBeInTheDocument();
      await waitFor(() => expect(api.createTrack).toHaveBeenCalled());
    });
  });

  describe('meta-prompt overrides', () => {
    it('sends a saved override as the template, and stops sending it once reset', async () => {
      api.getSettings.mockResolvedValue({ music: { designer: { describeTemplate: 'Be terse.' } } });
      api.describeMusic.mockResolvedValue({ description: 'Terse.', llm: {} });
      renderAt('/music/generate/concept');

      fireEvent.change(await screen.findByLabelText(/what do you want to hear/i), { target: { value: 'x' } });
      fireEvent.click(screen.getByRole('button', { name: /advanced — meta-prompts/i }));
      await waitFor(() => expect(screen.getByLabelText(/description instruction/i)).toHaveValue('Be terse.'));

      fireEvent.click(screen.getByRole('button', { name: /describe it/i }));
      await waitFor(() => expect(api.describeMusic).toHaveBeenCalledWith(
        expect.objectContaining({ template: 'Be terse.' }),
        { silent: true },
      ));

      // Reset clears the override so the server falls back to the shipped default.
      fireEvent.click(screen.getByRole('tab', { name: /concept/i }));
      fireEvent.click(screen.getAllByRole('button', { name: /reset to default/i })[0]);
      fireEvent.click(screen.getByRole('button', { name: /describe it/i }));
      await waitFor(() => expect(api.describeMusic).toHaveBeenLastCalledWith(
        expect.objectContaining({ template: undefined }),
        { silent: true },
      ));
    });
  });
});
