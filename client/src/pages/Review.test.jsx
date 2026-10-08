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

const FEEDBACK_ITEM = {
  id: 'feedback:agent-example',
  source: 'feedback',
  sourceRef: 'agent-example',
  sourceLabel: 'CoS run feedback',
  title: 'Rate completed CoS run',
  summary: 'Review an example change',
  timestamp: '2026-08-01T12:00:00.000Z',
  drillTo: '/cos/agents/agent-example?feedback=needs-feedback',
  operations: [{
    id: 'rate',
    label: 'Rate',
    available: true,
    input: { type: 'rating', required: true, options: ['positive', 'negative', 'neutral'] },
  }],
};

const TRIAGE_RECOMMENDATION = {
  id: 'ask:conversation-example',
  source: 'ask',
  sourceLabel: 'Ask answers',
  title: 'Optional answer ready',
  summary: 'A recommendation to triage',
  triageOperations: [
    { id: 'snooze', label: 'Snooze', available: true },
    { id: 'dismiss', label: 'Dismiss', available: true },
  ],
};

vi.mock('../services/api', () => ({
  getReviewItems: vi.fn(() => Promise.resolve([ITEM, SHORT_ITEM, COMPLETED_ITEM])),
  addCosTask: vi.fn(() => Promise.resolve({ id: 'task-1' })),
  getReviewCounts: vi.fn(),
  getReviewBriefing: vi.fn(() => Promise.resolve(null)),
  getReviewQueue: vi.fn(() => Promise.resolve({ items: [], sources: {}, partial: false })),
  createThread: vi.fn(() => Promise.resolve({ id: 'thread-1', title: 'New action' })),
  getThread: vi.fn(() => Promise.resolve({ id: 'thread-1', title: 'New action', status: 'open' })),
  updateThread: vi.fn(() => Promise.resolve({ id: 'thread-1', title: 'Updated action', status: 'open' })),
  completeReviewItem: vi.fn(() => Promise.resolve({})),
  dismissReviewItem: vi.fn(() => Promise.resolve({})),
  deleteReviewItem: vi.fn(() => Promise.resolve({})),
  updateReviewItem: vi.fn(() => Promise.resolve({})),
  bulkUpdateReviewStatus: vi.fn(() => Promise.resolve({})),
  resolveReviewQueueItem: vi.fn(() => Promise.resolve({})),
  triageReviewQueueItem: vi.fn(() => Promise.resolve({})),
  promoteAskReviewQueueItem: vi.fn(() => Promise.resolve({})),
  getCosAgent: vi.fn(),
  submitCosAgentFeedback: vi.fn(),
  normalizeBrainScanReportPath: vi.fn((p) => p)
}));

vi.mock('../services/socket', () => ({
  default: { on: vi.fn(), off: vi.fn(), emit: vi.fn() }
}));

const routerState = vi.hoisted(() => ({
  navigate: vi.fn(),
  setSearchParams: vi.fn(),
  actionId: undefined,
  searchParams: new URLSearchParams(),
}));

vi.mock('react-router', () => ({
  Link: ({ children, to }) => <a href={to}>{children}</a>,
  useNavigate: () => routerState.navigate,
  useParams: () => ({ actionId: routerState.actionId }),
  useSearchParams: () => [routerState.searchParams, routerState.setSearchParams]
}));

