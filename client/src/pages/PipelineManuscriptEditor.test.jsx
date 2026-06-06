import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
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

// Reveal a comment in context by clicking its sidebar index row.
const revealFromIndex = (problem) => fireEvent.click(screen.getByText(problem));

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear(); // default to Live mode
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
  it('renders the manuscript section and an open editorial comment in the index', async () => {
    renderEditor();
    expect(await screen.findByText('My Series')).toBeInTheDocument();
    expect(screen.getByText('The ending is abrupt')).toBeInTheDocument();
    expect(screen.getByDisplayValue('The hero walked in. She left.')).toBeInTheDocument();
    expect(screen.getByText(/1 open/)).toBeInTheDocument();
  });

  it('reveals a comment in-context (Live mode) when its index row is clicked, and closes it', async () => {
    renderEditor();
    await screen.findByText('My Series');

    // Initially only the sidebar index row references the comment.
    expect(screen.getAllByText('The ending is abrupt')).toHaveLength(1);

    revealFromIndex('The ending is abrupt');
    // Now an in-context note card also shows the problem text → two instances.
    await waitFor(() => expect(screen.getAllByText('The ending is abrupt')).toHaveLength(2));

    // Closing the in-context note leaves the sidebar index intact.
    fireEvent.click(screen.getByLabelText('Close note'));
    await waitFor(() => expect(screen.getAllByText('The ending is abrupt')).toHaveLength(1));
  });

  it('closes the in-context note on Escape', async () => {
    renderEditor();
    await screen.findByText('My Series');
    revealFromIndex('The ending is abrupt');
    await waitFor(() => expect(screen.getAllByText('The ending is abrupt')).toHaveLength(2));
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.getAllByText('The ending is abrupt')).toHaveLength(1));
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
    await screen.findByText('My Series');
    revealFromIndex('The ending is abrupt');

    fireEvent.click(await screen.findByText('Generate fix'));
    expect(await screen.findByDisplayValue('She left, but paused.')).toBeInTheDocument();
    expect(api.generatePipelineManuscriptFix).toHaveBeenCalledWith('ser-1', 'mrc-1', expect.any(Object));

    fireEvent.click(screen.getByText('Accept'));

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

    fireEvent.blur(ta);
    expect(api.savePipelineManuscriptSection).not.toHaveBeenCalled();

    fireEvent.change(ta, { target: { value: 'The hero walked in. She stayed.' } });
    fireEvent.blur(ta);
    await waitFor(() => expect(api.savePipelineManuscriptSection).toHaveBeenCalledWith(
      'ser-1',
      'iss-1',
      { stageId: 'prose', output: 'The hero walked in. She stayed.' },
      { silent: true },
    ));
    expect(await screen.findByTitle('Show prior saved versions')).toBeInTheDocument();
  });

  it('Review mode renders annotated prose with an Edit toggle that swaps in the textarea', async () => {
    renderEditor();
    await screen.findByText('My Series');

    fireEvent.click(screen.getByRole('button', { name: /Review/ }));
    // Read-only prose: the section textarea is gone, the anchor is a highlight.
    await waitFor(() => expect(screen.queryByDisplayValue('The hero walked in. She left.')).not.toBeInTheDocument());
    expect(screen.getByTitle('Open editorial note')).toBeInTheDocument();

    // Edit toggle brings back the editable textarea.
    fireEvent.click(screen.getByRole('button', { name: /Edit/ }));
    expect(await screen.findByDisplayValue('The hero walked in. She left.')).toBeInTheDocument();
  });

  it('Review mode: revealing an anchored comment from the sidebar opens it in-context (no "not anchored")', async () => {
    const toast = (await import('../components/ui/Toast')).default;
    renderEditor();
    await screen.findByText('My Series');
    fireEvent.click(screen.getByRole('button', { name: /Review/ }));
    await waitFor(() => expect(screen.queryByDisplayValue('The hero walked in. She left.')).not.toBeInTheDocument());

    revealFromIndex('The ending is abrupt');
    // The inline card appears (problem now shown in both the index row and card)…
    await waitFor(() => expect(screen.getAllByText('The ending is abrupt')).toHaveLength(2));
    // …and the bogus "not anchored" toast is NOT fired for an anchored comment.
    expect(toast).not.toHaveBeenCalledWith('This comment is not anchored to a specific issue');

    // The card's close control collapses it back to index-only.
    fireEvent.click(screen.getByLabelText('Close note'));
    await waitFor(() => expect(screen.getAllByText('The ending is abrupt')).toHaveLength(1));
  });

  it('opens the whole-manuscript impact preview modal', async () => {
    renderEditor();
    await screen.findByText('My Series');
    fireEvent.click(screen.getByText('Impact preview'));
    expect(await screen.findByRole('dialog', { name: 'Manuscript impact preview' })).toBeInTheDocument();
  });

  it('routes Generate fix through the selected provider/model override', async () => {
    api.generatePipelineManuscriptFix.mockResolvedValue({
      fix: { find: 'She left.', replace: 'She left, but paused.' },
      comment: { ...comment, fix: { find: 'She left.', replace: 'She left, but paused.' } },
    });
    renderEditor();
    await screen.findByText('My Series');

    const providerSelect = screen.getByLabelText(/AI provider/i);
    expect(screen.queryByRole('option', { name: 'Disabled' })).not.toBeInTheDocument();
    fireEvent.change(providerSelect, { target: { value: 'anthropic' } });
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'claude-haiku' } });

    revealFromIndex('The ending is abrupt');
    fireEvent.click(await screen.findByText('Generate fix'));
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
