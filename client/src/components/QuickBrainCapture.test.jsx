import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../services/api', () => ({
  captureBrainThought: vi.fn(),
  getYoutubeIngestSettings: vi.fn(),
  getApps: vi.fn(),
  getProviders: vi.fn(),
}));
// The ingest hook reaches for apiBrain directly (not through the `api` barrel),
// so mock it separately — that keeps the REAL useYoutubeIngest/useSseJobSlot
// wiring under test while never opening an EventSource.
vi.mock('../services/apiBrain.js', () => ({
  startYoutubeIngest: vi.fn(),
  cancelYoutubeIngest: vi.fn(),
  youtubeIngestEventsUrl: (jobId) => `/api/brain/youtube/ingest/${jobId}/events`,
}));
const clipboard = vi.hoisted(() => ({ readClipboard: vi.fn() }));
vi.mock('../lib/clipboard', () => clipboard);
vi.mock('./ui/Toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}));

// jsdom has no EventSource, and once a kickoff resolves the real
// useSseProgress subscribes to one. This controllable stub lets the accessibility
// coverage drive realistic progress frames without opening a network transport.
class StubEventSource {
  static CLOSED = 2;
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    StubEventSource.instances.push(this);
  }
  emit(frame) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  fail() {
    this.readyState = StubEventSource.CLOSED;
    this.onerror?.();
  }
  close() { this.readyState = StubEventSource.CLOSED; }
}
globalThis.EventSource = StubEventSource;

import { captureBrainThought, getApps, getProviders, getYoutubeIngestSettings } from '../services/api';
import { startYoutubeIngest } from '../services/apiBrain.js';
import toast from './ui/Toast';
import QuickBrainCapture from './QuickBrainCapture';

const PLACEHOLDER = 'Thought, URL, or YouTube link...';
const YT = 'https://youtu.be/oCnxnaVg0bY';

const renderWidget = () => render(<MemoryRouter><QuickBrainCapture /></MemoryRouter>);

const type = (text) =>
  fireEvent.change(screen.getByPlaceholderText(PLACEHOLDER), { target: { value: text } });

const submit = (text) => {
  type(text);
  fireEvent.click(screen.getByLabelText('Capture'));
};

// Open the advanced panel and wait for the settings-seeded checkbox state.
const openAdvanced = async () => {
  await waitFor(() => expect(getYoutubeIngestSettings).toHaveBeenCalled());
  fireEvent.click(screen.getByLabelText('Toggle ingest options'));
};

