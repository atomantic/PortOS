import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Mock the API so the component renders a deterministic synced-review payload.
const getWritersRoomSyncedReview = vi.fn();
vi.mock('../../services/apiWritersRoom', () => ({
  getWritersRoomSyncedReview: (...args) => getWritersRoomSyncedReview(...args),
}));

import SyncedReview from './SyncedReview';

function payload(overrides = {}) {
  return {
    workId: 'wr-work-1',
    title: 'Test',
    draftVersionId: 'wr-draft-1',
    activeContentHash: 'h',
    prose: {
      segments: [
        { id: 'seg-001', kind: 'chapter', heading: 'Opening', start: 0, end: 10, wordCount: 5, text: 'The hero wakes.', scriptSceneIds: ['scene-01'], media: [] },
        { id: 'seg-002', kind: 'chapter', heading: 'Battle', start: 10, end: 20, wordCount: 5, text: 'Swords clash.', scriptSceneIds: [], media: [] },
      ],
    },
    script: {
      available: true, status: 'succeeded', stale: false, analysisId: 'script',
      providerId: 'openai', model: 'gpt-x', completedAt: '2026-01-01T00:00:00Z', error: null,
      title: 'T', logline: 'L',
      scenes: [
        { id: 'scene-01', heading: 'Opening Scene', slugline: 'INT. ROOM', summary: 'wakes', characters: [], sourceSegmentIds: ['seg-001'], proseSegmentIds: ['seg-001'], media: null },
      ],
    },
    media: { items: [] },
    ...overrides,
  };
}

beforeEach(() => {
  getWritersRoomSyncedReview.mockReset();
});

const work = { id: 'wr-work-1', title: 'Test' };

describe('SyncedReview', () => {
  it('renders the three panes from the assembled payload', async () => {
    getWritersRoomSyncedReview.mockResolvedValue(payload());
    render(<SyncedReview work={work} />);
    // unique body text identifies each prose segment card
    expect(await screen.findByText('The hero wakes.')).toBeTruthy();
    expect(screen.getByText('Swords clash.')).toBeTruthy();
    expect(screen.getByText('Opening Scene')).toBeTruthy();
    // pane toggles in the toolbar
    expect(screen.getByTitle('Toggle Prose pane')).toBeTruthy();
    expect(screen.getByTitle('Toggle Script pane')).toBeTruthy();
    expect(screen.getByTitle('Toggle Media pane')).toBeTruthy();
  });

  it('selecting a prose segment activates the cross-link (Clear link appears)', async () => {
    getWritersRoomSyncedReview.mockResolvedValue(payload());
    render(<SyncedReview work={work} />);
    fireEvent.click(await screen.findByText('The hero wakes.'));
    expect(await screen.findByText(/Clear link/)).toBeTruthy();
    // clicking again clears the selection
    fireEvent.click(screen.getByText('The hero wakes.'));
    await waitFor(() => expect(screen.queryByText(/Clear link/)).toBeNull());
  });

  it('toggling the Script pane off hides it but keeps at least one pane', async () => {
    getWritersRoomSyncedReview.mockResolvedValue(payload());
    render(<SyncedReview work={work} />);
    await screen.findByText('Opening Scene');
    // toggle Script pane off via the toolbar button
    const scriptToggle = screen.getByTitle('Toggle Script pane');
    fireEvent.click(scriptToggle);
    await waitFor(() => expect(screen.queryByText('Opening Scene')).toBeNull());
    // prose pane still present
    expect(screen.getByText('The hero wakes.')).toBeTruthy();
  });

  it('shows the stale badge when the script is stale', async () => {
    getWritersRoomSyncedReview.mockResolvedValue(payload({
      script: { ...payload().script, stale: true },
    }));
    render(<SyncedReview work={work} />);
    expect(await screen.findByText(/Script is stale/)).toBeTruthy();
  });

  it('renders an empty state when the draft has no prose segments', async () => {
    getWritersRoomSyncedReview.mockResolvedValue(payload({
      prose: { segments: [] },
      script: { ...payload().script, available: false, scenes: [] },
    }));
    render(<SyncedReview work={work} />);
    expect(await screen.findByText(/Nothing to review yet/)).toBeTruthy();
  });

  it('prompts to run Adapt when no script is available', async () => {
    getWritersRoomSyncedReview.mockResolvedValue(payload({
      script: { available: false, status: null, stale: false, scenes: [], error: null },
    }));
    render(<SyncedReview work={work} />);
    expect(await screen.findByText(/run .*Adapt/i)).toBeTruthy();
  });
});
