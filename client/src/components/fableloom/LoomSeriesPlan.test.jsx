import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { useState } from 'react';

vi.mock('../../services/api', () => ({
  feedbackLoomSeriesPlan: vi.fn(),
  generateLoomSeriesPlan: vi.fn(),
  reviewLoomSeriesPlan: vi.fn(),
  reviewLoomTeleplay: vi.fn(),
  updateLoom: vi.fn(),
  validateLoomSeriesOutlines: vi.fn(),
}));
vi.mock('../../hooks/useProviderModels', () => ({ default: () => ({ providers: [], loading: false }) }));
vi.mock('../../services/socket', () => ({
  default: { on: vi.fn(), off: vi.fn() },
}));
vi.mock('../ProviderModelSelector', () => ({ default: () => <div>AI route picker</div> }));
vi.mock('./LoomEditorialAutomation', () => ({
  default: () => <div>Editorial automation</div>,
}));

import * as api from '../../services/api';
import LoomSeriesPlan from './LoomSeriesPlan';

const loom = (fields = {}) => ({
  id: 'loom-1',
  name: 'Example Loom',
  episodes: [{ id: 'ep-1', number: 1, title: 'Pilot' }],
  seriesPlan: {
    storyArc: 'An old arc.',
    plotPoints: [{ id: 'plot-1', title: 'The turn', description: 'Everything changes.', episodeId: 'ep-1' }],
    sideQuests: [],
  },
  ...fields,
});

beforeEach(() => {
  vi.clearAllMocks();
});

const renderPlan = (props) => render(<RouterProvider router={createMemoryRouter([
  { path: '/', element: <LoomSeriesPlan {...props} /> },
], { initialEntries: ['/'] })} />);

function StatefulPlan({ initial }) {
  const [record, setRecord] = useState(initial);
  return <LoomSeriesPlan loom={record} onLoomUpdate={setRecord} />;
}

