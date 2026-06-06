import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const api = vi.hoisted(() => ({
  getPipelineSeries: vi.fn(),
  updatePipelineSeries: vi.fn(),
  getPipelineManuscript: vi.fn(),
  getPipelineManuscriptReview: vi.fn(),
  savePipelineManuscriptSection: vi.fn(),
  restorePipelineStageVersion: vi.fn(),
  patchPipelineManuscriptComment: vi.fn(),
  generatePipelineManuscriptFix: vi.fn(),
  acceptPipelineManuscriptFix: vi.fn(),
  analyzePipelineManuscriptCompleteness: vi.fn(),
  getProviders: vi.fn(),
}));
vi.mock('../services/api', () => api);
vi.mock('../components/ui/Toast', () => ({ default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

import PipelineManuscriptEditor from './PipelineManuscriptEditor';

const comment = {
  id: 'mrc-1', issueNumber: 1, issueId: 'iss-1', stageId: 'prose',
  severity: 'high', category: 'arc-gap', location: 'Issue 1',
  problem: 'The ending is abrupt', suggestion: 'add a beat', anchorQuote: 'She left.',
  status: 'open', fix: null, createdAt: 't', updatedAt: 't',
};

const renderEditor = () => render(
  <MemoryRouter initialEntries={['/pipeline/series/ser-1/manuscript']}>
    <Routes>
      <Route path="/pipeline/series/:seriesId/manuscript" element={<PipelineManuscriptEditor />} />
      <Route path="/pipeline/series/:seriesId" element={<div>series page</div>} />
    </Routes>
  </MemoryRouter>,
);

beforeEach(() => {
  vi.clearAllMocks();
  api.getPipelineSeries.mockResolvedValue({ id: 'ser-1', name: 'My Series', primaryManuscriptType: 'prose' });
  api.getPipelineManuscript.mockResolvedValue({
    sections: [{ issueId: 'iss-1', number: 1, title: 'One', stageId: 'prose', content: 'The hero walked in. She left.' }],
    viewType: 'prose',
    primaryStageId: 'prose',
    pinnedPrimary: 'prose',
    availableTypes: ['prose'],
  });
  api.getPipelineManuscriptReview.mockResolvedValue({ schemaVersion: 1, comments: [comment] });
  api.getProviders.mockResolvedValue({ providers: [
    { id: 'anthropic', name: 'Anthropic', enabled: true, defaultModel: 'claude-opus', models: ['claude-opus', 'claude-haiku'] },
    { id: 'openai', name: 'OpenAI', enabled: true, defaultModel: 'gpt-5', models: ['gpt-5'] },
    { id: 'off', name: 'Disabled', enabled: false, defaultModel: 'x', models: ['x'] },
  ] });
});

describe('PipelineManuscriptEditor', () => {
  it('renders the manuscript section and an open editorial comment', async () => {
    renderEditor();
    expect(await screen.findByText('My Series')).toBeInTheDocument();
    expect(screen.getByText('The ending is abrupt')).toBeInTheDocument();
    expect(screen.getByDisplayValue('The hero walked in. She left.')).toBeInTheDocument();
    expect(screen.getByText(/1 open/)).toBeInTheDocument();
  });

  it('pins the clicked comment in a dismissable overlay so its context survives the jump', async () => {
    renderEditor();
    await screen.findByText('My Series');

    // Initially only the sidebar card exists.
    expect(screen.getByText('The ending is abrupt')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Editorial comment' })).not.toBeInTheDocument();

    // Clicking Jump pins it as a floating overlay (problem text now appears twice).
    fireEvent.click(screen.getByTitle('Jump to this spot in the manuscript'));
    const overlay = await screen.findByRole('dialog', { name: 'Editorial comment' });
    expect(overlay).toBeInTheDocument();
    expect(screen.getAllByText('The ending is abrupt').length).toBe(2);

    // Closing the overlay leaves the sidebar card intact.
    fireEvent.click(screen.getByTitle('Close pinned comment'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Editorial comment' })).not.toBeInTheDocument());
    expect(screen.getByText('The ending is abrupt')).toBeInTheDocument();
  });

  it('dismisses the pinned overlay on Escape', async () => {
    renderEditor();
    await screen.findByText('My Series');

    fireEvent.click(screen.getByTitle('Jump to this spot in the manuscript'));
    await screen.findByRole('dialog', { name: 'Editorial comment' });

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Editorial comment' })).not.toBeInTheDocument());
  });

  it('preserves an in-progress fix edit made in the sidebar when accepting from the pinned overlay', async () => {
    api.generatePipelineManuscriptFix.mockResolvedValue({
      fix: { find: 'She left.', replace: 'She left, but paused.' },
      comment: { ...comment, fix: { find: 'She left.', replace: 'She left, but paused.' } },
    });
    api.acceptPipelineManuscriptFix.mockResolvedValue({
      comment: { ...comment, status: 'accepted', fix: { find: 'She left.', replace: 'edited in sidebar.' } },
      section: { issueId: 'iss-1', number: 1, title: 'One', stageId: 'prose', content: 'The hero walked in. edited in sidebar.' },
    });

    renderEditor();
    await screen.findByText('My Series');

    // Generate a fix, then edit the replacement text in the sidebar card.
    fireEvent.click(screen.getByText('Generate fix'));
    const sidebarReplace = await screen.findByDisplayValue('She left, but paused.');
    fireEvent.change(sidebarReplace, { target: { value: 'edited in sidebar.' } });

    // Now jump → the overlay mounts a second card; it must carry the edit.
    fireEvent.click(screen.getByTitle('Jump to this spot in the manuscript'));
    const overlay = await screen.findByRole('dialog', { name: 'Editorial comment' });
    expect(within(overlay).getByDisplayValue('edited in sidebar.')).toBeInTheDocument();

    // Accept from the overlay applies the edited replacement, not the original.
    fireEvent.click(within(overlay).getByText('Accept'));
    await waitFor(() => expect(api.acceptPipelineManuscriptFix).toHaveBeenCalledWith('ser-1', 'mrc-1', {
      edits: [{ issueNumber: 1, issueId: 'iss-1', stageId: 'prose', find: 'She left.', replace: 'edited in sidebar.', fuzzy: undefined }],
    }));
  });

  it('closes the pinned overlay automatically when its comment is accepted', async () => {
    api.generatePipelineManuscriptFix.mockResolvedValue({
      fix: { find: 'She left.', replace: 'She left, but paused.' },
      comment: { ...comment, fix: { find: 'She left.', replace: 'She left, but paused.' } },
    });
    api.acceptPipelineManuscriptFix.mockResolvedValue({
      comment: { ...comment, status: 'accepted', fix: { find: 'She left.', replace: 'She left, but paused.' } },
      section: { issueId: 'iss-1', number: 1, title: 'One', stageId: 'prose', content: 'The hero walked in. She left, but paused.' },
    });

    renderEditor();
    await screen.findByText('My Series');

    fireEvent.click(screen.getByTitle('Jump to this spot in the manuscript'));
    const overlay = await screen.findByRole('dialog', { name: 'Editorial comment' });

    // Act on the comment from inside the overlay.
    fireEvent.click(within(overlay).getByText('Generate fix'));
    fireEvent.click(await within(overlay).findByText('Accept'));

    // Accepting flips status → the overlay vanishes on its own.
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Editorial comment' })).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByText(/0 open/)).toBeInTheDocument());
  });

  it('generates a fix, then accepts it — moving the comment to Accepted and updating the section', async () => {
    api.generatePipelineManuscriptFix.mockResolvedValue({
      fix: { find: 'She left.', replace: 'She left, but paused.' },
      comment: { ...comment, fix: { find: 'She left.', replace: 'She left, but paused.' } },
    });
    api.acceptPipelineManuscriptFix.mockResolvedValue({
      comment: { ...comment, status: 'accepted', fix: { find: 'She left.', replace: 'She left, but paused.' } },
      section: { issueId: 'iss-1', number: 1, title: 'One', stageId: 'prose', content: 'The hero walked in. She left, but paused.' },
    });

    renderEditor();
    fireEvent.click(await screen.findByText('Generate fix'));

    // The editable replacement appears.
    expect(await screen.findByDisplayValue('She left, but paused.')).toBeInTheDocument();
    expect(api.generatePipelineManuscriptFix).toHaveBeenCalledWith('ser-1', 'mrc-1', expect.any(Object));

    fireEvent.click(screen.getByText('Accept'));

    // Section text updates and the open count drops to 0.
    expect(await screen.findByDisplayValue('The hero walked in. She left, but paused.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/0 open/)).toBeInTheDocument());
    expect(api.acceptPipelineManuscriptFix).toHaveBeenCalledWith('ser-1', 'mrc-1', {
      edits: [{ issueNumber: 1, issueId: 'iss-1', stageId: 'prose', find: 'She left.', replace: 'She left, but paused.', fuzzy: undefined }],
    });
  });

  it('switches manuscript format on demand', async () => {
    api.getPipelineManuscript.mockImplementation((_id, type) => {
      if (type === 'teleplay') return Promise.resolve({
        sections: [{ issueId: 'iss-1', number: 1, title: 'One', stageId: 'teleplay', content: 'INT. ROOM - DAY' }],
        viewType: 'teleplay', primaryStageId: 'prose', pinnedPrimary: 'prose', availableTypes: ['prose', 'teleplay'],
      });
      return Promise.resolve({
        sections: [{ issueId: 'iss-1', number: 1, title: 'One', stageId: 'prose', content: 'The hero walked in. She left.' }],
        viewType: 'prose', primaryStageId: 'prose', pinnedPrimary: 'prose', availableTypes: ['prose', 'teleplay'],
      });
    });
    renderEditor();
    await screen.findByText('My Series');
    fireEvent.click(screen.getByText('Teleplay'));
    expect(await screen.findByDisplayValue('INT. ROOM - DAY')).toBeInTheDocument();
    expect(api.getPipelineManuscript).toHaveBeenCalledWith('ser-1', 'teleplay');
  });

  it('saves a changed free-text section edit on blur (versioned), and skips no-op blurs', async () => {
    api.savePipelineManuscriptSection.mockResolvedValue({
      section: { issueId: 'iss-1', number: 1, title: 'One', stageId: 'prose', content: 'The hero walked in. She stayed.', versions: [{ runId: 'v1', createdAt: 't' }] },
    });
    renderEditor();
    const ta = await screen.findByDisplayValue('The hero walked in. She left.');

    // No-op blur (unchanged) must not save.
    fireEvent.blur(ta);
    expect(api.savePipelineManuscriptSection).not.toHaveBeenCalled();

    // Changed blur saves with the versioned section endpoint.
    fireEvent.change(ta, { target: { value: 'The hero walked in. She stayed.' } });
    fireEvent.blur(ta);
    await waitFor(() => expect(api.savePipelineManuscriptSection).toHaveBeenCalledWith(
      'ser-1',
      'iss-1',
      { stageId: 'prose', output: 'The hero walked in. She stayed.' },
      { silent: true },
    ));
    // Version history surfaces after the save.
    expect(await screen.findByTitle('Show prior saved versions')).toBeInTheDocument();
  });

  it('routes Generate fix through the selected provider/model override', async () => {
    api.generatePipelineManuscriptFix.mockResolvedValue({
      fix: { find: 'She left.', replace: 'She left, but paused.' },
      comment: { ...comment, fix: { find: 'She left.', replace: 'She left, but paused.' } },
    });
    renderEditor();
    await screen.findByText('My Series');

    // Only enabled providers populate the selector.
    const providerSelect = screen.getByLabelText(/AI provider/i);
    expect(screen.queryByRole('option', { name: 'Disabled' })).not.toBeInTheDocument();
    fireEvent.change(providerSelect, { target: { value: 'anthropic' } });
    // Model defaults to the provider's defaultModel; switch it explicitly.
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'claude-haiku' } });

    fireEvent.click(screen.getByText('Generate fix'));
    await waitFor(() => expect(api.generatePipelineManuscriptFix).toHaveBeenCalledWith(
      'ser-1', 'mrc-1', { providerOverride: 'anthropic', modelOverride: 'claude-haiku' },
    ));
  });

  it('re-runs the editorial review with the override and swaps in the returned comments', async () => {
    const fresh = { ...comment, id: 'mrc-2', problem: 'New pacing note' };
    api.analyzePipelineManuscriptCompleteness.mockResolvedValue({
      review: { schemaVersion: 1, comments: [comment, fresh] },
    });
    renderEditor();
    await screen.findByText('My Series');

    fireEvent.change(screen.getByLabelText(/AI provider/i), { target: { value: 'openai' } });
    fireEvent.click(screen.getByText('Run editorial review'));

    expect(await screen.findByText('New pacing note')).toBeInTheDocument();
    expect(api.analyzePipelineManuscriptCompleteness).toHaveBeenCalledWith(
      'ser-1', { providerOverride: 'openai', modelOverride: 'gpt-5', mode: 'merge' },
    );
    await waitFor(() => expect(screen.getByText(/2 open/)).toBeInTheDocument());
  });

  it('sends mode "fresh" when the Start fresh checkbox is checked', async () => {
    api.analyzePipelineManuscriptCompleteness.mockResolvedValue({
      review: { schemaVersion: 1, comments: [comment] },
    });
    renderEditor();
    await screen.findByText('My Series');

    fireEvent.click(screen.getByLabelText(/Start fresh/i));
    fireEvent.click(screen.getByText('Run editorial review'));

    await waitFor(() => expect(api.analyzePipelineManuscriptCompleteness).toHaveBeenCalledWith(
      'ser-1', expect.objectContaining({ mode: 'fresh' }),
    ));
  });

  it('shows a chunk-count badge when the review ran in chunks (small context window)', async () => {
    api.analyzePipelineManuscriptCompleteness.mockResolvedValue({
      review: { schemaVersion: 1, comments: [comment] },
      chunked: true,
      chunkCount: 4,
    });
    renderEditor();
    await screen.findByText('My Series');

    expect(screen.queryByText(/Reviewed in/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Run editorial review'));

    expect(await screen.findByText('Reviewed in 4 chunks')).toBeInTheDocument();
  });

  it('does not show a chunk-count badge when the whole manuscript was reviewed at once', async () => {
    api.analyzePipelineManuscriptCompleteness.mockResolvedValue({
      review: { schemaVersion: 1, comments: [comment] },
      chunked: false,
      chunkCount: 1,
    });
    renderEditor();
    await screen.findByText('My Series');

    fireEvent.click(screen.getByText('Run editorial review'));
    await waitFor(() => expect(api.analyzePipelineManuscriptCompleteness).toHaveBeenCalled());
    expect(screen.queryByText(/Reviewed in/)).not.toBeInTheDocument();
  });
});
