import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// The analysis view's DSP (referenceAnalysis.js) and transcription
// (singToScore.js) stay REAL — we fake only the browser seams jsdom lacks:
// fetch (the uploaded audio bytes), AudioContext.decodeAudioData (returns a
// synthesized sine buffer), and the heavy ScoreSheet SVG renderer.

vi.mock('./ScoreSheet.jsx', () => ({
  default: ({ text }) => <pre data-testid="scoresheet">{text}</pre>,
}));

vi.mock('../../services/api', () => ({
  uploadFile: vi.fn(() => Promise.resolve({ filename: 'up.wav' })),
  getUploadUrl: (f) => `/api/uploads/${f}`,
}));

const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock('../ui/Toast', () => ({ default: { success: (...a) => toastSuccess(...a), error: (...a) => toastError(...a) } }));

vi.mock('../../lib/audioRecorder', () => ({
  startMemoRecording: vi.fn(),
  arrayBufferToBase64: vi.fn(() => 'b64'),
}));

import ReferenceAnalysis, { ReferenceAudioAttach } from './ReferenceAnalysis.jsx';

const SR = 16000;
const sine = (hz, seconds) => {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / SR);
  return out;
};

// Fake Web Audio decode: any fetched bytes decode to 1 s of A3 (220 Hz).
const installFakeAudio = () => {
  const samples = sine(220, 1.0);
  window.AudioContext = function FakeAudioContext() {
    return {
      sampleRate: SR,
      decodeAudioData: () => Promise.resolve({
        getChannelData: () => samples,
        sampleRate: SR,
        duration: 1.0,
      }),
      close: () => Promise.resolve(),
    };
  };
  global.fetch = vi.fn(() => Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) }));
};

const baseRef = {
  id: 'ref-1',
  url: 'https://www.tiktok.com/@u/video/1',
  label: 'Layered build',
  note: '',
  audioFilename: 'abc-ref.wav',
  segments: [{ layerId: 'bass', startMs: 0, endMs: 1000 }],
};
const layers = [
  { id: 'melody', label: 'Melody', part: '', notes: '' },
  { id: 'bass', label: 'Bass', part: '', notes: '' },
];

const originalAudioContext = window.AudioContext;
const originalFetch = global.fetch;

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  window.AudioContext = originalAudioContext;
  global.fetch = originalFetch;
});

