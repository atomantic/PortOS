import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    expect(screen.getByRole('button', { name: /analyze series/i })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /save plan/i }));

    await waitFor(() => expect(api.updateLoom).toHaveBeenCalledWith('loom-1', {
      seriesPlan: expect.objectContaining({ storyArc: 'A stronger arc.' }),
    }, { silent: true }));
    expect(onLoomUpdate).toHaveBeenCalledWith(updated);
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

    fireEvent.click(screen.getByRole('button', { name: /regenerate full plan/i }));
    fireEvent.click(screen.getByRole('button', { name: /^regenerate$/i }));
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

  it('renders AI tools and save plan within the persistent desktop rail beside the story content', () => {
    renderPlan({ loom: loom(), onLoomUpdate: () => {} });
    const rightRail = screen.getByRole('complementary', { name: /ai tools and actions/i });
    expect(rightRail).toBeInTheDocument();
    expect(rightRail.className).toContain('lg:sticky');
    expect(rightRail.className).toContain('lg:top-0');

    // Confirm actions and AI tools reside within the right rail
    expect(rightRail).toContainElement(screen.getByRole('button', { name: /save plan/i }));
    expect(rightRail).toContainElement(screen.getByRole('button', { name: /analyze series/i }));
    expect(rightRail).toContainElement(screen.getByRole('button', { name: /(draft|regenerate) full plan/i }));
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
