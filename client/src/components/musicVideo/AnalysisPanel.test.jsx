import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AnalysisPanel from './AnalysisPanel.jsx';

const BASE = { bpm: 120, beats: [0, 0.5], downbeats: [0], sections: [], durationSec: 30 };
const TEMPO = { bpm: '', offset: '0', setBpm: vi.fn(), setOffset: vi.fn(), tap: vi.fn(), submit: vi.fn(), saving: false };

describe('AnalysisPanel song features (#9073)', () => {
  it('offers Re-analyze, and shows no hit counts, for an analysis cached without a feature track', () => {
    const onReanalyze = vi.fn();
    render(<AnalysisPanel audioAnalysis={BASE} scenes={[]} tempo={TEMPO} onReanalyze={onReanalyze} />);
    expect(screen.getByText(/not analyzed/)).toBeTruthy();
    expect(screen.queryByText(/kick-ish/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Re-analyze' }));
    expect(onReanalyze).toHaveBeenCalledTimes(1);
  });

  it('summarizes onsets and flags a truncated feature track', () => {
    const features = {
      envelopes: { fps: 30, rms: [0], low: [0], mid: [0], high: [0] },
      onsets: { low: [0.5, 1], mid: [0.75], high: [] },
      truncatedAtSec: 300,
    };
    render(<AnalysisPanel audioAnalysis={{ ...BASE, features }} scenes={[]} tempo={TEMPO} onReanalyze={vi.fn()} />);
    expect(screen.getByText(/2 kick-ish · 1 snare-ish · 0 hat-ish/)).toBeTruthy();
    expect(screen.getByText(/Covers the first/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Re-analyze' })).toBeNull();
  });
});