describe('QuickBrainCapture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    StubEventSource.instances = [];
    localStorage.clear();
    captureBrainThought.mockResolvedValue({ message: 'Saved to Links!' });
    getYoutubeIngestSettings.mockResolvedValue({
      defaultCaptureTranscript: true,
      defaultDownloadVideo: false,
      defaultIngestAudio: false,
    });
    getApps.mockResolvedValue([
      { id: 'portos-default', name: 'PortOS', repoPath: '/srv/portos' },
      { id: 'app-example', name: 'Example App', repoPath: '/srv/example-app' },
    ]);
    getProviders.mockResolvedValue({
      activeProvider: 'codex',
      providers: [
        { id: 'codex', name: 'Codex', type: 'cli', command: 'codex', enabled: true, defaultModel: 'gpt-5', models: ['gpt-5'] },
        { id: 'claude-code', name: 'Claude Code', type: 'cli', command: 'claude', enabled: true, defaultModel: 'claude-sonnet', models: ['claude-sonnet'] },
      ],
    });
    startYoutubeIngest.mockResolvedValue({ jobId: 'job-1' });
  });

  it('captures both thoughts and URLs through the same endpoint', async () => {
    renderWidget();
    submit('https://example.com');
    await waitFor(() => expect(captureBrainThought).toHaveBeenCalled());
    expect(captureBrainThought.mock.calls[0][0]).toBe('https://example.com');
  });

  it('surfaces the server message so a URL reads as saved to Links', async () => {
    renderWidget();
    submit('https://example.com');
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Saved to Links!'));
  });

  it('sends a trimmed note with a saved URL', async () => {
    renderWidget();
    type('https://example.com');
    fireEvent.change(screen.getByLabelText(/Why are you saving this link/i), {
      target: { value: '  Read this before planning the next release.  ' },
    });
    fireEvent.click(screen.getByLabelText('Capture'));

    await waitFor(() => expect(captureBrainThought).toHaveBeenCalled());
    expect(captureBrainThought.mock.calls[0][3]).toMatchObject({
      note: 'Read this before planning the next release.',
    });
  });

  it('does not flag a URL as creative even when the sticky flag is on', async () => {
    localStorage.setItem('brain.captureCreative', 'true');
    renderWidget();
    submit('https://example.com');
    await waitFor(() => expect(captureBrainThought).toHaveBeenCalled());
    expect(captureBrainThought.mock.calls[0][3]).toEqual({ creative: false });
  });

  it('still flags ordinary text as creative when the flag is on', async () => {
    localStorage.setItem('brain.captureCreative', 'true');
    renderWidget();
    submit('a city that dreams');
    await waitFor(() => expect(captureBrainThought).toHaveBeenCalled());
    expect(captureBrainThought.mock.calls[0][3]).toEqual({ creative: true });
  });

  it('hints which way the capture will go', () => {
    renderWidget();
    type('https://example.com');
    expect(screen.getByText('Will save as link')).toBeInTheDocument();
    type('call mom');
    expect(screen.getByText('Will capture as thought')).toBeInTheDocument();
  });

  describe('GitHub repo intake', () => {
    const REPO = 'https://github.com/example-owner/example-repo';

    it('offers the post-clone agent options only for a bare repo URL', () => {
      renderWidget();
      type('https://example.com/article');
      expect(screen.queryByLabelText('Scan for malware')).toBeNull();

      type(REPO);
      expect(screen.getByLabelText('Scan for malware')).toBeInTheDocument();
      expect(screen.getByLabelText('Study for app ideas')).toBeInTheDocument();
      expect(screen.getByText(/will be cloned locally/)).toBeInTheDocument();
      expect(screen.getByText('Will save as link and clone the repo')).toBeInTheDocument();
    });

    // The server files this as a thought (parseBareUrl rejects prose), so no
    // clone happens and the options would be a lie.
    it('hides the options for a repo URL wrapped in prose', () => {
      renderWidget();
      type(`worth reading ${REPO}`);
      expect(screen.queryByLabelText('Scan for malware')).toBeNull();
    });

    it('hides the options for a non-repo github.com URL', () => {
      renderWidget();
      type('https://github.com/settings');
      expect(screen.queryByLabelText('Scan for malware')).toBeNull();
    });

    it('sends the ticked actions with the capture', async () => {
      renderWidget();
      type(REPO);
      fireEvent.click(screen.getByLabelText('Study for app ideas'));
      fireEvent.click(screen.getByLabelText('Capture'));

      await waitFor(() => expect(captureBrainThought).toHaveBeenCalled());
      expect(captureBrainThought.mock.calls[0][3].repoIntake).toEqual({
        malwareScan: false,
        learn: true,
        targetAppId: 'portos-default',
      });
    });

    it('sends the selected managed app as the study target', async () => {
      renderWidget();
      type(REPO);
      fireEvent.click(screen.getByLabelText('Study for app ideas'));
      await waitFor(() => expect(screen.getByLabelText('File study issues against')).toBeInTheDocument());
      fireEvent.change(screen.getByLabelText('File study issues against'), { target: { value: 'app-example' } });
      fireEvent.click(screen.getByLabelText('Capture'));

      await waitFor(() => expect(captureBrainThought).toHaveBeenCalled());
      expect(captureBrainThought.mock.calls[0][3].repoIntake).toEqual({
        malwareScan: false,
        learn: true,
        targetAppId: 'app-example',
      });
    });

    it('sends optional study context with the repo study request', async () => {
      renderWidget();
      type(REPO);
      fireEvent.click(screen.getByLabelText('Study for app ideas'));
      fireEvent.change(screen.getByLabelText(/study context/i), {
        target: { value: 'Look for the indexing approach and where it could fit in search.' },
      });
      fireEvent.click(screen.getByLabelText('Capture'));

      await waitFor(() => expect(captureBrainThought).toHaveBeenCalled());
      expect(captureBrainThought.mock.calls[0][3].repoIntake).toEqual({
        malwareScan: false,
        learn: true,
        targetAppId: 'portos-default',
        studyContext: 'Look for the indexing approach and where it could fit in search.',
      });
    });

    it('defaults the study context to the save note when the study option is ticked', async () => {
      renderWidget();
      type(REPO);
      fireEvent.change(screen.getByLabelText(/why are you saving this link/i), {
        target: { value: 'Might be a good fit for the media pipeline' },
      });
      fireEvent.click(screen.getByLabelText('Study for app ideas'));

      await waitFor(() => expect(screen.getByLabelText(/study context/i))
        .toHaveValue('Might be a good fit for the media pipeline'));
    });

    it('does not overwrite a study context the user already edited', async () => {
      renderWidget();
      type(REPO);
      fireEvent.click(screen.getByLabelText('Study for app ideas'));
      await waitFor(() => expect(screen.getByLabelText('File study issues against')).toBeInTheDocument());
      fireEvent.change(screen.getByLabelText(/study context/i), { target: { value: 'My own brief' } });
      fireEvent.change(screen.getByLabelText(/why are you saving this link/i), {
        target: { value: 'Unrelated save note' },
      });

      expect(screen.getByLabelText(/study context/i)).toHaveValue('My own brief');
      await waitFor(() => expect(screen.getByLabelText('Provider')).toBeInTheDocument());
    });

    it('sends a provider, model, and effort override with the repo study request', async () => {
      renderWidget();
      type(REPO);
      fireEvent.click(screen.getByLabelText('Study for app ideas'));
      await waitFor(() => expect(screen.getByLabelText('Provider')).toBeInTheDocument());
      fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'claude-code' } });
      fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'claude-sonnet' } });
      fireEvent.change(screen.getByLabelText('Thinking effort'), { target: { value: 'high' } });
      fireEvent.click(screen.getByLabelText('Capture'));

      await waitFor(() => expect(captureBrainThought).toHaveBeenCalled());
      expect(captureBrainThought.mock.calls[0][3].repoIntake).toEqual({
        malwareScan: false,
        learn: true,
        targetAppId: 'portos-default',
        providerId: 'claude-code',
        model: 'claude-sonnet',
        effort: 'high',
      });
    });

    it('clears study context when switching to another repo', async () => {
      renderWidget();
      type(REPO);
      fireEvent.click(screen.getByLabelText('Study for app ideas'));
      fireEvent.change(screen.getByLabelText(/study context/i), {
        target: { value: 'Only for the first repo.' },
      });

      type('https://github.com/example-owner/another-repo');
      await waitFor(() => expect(screen.getByLabelText(/study context/i)).toHaveValue(''));
    });

    it('remembers the choice across mounts', () => {
      const { unmount } = renderWidget();
      type(REPO);
      fireEvent.click(screen.getByLabelText('Scan for malware'));
      expect(screen.getByLabelText('Scan for malware').checked).toBe(true);
      unmount();

      renderWidget();
      type(REPO);
      expect(screen.getByLabelText('Scan for malware').checked).toBe(true);
    });

    // A sticky tick must not ride along on a capture the user retyped into
    // something the server will never clone.
    it('omits the intake when the text is no longer a repo URL at submit time', async () => {
      localStorage.setItem('brain.repoIntake.malwareScan', 'true');
      renderWidget();
      type(REPO);
      submit('call mom');

      await waitFor(() => expect(captureBrainThought).toHaveBeenCalled());
      expect(captureBrainThought.mock.calls[0][3].repoIntake).toBeUndefined();
    });
  });

  describe('YouTube ingest path', () => {
    it('offers ingest options only for a single-video YouTube URL', async () => {
      renderWidget();
      type('https://example.com/article');
      expect(screen.queryByLabelText('Toggle ingest options')).toBeNull();
      expect(screen.getByLabelText('Toggle creative capture mode')).toBeInTheDocument();

      type(YT);
      expect(screen.getByLabelText('Toggle ingest options')).toBeInTheDocument();
      // The creative flag is meaningless for an ingest — don't offer it.
      expect(screen.queryByLabelText('Toggle creative capture mode')).toBeNull();
      // Typing a YouTube URL kicks off the settings fetch; settle it so its
      // state update lands inside the test.
      await waitFor(() => expect(getYoutubeIngestSettings).toHaveBeenCalled());
    });

    it('treats a playlist URL as an ordinary link, not an ingest', () => {
      renderWidget();
      type('https://www.youtube.com/playlist?list=PLabcdefghij');
      expect(screen.queryByLabelText('Toggle ingest options')).toBeNull();
      expect(screen.getByText('Will save as link')).toBeInTheDocument();
    });

    it('seeds the option checkboxes from saved settings', async () => {
      getYoutubeIngestSettings.mockResolvedValue({
        defaultCaptureTranscript: true,
        defaultDownloadVideo: false,
        defaultIngestAudio: true,
      });
      renderWidget();
      type(YT);
      await openAdvanced();
      await waitFor(() => expect(screen.getByLabelText('Audio').checked).toBe(true));
      expect(screen.getByLabelText('Transcript').checked).toBe(true);
      expect(screen.getByLabelText('Video').checked).toBe(false);
    });

    it('submits the full ingest payload — options, prompt, and parsed tags', async () => {
      renderWidget();
      type(YT);
      await openAdvanced();

      fireEvent.change(screen.getByLabelText(/Why are you saving this link/i), {
        target: { value: '  Keep this for the next research session.  ' },
      });

      fireEvent.change(screen.getByLabelText(/what should an agent do/i), {
        target: { value: 'Review for writing-tool improvements.' },
      });
      fireEvent.change(screen.getByLabelText(/^tags/i), { target: { value: ' writing-tools , research ,, ' } });
      fireEvent.click(screen.getByLabelText('Capture'));

      expect(captureBrainThought).not.toHaveBeenCalled();
      await waitFor(() => expect(startYoutubeIngest).toHaveBeenCalled());
      expect(startYoutubeIngest.mock.calls[0][0]).toEqual({
        url: YT,
        captureTranscript: true,
        downloadVideo: false,
        ingestAudio: false,
        note: 'Keep this for the next research session.',
        agentPrompt: 'Review for writing-tool improvements.',
        // Blank entries dropped, surrounding whitespace trimmed.
        tags: ['writing-tools', 'research'],
      });
    });

    it('ingests with no prompt or tags when the panel was never opened', async () => {
      renderWidget();
      type(YT);
      await waitFor(() => expect(getYoutubeIngestSettings).toHaveBeenCalled());
      fireEvent.click(screen.getByLabelText('Capture'));
      await waitFor(() => expect(startYoutubeIngest).toHaveBeenCalled());
      expect(startYoutubeIngest.mock.calls[0][0]).toEqual({
        url: YT,
        captureTranscript: true,
        downloadVideo: false,
        ingestAudio: false,
        agentPrompt: '',
        tags: [],
      });
    });

    // The panel is optional and most captures never open it, so saved defaults
    // have to govern the plain paste-and-send path — not just the expanded one.
    it('honors saved defaults on a submit that never opened the panel', async () => {
      getYoutubeIngestSettings.mockResolvedValue({
        defaultCaptureTranscript: true,
        defaultDownloadVideo: false,
        defaultIngestAudio: true,
      });
      renderWidget();
      type(YT);
      await waitFor(() => expect(getYoutubeIngestSettings).toHaveBeenCalled());
      fireEvent.click(screen.getByLabelText('Capture'));
      await waitFor(() => expect(startYoutubeIngest).toHaveBeenCalled());
      expect(startYoutubeIngest.mock.calls[0][0]).toMatchObject({ ingestAudio: true, captureTranscript: true });
    });

    it('exposes ingest progress and stage updates to assistive technology', async () => {
      renderWidget();
      type(YT);
      await waitFor(() => expect(getYoutubeIngestSettings).toHaveBeenCalled());
      fireEvent.click(screen.getByLabelText('Capture'));

      const progress = await screen.findByRole('progressbar', { name: 'YouTube video ingest progress' });
      expect(progress).toHaveAttribute('aria-valuenow', '0');
      expect(progress).toHaveAttribute('aria-valuemin', '0');
      expect(progress).toHaveAttribute('aria-valuemax', '100');
      expect(screen.getByText('starting…')).toHaveAttribute('aria-live', 'polite');

      await waitFor(() => expect(StubEventSource.instances).toHaveLength(1));
      act(() => StubEventSource.instances[0].emit({ type: 'progress', stage: 'video', percent: 47.6 }));
      await waitFor(() => expect(progress).toHaveAttribute('aria-valuenow', '48'));
      expect(screen.getByText('video…')).toHaveAttribute('aria-live', 'polite');

      act(() => StubEventSource.instances[0].emit({ type: 'metadata', title: 'Example Video' }));
      await waitFor(() => expect(progress).toHaveAttribute('aria-valuenow', '48'));
      expect(screen.getByText('video…')).toBeInTheDocument();

      act(() => StubEventSource.instances[0].fail());
      await waitFor(() => expect(screen.queryByRole('progressbar')).not.toBeInTheDocument());

      startYoutubeIngest.mockResolvedValueOnce({ jobId: 'job-2' });
      type(YT);
      fireEvent.click(screen.getByLabelText('Capture'));

      const retryProgress = await screen.findByRole('progressbar', { name: 'YouTube video ingest progress' });
      expect(retryProgress).toHaveAttribute('aria-valuenow', '0');
      expect(screen.getByText('starting…')).toHaveAttribute('aria-live', 'polite');
    });

    it('does not fetch ingest settings until a YouTube URL is typed', () => {
      renderWidget();
      type('just a thought');
      expect(getYoutubeIngestSettings).not.toHaveBeenCalled();
    });

    it('refuses to start an ingest with every artifact unchecked', async () => {
      renderWidget();
      type(YT);
      await openAdvanced();
      fireEvent.click(screen.getByLabelText('Transcript'));
      fireEvent.click(screen.getByLabelText('Capture'));
      expect(startYoutubeIngest).not.toHaveBeenCalled();
      expect(toast.error).toHaveBeenCalledWith('Pick at least one of transcript, video, or audio');
    });
  });

  describe('paste button', () => {
    it('fills the input from the clipboard without focusing it first', async () => {
      clipboard.readClipboard.mockResolvedValue('  https://example.com/post  ');
      renderWidget();
      fireEvent.click(screen.getByLabelText('Paste from clipboard'));
      await waitFor(() =>
        expect(screen.getByPlaceholderText(PLACEHOLDER)).toHaveValue('https://example.com/post'));
      fireEvent.click(screen.getByLabelText('Capture'));
      await waitFor(() => expect(captureBrainThought).toHaveBeenCalled());
      expect(captureBrainThought.mock.calls[0][0]).toBe('https://example.com/post');
    });

    it('reports an unreadable clipboard and leaves what was typed alone', async () => {
      clipboard.readClipboard.mockResolvedValue(null);
      renderWidget();
      type('half a thought');
      fireEvent.click(screen.getByLabelText('Paste from clipboard'));
      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith('Clipboard unavailable — paste into the box instead'));
      expect(screen.getByPlaceholderText(PLACEHOLDER)).toHaveValue('half a thought');
    });

    it('distinguishes an empty clipboard from an unreadable one', async () => {
      clipboard.readClipboard.mockResolvedValue('   ');
      renderWidget();
      fireEvent.click(screen.getByLabelText('Paste from clipboard'));
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Clipboard is empty'));
      expect(screen.getByPlaceholderText(PLACEHOLDER)).toHaveValue('');
    });
  });
});
