import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

// A CoS action body is arbitrary agent-authored markdown — thousands of words,
// its own heading outline, and raw technical payloads. This is the shape that
// made the queue unscannable (issue #3282).
const LONG_BODY = [
  '## Task Prompt',
  '',
  'Investigate the **failing** request and file a follow-up.',
  '',
  '- url: https://example.com/a',
  '- user-agent: Mozilla/5.0 (X11; Linux x86_64) ExampleBrowser/1.0',
  '',
  '### Stack',
  '',
  '```',
  'TypeError: x is not a function',
  '    at foo (/app/a.js:1:2)',
  '```'
].join('\n');

const ITEM = {
  id: 'item-1',
  type: 'alert',
  status: 'pending',
  title: 'Client error reported',
  description: LONG_BODY,
  createdAt: '2026-08-01T12:00:00.000Z',
  metadata: {}
};

vi.mock('../services/api', () => ({
  getReviewItems: vi.fn(() => Promise.resolve([ITEM])),
  getReviewBriefing: vi.fn(() => Promise.resolve(null)),
  getReviewQueue: vi.fn(() => Promise.resolve({ items: [], sources: {} })),
  createReviewTodo: vi.fn(() => Promise.resolve({})),
  completeReviewItem: vi.fn(() => Promise.resolve({})),
  dismissReviewItem: vi.fn(() => Promise.resolve({})),
  deleteReviewItem: vi.fn(() => Promise.resolve({})),
  updateReviewItem: vi.fn(() => Promise.resolve({})),
  bulkUpdateReviewStatus: vi.fn(() => Promise.resolve({})),
  resolveReviewQueueItem: vi.fn(() => Promise.resolve({})),
  promoteAskReviewQueueItem: vi.fn(() => Promise.resolve({})),
  normalizeBrainScanReportPath: vi.fn((p) => p)
}));

vi.mock('../services/socket', () => ({
  default: { on: vi.fn(), off: vi.fn(), emit: vi.fn() }
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn()
}));

import Review from './Review';

// jsdom reports 0 for scrollHeight/clientHeight, so nothing measures as
// overflowing unless we force it.
const forceOverflow = () =>
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(500);

afterEach(() => vi.restoreAllMocks());

const actionQueueBody = () => document.getElementById(`review-item-body-action-queue-${ITEM.id}`);

describe('Review Hub queue-card triage (#3282)', () => {
  it('previews the body as clamped plain text instead of full markdown', async () => {
    render(<Review />);

    const body = await waitFor(() => {
      const el = actionQueueBody();
      expect(el).toBeTruthy();
      return el;
    });

    // Three-line clamp on the element that actually carries the text — a clamp
    // on a wrapper around block-level markdown does not clamp at all.
    expect(body).toHaveClass('line-clamp-3');
    // Flattened: heading/list/fence markers stripped, words kept.
    expect(body.textContent).toContain('Task Prompt');
    expect(body.textContent).toContain('Investigate the failing request');
    expect(body.textContent).not.toContain('##');
    expect(body.textContent).not.toContain('**');
    // The foreign body contributes no headings to this page's outline.
    expect(screen.queryByRole('heading', { name: 'Task Prompt' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Stack' })).not.toBeInTheDocument();
  });

  it('keeps the per-card decisions available without expanding', async () => {
    render(<Review />);
    await waitFor(() => expect(actionQueueBody()).toBeTruthy());

    // Accept / Reject / Delete are all reachable on the collapsed card.
    expect(screen.getAllByTitle('Accept').length).toBeGreaterThan(0);
    expect(screen.getAllByTitle('Reject').length).toBeGreaterThan(0);
    expect(screen.getAllByTitle('Delete').length).toBeGreaterThan(0);
  });

  it('renders the full markdown behind Show more, height-capped', async () => {
    forceOverflow();
    render(<Review />);
    await waitFor(() => expect(actionQueueBody()).toBeTruthy());

    // findAll, not getAll: the overflow measurement lives in a passive effect,
    // which React may flush a tick after the card itself paints.
    const toggles = await screen.findAllByRole('button', { name: /Show more/ });
    const toggle = toggles.find(b => b.getAttribute('aria-controls') === `review-item-body-action-queue-${ITEM.id}`);
    expect(toggle).toBeTruthy();

    fireEvent.click(toggle);

    expect(screen.getByRole('heading', { name: 'Task Prompt' })).toBeInTheDocument();
    expect(actionQueueBody()).toHaveClass('max-h-80', 'overflow-y-auto');
  });

  it('scopes the body id per placement so the duplicate card is not an id collision', async () => {
    render(<Review />);
    await waitFor(() => expect(actionQueueBody()).toBeTruthy());

    // The same actionable item renders twice: Action Queue + its Alerts section.
    expect(document.getElementById(`review-item-body-section-alert-${ITEM.id}`)).toBeTruthy();
    expect(document.querySelectorAll(`[id="review-item-body-action-queue-${ITEM.id}"]`)).toHaveLength(1);
  });
});
