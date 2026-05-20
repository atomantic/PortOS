import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../services/apiPipeline', () => ({
  listPipelineTtsVoices: vi.fn(),
  previewPipelineTtsVoice: vi.fn(),
}));
vi.mock('../../services/voiceClient', () => ({
  playWav: vi.fn(),
}));
vi.mock('../ui/Toast', () => ({
  default: { error: vi.fn() },
}));

import VoicePicker, { __resetVoicePickerCache } from './VoicePicker';
import { listPipelineTtsVoices, previewPipelineTtsVoice } from '../../services/apiPipeline';
import { playWav } from '../../services/voiceClient';

const SAMPLE_VOICES = [
  { id: 'kokoro:af_bella', engine: 'kokoro', voice: 'af_bella', name: 'af_bella', gender: 'female', language: 'en-US', grade: 'A' },
  { id: 'kokoro:am_michael', engine: 'kokoro', voice: 'am_michael', name: 'am_michael', gender: 'male', language: 'en-US', grade: 'B' },
  { id: 'piper:lessac-medium', engine: 'piper', voice: 'lessac-medium', name: 'lessac-medium', gender: 'female', accent: 'American', downloaded: true },
];

beforeEach(() => {
  __resetVoicePickerCache();
  vi.clearAllMocks();
});

describe('VoicePicker', () => {
  it('fetches voices on mount and groups them by engine', async () => {
    listPipelineTtsVoices.mockResolvedValue({ voices: SAMPLE_VOICES });
    render(<VoicePicker value={null} onChange={() => {}} />);
    await waitFor(() => {
      expect(document.querySelector('option[value="kokoro:af_bella"]')).toBeInTheDocument();
    });
    expect(document.querySelector('option[value="piper:lessac-medium"]')).toBeInTheDocument();
    expect(document.querySelector('optgroup[label="Kokoro"]')).toBeInTheDocument();
    expect(document.querySelector('optgroup[label="Piper"]')).toBeInTheDocument();
    expect(listPipelineTtsVoices).toHaveBeenCalledTimes(1);
  });

  it('fires onChange with the selected namespaced voiceId', async () => {
    listPipelineTtsVoices.mockResolvedValue({ voices: SAMPLE_VOICES });
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<VoicePicker value={null} onChange={onChange} />);
    await waitFor(() => document.querySelector('option[value="kokoro:af_bella"]'));
    const select = screen.getByRole('combobox');
    await user.selectOptions(select, 'kokoro:af_bella');
    expect(onChange).toHaveBeenCalledWith('kokoro:af_bella');
  });

  it('fires onChange(null) when the placeholder is selected (clears binding)', async () => {
    listPipelineTtsVoices.mockResolvedValue({ voices: SAMPLE_VOICES });
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<VoicePicker value="kokoro:af_bella" onChange={onChange} placeholder="Project default voice" />);
    await waitFor(() => document.querySelector('option[value="kokoro:af_bella"]'));
    const select = screen.getByRole('combobox');
    await user.selectOptions(select, '');
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('renders undownloaded Piper voices as disabled options (visible but unbindable)', async () => {
    listPipelineTtsVoices.mockResolvedValue({
      voices: [
        ...SAMPLE_VOICES,
        { id: 'piper:glados', engine: 'piper', voice: 'glados', name: 'glados', downloaded: false },
      ],
    });
    render(<VoicePicker value={null} onChange={() => {}} />);
    await waitFor(() => {
      expect(document.querySelector('option[value="piper:glados"]')).toBeInTheDocument();
    });
    const stub = document.querySelector('option[value="piper:glados"]');
    expect(stub.disabled).toBe(true);
    // Downloaded Piper voices stay enabled.
    const downloaded = document.querySelector('option[value="piper:lessac-medium"]');
    expect(downloaded.disabled).toBe(false);
  });

  it('preserves an unavailable saved voiceId so the user sees what was bound', async () => {
    listPipelineTtsVoices.mockResolvedValue({ voices: SAMPLE_VOICES });
    render(<VoicePicker value="kokoro:retired-voice" onChange={() => {}} />);
    await waitFor(() => document.querySelector('option[value="kokoro:af_bella"]'));
    expect(screen.getByRole('option', { name: /retired-voice \(unavailable\)/i })).toBeInTheDocument();
  });

  it('audition button posts to preview and pipes the wav through playWav', async () => {
    listPipelineTtsVoices.mockResolvedValue({ voices: SAMPLE_VOICES });
    const buf = new ArrayBuffer(8);
    previewPipelineTtsVoice.mockResolvedValue(buf);
    const user = userEvent.setup();
    render(<VoicePicker value="kokoro:af_bella" onChange={() => {}} previewText="hello" />);
    await waitFor(() => document.querySelector('option[value="kokoro:af_bella"]'));
    const button = screen.getByRole('button', { name: /audition kokoro:af_bella/i });
    await user.click(button);
    await waitFor(() => {
      expect(previewPipelineTtsVoice).toHaveBeenCalledWith('kokoro:af_bella', 'hello');
      expect(playWav).toHaveBeenCalledWith(buf);
    });
  });

  it('disables the audition button when no voice is selected', async () => {
    listPipelineTtsVoices.mockResolvedValue({ voices: SAMPLE_VOICES });
    render(<VoicePicker value={null} onChange={() => {}} />);
    await waitFor(() => document.querySelector('option[value="kokoro:af_bella"]'));
    const button = screen.getByRole('button', { name: /audition voice/i });
    expect(button).toBeDisabled();
  });

  it('shows the load error inline when listPipelineTtsVoices rejects', async () => {
    listPipelineTtsVoices.mockRejectedValue(new Error('Boom'));
    render(<VoicePicker value={null} onChange={() => {}} />);
    await waitFor(() => {
      expect(screen.getByText('Boom')).toBeInTheDocument();
    });
  });

  it('hideWhenEmpty + zero voices renders nothing', async () => {
    listPipelineTtsVoices.mockResolvedValue({ voices: [] });
    const { container } = render(<VoicePicker value={null} onChange={() => {}} hideWhenEmpty />);
    await waitFor(() => {
      expect(listPipelineTtsVoices).toHaveBeenCalled();
    });
    // After the resolve settles, the component returns null when the list is empty.
    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
  });

  it('shares the module-local cache between mounts (single fetch)', async () => {
    listPipelineTtsVoices.mockResolvedValue({ voices: SAMPLE_VOICES });
    const { unmount } = render(<VoicePicker value={null} onChange={() => {}} />);
    await waitFor(() => document.querySelector('option[value="kokoro:af_bella"]'));
    unmount();
    render(<VoicePicker value={null} onChange={() => {}} />);
    await waitFor(() => document.querySelector('option[value="kokoro:af_bella"]'));
    expect(listPipelineTtsVoices).toHaveBeenCalledTimes(1);
  });

  it('refetches after the cache TTL expires (so newly-downloaded voices show up)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      listPipelineTtsVoices.mockResolvedValue({ voices: SAMPLE_VOICES });
      const { unmount } = render(<VoicePicker value={null} onChange={() => {}} />);
      await waitFor(() => document.querySelector('option[value="kokoro:af_bella"]'));
      unmount();
      // Advance past the 15-second TTL.
      vi.advanceTimersByTime(20_000);
      render(<VoicePicker value={null} onChange={() => {}} />);
      await waitFor(() => expect(listPipelineTtsVoices).toHaveBeenCalledTimes(2));
    } finally {
      vi.useRealTimers();
    }
  });
});