import Review from './Review';
import * as api from '../services/api';
import socket from '../services/socket';
import { __resetActionQueue } from '../hooks/useActionQueue';

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
  __resetActionQueue();
  vi.clearAllMocks();
  routerState.actionId = undefined;
  routerState.searchParams = new URLSearchParams();
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

    // Source-owned alerts cannot be silently accepted or deleted. Dismissal
    // remains available as the explicit triage action.
    expect(screen.queryByTitle('Accept')).not.toBeInTheDocument();
    expect(screen.getAllByTitle('Reject').length).toBeGreaterThan(0);
    expect(screen.getAllByTitle('Delete')).toHaveLength(2);
  });

  it('queues an app-scoped investigation without resolving the alert', async () => {
    const investigation = { app: 'example-app', description: 'Fix process failure', prompt: 'Inspect example-worker logs and verify recovery.' };
    api.getReviewQueue.mockResolvedValueOnce({ partial: false, sources: {}, items: [{
      id: 'health:process_errored:7', source: 'health', sourceLabel: 'Health anomalies',
      title: 'Errored process: example-worker', investigation,
      operations: [{ id: 'complete', label: 'Mark resolved', available: true }],
    }] });
    render(<Review />);
    fireEvent.click(await screen.findByRole('button', { name: 'Queue agent to investigate' }));
    await waitFor(() => expect(api.addCosTask).toHaveBeenCalledWith({ ...investigation, isInvestigation: true }, { silent: true }));
    expect(await screen.findByRole('button', { name: 'Agent queued' })).toBeDisabled();
    expect(screen.getByText('Errored process: example-worker')).toBeInTheDocument();
    expect(api.resolveReviewQueueItem).not.toHaveBeenCalled();
  });

  it('lets a corrected health issue be resolved from its card', async () => {
    const item = {
      id: 'health:success_drop:example', source: 'health', sourceLabel: 'Health anomalies',
      title: 'Low success rate: example', summary: '3% success across the last 30 runs',
      operations: [{ id: 'complete', label: 'Mark resolved', available: true }],
    };
    api.getReviewQueue.mockResolvedValueOnce({ partial: false, items: [item], sources: {} });
    render(<Review />);
    fireEvent.click(await screen.findByRole('button', { name: 'Mark resolved' }));
    await waitFor(() => expect(api.resolveReviewQueueItem).toHaveBeenCalledWith(item.id, { operation: 'complete' }));
    await waitFor(() => expect(screen.queryByText(item.title)).not.toBeInTheDocument());
  });

  it('forwards an explicit source operation for source-owned queue actions', async () => {
    api.getReviewQueue.mockResolvedValueOnce({
      partial: false,
      items: [{
        id: 'memory:memory-1',
        source: 'review',
        sourceLabel: 'Stored review obligations',
        title: 'Memory approval',
        summary: 'Approve a memory',
        timestamp: '2026-09-20T00:00:00.000Z',
        drillTo: '/cos/memory',
        operations: [
          { id: 'approve', label: 'Approve', available: true },
          { id: 'reject', label: 'Reject', available: true },
        ],
      }],
      sources: {},
    });

    render(<Review />);
    const approve = await screen.findByRole('button', { name: 'Approve' });
    fireEvent.click(approve);

    await waitFor(() => expect(api.resolveReviewQueueItem).toHaveBeenCalledWith(
      'memory:memory-1',
      { operation: 'approve' },
    ));
  });

  it('shows linked app and blocked task context with a direct PR link', async () => {
    const item = {
      id: 'threads:pr-follow-up',
      source: 'threads',
      sourceLabel: 'Brain commitments',
      title: 'PR follow-up needs attention',
      summary: 'Fix the merge follow-up or merge the PR manually. Still blocked: Repository path is unavailable.',
      timestamp: '2026-09-24T20:00:00.000Z',
      drillTo: '/brain/threads?thread=pr-follow-up',
      operations: [{ id: 'complete', label: 'Complete', available: true }],
      meta: {
        localStatus: 'open',
        taskStatus: 'blocked',
        blockedCategory: 'app-unresolved',
        appLabel: 'Example Repo',
        reviewLoopPRUrl: 'https://github.com/example-org/example-repo/pull/9',
      },
    };
    api.getReviewQueue.mockResolvedValueOnce({ items: [item], sources: {}, partial: false });

    render(<Review />);

    expect(await screen.findByText(item.summary)).toBeInTheDocument();
    expect(screen.getByText('App: Example Repo')).toBeInTheDocument();
    expect(screen.getByText('Task: blocked')).toBeInTheDocument();
    expect(screen.getByText('Block: app-unresolved')).toBeInTheDocument();
    const openPr = screen.getByRole('link', { name: 'Open pull request' });
    expect(openPr).toHaveAttribute('href', item.meta.reviewLoopPRUrl);
    expect(openPr).toHaveAttribute('target', '_blank');
    expect(openPr).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('shows durable snooze and recommendation-dismiss controls', async () => {
    api.getReviewQueue.mockResolvedValueOnce({ items: [TRIAGE_RECOMMENDATION], sources: {}, partial: false });

    render(<Review />);
    const snooze = await screen.findByRole('combobox', { name: 'Snooze Optional answer ready' });
    expect(screen.getByRole('button', { name: 'Dismiss this recommendation' })).toBeInTheDocument();

    fireEvent.change(snooze, { target: { value: String(60 * 60 * 1000) } });

    await waitFor(() => expect(api.triageReviewQueueItem).toHaveBeenCalledWith(
      TRIAGE_RECOMMENDATION.id,
      { operation: 'snooze', snoozedUntil: expect.any(String) },
    ));
  });

  it('persists dismissal only for an optional recommendation', async () => {
    api.getReviewQueue.mockResolvedValueOnce({ items: [TRIAGE_RECOMMENDATION], sources: {}, partial: false });

    render(<Review />);
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss this recommendation' }));

    await waitFor(() => expect(api.triageReviewQueueItem).toHaveBeenCalledWith(
      TRIAGE_RECOMMENDATION.id,
      { operation: 'dismiss' },
    ));
  });

  it('renders the agent run card inline in the queue and submits feedback without opening the drawer', async () => {
    api.getReviewQueue.mockResolvedValueOnce({ items: [FEEDBACK_ITEM], sources: {}, partial: false });
    api.getCosAgent.mockResolvedValue({
      id: 'agent-example', status: 'completed', taskId: 'user-example',
      startedAt: '2026-08-01T11:00:00Z', completedAt: '2026-08-01T12:00:00Z',
      metadata: { taskDescription: 'Full example task context', taskType: 'user' },
      output: [{ line: 'Example diagnostic output', timestamp: '2026-08-01T12:00:00Z' }],
    });
    api.submitCosAgentFeedback.mockResolvedValue({ success: true, agent: { id: 'agent-example', feedback: { rating: 'positive' } } });
    render(<Review />);
    expect(await screen.findByText('Full example task context')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Review run and give feedback' })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Mark as helpful' }));
    await waitFor(() => expect(api.submitCosAgentFeedback).toHaveBeenCalledWith('agent-example', { rating: 'positive', comment: undefined }, { silent: true }));
    expect(routerState.navigate).not.toHaveBeenCalled();
  });

  it.each([['positive', 'Mark as helpful'], ['negative', 'Mark as not helpful']])('reviews the completed run and submits %s feedback using the shared agent card', async (rating, label) => {
    routerState.actionId = FEEDBACK_ITEM.id;
    api.getReviewQueue.mockResolvedValueOnce({ items: [FEEDBACK_ITEM], sources: {}, partial: false });
    api.getCosAgent.mockResolvedValue({
      id: 'agent-example', status: 'completed', taskId: 'user-example',
      startedAt: '2026-08-01T11:00:00Z', completedAt: '2026-08-01T12:00:00Z',
      metadata: { taskDescription: 'Full example task context', taskType: 'user' },
      output: [{ line: 'Example diagnostic output', timestamp: '2026-08-01T12:00:00Z' }],
    });
    api.submitCosAgentFeedback.mockResolvedValue({ success: true, agent: { id: 'agent-example', feedback: { rating } } });
    render(<Review />);
    expect(await screen.findByText('Full example task context')).toBeInTheDocument();
    expect(await screen.findByText('No completion summary was saved. The runner transcript is available separately.')).toBeInTheDocument();
    expect(screen.queryByText('Example diagnostic output')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show full transcript' }));
    expect(await screen.findByText('Example diagnostic output')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: label }));
    await waitFor(() => expect(api.submitCosAgentFeedback).toHaveBeenCalledWith('agent-example', { rating, comment: undefined }, { silent: true }));
    await waitFor(() => expect(routerState.navigate).toHaveBeenCalledWith('/review?view=today', { replace: true }));
    expect(api.resolveReviewQueueItem).not.toHaveBeenCalled();
  });

  it('keeps failed run loads retryable without exposing a separate rating form', async () => {
    routerState.actionId = FEEDBACK_ITEM.id;
    api.getReviewQueue.mockResolvedValueOnce({ items: [FEEDBACK_ITEM], sources: {}, partial: false });
    api.getCosAgent.mockRejectedValueOnce(new Error('Unavailable'));
    render(<Review />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load this agent run');
    expect(screen.queryByRole('button', { name: 'Mark as helpful' })).not.toBeInTheDocument();
    api.getCosAgent.mockResolvedValue({ id: 'agent-example', status: 'completed', metadata: { taskType: 'user' } });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: 'Mark as helpful' })).toBeInTheDocument();
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

