import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
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

// Control the reference-audio-import hook (#2120) so the "Download from URL"
// control is exercised without a real yt-dlp/SSE round-trip. `state` is mutated
// per-test to simulate the active (downloading) vs idle render.
const refImport = vi.hoisted(() => ({
  start: vi.fn(),
  cancel: vi.fn(),
  onComplete: null,
  state: { active: false, percent: 0, stage: null },
}));
vi.mock('../../hooks/useReferenceAudioImport.js', () => ({
  default: (opts = {}) => {
    refImport.onComplete = opts.onComplete;
    return { ...refImport.state, start: refImport.start, cancel: refImport.cancel };
  },
}));

import { act } from '@testing-library/react';
import ReferenceAnalysis, { ReferenceAudioAttach } from './ReferenceAnalysis.jsx';

const SR = 16000;
const sine = (hz, seconds) => {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / SR);
  return out;
};

// A voice-like tone (fundamental + 2 harmonics) so the spectral harmonic-sum
// estimator has an overtone series to lock onto.
const harmonicTone = (f0, seconds, amp = 0.5) => {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    out[i] = amp * (Math.sin(2 * Math.PI * f0 * t) + 0.5 * Math.sin(2 * Math.PI * 2 * f0 * t) + 0.33 * Math.sin(2 * Math.PI * 3 * f0 * t));
  }
  return out;
};
const concatArr = (...parts) => {
  const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
};
const mixArr = (...parts) => {
  const n = Math.min(...parts.map((p) => p.length));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) for (const p of parts) out[i] += p[i];
  return out;
};

// Fake Web Audio decode: any fetched bytes decode to the given mono samples.
const installFakeAudioBuffer = (samples, durationSec) => {
  window.AudioContext = function FakeAudioContext() {
    return {
      sampleRate: SR,
      decodeAudioData: () => Promise.resolve({
        getChannelData: () => samples,
        sampleRate: SR,
        duration: durationSec,
      }),
      close: () => Promise.resolve(),
    };
  };
  global.fetch = vi.fn(() => Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) }));
};

// Default fake: 1 s of A3 (220 Hz) for the solo-path tests.
const installFakeAudio = () => installFakeAudioBuffer(sine(220, 1.0), 1.0);

// A controlled host that feeds reference updates back as props, so a toggle
// that persists through onUpdateReference re-renders the view (the parent owns
// segment state in production).
function ControlledAnalysis({ initialRef, ...props }) {
  const [ref, setRef] = useState(initialRef);
  return (
    <ReferenceAnalysis
      reference={ref}
      onUpdateReference={(id, key, val) => setRef((r) => ({ ...r, [key]: val }))}
      {...props}
    />
  );
}

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

