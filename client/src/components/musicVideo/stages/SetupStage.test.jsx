// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import SetupStage from './SetupStage.jsx';

vi.mock('../../songs/MidiVisualization.jsx', () => ({ default: () => null }));
vi.mock('../ProjectOptionsPanel.jsx', () => ({ default: () => null, projectOptionsSummary: () => '' }));
vi.mock('../CreativeSetupPanel.jsx', () => ({ default: () => null }));
vi.mock('../StyleReferencesPanel.jsx', () => ({ default: () => null }));
vi.mock('../VisualSpecPanel.jsx', () => ({ default: () => null }));
vi.mock('../TreatmentPanel.jsx', () => ({ default: () => null, treatmentSummary: () => 'Not started' }));
vi.mock('../VocalStemControl.jsx', () => ({ default: () => <div>vocal-stem</div> }));
vi.mock('../SoundBedControl.jsx', () => ({ default: () => <div>sound-bed</div> }));
vi.mock('../SongRevisionPanel.jsx', () => ({ default: () => <div>song-revision</div> }));

const board = (project) => ({
  project, tracks: [], trackName: () => 'Song', tempo: { bpm: '', setBpm: vi.fn() }, audioFilename: 'a.wav', locked: false,
  youtube: { editJob: {}, editUrl: '', setEditUrl: vi.fn(), startEdit: vi.fn() },
  midi: { model: 'base', active: false }, busy: {}, conceptDraft: {}, styleDraft: {}, treatment: {},
  onAnalyze: vi.fn(), onAlignLyrics: vi.fn(),
});

describe('SetupStage Song & lyrics', () => {
  it('lays out four numbered steps with done states and keeps advanced audio tools in a trailing fold', () => {
    const project = { id: 'p', trackId: 't', audioAnalysis: { durationSec: 10 }, lyricCues: [{ id: 'c', text: 'hi', words: [{ w: 'hi', startSec: 0, endSec: 1 }] }] };
    render(<SetupStage board={board(project)} />);
    const steps = screen.getAllByRole('region', { name: /^Step \d/ });
    expect(steps.map((s) => s.getAttribute('aria-label'))).toEqual([
      'Step 1: Track', 'Step 2: Analyze', 'Step 3: Lyrics', 'Step 4: Align & verify',
    ]);
    steps.forEach((s) => expect(within(s).getByText('Done')).toBeTruthy());
    const advanced = document.getElementById('mv-setup-advanced-audio');
    expect(advanced.contains(screen.getByText('vocal-stem'))).toBe(true);
    expect(advanced.contains(screen.getByText('song-revision'))).toBe(true);
    expect(advanced.contains(screen.getByText('Preview audio timing revision'))).toBe(true);
    steps.forEach((s) => expect(advanced.contains(s)).toBe(false));
    // The lyrics editor is inline in step 3, not a nested fold.
    expect(steps[2].contains(within(steps[2]).getByText(/Lyrics, phrases & pacing/).closest('details'))).toBe(false);
  });

  it('marks later steps to do for an empty project', () => {
    render(<SetupStage board={board({ id: 'p' })} />);
    expect(screen.getAllByText('To do')).toHaveLength(4);
  });
});