describe('ReferenceAnalysis — fallbacks', () => {
  it('shows a stale-reference fallback and closes', () => {
    const onClose = vi.fn();
    render(<ReferenceAnalysis reference={null} onClose={onClose} />);
    expect(screen.getByText(/no longer exists/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /back to round/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it('shows a no-audio hint for a reference without audio', () => {
    render(<ReferenceAnalysis reference={{ ...baseRef, audioFilename: '' }} onClose={vi.fn()} />);
    expect(screen.getByText(/no attached audio yet/i)).toBeTruthy();
  });

  it('degrades to a decode error when audio cannot be decoded, keeping segments editable', async () => {
    // jsdom has no AudioContext, so the decode effect reports the Web Audio
    // gate — the same degraded path a fetch/decode failure lands on.
    const onUpdateReference = vi.fn();
    render(
      <ReferenceAnalysis
        reference={baseRef}
        layers={layers}
        onUpdateReference={onUpdateReference}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByText(/web audio is not available/i)).toBeTruthy());
    // The segment row still renders and edits still flow to the parent draft.
    const layerSelect = screen.getByLabelText('Segment layer');
    fireEvent.change(layerSelect, { target: { value: 'melody' } });
    expect(onUpdateReference).toHaveBeenCalledWith('ref-1', 'segments', [
      { layerId: 'melody', startMs: 0, endMs: 1000 },
    ]);
    // Extraction is gated on decoded audio.
    expect(screen.getByRole('button', { name: /extract part/i }).disabled).toBe(true);
  });
});

describe('ReferenceAnalysis — extract → review → apply (solo segment)', () => {
  it('extracts a proposed part from a solo tone segment and applies it as a new part', async () => {
    installFakeAudio();
    const onApplyPart = vi.fn();
    render(
      <ReferenceAnalysis
        reference={baseRef}
        layers={layers}
        scoreParts={[]}
        tempo={60}
        songKey="C"
        onUpdateReference={vi.fn()}
        onApplyPart={onApplyPart}
        onClose={vi.fn()}
      />,
    );
    // Wait for the decode to land (Extract becomes enabled).
    const extract = screen.getByRole('button', { name: /extract part/i });
    await waitFor(() => expect(extract.disabled).toBe(false));

    fireEvent.click(extract);
    // The proposal renders the transcribed score (220 Hz → A3) once the
    // deferred DSP tick runs.
    await waitFor(() => expect(screen.getAllByTestId('scoresheet').length).toBeGreaterThan(0), { timeout: 3000 });
    const sheets = screen.getAllByTestId('scoresheet');
    expect(sheets[0].textContent).toMatch(/A3/);
    expect(sheets[0].textContent).toContain('key: C');

    // No stored parts → applying adds a new part carrying the segment's layer role.
    fireEvent.click(screen.getByRole('button', { name: /add as new part/i }));
    expect(onApplyPart).toHaveBeenCalledTimes(1);
    const part = onApplyPart.mock.calls[0][0];
    expect(part.id).toBe('');
    expect(part.role).toBe('bass');
    expect(part.score).toMatch(/A3/);
  });

  it('defaults the comparison to the stored part matching the segment layer and diffs bars', async () => {
    installFakeAudio();
    const existing = { id: 'part-bass', label: 'Bass', role: 'bass', score: '| A3q |' };
    const onApplyPart = vi.fn();
    render(
      <ReferenceAnalysis
        reference={baseRef}
        layers={layers}
        scoreParts={[existing]}
        tempo={60}
        songKey="C"
        onUpdateReference={vi.fn()}
        onApplyPart={onApplyPart}
        onClose={vi.fn()}
      />,
    );
    const extract = screen.getByRole('button', { name: /extract part/i });
    await waitFor(() => expect(extract.disabled).toBe(false));
    fireEvent.click(extract);
    await waitFor(() => expect(screen.getAllByTestId('scoresheet').length).toBeGreaterThan(0), { timeout: 3000 });

    // Comparison select defaulted to the matching stored part → diff chips render.
    expect(screen.getByLabelText(/compare \/ apply to/i).value).toBe('part-bass');
    expect(screen.getByText(/bar-by-bar pitch classes/i)).toBeTruthy();

    // Applying to the existing part carries its id (replace, not append).
    fireEvent.click(screen.getByRole('button', { name: /apply to current part/i }));
    const part = onApplyPart.mock.calls[0][0];
    expect(part.id).toBe('part-bass');
    expect(part.role).toBe('bass');
  });

  it('routes a melody-layer proposal to the base score, not scoreParts', async () => {
    installFakeAudio();
    const onApplyPart = vi.fn();
    render(
      <ReferenceAnalysis
        reference={{ ...baseRef, segments: [{ layerId: 'melody', startMs: 0, endMs: 1000 }] }}
        layers={layers}
        scoreParts={[]}
        baseScore="| A3q |"
        tempo={60}
        songKey="C"
        onUpdateReference={vi.fn()}
        onApplyPart={onApplyPart}
        onClose={vi.fn()}
      />,
    );
    const extract = screen.getByRole('button', { name: /extract part/i });
    await waitFor(() => expect(extract.disabled).toBe(false));
    fireEvent.click(extract);
    await waitFor(() => expect(screen.getAllByTestId('scoresheet').length).toBeGreaterThan(0), { timeout: 3000 });

    // Melody defaults to the base-score target and applies as { base: true }.
    expect(screen.getByLabelText(/compare \/ apply to/i).value).toBe('__base__');
    fireEvent.click(screen.getByRole('button', { name: /apply to base melody/i }));
    const applied = onApplyPart.mock.calls[0][0];
    expect(applied.base).toBe(true);
    expect(applied.score).toMatch(/A3/);
  });
});

describe('ReferenceAudioAttach', () => {
  it('offers upload + mic capture when no audio is attached', () => {
    render(<ReferenceAudioAttach reference={{ id: 'r', url: 'https://x.com' }} onUpdate={vi.fn()} />);
    expect(screen.getByRole('button', { name: /upload audio/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /capture from mic/i })).toBeTruthy();
  });

  it('shows the attached state and clears audio AND segments via Remove audio', () => {
    const onUpdate = vi.fn();
    render(<ReferenceAudioAttach reference={{ id: 'r', url: 'https://x.com', audioFilename: 'a.wav' }} onUpdate={onUpdate} />);
    expect(screen.getByText(/audio attached/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /remove audio/i }));
    expect(onUpdate).toHaveBeenCalledWith('audioFilename', '');
    // Segments are offsets into the removed audio — cleared with it so stale
    // ranges can't resurrect against a later, different recording.
    expect(onUpdate).toHaveBeenCalledWith('segments', []);
  });
});
