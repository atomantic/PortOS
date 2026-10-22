import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const progress = vi.hoisted(() => ({ current: { status: 'unknown', progress: 0 } }));
vi.mock('../../services/api', () => ({
  listMusicEngines: vi.fn(),
  previewMusicPrompt: vi.fn(async ({ prompt }) => ({ sentPrompt: prompt, promptAdditions: [] })),
  generateCodeAnimationSoundtrack: vi.fn(),
  writeMusicCode: vi.fn(),
  previewMusicCode: vi.fn(async () => ({ sentPrompt: 'Example prompt', promptAdditions: [] })),
  ensureCodeAnimationSoundtrackTrack: vi.fn(),
  renderTrackCode: vi.fn(),
}));
vi.mock('../../hooks/useMediaJobProgress', () => ({ default: vi.fn(() => progress.current) }));
const providerHook = vi.hoisted(() => ({ setSelectedProviderId: vi.fn(), setSelectedModel: vi.fn() }));
vi.mock('../../hooks/useProviderModels', () => ({
  default: () => ({
    providers: [{ id: 'other', models: ['o'] }, { id: 'job-provider', models: ['m1', 'm2'] }],
    selectedProviderId: 'job-provider', selectedModel: 'm2', availableModels: ['m1', 'm2'], loading: false,
    ...providerHook,
  }),
}));
vi.mock('../ProviderModelSelector', () => ({ default: () => <div data-testid="provider-picker" /> }));
vi.mock('../music/strudelFrame', () => ({
  CODE_FRAME_SOURCE: 'portos-code-frame', STRUDEL_VERSION: '0', TONE_VERSION: '0',
  buildStrudelFrameDoc: () => '<!doctype html><title>stub</title>', buildToneFrameDoc: () => '<!doctype html><title>stub</title>',
}));

import CodeAnimationSoundtrack, { SOUNDTRACK_CHOICE_KEY } from './CodeAnimationSoundtrack';
import { generateCodeAnimationSoundtrack, listMusicEngines, writeMusicCode } from '../../services/api';

const ENGINES = [
  { id: 'musicgen', name: 'MusicGen', ready: true, maxDurationSec: 30, models: [{ id: 'mg', name: 'MG' }], defaultModelId: 'mg' },
  { id: 'audioldm2', name: 'AudioLDM2', ready: false, maxDurationSec: 120, models: [{ id: 'al' }], defaultModelId: 'al' },
  { id: 'acestep15', name: 'ACE-Step 1.5', ready: true, maxDurationSec: 240, models: [{ id: 'ace' }], defaultModelId: 'ace' },
];
const JOB_ID = '00000000-0000-4000-8000-000000000003';

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  progress.current = { status: 'unknown', progress: 0 };
  listMusicEngines.mockResolvedValue({ engines: ENGINES });
  generateCodeAnimationSoundtrack.mockResolvedValue({ mediaJobId: 'media-audio' });
});

