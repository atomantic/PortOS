import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../../../services/api', () => ({
  getBrainLinks: vi.fn(),
  getBrainLink: vi.fn(),
  getBrainBuckets: vi.fn(),
  createBrainLink: vi.fn(),
  updateBrainLink: vi.fn(),
  deleteBrainLink: vi.fn(),
  reorderBrainLinks: vi.fn(),
  cloneBrainLink: vi.fn(),
  pullBrainLink: vi.fn(),
  scanBrainLink: vi.fn(),
  openBrainLinkFolder: vi.fn(),
  brainScanReportPath: vi.fn(() => '/report'),
  studyBrainLink: vi.fn(),
  // Read by the shared repo-study form (useRepoStudyConfig).
  getApps: vi.fn(() => Promise.resolve([])),
  getProviders: vi.fn(() => Promise.resolve({ providers: [] })),
}));

vi.mock('../../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

// Counting stub: the board is the most expensive consumer of the `links`
// array, so its render count is the direct measure of "the poll does not
// replace the array on every tick".
let bucketBoardRenders = 0;
vi.mock('../links/BucketBoard', () => ({
  default: () => {
    bucketBoardRenders += 1;
    return <div data-testid="bucket-board" />;
  },
}));

import { createBrainLink, getBrainLink, getBrainLinks, getBrainBuckets, studyBrainLink } from '../../../services/api';
import toast from '../../ui/Toast';
import LinksTab from './LinksTab';

const link = (id, cloneStatus, overrides = {}) => ({
  id,
  url: `https://github.com/example/${id}`,
  title: `repo-${id}`,
  linkType: 'repo',
  tags: [],
  isRepo: true,
  cloneStatus,
  bucketId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

// Mount and settle the initial `getBrainLinks` + `getBrainBuckets` round-trip.
async function renderTab() {
  const result = render(<MemoryRouter><LinksTab /></MemoryRouter>);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return result;
}

const tick = (ms = 3000) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
  vi.clearAllMocks();
  bucketBoardRenders = 0;
  vi.useFakeTimers();
  getBrainBuckets.mockResolvedValue({ buckets: [] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('LinksTab clone-status polling', () => {
  it('polls only the in-flight ids, never the whole collection again', async () => {
    getBrainLinks.mockResolvedValue({ links: [link('a', 'cloning'), link('b', 'cloned')] });
    getBrainLink.mockResolvedValue(link('a', 'cloning'));
    await renderTab();

    expect(getBrainLinks).toHaveBeenCalledTimes(1);
    expect(getBrainLink).not.toHaveBeenCalled();

    await tick();
    expect(getBrainLink).toHaveBeenCalledTimes(1);
    expect(getBrainLink).toHaveBeenCalledWith('a', { silent: true });

    await tick();
    expect(getBrainLink).toHaveBeenCalledTimes(2);
    expect(getBrainLink.mock.calls.every(([id]) => id === 'a')).toBe(true);
    // The whole-collection fetch happened once, at mount, and never again.
    expect(getBrainLinks).toHaveBeenCalledTimes(1);
  });

  it('polls a pending clone too, and every in-flight id in one tick', async () => {
    getBrainLinks.mockResolvedValue({
      links: [link('a', 'cloning'), link('b', 'pending'), link('c', 'none')],
    });
    getBrainLink.mockImplementation(async (id) => link(id, 'cloning'));
    await renderTab();

    await tick();
    expect(getBrainLink.mock.calls.map(([id]) => id).sort()).toEqual(['a', 'b']);
  });

  it('patches the fresh status in and stops polling once nothing is in flight', async () => {
    getBrainLinks.mockResolvedValue({ links: [link('a', 'cloning'), link('b', 'cloned')] });
    getBrainLink.mockResolvedValue(link('a', 'cloned'));
    await renderTab();

    expect(screen.getByText('Cloning...')).toBeTruthy();

    await tick();
    expect(screen.queryByText('Cloning...')).toBeNull();
    expect(screen.getAllByText('Cloned')).toHaveLength(2);

    const callsAfterCompletion = getBrainLink.mock.calls.length;
    await tick(9000);
    expect(getBrainLink).toHaveBeenCalledTimes(callsAfterCompletion);
  });

  it('leaves the other links intact when one in-flight id fails transiently', async () => {
    getBrainLinks.mockResolvedValue({ links: [link('a', 'cloning'), link('c', 'cloning')] });
    getBrainLink.mockImplementation(async (id) => {
      if (id === 'a') throw Object.assign(new Error('Server unreachable'), { status: 503 });
      return link('c', 'cloned');
    });
    await renderTab();

    await tick();
    expect(screen.getByText('Cloning...')).toBeTruthy();
    expect(screen.getByText('Cloned')).toBeTruthy();
    expect(screen.getByText('repo-a')).toBeTruthy();
    expect(screen.getByText('repo-c')).toBeTruthy();
  });

  // Without this the deleted record keeps its slot in the in-flight set and is
  // polled every 3s until the stall bound expires.
  it('drops a link deleted mid-clone and stops polling it', async () => {
    getBrainLinks.mockResolvedValue({ links: [link('a', 'cloning'), link('c', 'cloning')] });
    getBrainLink.mockImplementation(async (id) => {
      if (id === 'a') throw Object.assign(new Error('Link not found'), { status: 404 });
      return link('c', 'cloning');
    });
    await renderTab();

    await tick();
    expect(screen.queryByText('repo-a')).toBeNull();
    expect(screen.getByText('repo-c')).toBeTruthy();

    getBrainLink.mockClear();
    await tick();
    expect(getBrainLink.mock.calls.map(([id]) => id)).toEqual(['c']);
  });

  // The poll's job is the clone badge; it must not carry a pre-edit snapshot of
  // the rest of the record back over a local change.
  it('merges only the clone-progress fields, never the whole record', async () => {
    getBrainLinks.mockResolvedValue({ links: [link('a', 'cloning', { title: 'renamed-locally' })] });
    getBrainLink.mockResolvedValue(link('a', 'cloned', { title: 'repo-a', localPath: '/repos/a' }));
    await renderTab();

    await tick();
    expect(screen.getByText('Cloned')).toBeTruthy();
    // The clone's own localPath landed…
    expect(screen.getByText('repos/a')).toBeTruthy();
    // …but the stale title from the same response did not.
    expect(screen.getByText('renamed-locally')).toBeTruthy();
    expect(screen.queryByText('repo-a')).toBeNull();
  });

  it('does not re-render the list from a replaced array when a tick brings no change', async () => {
    getBrainLinks.mockResolvedValue({ links: [link('a', 'cloning')] });
    getBrainLink.mockResolvedValue(link('a', 'cloning'));
    await renderTab();

    const before = bucketBoardRenders;
    await tick(9000);
    expect(getBrainLink).toHaveBeenCalledTimes(3);
    expect(bucketBoardRenders).toBe(before);
  });

  // A server restart mid-clone strands the record at `cloning` forever, so an
  // unbounded poll would become the tab's permanent steady state.
  it('gives up on a clone stuck with no status change past the stall window', async () => {
    getBrainLinks.mockResolvedValue({ links: [link('a', 'cloning')] });
    getBrainLink.mockResolvedValue(link('a', 'cloning'));
    await renderTab();

    await tick(10 * 60 * 1000);
    const stalledAt = getBrainLink.mock.calls.length;
    expect(stalledAt).toBeGreaterThan(0);

    await tick(60 * 1000);
    expect(getBrainLink).toHaveBeenCalledTimes(stalledAt);
    // …and says so, rather than spinning on a status nothing is watching.
    expect(screen.getByText('Cloning...')).toBeTruthy();
    expect(screen.getByText('(stalled)')).toBeTruthy();
  });

  // The stall bound counts ticks, not wall-clock: useAutoRefetch pauses while
  // the tab is hidden, so a wall-clock deadline would be tripped by the resume
  // tick alone and abandon a clone that may well have finished.
  it('does not count time the tab spent hidden against the stall bound', async () => {
    getBrainLinks.mockResolvedValue({ links: [link('a', 'cloning')] });
    getBrainLink.mockResolvedValue(link('a', 'cloning'));
    await renderTab();

    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await tick(20 * 60 * 1000);
    expect(getBrainLink).not.toHaveBeenCalled();

    hidden.mockReturnValue('visible');
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(getBrainLink).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('(stalled)')).toBeNull();
    hidden.mockRestore();
  });

  it('ignores a poll response overtaken by a newer one', async () => {
    getBrainLinks.mockResolvedValue({ links: [link('a', 'cloning')] });
    // The first tick's response resolves only after the second tick's has been
    // applied — it must not patch the finished clone back to `cloning`.
    let release;
    const slow = new Promise(resolve => { release = resolve; });
    getBrainLink
      .mockImplementationOnce(async () => { await slow; return link('a', 'cloning'); })
      .mockResolvedValue(link('a', 'cloned', { localPath: '/repos/a' }));
    await renderTab();

    await tick();
    await tick();
    expect(screen.getByText('Cloned')).toBeTruthy();

    await act(async () => { release(); await Promise.resolve(); });
    expect(screen.getByText('Cloned')).toBeTruthy();
    expect(screen.queryByText('Cloning...')).toBeNull();
  });

  // The post-clone intake writes these in a second update, right after the
  // status flips — the poll has to carry them or the chips never appear.
  it('carries the post-clone intake fields through', async () => {
    getBrainLinks.mockResolvedValue({ links: [link('a', 'cloning')] });
    getBrainLink.mockResolvedValue(link('a', 'cloning', {
      malwareScan: { reportId: '11111111-1111-4111-8111-111111111111', status: 'queued' },
    }));
    await renderTab();

    await tick();
    expect(screen.getByTitle(/Malware scan queued/)).toBeTruthy();

    // …and an unchanged object on the next tick is not treated as a change.
    const renders = bucketBoardRenders;
    await tick();
    expect(bucketBoardRenders).toBe(renders);
  });

  it('restarts the stall window when a clone actually progresses', async () => {
    getBrainLinks.mockResolvedValue({ links: [link('a', 'pending')] });
    getBrainLink.mockResolvedValue(link('a', 'pending'));
    await renderTab();

    await tick(9 * 60 * 1000);
    getBrainLink.mockResolvedValue(link('a', 'cloning'));
    await tick();
    expect(screen.getByText('Cloning...')).toBeTruthy();

    // Without the reset the window would have expired 2 minutes in; the status
    // change bought a fresh 10 minutes.
    getBrainLink.mockResolvedValue(link('a', 'cloning'));
    const beforeExtra = getBrainLink.mock.calls.length;
    await tick(3 * 60 * 1000);
    expect(getBrainLink.mock.calls.length).toBeGreaterThan(beforeExtra);
  });
});

describe('LinksTab link creation form', () => {
  it('sends an optional note with a directly saved link', async () => {
    getBrainLinks.mockResolvedValue({ links: [] });
    const created = link('new', 'none', {
      url: 'https://example.com/article',
      title: 'example.com',
      isRepo: false,
    });
    createBrainLink.mockResolvedValue(created);
    await renderTab();

    fireEvent.click(screen.getByRole('button', { name: 'Add title, note & tags (optional)' }));
    fireEvent.change(screen.getByLabelText('Link URL to save'), {
      target: { value: 'https://example.com/article' },
    });
    fireEvent.change(screen.getByLabelText(/Why are you saving this/i), {
      target: { value: '  Read this later  ' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTitle('Save link'));
      await Promise.resolve();
    });

    expect(createBrainLink).toHaveBeenCalled();
    expect(createBrainLink.mock.calls[0][0]).toEqual({
      url: 'https://example.com/article',
      note: 'Read this later',
    });
  });
});

describe('LinksTab on-demand repo re-study', () => {
  const cloned = () => link('a', 'cloned', { localPath: '/repos/example/a' });

  const openStudyForm = async () => {
    getBrainLinks.mockResolvedValue({ links: [cloned()] });
    const view = await renderTab();
    await act(async () => { screen.getByRole('button', { name: /update & study/i }).click(); });
    return view;
  };

  it('sends the brief, the target app, and the pull flag', async () => {
    studyBrainLink.mockResolvedValue({ taskId: 'task-1', pulled: { ok: true }, link: cloned() });
    const { container } = await openStudyForm();

    const brief = container.querySelector('#restudy-a-study-context');
    await act(async () => {
      fireEvent.change(brief, { target: { value: 'look at its offline sync' } });
    });
    // Two buttons carry the label — the row toggle and the form's submit.
    await act(async () => { screen.getAllByRole('button', { name: /update & study/i }).at(-1).click(); });

    expect(studyBrainLink).toHaveBeenCalledWith(
      'a',
      // targetAppId is asserted explicitly: dropping it from studyPayload() would
      // silently fall the server back to PortOS rather than fail.
      { pull: true, studyContext: 'look at its offline sync', targetAppId: 'portos-default' },
      { silent: true },
    );
  });

  it('pre-fills the brief with the one the last study was given', async () => {
    getBrainLinks.mockResolvedValue({
      links: [link('a', 'cloned', {
        localPath: '/repos/example/a',
        repoStudy: { taskId: 'old', studyContext: 'the previous brief' },
      })],
    });
    const { container } = await renderTab();
    await act(async () => { screen.getByRole('button', { name: /update & study/i }).click(); });

    expect(container.querySelector('#restudy-a-study-context').value).toBe('the previous brief');
  });

  it('patches the row with the updated link so the queued chip survives a re-render', async () => {
    const queued = { ...cloned(), repoStudy: { taskId: 'task-1', queuedAt: '2026-01-02T00:00:00.000Z' } };
    studyBrainLink.mockResolvedValue({ taskId: 'task-1', pulled: { ok: true }, link: queued });
    await openStudyForm();

    await act(async () => { screen.getAllByRole('button', { name: /update & study/i }).at(-1).click(); });

    // The form closes and the row now links the queued study — from local state,
    // with no refetch.
    expect(screen.getByRole('link', { name: /repo study/i })).toBeTruthy();
    expect(getBrainLinks).toHaveBeenCalledTimes(1);
  });

  it('warns rather than claiming success when the pull failed but the study queued', async () => {
    studyBrainLink.mockResolvedValue({ taskId: 'task-1', pulled: { ok: false, error: 'diverged' }, link: cloned() });
    await openStudyForm();

    await act(async () => { screen.getAllByRole('button', { name: /update & study/i }).at(-1).click(); });

    expect(toast.warning).toHaveBeenCalledWith(expect.stringMatching(/pull failed/i));
    expect(toast.success).not.toHaveBeenCalled();
  });
});
