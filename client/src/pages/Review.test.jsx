import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

// A CoS action body is arbitrary agent-authored markdown — thousands of words,
// its own heading outline, and raw technical payloads. This is the shape that
// made the queue unscannable (issue #3282).
const LONG_BODY = [
  '## Task Prompt',
  '',
  'Investigate the **failing** request and file a follow-up.',
  '',
  '- url: https://example.com/a_b_c/d',
  '- user-agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ExampleBrowser/1.0',
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

// A body short enough to fit the clamp, but whose flattened preview is still
// lossy — the link survives only in the markdown.
const SHORT_ITEM = {
  id: 'item-2',
  type: 'todo',
  status: 'pending',
  title: 'Read the scan report',
  description: 'See the [scan report](/data/reports/x.html) for details.',
  createdAt: '2026-08-01T11:00:00.000Z',
  metadata: {}
};

const COMPLETED_ITEM = {
  ...ITEM,
  id: 'item-3',
  status: 'completed',
  title: 'Completed review item',
  description: 'Already completed.'
};

const CREATED_PENDING_ITEM = {
  ...ITEM,
  id: 'item-4',
  title: 'New pending review item',
  description: 'Created after the completed view loaded.'
};

vi.mock('../services/api', () => ({
  getReviewItems: vi.fn(() => Promise.resolve([ITEM, SHORT_ITEM, COMPLETED_ITEM])),
  getReviewCounts: vi.fn(),
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

vi.mock('react-router', () => ({
  useNavigate: () => vi.fn()
}));

import Review from './Review';
import * as api from '../services/api';
import socket from '../services/socket';

const SUMMARY_COUNTS = { total: 8, alert: 3, todo: 1, briefing: 0, cos: 4 };

const summaryValue = (label) => {
  const labelNode = screen.getAllByText(label, { exact: true })
    .find(node => node.matches('span.text-xs'));
  return labelNode?.parentElement?.querySelector('span.text-sm')?.textContent;
};

// jsdom reports 0 for scrollHeight/clientHeight, so nothing measures as
// overflowing unless we force it.
const forceOverflow = () =>
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(500);

afterEach(() => vi.restoreAllMocks());

beforeEach(() => {
  vi.clearAllMocks();
  api.getReviewCounts.mockResolvedValue(SUMMARY_COUNTS);
});

const actionQueueBody = () => document.getElementById(`review-item-body-action-queue-${ITEM.id}`);

// Wait for the toggle that controls one specific element. `findAllByRole`
// alone is not enough: a forceToggle card renders its toggle on the first
// paint, so the query resolves before the overflow-measuring passive effects
// that reveal the other cards' toggles have flushed.
const findToggleFor = async (controlsId) => {
  let toggle;
  await waitFor(() => {
    toggle = screen.getAllByRole('button', { name: /Show more/ })
      .find(b => b.getAttribute('aria-controls') === controlsId);
    expect(toggle).toBeTruthy();
  });
  return toggle;
};

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
    // Technical payloads survive the flatten byte-for-byte — a preview that
    // rewrites `10_15_7` to `10157` is worse than one that shows a marker.
    expect(body.textContent).toContain('Mac OS X 10_15_7');
    expect(body.textContent).toContain('https://example.com/a_b_c/d');
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

    const toggle = await findToggleFor(`review-item-body-action-queue-${ITEM.id}`);
    fireEvent.click(toggle);

    expect(screen.getByRole('heading', { name: 'Task Prompt' })).toBeInTheDocument();
    expect(actionQueueBody()).toHaveClass('max-h-80', 'overflow-y-auto');
  });

  it('still offers Show more when a short body loses markup to the flatten', async () => {
    // No forced overflow: this body fits the 3-line clamp. Without the lossy
    // check the link would be stranded as inert text with no way to reach it.
    render(<Review />);
    const shortBodyId = `review-item-body-action-queue-${SHORT_ITEM.id}`;
    await waitFor(() => expect(document.getElementById(shortBodyId)).toBeTruthy());

    expect(document.getElementById(shortBodyId).textContent).toBe('See the scan report for details.');
    expect(screen.queryByRole('link', { name: 'scan report' })).not.toBeInTheDocument();

    const toggle = await findToggleFor(shortBodyId);
    fireEvent.click(toggle);
    expect(screen.getAllByRole('link', { name: 'scan report' }).length).toBeGreaterThan(0);
  });

  it('gives a clamped title a real disclosure rather than a hover-only tooltip', async () => {
    // `title` never fires on touch, and the issue measures this page at 375px
    // wide — a two-line-clamped title needs a control, not a tooltip.
    forceOverflow();
    render(<Review />);
    const titleId = `review-item-title-action-queue-${ITEM.id}`;
    await waitFor(() => expect(document.getElementById(titleId)).toBeTruthy());

    expect(document.getElementById(titleId)).toHaveClass('line-clamp-2');
    expect(await findToggleFor(titleId)).toBeTruthy();
  });

  it('scopes the body id per placement so the duplicate card is not an id collision', async () => {
    render(<Review />);
    await waitFor(() => expect(actionQueueBody()).toBeTruthy());

    // The same actionable item renders twice: Action Queue + its Alerts section.
    expect(document.getElementById(`review-item-body-section-alert-${ITEM.id}`)).toBeTruthy();
    expect(document.querySelectorAll(`[id="review-item-body-action-queue-${ITEM.id}"]`)).toHaveLength(1);
  });
});