describe('CodeAnimationSoundtrack', () => {
  it('generates audio for a finished animation with a remembered model that fits the film', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<CodeAnimationSoundtrack jobId={JOB_ID} durationSeconds={120} />);
    const picker = await screen.findByLabelText('Music model');
    // A model too short for the film, or not installed, says why in the option.
    expect(screen.getByRole('option', { name: 'MusicGen (max 30s)' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'AudioLDM2 (not installed)' })).toBeTruthy();
    expect(picker.value).toBe('acestep15');

    await user.selectOptions(picker, 'musicgen');
    expect(screen.getByText(/The film is 120s; MusicGen renders at most 30s/)).toBeTruthy();
    await user.type(screen.getByLabelText('Describe the music'), 'Warm synths');
    expect(screen.getByRole('button', { name: /Generate audio/ }).disabled).toBe(true);

    await user.selectOptions(picker, 'acestep15');
    await user.click(screen.getByRole('button', { name: /Generate audio/ }));
    expect(generateCodeAnimationSoundtrack).toHaveBeenCalledWith(JOB_ID,
      { prompt: 'Warm synths', engine: 'acestep15', modelId: 'ace', instrumentalOnly: true }, { silent: true });
    expect(JSON.parse(localStorage.getItem(SOUNDTRACK_CHOICE_KEY))).toMatchObject({ engine: 'acestep15' });
    unmount();

    // The next animation opens on the same choice.
    localStorage.setItem(SOUNDTRACK_CHOICE_KEY, JSON.stringify({ engine: 'acestep15', instrumentalOnly: false }));
    render(<CodeAnimationSoundtrack jobId={JOB_ID} durationSeconds={20} />);
    await waitFor(() => expect(screen.getByLabelText('Music model').value).toBe('acestep15'));
    expect(screen.getByLabelText('Instrumental only').checked).toBe(false);
  });

  it('shows render progress, then the take as the animation audio once it lands', async () => {
    progress.current = { status: 'running', progress: 0.4, statusMsg: 'Rendering the score' };
    const onReady = vi.fn();
    const soundtrack = { trackId: 'track-1', mediaJobId: 'media-audio', prompt: 'Warm synths' };
    const { rerender } = render(<CodeAnimationSoundtrack jobId={JOB_ID} durationSeconds={120} soundtrack={soundtrack} onReady={onReady} />);
    expect(await screen.findByRole('button', { name: 'Generating audio 40%' })).toBeTruthy();
    expect(screen.getByText('Rendering the score')).toBeTruthy();

    progress.current = { status: 'completed', progress: 1 };
    rerender(<CodeAnimationSoundtrack jobId={JOB_ID} durationSeconds={120} soundtrack={soundtrack} onReady={onReady} audioUrl="/data/music/take.wav" audioTrackId="track-1" />);
    await waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText('Generated soundtrack').getAttribute('src')).toBe('/data/music/take.wav');
    expect(screen.getByRole('button', { name: 'Regenerate audio' })).toBeTruthy();
  });

  it('stays usable when the saved render is gone from the queue, and never calls older audio the take', async () => {
    // A 404 hydrate leaves the media job "unknown"; that is not a live render.
    const soundtrack = { trackId: 'track-1', mediaJobId: 'media-archived', prompt: 'Warm synths' };
    render(<CodeAnimationSoundtrack jobId={JOB_ID} durationSeconds={120} soundtrack={soundtrack} audioUrl="/api/uploads/original.mp3" audioTrackId={undefined} />);
    const button = await screen.findByRole('button', { name: 'Generate audio' });
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(screen.getByLabelText('Describe the music').disabled).toBe(false);
    expect(screen.queryByLabelText('Generated soundtrack')).toBeNull();
  });

  it('writes the audio as code from the animation script, remembering the choice', async () => {
    const user = userEvent.setup();
    writeMusicCode.mockResolvedValue({ language: 'strudel', code: 'silence', llm: {} });
    const job = {
      id: JOB_ID, title: 'Boot', providerId: 'job-provider', model: 'm2',
      input: { title: 'Station boot', concept: 'Panels light up one by one', onScreenText: 'SYSTEM ONLINE' },
    };
    render(<CodeAnimationSoundtrack job={job} jobId={JOB_ID} durationSeconds={20} />);
    await user.click(screen.getByRole('button', { name: 'Coding model' }));
    expect(JSON.parse(localStorage.getItem(SOUNDTRACK_CHOICE_KEY))).toMatchObject({ mode: 'code' });
    expect(screen.queryByLabelText('Music model')).toBeNull();
    // The animation's own words, editable before they are sent.
    expect(screen.getByLabelText(/Animation script/).value).toBe('Station boot\n\nPanels light up one by one\n\nOn-screen text:\nSYSTEM ONLINE');
    // Opens on the provider that made the animation.
    expect(providerHook.setSelectedProviderId).toHaveBeenCalledWith('job-provider');
    expect(providerHook.setSelectedModel).toHaveBeenCalledWith('m2');

    await user.type(screen.getByLabelText('Describe the sound (optional)'), 'Whirrs and blips');
    await user.click(screen.getByRole('button', { name: /Write the code/ }));
    await waitFor(() => expect(writeMusicCode).toHaveBeenCalled());
    expect(writeMusicCode.mock.calls[0][0]).toMatchObject({
      description: 'Whirrs and blips', scene: expect.stringContaining('Panels light up'), durationSec: 20, providerId: 'job-provider', model: 'm2',
    });
  });
});
