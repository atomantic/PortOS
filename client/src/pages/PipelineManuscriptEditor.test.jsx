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
});

describe('PipelineManuscriptEditor', () => {
  it('renders the manuscript section and an open editorial comment', async () => {
    renderEditor();
    expect(await screen.findByText('My Series')).toBeInTheDocument();
    expect(screen.getByText('The ending is abrupt')).toBeInTheDocument();
    expect(screen.getByDisplayValue('The hero walked in. She left.')).toBeInTheDocument();
    expect(screen.getByText(/1 open/)).toBeInTheDocument();
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
    expect(api.generatePipelineManuscriptFix).toHaveBeenCalledWith('ser-1', 'mrc-1');

    fireEvent.click(screen.getByText('Accept'));

    // Section text updates and the open count drops to 0.
    expect(await screen.findByDisplayValue('The hero walked in. She left, but paused.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/0 open/)).toBeInTheDocument());
    expect(api.acceptPipelineManuscriptFix).toHaveBeenCalledWith('ser-1', 'mrc-1', { find: 'She left.', replace: 'She left, but paused.' });
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
});
