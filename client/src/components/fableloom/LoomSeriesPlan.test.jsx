import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { useState } from 'react';

vi.mock('../../services/api', () => ({
  feedbackLoomSeriesPlan: vi.fn(),
  generateLoomSeriesPlan: vi.fn(),
  reviewLoomSeriesPlan: vi.fn(),
  updateLoom: vi.fn(),
}));
vi.mock('../../hooks/useProviderModels', () => ({ default: () => ({ providers: [], loading: false }) }));
vi.mock('../ProviderModelSelector', () => ({ default: () => <div>AI route picker</div> }));
vi.mock('./LoomEpisodeFeedback', () => ({ default: ({ episode }) => <div>Episode feedback for {episode.title}</div> }));

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

  it('shows AI series analysis and exposes whole-episode editing outside the episode graph', async () => {
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
    expect(screen.getByText('Episode feedback for Pilot')).toBeInTheDocument();
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
      'loom-1', {}, { silent: true },
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
});