describe('Review Hub bulk status updates (#6853)', () => {
  it('applies a review:items:bulk-updated event to every affected item in one update', async () => {
    render(<Review />);
    await waitFor(() => expect(actionQueueBody()).toBeTruthy());
    await waitFor(() => expect(document.getElementById(`review-item-body-action-queue-${SHORT_ITEM.id}`)).toBeTruthy());

    const handler = socket.on.mock.calls.find(([name]) => name === 'review:items:bulk-updated')?.[1];
    expect(handler).toBeTypeOf('function');

    act(() => {
      handler({ ids: [ITEM.id, SHORT_ITEM.id], status: 'dismissed', updatedAt: new Date().toISOString() });
    });

    // Both items are no longer pending, so — in the same render — both drop
    // out of the Action Queue, which is built from pendingItems.
    await waitFor(() => {
      expect(actionQueueBody()).toBeFalsy();
      expect(document.getElementById(`review-item-body-action-queue-${SHORT_ITEM.id}`)).toBeFalsy();
      expect(screen.queryByText(ITEM.title)).not.toBeInTheDocument();
      expect(screen.queryByText(SHORT_ITEM.title)).not.toBeInTheDocument();
    });
  });

  it('subscribes to and unsubscribes from review:items:bulk-updated', async () => {
    const { unmount } = render(<Review />);
    await waitFor(() => expect(actionQueueBody()).toBeTruthy());

    expect(socket.on.mock.calls.some(([name]) => name === 'review:items:bulk-updated')).toBe(true);

    unmount();
    expect(socket.off.mock.calls.some(([name]) => name === 'review:items:bulk-updated')).toBe(true);
  });
});

describe('Review Hub status-filtered socket items (#6925)', () => {
  it('removes individually updated items from the active status list', async () => {
    render(<Review />);
    await waitFor(() => expect(screen.getAllByText(ITEM.title).length).toBeGreaterThan(0));

    const handler = [...socket.on.mock.calls]
      .reverse()
      .find(([name]) => name === 'review:item:updated')?.[1];
    expect(handler).toBeTypeOf('function');

    act(() => {
      handler({ ...ITEM, status: 'completed' });
    });

    await waitFor(() => {
      expect(screen.queryByText(ITEM.title)).not.toBeInTheDocument();
      expect(screen.queryByText(COMPLETED_ITEM.title)).not.toBeInTheDocument();
    });
  });

  it('keeps socket-created pending items out of the completed view', async () => {
    render(<Review />);
    const filterSelect = await screen.findByLabelText('Filter review items by status');
    fireEvent.change(filterSelect, { target: { value: 'completed' } });

    await waitFor(() => expect(screen.getByText(COMPLETED_ITEM.title)).toBeInTheDocument());

    const handler = [...socket.on.mock.calls]
      .reverse()
      .find(([name]) => name === 'review:item:created')?.[1];
    expect(handler).toBeTypeOf('function');

    act(() => {
      handler(CREATED_PENDING_ITEM);
    });

    await waitFor(() => {
      expect(screen.getByText(COMPLETED_ITEM.title)).toBeInTheDocument();
      expect(document.getElementById(`review-item-title-section-alert-${CREATED_PENDING_ITEM.id}`)).not.toBeInTheDocument();
    });
  });
});

describe('Review Hub triage summary (#6926)', () => {
  it('keeps global pending counts when the list filter changes', async () => {
    render(<Review />);
    await waitFor(() => expect(summaryValue('Pending')).toBe('8'));

    fireEvent.change(screen.getByRole('combobox', { name: 'Filter review items by status' }), {
      target: { value: 'completed' }
    });
    await waitFor(() => expect(api.getReviewItems).toHaveBeenLastCalledWith({ status: 'completed' }));

    expect(summaryValue('Pending')).toBe('8');
    expect(summaryValue('Alerts')).toBe('3');
    expect(summaryValue('CoS')).toBe('4');
    expect(summaryValue('Todos')).toBe('1');
  });

  it('refreshes global pending counts when a review item changes', async () => {
    const updatedCounts = { total: 7, alert: 2, todo: 1, briefing: 0, cos: 4 };
    api.getReviewCounts
      .mockReset()
      .mockResolvedValueOnce(SUMMARY_COUNTS)
      .mockResolvedValueOnce(updatedCounts);

    render(<Review />);
    await waitFor(() => expect(summaryValue('Pending')).toBe('8'));

    const handler = socket.on.mock.calls.find(([name]) => name === 'review:item:updated')?.[1];
    expect(handler).toBeTypeOf('function');

    await act(async () => {
      handler({ ...ITEM, status: 'completed' });
      await Promise.resolve();
    });

    await waitFor(() => expect(summaryValue('Pending')).toBe('7'));
    expect(summaryValue('Alerts')).toBe('2');
    expect(api.getReviewCounts).toHaveBeenCalledTimes(2);
  });
});
