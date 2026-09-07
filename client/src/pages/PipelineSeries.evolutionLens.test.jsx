/**
 * The OPTIONAL five-stage evolution lens on a Pipeline series character arc
 * (#6441). The lens nests inside `series.characterArcs[]`, which already rides
 * the wholesale bible flush (`ARC_FLUSH_FIELDS`), so the regression worth
 * pinning here is the AUTHORING behavior — a partial lens stays partial, a
 * declared flat arc raises nothing, and an anchor that no longer resolves is
 * marked rather than silently dropped.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import PipelineSeries from './PipelineSeries';
import {
  CHARACTER_ARC_LIMITS, TRANSITION_KINDS, TRANSITION_KIND_LABELS,
} from '../../../server/lib/seriesCharacterArc.js';

const getPipelineSeries = vi.fn();
const listPipelineIssues = vi.fn();
const listUniverses = vi.fn();

vi.mock('../services/api', () => ({
  getPipelineSeries: (...args) => getPipelineSeries(...args),
  updatePipelineSeries: vi.fn(),
  listPipelineIssues: (...args) => listPipelineIssues(...args),
  listUniverses: (...args) => listUniverses(...args),
  generateSeriesTitleLogo: vi.fn(),
  discoverSeriesVoice: vi.fn(),
  SERIES_TITLE_LOGO_MAX: 1_000,
}));

vi.mock('../hooks/useArcCanvasSync', () => ({
  useArcCanvasSync: () => ({
    updateSeriesFromServer: vi.fn(),
    handleIssuesUpdate: vi.fn(),
    flushPending: vi.fn(async () => false),
  }),
}));
vi.mock('../hooks/useLocalStorageBool', () => ({ useLocalStorageBool: () => [false, vi.fn()] }));
vi.mock('../components/pipeline/ArcCanvas', () => ({ default: () => <div>arc canvas</div> }));
vi.mock('../components/pipeline/AutopilotPanel', () => ({ default: () => <div>autopilot</div> }));
vi.mock('../components/pipeline/SeriesReviewPanel', () => ({ default: () => <div>series review</div> }));
vi.mock('../components/pipeline/SeriesLoomsPanel', () => ({ default: () => <div>branching narratives</div> }));
vi.mock('../components/CatalogCastPanel', () => ({ default: () => <div>cast</div> }));
vi.mock('../components/pipeline/AuthorPicker', () => ({ default: () => <div>author</div> }));
vi.mock('../components/VoiceExemplarEditor', () => ({ default: () => <div>voice exemplars</div>, VOICE_EXEMPLARS_MAX: 5 }));
vi.mock('../components/imageGen/RecordRenderPinRow', () => ({ default: () => <div>render backend</div> }));
vi.mock('../components/ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

const universe = {
  id: 'uni-1',
  name: 'Example Universe',
  characters: [{
    id: 'chr-1111',
    name: 'Vale',
    psychology: { theoryOfControl: 'If I stay useful, nobody leaves.' },
  }],
};

const seriesWith = (arc) => ({
  id: 'series-1',
  name: 'Example Series',
  universeId: 'uni-1',
  characterArcs: [{
    characterId: 'chr-1111',
    characterName: 'Vale',
    want: '', need: '', startState: '', endState: '',
    transitions: [{ id: 'trn-1111', kind: 'decision', label: 'Stays for the relay', atIssue: 3 }],
    ...arc,
  }],
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/pipeline/series/series-1']}>
      <Routes>
        <Route path="/pipeline/series/:seriesId" element={<PipelineSeries />} />
      </Routes>
    </MemoryRouter>,
  );
}

const openLens = async (user) => {
  await screen.findByRole('heading', { name: 'Example Series' });
  await user.click(screen.getByText('Evolution lens'));
};

describe('Pipeline series — character-arc evolution lens', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listPipelineIssues.mockResolvedValue([]);
    listUniverses.mockResolvedValue([universe]);
  });

  it('caps every arc input at the server limits the PATCH route enforces', async () => {
    getPipelineSeries.mockResolvedValue(seriesWith());
    renderPage();
    await screen.findByRole('heading', { name: 'Example Series' });

    // Save re-sends the whole arc list, so an input that loses its cap lets one
    // over-long field reject every subsequent series save with nothing visible.
    const cappedAt = {
      'Character name': CHARACTER_ARC_LIMITS.CHARACTER_NAME_MAX,
      Want: CHARACTER_ARC_LIMITS.WANT_MAX,
      Need: CHARACTER_ARC_LIMITS.NEED_MAX,
      'Start state': CHARACTER_ARC_LIMITS.START_STATE_MAX,
      'End state': CHARACTER_ARC_LIMITS.END_STATE_MAX,
      'Transition label': CHARACTER_ARC_LIMITS.TRANSITION_LABEL_MAX,
    };
    for (const [name, max] of Object.entries(cappedAt)) {
      expect(screen.getByRole('textbox', { name }), name).toHaveAttribute('maxlength', String(max));
    }
    expect(screen.getByRole('spinbutton', { name: 'At issue' }))
      .toHaveAttribute('max', String(CHARACTER_ARC_LIMITS.ISSUE_MAX));
    const kindPicker = screen.getByRole('combobox', { name: 'Transition kind' });
    expect([...kindPicker.options].map((o) => [o.value, o.text]))
      .toEqual(TRANSITION_KINDS.map((kind) => [kind, TRANSITION_KIND_LABELS[kind]]));
  });

  it('authors a sparse lens and declares a flat arc without raising a blocking state', async () => {
    const user = userEvent.setup();
    getPipelineSeries.mockResolvedValue(seriesWith());
    renderPage();
    await openLens(user);

    expect(screen.getByText('not declared · 0/5 stages')).toBeVisible();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Declared outcome' }), 'flat-testing');
    await user.type(
      screen.getByRole('textbox', { name: 'cost tested — Causal consequence' }),
      'The relay holds.',
    );

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('flat-testing · 1/5 stages')).toBeVisible();
  });

  it('anchors a stage to an authored transition beat and clears a stale one in a click', async () => {
    const user = userEvent.setup();
    getPipelineSeries.mockResolvedValue(seriesWith({
      evolution: {
        outcome: 'partial-open',
        outcomeNote: '',
        stages: [{
          stageId: 'final-proof',
          testedBelief: 'Usefulness buys safety.',
          externalPressure: '', characterChoice: '', causalConsequence: '',
          evidence: { atIssue: null, atSceneAnchor: '', transitionId: 'trn-deleted', episodeId: '', sceneKey: '' },
        }],
      },
    }));
    renderPage();
    await openLens(user);

    expect(screen.getByText('Stale anchor')).toBeVisible();
    const beat = screen.getByRole('combobox', { name: 'final proof — Evidence beat' });
    expect(beat).toHaveValue('trn-deleted');

    await user.click(screen.getByRole('button', { name: 'Re-pick final proof anchor' }));
    expect(screen.queryByText('Stale anchor')).not.toBeInTheDocument();

    await user.selectOptions(beat, 'trn-1111');
    expect(beat).toHaveValue('trn-1111');
  });

  it('surfaces universe psychology as read-only context, never as an editable field', async () => {
    const user = userEvent.setup();
    getPipelineSeries.mockResolvedValue(seriesWith());
    renderPage();
    await openLens(user);
    await user.click(screen.getByText('Universe baseline (read-only)'));

    expect(screen.getByText('If I stay useful, nobody leaves.')).toBeVisible();
    expect(screen.queryByRole('textbox', { name: /theory of control/i })).not.toBeInTheDocument();
  });
});