describe('Actions commitments workspace (#7739)', () => {
  it('keeps stored-item filters and bulk actions out of the canonical queue header', async () => {
    const canonicalItem = {
      id: 'health:required-example', source: 'health', sourceLabel: 'Health anomalies',
      title: 'Required health action', summary: 'Review this action',
      operations: [{ id: 'complete', label: 'Mark resolved', available: true }],
    };
    api.getReviewQueue.mockResolvedValueOnce({ partial: false, sources: {}, items: [canonicalItem] });

    render(<Review />);

    expect(await screen.findByText(canonicalItem.title)).toBeInTheDocument();
    expect(screen.queryByLabelText('Filter review items by status')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Complete All' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dismiss All' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Stored review items' })).not.toBeInTheDocument();
  });

  it('keeps stored-item controls inside the named legacy fallback section', async () => {
    render(<Review />);

    const heading = await screen.findByRole('heading', { name: 'Stored review items' });
    const section = heading.closest('section');
    expect(section).toContainElement(screen.getByLabelText('Filter review items by status'));
    expect(section).toContainElement(screen.getByRole('button', { name: 'Complete All' }));
    expect(section).toContainElement(screen.getByRole('button', { name: 'Dismiss All' }));
  });

  it('hides stored-item controls when the canonical queue is degraded or partial', async () => {
    const degradedQueue = {
      partial: true,
      sources: { health: { label: 'Health anomalies', error: 'source unavailable' } },
      items: [],
    };
    api.getReviewQueue.mockResolvedValueOnce(degradedQueue);

    render(<Review />);

    expect(await screen.findByText(/This bounded view may omit additional actions/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Filter review items by status')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Complete All' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dismiss All' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Stored review items' })).not.toBeInTheDocument();
  });

  it('renders the canonical Actions workspace while stored review items are pending', async () => {
    let resolveLegacyItems;
    api.getReviewItems.mockReturnValueOnce(new Promise((resolve) => { resolveLegacyItems = resolve; }));
    api.getReviewQueue.mockResolvedValueOnce({
      partial: false,
      sources: {},
      items: [],
    });

    render(<Review />);
    const input = await screen.findByLabelText('Quick add action');
    expect(input).toBeEnabled();
    expect(screen.getByRole('status')).toHaveTextContent('Loading stored review items');

    await act(async () => resolveLegacyItems([ITEM]));

    expect(await screen.findByLabelText('Quick add action')).toBe(input);
    expect(screen.getAllByText(ITEM.title)).toHaveLength(2);
  });

  it('shows and retries a canonical queue failure while stored review items are pending', async () => {
    api.getReviewItems.mockReturnValueOnce(new Promise(() => {}));
    api.getReviewQueue.mockRejectedValueOnce(new Error('synthetic queue failure'));

    render(<Review />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Actions unavailable');
    expect(screen.getByLabelText('Quick add action')).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(api.getReviewQueue).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Actions unavailable')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Quick add action')).toBeEnabled();
  });

  it('shows a local retry when stored review items fail to load', async () => {
    api.getReviewItems
      .mockRejectedValueOnce(new Error('synthetic legacy read failure'))
      .mockResolvedValueOnce([ITEM]);

    render(<Review />);
    const retry = await screen.findByRole('button', { name: 'Retry' });
    expect(screen.getByRole('alert')).toHaveTextContent('Stored review items are unavailable');

    fireEvent.click(retry);

    expect(await screen.findAllByText(ITEM.title)).toHaveLength(2);
    expect(screen.queryByText('Stored review items are unavailable')).not.toBeInTheDocument();
  });

  it('uses Brain threads for quick-add instead of the legacy todo endpoint', async () => {
    render(<Review />);
    const input = await screen.findByLabelText('Quick add action');
    fireEvent.change(input, { target: { value: 'Track the example follow-up' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(api.createThread).toHaveBeenCalledWith(
      { title: 'Track the example follow-up' },
      { silent: true },
    ));
  });

  it('opens a newly added thread in a view where an open commitment is visible', async () => {
    routerState.searchParams = new URLSearchParams('view=waiting');
    render(<Review />);
    const input = await screen.findByLabelText('Quick add action');
    fireEvent.change(input, { target: { value: 'Track the example follow-up' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(routerState.navigate).toHaveBeenCalledWith(
      '/review/threads%3Athread-1?view=today',
    ));
  });
});

describe('Review status request ownership (#9447)', () => {
  const dismissedItem = { ...SHORT_ITEM, status: 'dismissed', title: 'Example dismissed action' };

  it('keeps the latest selected status results when an older success arrives last', async () => {
    let resolveCompleted;
    api.getReviewItems
      .mockResolvedValueOnce([])
      .mockReturnValueOnce(new Promise(resolve => { resolveCompleted = resolve; }))
      .mockResolvedValueOnce([dismissedItem]);

    render(<Review />);
    await waitFor(() => expect(screen.queryByText('Loading stored review items…')).not.toBeInTheDocument());
    const selector = screen.getByRole('combobox', { name: 'Filter review items by status' });
    fireEvent.change(selector, { target: { value: 'completed' } });
    fireEvent.change(selector, { target: { value: 'dismissed' } });
    expect(await screen.findByText(dismissedItem.title)).toBeInTheDocument();

    await act(async () => resolveCompleted([COMPLETED_ITEM]));

    expect(selector).toHaveValue('dismissed');
    expect(screen.getByText(dismissedItem.title)).toBeInTheDocument();
    expect(screen.queryByText('No review items in this view')).not.toBeInTheDocument();
  });

  it.each(['success', 'failure'])('ignores an obsolete %s while the selected status is still loading', async (outcome) => {
    let resolveCompleted;
    let rejectCompleted;
    let resolveDismissed;
    api.getReviewItems
      .mockResolvedValueOnce([])
      .mockReturnValueOnce(new Promise((resolve, reject) => { resolveCompleted = resolve; rejectCompleted = reject; }))
      .mockReturnValueOnce(new Promise(resolve => { resolveDismissed = resolve; }));

    render(<Review />);
    await waitFor(() => expect(screen.queryByText('Loading stored review items…')).not.toBeInTheDocument());
    const selector = screen.getByRole('combobox', { name: 'Filter review items by status' });
    fireEvent.change(selector, { target: { value: 'completed' } });
    fireEvent.change(selector, { target: { value: 'dismissed' } });

    await act(async () => {
      if (outcome === 'success') resolveCompleted([COMPLETED_ITEM]);
      else rejectCompleted(new Error('synthetic obsolete failure'));
    });

    expect(screen.getByRole('status')).toHaveTextContent('Loading stored review items');
    expect(screen.queryByText(/Stored review items are unavailable/)).not.toBeInTheDocument();
    await act(async () => resolveDismissed([dismissedItem]));
    expect(screen.getByText(dismissedItem.title)).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

describe('Review Hub bulk status updates (#6853)', () => {
  it('applies a review:items:bulk-updated event to every affected item in one update', async () => {
    render(<Review />);
    await waitFor(() => expect(actionQueueBody()).toBeTruthy());
    await waitFor(() => expect(document.getElementById(`review-item-body-action-queue-${SHORT_ITEM.id}`)).toBeTruthy());

    const handler = socket.on.mock.calls.findLast(([name]) => name === 'review:items:bulk-updated')?.[1];
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

    const handler = socket.on.mock.calls
      .findLast(([name]) => name === 'review:item:updated')?.[1];
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

    const handler = socket.on.mock.calls
      .findLast(([name]) => name === 'review:item:created')?.[1];
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
    await waitFor(() => expect(api.getReviewItems).toHaveBeenLastCalledWith({ status: 'completed' }, { silent: true }));

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

    const handler = socket.on.mock.calls.findLast(([name]) => name === 'review:item:updated')?.[1];
    expect(handler).toBeTypeOf('function');

    await act(async () => {
      handler({ ...ITEM, status: 'completed' });
      await Promise.resolve();
    });

    await waitFor(() => expect(summaryValue('Pending')).toBe('7'));
    expect(summaryValue('Alerts')).toBe('2');
    expect(api.getReviewCounts).toHaveBeenCalledTimes(2);
  });

  it('keeps the newest count response when refreshes resolve out of order', async () => {
    let resolveInitial;
    let resolveRefresh;
    api.getReviewCounts
      .mockReset()
      .mockImplementationOnce(() => new Promise(resolve => { resolveInitial = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveRefresh = resolve; }));

    render(<Review />);
    await waitFor(() => expect(resolveInitial).toBeTypeOf('function'));

    const handler = socket.on.mock.calls.findLast(([name]) => name === 'review:item:updated')?.[1];
    expect(handler).toBeTypeOf('function');
    act(() => handler({ ...ITEM, status: 'completed' }));
    await waitFor(() => expect(resolveRefresh).toBeTypeOf('function'));

    await act(async () => {
      resolveRefresh({ total: 7, alert: 2, todo: 1, briefing: 0, cos: 4 });
      await Promise.resolve();
    });
    expect(summaryValue('Pending')).toBe('7');

    await act(async () => {
      resolveInitial(SUMMARY_COUNTS);
      await Promise.resolve();
    });
    expect(summaryValue('Pending')).toBe('7');
    expect(summaryValue('Alerts')).toBe('2');
  });
});

describe('Review Hub Daily Briefing fullscreen dialog (#9121)', () => {
  it('acts as a focus-trapped, Escape-dismissable dialog and returns focus to the toggle', async () => {
    api.getReviewBriefing.mockResolvedValueOnce({ source: 'test', generatedAt: '2026-09-29T00:00:00Z', content: 'Briefing body' });
    render(<Review />);

    const toggle = await screen.findByRole('button', { name: 'Fullscreen' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    toggle.focus();
    fireEvent.click(toggle);

    const dialog = await screen.findByRole('dialog', { name: 'Daily Briefing' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    // Tab from the last (only) focusable wraps inside instead of escaping to the page behind.
    const exit = screen.getByRole('button', { name: 'Exit fullscreen' });
    exit.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(dialog.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Fullscreen' })).toHaveFocus();
  });
});

describe('Actions view tabs wiring', () => {
  it.each(['today', 'waiting'])('points the selected %s tab at a tabpanel it labels', async (view) => {
    routerState.searchParams = new URLSearchParams(`view=${view}`);
    render(<Review />);
    const tab = await screen.findByRole('tab', { selected: true });
    const panel = document.getElementById(tab.getAttribute('aria-controls'));
    expect(panel).toBeTruthy();
    expect(panel.getAttribute('role')).toBe('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe(tab.id);
    expect(tab.id).toBe(`tab-${view}`);
  });
});