describe('ReferenceAnalysis — stacked-mix extraction (#2121)', () => {
  it('toggling Stacked seeds a backing window ending where the voice enters', () => {
    installFakeAudio();
    const onUpdateReference = vi.fn();
    render(
      <ReferenceAnalysis
        reference={{ ...baseRef, segments: [{ layerId: 'bass', startMs: 3000, endMs: 6000 }] }}
        layers={layers}
        scoreParts={[]}
        tempo={60}
        songKey="C"
        onUpdateReference={onUpdateReference}
        onApplyPart={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /stacked/i }));
    expect(onUpdateReference).toHaveBeenCalledWith('ref-1', 'segments', [
      // Pre-roll clamped to the segment length (3 s → capped at 4 s), ending at
      // the segment start (the voice's entrance).
      { layerId: 'bass', startMs: 3000, endMs: 6000, bgStartMs: 0, bgEndMs: 3000 },
    ]);
  });

  it('warns when there is no audio before the segment to use as a backing ref', () => {
    installFakeAudio();
    render(
      <ReferenceAnalysis
        reference={{ ...baseRef, segments: [{ layerId: 'bass', startMs: 0, endMs: 1000 }] }}
        layers={layers}
        scoreParts={[]}
        tempo={60}
        songKey="C"
        onUpdateReference={vi.fn()}
        onApplyPart={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /stacked/i }));
    expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/not enough audio before/i));
  });

  it('rejects an invalid backing-window edit instead of silently dropping stacked mode', async () => {
    installFakeAudio();
    render(
      <ControlledAnalysis
        initialRef={{ ...baseRef, segments: [{ layerId: 'bass', startMs: 3000, endMs: 6000 }] }}
        layers={layers}
        scoreParts={[]}
        tempo={60}
        songKey="C"
        onApplyPart={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    // Enable stacked → backing [0, 3000] seeded, "Extract from mix" shows.
    fireEvent.click(screen.getByRole('button', { name: /stacked/i }));
    expect(await screen.findByRole('button', { name: /extract from mix/i })).toBeTruthy();

    // Collapse the backing 'to' below 'from' + the minimum → the edit is
    // rejected with a toast, and the segment STAYS in stacked mode (the row and
    // "Extract from mix" persist), rather than silently reverting to solo.
    const bgEnd = screen.getByLabelText(/backing reference end/i);
    fireEvent.change(bgEnd, { target: { value: '0.1' } });
    fireEvent.blur(bgEnd);
    expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/backing reference must be at least/i));
    expect(screen.getByRole('button', { name: /extract from mix/i })).toBeTruthy();
    expect(screen.getByLabelText(/backing reference end/i)).toBeTruthy();
  });

  it('rejects a backing window that overlaps the segment (must end before the voice enters)', async () => {
    installFakeAudio();
    render(
      <ControlledAnalysis
        initialRef={{ ...baseRef, segments: [{ layerId: 'bass', startMs: 3000, endMs: 6000 }] }}
        layers={layers}
        scoreParts={[]}
        tempo={60}
        songKey="C"
        onApplyPart={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /stacked/i }));
    expect(await screen.findByRole('button', { name: /extract from mix/i })).toBeTruthy();
    // Push backing end to 4s — past the segment start (3s), so it overlaps the
    // voice. Rejected with a toast; stacked mode stays intact.
    const bgEnd = screen.getByLabelText(/backing reference end/i);
    fireEvent.change(bgEnd, { target: { value: '4' } });
    fireEvent.blur(bgEnd);
    expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/must end before the voice enters/i));
    expect(screen.getByRole('button', { name: /extract from mix/i })).toBeTruthy();
  });

  it('recovers a new voice from a stacked mix end-to-end (toggle → extract from mix)', async () => {
    // [0, 0.8s]: C4 backing alone. [0.8, 1.8s]: C4 + a new A4 (440) on top.
    const audio = concatArr(harmonicTone(262, 0.8), mixArr(harmonicTone(262, 1.0), harmonicTone(440, 1.0)));
    installFakeAudioBuffer(audio, 1.8);
    const onApplyPart = vi.fn();
    render(
      <ControlledAnalysis
        initialRef={{ ...baseRef, segments: [{ layerId: 'bass', startMs: 800, endMs: 1800 }] }}
        layers={layers}
        scoreParts={[]}
        tempo={60}
        songKey="C"
        onApplyPart={onApplyPart}
        onClose={vi.fn()}
      />,
    );
    // Wait for decode (solo Extract enabled), then flip to stacked mode. The
    // toggle derives the backing window [0, 800] — the C4-only pre-entrance.
    await waitFor(() => expect(screen.getByRole('button', { name: /extract part/i }).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: /stacked/i }));

    const extractFromMix = await screen.findByRole('button', { name: /extract from mix/i });
    fireEvent.click(extractFromMix);

    // The spectral diff subtracts the C4 backing and transcribes the new A4.
    await waitFor(() => expect(screen.getAllByTestId('scoresheet').length).toBeGreaterThan(0), { timeout: 3000 });
    expect(screen.getAllByTestId('scoresheet')[0].textContent).toMatch(/A4/);
    expect(toastError).not.toHaveBeenCalled();
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

  it('starts a URL download and wires the finished filename onto the reference draft (#2120)', () => {
    refImport.start.mockClear();
    refImport.state = { active: false, percent: 0, stage: null };
    const onUpdate = vi.fn();
    render(<ReferenceAudioAttach reference={{ id: 'r', url: 'https://x.com' }} onUpdate={onUpdate} />);

    const input = screen.getByLabelText(/reference audio url/i);
    fireEvent.change(input, { target: { value: 'https://tiktok.com/@a/video/1' } });
    fireEvent.click(screen.getByRole('button', { name: /download/i }));
    expect(refImport.start).toHaveBeenCalledWith('https://tiktok.com/@a/video/1');

    // Simulate the SSE 'complete' frame landing an uploads-dir filename.
    act(() => refImport.onComplete('dl.mp3'));
    expect(onUpdate).toHaveBeenCalledWith('audioFilename', 'dl.mp3');
  });

  it('shows live progress and disables upload while a download is active (#2120)', () => {
    refImport.state = { active: true, percent: 42, stage: null };
    render(<ReferenceAudioAttach reference={{ id: 'r', url: 'https://x.com' }} onUpdate={vi.fn()} />);
    expect(screen.getByText(/downloading 42%/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /upload audio/i }).disabled).toBe(true);
    refImport.state = { active: false, percent: 0, stage: null }; // reset for other tests
  });
});
