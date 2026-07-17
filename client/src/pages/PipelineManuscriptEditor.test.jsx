import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { MockEventSource, lastEventSource as lastEs } from '../test/mockEventSource';

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
  startPipelineManuscriptCompleteness: vi.fn(),
  cancelPipelineManuscriptCompleteness: vi.fn(),
  getPipelineManuscriptCompletenessStatus: vi.fn(),
  pipelineManuscriptCompletenessSseUrl: vi.fn((id) => `/api/pipeline/series/${id}/manuscript/completeness/progress`),
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

const renderEditor = (path = '/pipeline/series/ser-1/manuscript') => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/pipeline/series/:seriesId/manuscript/*" element={<PipelineManuscriptEditor />} />
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
  api.getPipelineManuscriptCompletenessStatus.mockResolvedValue({ active: false });
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

  it('revealing a comment from the sidebar switches to Review mode and opens it in-context, then closes', async () => {
    renderEditor();
    await screen.findByText('My Series');

    // Initially only the sidebar index row references the comment, and we're in
    // Live mode (the section is an editable textarea).
    expect(screen.getAllByText('The ending is abrupt')).toHaveLength(1);
    expect(screen.getByDisplayValue('The hero walked in. She left.')).toBeInTheDocument();

    revealFromIndex('The ending is abrupt');
    // Reveal drops into Review mode (read-only prose, no textarea) and opens the
    // note in-context — the problem text now shows in both the index and card.
    await waitFor(() => expect(screen.getAllByText('The ending is abrupt')).toHaveLength(2));
    expect(screen.queryByDisplayValue('The hero walked in. She left.')).not.toBeInTheDocument();

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

  it('Live mode: Escape closes the popover and the trailing keyup does not reopen it', async () => {
    renderEditor(); // Live is the default mode
    await screen.findByText('My Series');
    const ta = screen.getByDisplayValue('The hero walked in. She left.');
    // Put the caret inside the "She left." anchor span and click to open.
    const idx = 'The hero walked in. She left.'.indexOf('She left.') + 2;
    ta.selectionStart = idx; ta.selectionEnd = idx;
    fireEvent.click(ta);
    expect(await screen.findByText('Editorial note')).toBeInTheDocument();

    // Esc (keydown) closes; the trailing keyup must NOT re-open it.
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.keyUp(ta, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByText('Editorial note')).not.toBeInTheDocument());
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
    revealFromIndex('The ending is abrupt'); // → Review mode + opens the card

    fireEvent.click(await screen.findByText('Generate fix'));
    expect(await screen.findByDisplayValue('She left, but paused.')).toBeInTheDocument();
    expect(api.generatePipelineManuscriptFix).toHaveBeenCalledWith('ser-1', 'mrc-1', expect.any(Object));

    fireEvent.click(screen.getByText('Accept'));

    // Review mode is read-only prose (no textarea) — the accepted text shows there.
    expect(await screen.findByText('The hero walked in. She left, but paused.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/0 open/)).toBeInTheDocument());
    expect(api.acceptPipelineManuscriptFix).toHaveBeenCalledWith('ser-1', 'mrc-1', {
      edits: [{ issueNumber: 1, issueId: 'iss-1', stageId: 'prose', find: 'She left.', replace: 'She left, but paused.', fuzzy: undefined }],
    });
  });

  it('shows issue tabs and focuses one issue; a deep link opens that issue', async () => {
    const twoIssues = {
      sections: [
        { issueId: 'iss-1', number: 1, title: 'One', stageId: 'prose', content: 'Issue one body.' },
        { issueId: 'iss-2', number: 2, title: 'Two', stageId: 'prose', content: 'Issue two body.' },
      ],
      viewType: 'prose', primaryStageId: 'prose', pinnedPrimary: 'prose', availableTypes: ['prose'],
    };
    api.getPipelineManuscript.mockResolvedValue(twoIssues);
    renderEditor('/pipeline/series/ser-1/manuscript/2');
    await screen.findByText('My Series');
    // Deep link focuses issue 2 only — issue 1's body is not rendered.
    expect(await screen.findByDisplayValue('Issue two body.')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Issue one body.')).not.toBeInTheDocument();
    // Both issues appear as tabs.
    const tabs = within(screen.getByRole('navigation', { name: 'Issues' })).getAllByRole('link');
    expect(tabs).toHaveLength(2);
  });

  it('redirects the bare /manuscript URL to the first issue', async () => {
    renderEditor('/pipeline/series/ser-1/manuscript');
    await screen.findByText('My Series');
    // The single issue (number 1) renders; the canonical issue tab is current.
    expect(await screen.findByDisplayValue('The hero walked in. She left.')).toBeInTheDocument();
    // The bare→/1 redirect is an effect-driven navigate, so the tab's
    // aria-current lands a tick after the textarea content paints. Wait for it.
    await waitFor(() => {
      const tab = within(screen.getByRole('navigation', { name: 'Issues' })).getByRole('link');
      expect(tab).toHaveAttribute('aria-current', 'page');
    });
  });

  it('switches issues via the tabs without refetching the manuscript', async () => {
    api.getPipelineManuscript.mockResolvedValue({
      sections: [
        { issueId: 'iss-1', number: 1, title: 'One', stageId: 'prose', content: 'Issue one body.' },
        { issueId: 'iss-2', number: 2, title: 'Two', stageId: 'prose', content: 'Issue two body.' },
      ],
      viewType: 'prose', primaryStageId: 'prose', pinnedPrimary: 'prose', availableTypes: ['prose'],
    });
    renderEditor('/pipeline/series/ser-1/manuscript/1');
    expect(await screen.findByDisplayValue('Issue one body.')).toBeInTheDocument();
    const callsBefore = api.getPipelineManuscript.mock.calls.length;

    fireEvent.click(within(screen.getByRole('navigation', { name: 'Issues' })).getByRole('link', { name: /Issue 2/ }));
    expect(await screen.findByDisplayValue('Issue two body.')).toBeInTheDocument();
    // Tab navigation is pure routing — no extra manuscript fetch.
    expect(api.getPipelineManuscript.mock.calls.length).toBe(callsBefore);
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
    expect(api.getPipelineManuscript).toHaveBeenCalledWith('ser-1', 'teleplay', { silent: true });
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
      'ser-1', { providerOverride: 'openai', modelOverride: 'gpt-5', mode: 'merge' }, { silent: true },
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
      'ser-1', expect.objectContaining({ mode: 'fresh' }), { silent: true },
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

describe('PipelineManuscriptEditor — generate-edits streamed review', () => {
  beforeEach(() => {
    MockEventSource.reset();
    // Stub for the whole describe — a deferred SSE-open effect can fire after the
    // test body returns (during RTL cleanup), so don't delete it per-test or that
    // late `new EventSource(url)` throws a ReferenceError.
    vi.stubGlobal('EventSource', MockEventSource);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('checkbox-on runs the streamed edits endpoint (not the sync findings-only path)', async () => {
    api.startPipelineManuscriptCompleteness.mockResolvedValue({ runId: 'cr-1', sseUrl: '/sse' });
    renderEditor();
    await screen.findByText('My Series');

    fireEvent.click(screen.getByLabelText(/Generate edits for every finding/i));
    fireEvent.click(screen.getByText('Run editorial review'));

    await waitFor(() => expect(api.startPipelineManuscriptCompleteness).toHaveBeenCalledWith(
      'ser-1', expect.objectContaining({ mode: 'merge' }), { silent: true },
    ));
    expect(api.analyzePipelineManuscriptCompleteness).not.toHaveBeenCalled();
    // Let the deferred SSE-open effect flush + close inside the test (while the
    // EventSource stub is live) so it can't throw during teardown.
    await waitFor(() => expect(MockEventSource.instances.length).toBeGreaterThan(0));
    // Driving the mock stream by hand fires the EventSource handlers synchronously,
    // which call setState in useSseProgress — wrap in act() so those updates flush
    // inside the React lifecycle (no "not wrapped in act" warning).
    act(() => lastEs().emit({ type: 'canceled' }));
  });

  it('on the complete frame, re-fetches the review so comments arrive with fixes (diff + Accept, no Generate fix)', async () => {
    const withFix = {
      ...comment,
      fix: { find: 'She left.', replace: 'She left, but paused.', edits: [{ issueNumber: 1, issueId: 'iss-1', stageId: 'prose', find: 'She left.', replace: 'She left, but paused.' }] },
    };
    api.startPipelineManuscriptCompleteness.mockResolvedValue({ runId: 'cr-1', sseUrl: '/sse' });
    // First load returns the fix-less comment; the post-complete re-fetch returns
    // the comment with its pre-built fix.
    api.getPipelineManuscriptReview
      .mockResolvedValueOnce({ schemaVersion: 1, comments: [comment] })
      .mockResolvedValueOnce({ schemaVersion: 1, comments: [withFix] });

    renderEditor();
    await screen.findByText('My Series');

    fireEvent.click(screen.getByLabelText(/Generate edits for every finding/i));
    fireEvent.click(screen.getByText('Run editorial review'));
    await waitFor(() => expect(MockEventSource.instances.length).toBeGreaterThan(0));

    // Drive the terminal frame; the editor re-fetches the review.
    act(() => lastEs().emit({ type: 'complete', openCount: 1, chunked: false, chunkCount: 1 }));
    await waitFor(() => expect(api.getPipelineManuscriptReview).toHaveBeenCalledTimes(2));

    // The comment now carries a fix → the in-context card shows Accept, not "Generate fix".
    revealFromIndex('The ending is abrupt');
    expect(await screen.findByDisplayValue('She left, but paused.')).toBeInTheDocument();
    expect(screen.getByText('Accept')).toBeInTheDocument();
    expect(screen.queryByText('Generate fix')).not.toBeInTheDocument();
  });

  it('a SECOND streamed review in the same session is not torn down by the prior run\'s stale terminal frame', async () => {
    api.startPipelineManuscriptCompleteness.mockResolvedValue({ runId: 'cr-1', sseUrl: '/sse' });
    api.getPipelineManuscriptReview.mockResolvedValue({ schemaVersion: 1, comments: [comment] });
    renderEditor();
    await screen.findByText('My Series');

    // Run 1: start, complete, re-fetch (getReview now called twice — initial + post-complete).
    fireEvent.click(screen.getByLabelText(/Generate edits for every finding/i));
    fireEvent.click(screen.getByText('Run editorial review'));
    await waitFor(() => expect(MockEventSource.instances.length).toBe(1));
    act(() => lastEs().emit({ type: 'complete', openCount: 1, chunked: false, chunkCount: 1 }));
    await waitFor(() => expect(api.getPipelineManuscriptReview).toHaveBeenCalledTimes(2));
    // Run 1's button is back to idle.
    await screen.findByText('Run editorial review');

    // Run 2: starting it must subscribe a fresh stream and STAY active — the
    // prior run's `complete` frame is still in useSseProgress's `latest` until
    // the resubscribe resets it, and without the reviewClosed gate the terminal
    // effect would consume that stale frame and tear run 2 down on start
    // (firing a spurious 3rd review re-fetch).
    fireEvent.click(screen.getByText('Run editorial review'));
    await waitFor(() => expect(MockEventSource.instances.length).toBe(2));
    // Button stays busy (run 2 in flight) and no stale re-fetch fired.
    await screen.findByText(/Starting editorial review|Drafting edits/);
    expect(api.getPipelineManuscriptReview).toHaveBeenCalledTimes(2);

    // Run 2's own complete frame drives the real re-fetch (3rd call).
    act(() => lastEs().emit({ type: 'complete', openCount: 1, chunked: false, chunkCount: 1 }));
    await waitFor(() => expect(api.getPipelineManuscriptReview).toHaveBeenCalledTimes(3));
  });

  it('recovers when the SSE stream dies without a terminal frame (button re-enables, review re-fetched)', async () => {
    api.startPipelineManuscriptCompleteness.mockResolvedValue({ runId: 'cr-1', sseUrl: '/sse' });
    api.getPipelineManuscriptReview.mockResolvedValue({ schemaVersion: 1, comments: [comment] });
    renderEditor();
    await screen.findByText('My Series');

    fireEvent.click(screen.getByLabelText(/Generate edits for every finding/i));
    fireEvent.click(screen.getByText('Run editorial review'));
    await waitFor(() => expect(MockEventSource.instances.length).toBeGreaterThan(0));
    // Mid-run the button is disabled (busy) showing progress text.
    await screen.findByText(/Starting editorial review|Drafting edits/);

    // Connection drops with no complete/canceled/error frame.
    act(() => lastEs().fail());

    // Recovery: button re-enables (no longer stuck) and the review is re-fetched.
    expect(await screen.findByText('Run editorial review')).toBeInTheDocument();
    await waitFor(() => expect(api.getPipelineManuscriptReview).toHaveBeenCalledTimes(2));
  });
});