describe('LoomSeriesPlan', () => {
  it('edits and saves the series-level plan as one patch', async () => {
    const onLoomUpdate = vi.fn();
    const updated = loom({ seriesPlan: { ...loom().seriesPlan, storyArc: 'A stronger arc.' } });
    api.updateLoom.mockResolvedValue(updated);
    renderPlan({ loom: loom(), onLoomUpdate });

    fireEvent.change(screen.getByRole('textbox', { name: /story arc/i }), { target: { value: 'A stronger arc.' } });
    fireEvent.click(screen.getByRole('tab', { name: 'AI editor' }));
    fireEvent.click(screen.getByText('Manual AI plan tools'));
    expect(screen.getByRole('button', { name: /analyze series/i })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /save plan/i }));

    await waitFor(() => expect(api.updateLoom).toHaveBeenCalledWith('loom-1', {
      seriesPlan: expect.objectContaining({ storyArc: 'A stronger arc.' }),
    }, { silent: true }));
    expect(onLoomUpdate).toHaveBeenCalledWith(updated);
  });

  it('authors and clears the shared series-design brief without adding it to legacy saves', async () => {
    const user = userEvent.setup();
    api.updateLoom.mockImplementation(async (_id, { seriesPlan }) => loom({ seriesPlan }));
    render(<RouterProvider router={createMemoryRouter([
      { path: '/', element: <StatefulPlan initial={loom()} /> },
    ], { initialEntries: ['/'] })} />);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Story intent' }), 'renewable');
    await user.type(screen.getByRole('textbox', { name: 'Episode activity' }), 'Decode a dangerous signal.');
    await user.type(screen.getByRole('textbox', { name: 'Continuing tensions' }), 'Each relay hides another sender.');
    await user.click(screen.getByRole('button', { name: /save plan/i }));

    await waitFor(() => expect(api.updateLoom).toHaveBeenCalledTimes(1));
    expect(api.updateLoom.mock.calls[0][1].seriesPlan.seriesDesign).toEqual(expect.objectContaining({
      mode: 'renewable',
      episodeActivity: 'Decode a dangerous signal.',
      continuingTensions: 'Each relay hides another sender.',
    }));

    await user.selectOptions(screen.getByRole('combobox', { name: 'Story intent' }), '');
    await user.click(screen.getByRole('button', { name: /save plan/i }));
    await waitFor(() => expect(api.updateLoom).toHaveBeenCalledTimes(2));
    expect(api.updateLoom.mock.calls[1][1].seriesPlan).not.toHaveProperty('seriesDesign');
  });

  it('adds a playable challenge as an episode-mapped plot-point contract', async () => {
    const user = userEvent.setup();
    api.updateLoom.mockResolvedValue(loom());
    renderPlan({ loom: loom(), onLoomUpdate: vi.fn() });

    await user.click(screen.getByRole('tab', { name: 'Plot & challenges' }));
    await user.click(screen.getByRole('button', { name: 'Challenge' }));
    const challengeTitle = screen.getByRole('textbox', { name: 'Plot points 2 title' });
    expect(challengeTitle).toHaveValue('');
    expect(challengeTitle).toHaveFocus();
    expect(screen.getByRole('textbox', { name: 'Plot points 2 description' }).value)
      .toContain('VIEWER DECISION LOOP');
    expect(screen.getByText('0/1 playable challenges mapped to episodes')).toBeInTheDocument();
    await user.selectOptions(within(challengeTitle.closest('details')).getByRole('combobox', { name: 'Episode' }), 'ep-1');
    expect(screen.getByText('1/1 playable challenges mapped to episodes')).toBeInTheDocument();
  });

  it('keeps drafts across section changes and shows only the selected planning area', () => {
    renderPlan({ loom: loom(), onLoomUpdate: vi.fn() });
    fireEvent.change(screen.getByRole('textbox', { name: /story arc/i }), { target: { value: 'Unsaved arc' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Plot & challenges' }));
    expect(screen.queryByRole('textbox', { name: /story arc/i })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Plot points' })).toBeVisible();
    expect(screen.getByRole('button', { name: /save plan/i })).toBeVisible();
    fireEvent.click(screen.getByRole('tab', { name: 'Story arc' }));
    expect(screen.getByRole('textbox', { name: /story arc/i })).toHaveValue('Unsaved arc');
  });

  it('shows AI series analysis and recommendations for the outline', async () => {
    api.reviewLoomSeriesPlan.mockResolvedValue({
      analysis: {
        summary: 'The spine works.',
        strengths: ['Clear protagonist goal'],
        risks: ['Midpoint arrives late'],
        recommendations: ['Move the reversal into episode 3'],
      },
    });
    renderPlan({ loom: loom(), onLoomUpdate: () => {} });

    fireEvent.click(screen.getByRole('tab', { name: 'AI editor' }));
    fireEvent.click(screen.getByText('Manual AI plan tools'));
    fireEvent.click(screen.getByRole('button', { name: /analyze series/i }));
    expect(await screen.findByText('The spine works.')).toBeInTheDocument();
    expect(screen.getByText('Move the reversal into episode 3')).toBeInTheDocument();
  });

  it('applies AI editing feedback to revise the entire series outline and plot points', async () => {
    const onLoomUpdate = vi.fn();
    const updated = loom({
      seriesPlan: {
        storyArc: 'Revised arc.',
        plotPoints: [{ id: 'plot-1', title: 'Moved turn', description: 'Changes earlier.', episodeId: 'ep-1' }],
        sideQuests: [],
      },
    });
    api.feedbackLoomSeriesPlan.mockResolvedValue({ loom: updated, changes: ['Shifted plot point turn'] });
    renderPlan({ loom: loom(), onLoomUpdate });

    fireEvent.click(screen.getByRole('tab', { name: 'AI editor' }));
    fireEvent.click(screen.getByText('Manual AI plan tools'));
    fireEvent.change(screen.getByRole('textbox', { name: /edit outline & plot points/i }), {
      target: { value: 'Move the turn to episode 1 and raise stakes.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /apply guidance to plan/i }));

    await waitFor(() => expect(api.feedbackLoomSeriesPlan).toHaveBeenCalledWith(
      'loom-1',
      expect.objectContaining({
        feedback: 'Move the turn to episode 1 and raise stakes.',
        operationId: expect.any(String),
      }),
      { silent: true },
    ));
    expect(onLoomUpdate).toHaveBeenCalledWith(updated);
  });

  it('regenerates the whole saved scaffold through the selected AI route without touching episodes locally', async () => {
    const onLoomUpdate = vi.fn();
    const generated = loom({
      seriesPlan: {
        storyArc: 'A generated arc.',
        plotPoints: [{ id: 'plot-new', title: 'New turn', description: 'The cost lands.', episodeId: 'ep-1' }],
        sideQuests: [{ id: 'quest-new', title: 'Lost map', description: 'Find it.', status: 'planned', startEpisodeId: 'ep-1', endEpisodeId: null }],
      },
    });
    api.generateLoomSeriesPlan.mockResolvedValue({ loom: generated, runId: 'run-draft' });
    renderPlan({ loom: loom(), onLoomUpdate });

    fireEvent.click(screen.getByRole('tab', { name: 'AI editor' }));
    fireEvent.click(screen.getByText('Manual AI plan tools'));
    fireEvent.click(screen.getByRole('button', { name: /regenerate full plan/i }));
    expect(api.generateLoomSeriesPlan).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^regenerate$/i }));

    await waitFor(() => expect(api.generateLoomSeriesPlan).toHaveBeenCalledWith(
      'loom-1', { operationId: expect.any(String) }, { silent: true },
    ));
    expect(onLoomUpdate).toHaveBeenCalledWith(generated);
  });

  it('adopts a generated plan over typing performed while the provider call is in flight', async () => {
    let finishDraft;
    api.generateLoomSeriesPlan.mockImplementation(() => new Promise((resolve) => { finishDraft = resolve; }));
    render(<RouterProvider router={createMemoryRouter([
      { path: '/', element: <StatefulPlan initial={loom()} /> },
    ], { initialEntries: ['/'] })} />);

    fireEvent.click(screen.getByRole('tab', { name: 'AI editor' }));
    fireEvent.click(screen.getByText('Manual AI plan tools'));
    fireEvent.click(screen.getByRole('button', { name: /regenerate full plan/i }));
    fireEvent.click(screen.getByRole('button', { name: /^regenerate$/i }));
    fireEvent.click(screen.getByRole('tab', { name: 'Story arc' }));
    fireEvent.change(screen.getByRole('textbox', { name: /story arc/i }), {
      target: { value: 'Typing that should not undo the requested regeneration.' },
    });
    const generated = loom({ seriesPlan: {
      storyArc: 'The generated arc wins.',
      plotPoints: [],
      sideQuests: [],
    } });
    finishDraft({ loom: generated, runId: 'run-draft' });

    await waitFor(() => expect(screen.getByRole('textbox', { name: /story arc/i })).toHaveValue('The generated arc wins.'));
    expect(screen.getByRole('button', { name: /save plan/i })).toBeDisabled();
  });

  it('keeps typing performed while a save response is in flight', async () => {
    let resolveSave;
    api.updateLoom.mockImplementation(() => new Promise((resolve) => { resolveSave = resolve; }));
    render(<RouterProvider router={createMemoryRouter([
      { path: '/', element: <StatefulPlan initial={loom()} /> },
    ], { initialEntries: ['/'] })} />);

    const arc = screen.getByRole('textbox', { name: /story arc/i });
    fireEvent.change(arc, { target: { value: 'First draft.' } });
    fireEvent.click(screen.getByRole('button', { name: /save plan/i }));
    fireEvent.change(arc, { target: { value: 'Typed while saving.' } });
    resolveSave(loom({ seriesPlan: { ...loom().seriesPlan, storyArc: 'First draft.' } }));

    await waitFor(() => expect(screen.getByRole('textbox', { name: /story arc/i })).toHaveValue('Typed while saving.'));
    expect(screen.getByRole('button', { name: /save plan/i })).toBeEnabled();
  });

  it('reviews the complete expanded teleplay only when every episode has scenes', async () => {
    api.reviewLoomTeleplay.mockResolvedValue({
      analysis: {
        summary: 'The full teleplay escalates cleanly.',
        strengths: ['The handoff is earned.'],
        risks: [],
        recommendations: [],
      },
    });
    const fullLoom = loom({
      episodes: [
        { id: 'ep-1', number: 1, title: 'Pilot', nodes: [{ id: 'node-1' }] },
        { id: 'ep-2', number: 2, title: 'Finale', nodes: [{ id: 'node-2' }] },
      ],
    });
    renderPlan({ loom: fullLoom, onLoomUpdate: () => {} });

    fireEvent.click(screen.getByRole('tab', { name: 'AI editor' }));
    fireEvent.click(screen.getByText('Manual AI plan tools'));
    expect(screen.getByRole('button', { name: 'Review full teleplay' })).toBeEnabled();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Review full teleplay' }));
    expect(await screen.findByText('The full teleplay escalates cleanly.')).toBeInTheDocument();
    expect(api.reviewLoomTeleplay).toHaveBeenCalledWith('loom-1', { operationId: expect.any(String) }, { silent: true });
  });

  it('validates the complete ordered beat arc and links blocking issues to episodes', async () => {
    api.validateLoomSeriesOutlines.mockResolvedValue({
      stats: { ready: false, errorCount: 1 },
      issues: [{ code: 'MISSING_EPISODE_OUTLINE', episodeId: 'ep-1', message: 'Draft Episode 1 first.' }],
    });
    const user = userEvent.setup();
    renderPlan({ loom: loom(), onLoomUpdate: () => {} });

    await user.click(screen.getByRole('tab', { name: 'Episode outlines' }));
    await user.click(screen.getByRole('button', { name: 'Validate full beat arc' }));

    expect(await screen.findByText(/Draft Episode 1 first\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Episode 1' })).toHaveAttribute('href', '/fableloom/loom-1/ep-1');
    expect(api.validateLoomSeriesOutlines).toHaveBeenCalledWith('loom-1', { silent: true });
  });

  it('authors configured overnight handoffs and a finale teaser in the series plan', async () => {
    const user = userEvent.setup();
    const threeEpisodeLoom = loom({
      episodes: [
        { id: 'ep-1', number: 1, title: 'Pilot' },
        { id: 'ep-2', number: 2, title: 'The Turn' },
        { id: 'ep-3', number: 3, title: 'Finale' },
      ],
    });
    const onLoomUpdate = vi.fn();
    renderPlan({ loom: threeEpisodeLoom, onLoomUpdate });

    await user.click(screen.getByRole('tab', { name: 'Viewer handoffs' }));
    await user.click(screen.getByLabelText(/overnight voicemail between episodes/i));
    expect(screen.getAllByRole('textbox', { name: 'Voicemail transcript' })).toHaveLength(2);
    await user.type(screen.getAllByRole('textbox', { name: 'Voicemail transcript' })[0], 'Stay awake. The beacon is listening.');
    await user.click(screen.getByLabelText(/next-season teaser after the finale/i));
    await user.type(screen.getByRole('textbox', { name: 'Teaser / cliffhanger' }), 'Something answers from beyond the relay.');
    await user.click(screen.getByRole('button', { name: /save plan/i }));

    await waitFor(() => expect(api.updateLoom).toHaveBeenCalledWith(
      'loom-1',
      expect.objectContaining({
        seriesPlan: expect.objectContaining({
          deliveryOptions: { overnightVoicemails: true, nextSeasonTeaser: true },
          interEpisodeVoicemails: expect.arrayContaining([
            expect.objectContaining({
              fromEpisodeId: 'ep-1', toEpisodeId: 'ep-2',
              transcript: 'Stay awake. The beacon is listening.',
            }),
          ]),
          nextSeasonTeaser: expect.objectContaining({
            transcript: 'Something answers from beyond the relay.',
          }),
        }),
      }),
      { silent: true },
    ));
  });
});

// The OPTIONAL five-stage character evolution lens (#6441). Its own fixture so
// the outline-scene keys and linked cast this section needs stay out of the
// plan fixture every other test shares.
const castLoom = (plan = {}) => ({
  id: 'loom-1',
  name: 'Example Loom',
  episodes: [
    { id: 'ep-1', number: 1, title: 'Pilot', storyOutline: { scenes: [{ key: 'the-blockade' }] } },
    { id: 'ep-2', number: 2, title: 'Finale', storyOutline: { scenes: [{ key: 'the-cost' }] } },
  ],
  seriesPlan: { storyArc: 'An old arc.', plotPoints: [], sideQuests: [], ...plan },
});

const castUniverse = {
  id: 'uni-1',
  characters: [
    {
      id: 'chr-1111',
      name: 'Vale',
      psychology: { theoryOfControl: 'If I stay useful, nobody leaves.' },
    },
    { id: 'chr-2222', name: 'Roan' },
  ],
};

const renderCastPlan = (props, entry = '/?section=cast') => render(<RouterProvider router={createMemoryRouter([
  { path: '/', element: <LoomSeriesPlan universe={castUniverse} onLoomUpdate={vi.fn()} {...props} /> },
], { initialEntries: [entry] })} />);

const savedPlan = () => api.updateLoom.mock.calls.at(-1)[1].seriesPlan;

describe('LoomSeriesPlan — cast evolution lens', () => {
  it('deep-links straight to the cast section and offers the linked universe cast', () => {
    renderCastPlan({ loom: castLoom() });

    expect(screen.getByRole('heading', { name: 'Cast evolution' })).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Add cast member' })).toBeVisible();
    expect(screen.getByText('No character evolution authored yet.')).toBeVisible();
  });

  it('sends a plan with no lens as a body byte-identical to the pre-lens one', async () => {
    api.updateLoom.mockResolvedValue(castLoom());
    renderCastPlan({ loom: castLoom() });

    fireEvent.click(screen.getByRole('tab', { name: 'Story arc' }));
    fireEvent.change(screen.getByRole('textbox', { name: /story arc/i }), { target: { value: 'A stronger arc.' } });
    fireEvent.click(screen.getByRole('button', { name: /save plan/i }));

    await waitFor(() => expect(api.updateLoom).toHaveBeenCalled());
    expect(Object.keys(savedPlan())).toEqual([
      'storyArc', 'plotPoints', 'sideQuests', 'deliveryOptions', 'interEpisodeVoicemails', 'nextSeasonTeaser',
    ]);
  });

  it('authors a full five-stage lens against episode and scene evidence', async () => {
    const user = userEvent.setup();
    api.updateLoom.mockResolvedValue(castLoom());
    renderCastPlan({ loom: castLoom() });

    await user.selectOptions(screen.getByRole('combobox', { name: 'Add cast member' }), 'chr-1111');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Declared outcome' }), 'full-change');
    for (const stage of ['control strategy failing', 'pressure forces exploration', 'commitment to change', 'cost tested', 'final proof']) {
      fireEvent.change(screen.getByRole('textbox', { name: `${stage} — Belief under test` }), {
        target: { value: `${stage}: usefulness buys safety` },
      });
    }
    await user.selectOptions(screen.getByRole('combobox', { name: 'final proof — Evidence episode' }), 'ep-2');
    await user.selectOptions(screen.getByRole('combobox', { name: 'final proof — Evidence scene' }), 'the-cost');
    fireEvent.click(screen.getByRole('button', { name: /save plan/i }));

    await waitFor(() => expect(api.updateLoom).toHaveBeenCalled());
    const [lens] = savedPlan().characterEvolutions;
    expect(lens).toMatchObject({ characterId: 'chr-1111', characterName: 'Vale' });
    expect(lens.evolution.outcome).toBe('full-change');
    expect(lens.evolution.stages.map((s) => s.stageId)).toEqual([
      'control-strategy-failing', 'pressure-forces-exploration', 'commitment-to-change', 'cost-tested', 'final-proof',
    ]);
    expect(lens.evolution.stages.at(-1).evidence).toMatchObject({ episodeId: 'ep-2', sceneKey: 'the-cost' });
  });

  it('keeps a sparse lens sparse and treats a declared flat arc as complete, not a defect', async () => {
    const user = userEvent.setup();
    api.updateLoom.mockResolvedValue(castLoom());
    renderCastPlan({ loom: castLoom() });

    await user.selectOptions(screen.getByRole('combobox', { name: 'Add cast member' }), 'chr-2222');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Declared outcome' }), 'flat-testing');
    fireEvent.change(screen.getByRole('textbox', { name: 'control strategy failing — External pressure' }), {
      target: { value: 'The town votes to abandon the relay.' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'commitment to change — Character choice' }), {
      target: { value: 'Stays, and changes the vote instead.' },
    });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save plan/i })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: /save plan/i }));

    await waitFor(() => expect(api.updateLoom).toHaveBeenCalled());
    const [lens] = savedPlan().characterEvolutions;
    expect(lens.evolution.outcome).toBe('flat-testing');
    expect(lens.evolution.stages.map((s) => s.stageId))
      .toEqual(['control-strategy-failing', 'commitment-to-change']);
  });

  it('marks an unresolvable evidence anchor stale and re-picks it in one click', async () => {
    const user = userEvent.setup();
    api.updateLoom.mockResolvedValue(castLoom());
    renderCastPlan({
      loom: castLoom({
        characterEvolutions: [{
          characterId: 'chr-1111',
          characterName: 'Vale',
          evolution: {
            outcome: 'partial-open',
            outcomeNote: '',
            stages: [{
              stageId: 'cost-tested',
              testedBelief: 'Usefulness buys safety.',
              externalPressure: '',
              characterChoice: '',
              causalConsequence: '',
              evidence: { atIssue: null, atSceneAnchor: '', transitionId: '', episodeId: 'ep-deleted', sceneKey: '' },
            }],
          },
        }],
      }),
    });

    await user.click(screen.getByText('Vale'));
    expect(screen.getByText('Stale anchor')).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'cost tested — Evidence episode' }))
      .toHaveValue('ep-deleted');
    await user.click(screen.getByRole('button', { name: 'Re-pick cost tested anchor' }));

    expect(screen.queryByText('Stale anchor')).not.toBeInTheDocument();
    await user.selectOptions(screen.getByRole('combobox', { name: 'cost tested — Evidence episode' }), 'ep-1');
    fireEvent.click(screen.getByRole('button', { name: /save plan/i }));

    await waitFor(() => expect(api.updateLoom).toHaveBeenCalled());
    expect(savedPlan().characterEvolutions[0].evolution.stages[0].evidence)
      .toMatchObject({ episodeId: 'ep-1' });
  });

  it('persists a fully cleared lens as a clear rather than a no-op', async () => {
    const user = userEvent.setup();
    api.updateLoom.mockResolvedValue(castLoom());
    renderCastPlan({
      loom: castLoom({
        characterEvolutions: [{
          characterId: 'chr-1111',
          characterName: 'Vale',
          evolution: {
            outcome: 'tragic-refusal',
            outcomeNote: 'He never lets go.',
            stages: [{
              stageId: 'final-proof',
              testedBelief: 'Usefulness buys safety.',
              externalPressure: '',
              characterChoice: '',
              causalConsequence: '',
              evidence: null,
            }],
          },
        }],
      }),
    });

    await user.click(screen.getByText('Vale'));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Declared outcome' }), '');
    fireEvent.change(screen.getByRole('textbox', { name: 'Outcome note' }), { target: { value: '' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'final proof — Belief under test' }), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /save plan/i }));

    await waitFor(() => expect(api.updateLoom).toHaveBeenCalled());
    expect(savedPlan().characterEvolutions[0].evolution).toBeNull();
  });

  it('shows the universe psychology profile as read-only baseline context', async () => {
    const user = userEvent.setup();
    renderCastPlan({
      loom: castLoom({
        characterEvolutions: [{ characterId: 'chr-1111', characterName: 'Vale', evolution: null }],
      }),
    });

    await user.click(screen.getByText('Vale'));
    await user.click(screen.getByText('Universe baseline (read-only)'));
    expect(screen.getByText('Universe baseline (read-only)')).toBeVisible();
    expect(screen.getByText('If I stay useful, nobody leaves.')).toBeVisible();
    expect(screen.queryByRole('textbox', { name: /theory of control/i })).not.toBeInTheDocument();
  });
});
