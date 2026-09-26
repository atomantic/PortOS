import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../../../services/socket', async () => {
  const { EventEmitter } = await import('node:events');
  return { default: new EventEmitter() };
});
import socket from '../../../services/socket';

vi.mock('../../../services/api', () => ({
  getBrainLinks: vi.fn(),
  getBrainLink: vi.fn(),
  getBrainBuckets: vi.fn(),
  createBrainLink: vi.fn(),
  updateBrainLink: vi.fn(),
  deleteBrainLink: vi.fn(),
  reorderBrainLinks: vi.fn(),
  reorderBrainBuckets: vi.fn(),
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

vi.mock('../links/BucketBoard', () => ({
  default: () => <div data-testid="bucket-board" />,
}));

// LinksTab mounts its own `DndContext` (buckets + the flat link list share
// one). Capturing its props — the same shape KanbanBoard.test.jsx uses — lets
// the drag-end routing and the live announcement text be exercised directly,
// since jsdom cannot supply real pointer geometry to drive an actual drag.
const dndState = vi.hoisted(() => ({ context: null }));
vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children, ...props }) => {
    dndState.context = props;
    return <>{children}</>;
  },
  DragOverlay: ({ children }) => <>{children}</>,
  closestCenter: vi.fn(() => []),
  KeyboardSensor: function KeyboardSensorStub() {},
  PointerSensor: function PointerSensorStub() {},
  useDraggable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: () => {},
    setActivatorNodeRef: () => {},
    isDragging: false,
  }),
  useSensor: (sensor, options) => ({ sensor, options }),
  useSensors: (...sensors) => sensors,
}));

import { createBrainLink, getBrainLink, getBrainLinks, getBrainBuckets, studyBrainLink, reorderBrainBuckets, reorderBrainLinks } from '../../../services/api';
import toast from '../../ui/Toast';
import { KeyboardSensor } from '@dnd-kit/core';
import { BUCKET_KIND, LINK_KIND, LINK_SLOT_KIND, linksKeyboardCoordinates } from '../links/bucketDnd';
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
  const result = render(<StrictMode><MemoryRouter><LinksTab /></MemoryRouter></StrictMode>);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return result;
}

const tick = (ms = 3000) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
  vi.clearAllMocks();
  dndState.context = null;
  vi.useFakeTimers();
  getBrainBuckets.mockResolvedValue({ buckets: [] });
});

afterEach(() => {
  vi.useRealTimers();
});

const invalidate = (...ids) => act(async () => {
  for (const id of ids) socket.emit('brain:links:changed', { id });
});

describe('LinksTab socket updates', () => {
  it('reads only changed ids and updates completed clones without timer-driven reads', async () => {
    getBrainLinks.mockResolvedValue({ links: [link('a', 'cloning'), link('b', 'cloned')] });
    getBrainLink.mockResolvedValue(link('a', 'cloned'));
    await renderTab();
    await tick(600_000);
    expect(getBrainLink).not.toHaveBeenCalled();
    expect(getBrainLinks).toHaveBeenCalledTimes(1);
    await invalidate('a', 'a');
    expect(getBrainLink).toHaveBeenCalledTimes(1);
    expect(getBrainLink).toHaveBeenCalledWith('a', { silent: true });
    expect(screen.queryByText('Cloning...')).toBeNull();
    expect(screen.getAllByText('Cloned')).toHaveLength(2);
    getBrainLink.mockResolvedValue(link('a', 'cloned', {
      malwareScan: { reportId: '11111111-1111-4111-8111-111111111111', status: 'queued' },
    }));
    await invalidate('a');
    expect(screen.getByTitle(/Malware scan queued/)).toBeTruthy();
    await tick(60_000);
    expect(getBrainLink).toHaveBeenCalledTimes(2);
    expect(getBrainLinks).toHaveBeenCalledTimes(1);
  });

  it('retains failed records, removes deleted records and merges only clone progress', async () => {
    getBrainLinks.mockResolvedValue({ links: [
      link('a', 'cloning'), link('b', 'cloning'),
      link('c', 'cloning', { title: 'renamed-locally' })
    ] });
    getBrainLink.mockImplementation(async id => {
      if (id === 'a') throw Object.assign(new Error('Unavailable'), { status: 503 });
      if (id === 'b') throw Object.assign(new Error('Gone'), { status: 404 });
      return link('c', 'cloned', { localPath: '/repos/example' });
    });
    await renderTab();
    await invalidate('a', 'b', 'c');
    expect(screen.getByText('repo-a')).toBeTruthy();
    expect(screen.queryByText('repo-b')).toBeNull();
    expect(screen.getByText('renamed-locally')).toBeTruthy();
    expect(screen.queryByText('repo-c')).toBeNull();
    expect(screen.getByText('Cloned')).toBeTruthy();
  });

  it('reconciles once on reconnect and tab re-show, then detaches on unmount', async () => {
    getBrainLinks.mockResolvedValue({ links: [link('a', 'cloning')] });
    const view = await renderTab();
    getBrainLinks.mockResolvedValue({ links: [link('a', 'cloned')] });
    await act(async () => { socket.emit('connect'); });
    expect(getBrainLinks).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Cloned')).toBeTruthy();
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await invalidate('a');
    expect(getBrainLink).not.toHaveBeenCalled();
    visibility.mockReturnValue('visible');
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(getBrainLinks).toHaveBeenCalledTimes(3);
    expect(getBrainBuckets).toHaveBeenCalledTimes(3);
    visibility.mockRestore();
    view.unmount();
    await invalidate('a');
    expect(getBrainLink).not.toHaveBeenCalled();
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

// #8120: buckets and chips could only be reordered with a mouse (native HTML5
// drag, no keyboard path). This suite exercises the ONE DndContext LinksTab
// mounts around the flat list + the bucket board — sensors, drag-end routing,
// and the live announcement text — the same "capture DndContext's props"
// shape KanbanBoard.test.jsx uses, since jsdom cannot drive a real drag.
describe('LinksTab drag-and-drop wiring', () => {
  const buckets = [
    { id: 'b1', name: 'Reading', color: 'accent', order: 0 },
    { id: 'b2', name: 'Tools', color: 'purple', order: 1 },
  ];

  beforeEach(() => {
    getBrainBuckets.mockResolvedValue({ buckets });
  });

  it('registers a KeyboardSensor with the shared coordinate getter', async () => {
    getBrainLinks.mockResolvedValue({ links: [] });
    await renderTab();

    const keyboardSensor = dndState.context.sensors.find(({ sensor }) => sensor === KeyboardSensor);
    expect(keyboardSensor).toBeDefined();
    expect(keyboardSensor.options.coordinateGetter).toBe(linksKeyboardCoordinates);
  });

  it('reorders buckets when a bucket is dropped on another bucket', async () => {
    getBrainLinks.mockResolvedValue({ links: [] });
    reorderBrainBuckets.mockResolvedValue(true);
    await renderTab();

    const active = { data: { current: { kind: BUCKET_KIND, bucket: { id: 'b1' }, bucketIndex: 0 } } };
    const over = { data: { current: { kind: BUCKET_KIND, bucketId: 'b2', bucketIndex: 1 } } };
    await act(async () => { dndState.context.onDragEnd({ active, over }); });

    expect(reorderBrainBuckets).toHaveBeenCalledWith(['b2', 'b1'], { silent: true });
  });

  it('does nothing when a bucket is dropped back on itself', async () => {
    getBrainLinks.mockResolvedValue({ links: [] });
    await renderTab();

    const active = { data: { current: { kind: BUCKET_KIND, bucket: { id: 'b1' }, bucketIndex: 0 } } };
    const over = { data: { current: { kind: BUCKET_KIND, bucketId: 'b1', bucketIndex: 0 } } };
    await act(async () => { dndState.context.onDragEnd({ active, over }); });

    expect(reorderBrainBuckets).not.toHaveBeenCalled();
  });

  it('reorders a link to a specific chip slot when dropped on a link-slot droppable', async () => {
    const twoInBucket = [
      link('a', 'none', { bucketId: 'b1', bucketOrder: 0, title: 'Alpha' }),
      link('c', 'none', { bucketId: 'b1', bucketOrder: 1, title: 'Charlie' }),
    ];
    getBrainLinks.mockResolvedValue({ links: twoInBucket });
    reorderBrainLinks.mockResolvedValue(true);
    await renderTab();

    // Drag Alpha (currently index 0) to index 2 — after Charlie.
    const active = { data: { current: { kind: LINK_KIND, link: twoInBucket[0], bucketId: 'b1', index: 0 } } };
    const over = { data: { current: { kind: LINK_SLOT_KIND, bucketId: 'b1', bucketName: 'Reading', index: 2 } } };
    await act(async () => { dndState.context.onDragEnd({ active, over }); });

    expect(reorderBrainLinks).toHaveBeenCalledWith(
      [{ id: 'c', bucketId: 'b1', bucketOrder: 0 }, { id: 'a', bucketId: 'b1', bucketOrder: 1 }],
      { silent: true },
    );
  });

  it('ignores a drop with no destination, and a drop whose kinds do not match', async () => {
    getBrainLinks.mockResolvedValue({ links: [] });
    await renderTab();

    await act(async () => { dndState.context.onDragEnd({ active: { data: { current: { kind: BUCKET_KIND } } }, over: null }); });
    const mismatched = {
      active: { data: { current: { kind: LINK_KIND, link: { id: 'a' } } } },
      over: { data: { current: { kind: BUCKET_KIND, bucketId: 'b1' } } },
    };
    await act(async () => { dndState.context.onDragEnd(mismatched); });

    expect(reorderBrainBuckets).not.toHaveBeenCalled();
    expect(reorderBrainLinks).not.toHaveBeenCalled();
  });

  it('announces the destination bucket and position when a link drag ends', async () => {
    const twoInBucket = [
      link('a', 'none', { bucketId: 'b1', bucketOrder: 0, title: 'Alpha' }),
      link('c', 'none', { bucketId: 'b1', bucketOrder: 1, title: 'Charlie' }),
    ];
    getBrainLinks.mockResolvedValue({ links: twoInBucket });
    await renderTab();

    // Slot index 2 is the trailing "append to the end" slot for a 2-chip
    // bucket — dropping Alpha (currently index 0) there moves it after Charlie.
    const active = { data: { current: { kind: LINK_KIND, link: twoInBucket[0], bucketId: 'b1', index: 0 } } };
    const over = { data: { current: { kind: LINK_SLOT_KIND, bucketId: 'b1', index: 2 } } };
    const message = dndState.context.accessibility.announcements.onDragEnd({ active, over });
    expect(message).toBe('Moved Alpha to position 2 of 2 in Reading.');
  });

  it('announces the position a link stays at when dropped back on its own current slot', async () => {
    const twoInBucket = [
      link('a', 'none', { bucketId: 'b1', bucketOrder: 0, title: 'Alpha' }),
      link('c', 'none', { bucketId: 'b1', bucketOrder: 1, title: 'Charlie' }),
    ];
    getBrainLinks.mockResolvedValue({ links: twoInBucket });
    await renderTab();

    // Slot index 1 ("insert before Charlie") is exactly Alpha's current
    // position — the regression this guards was reporting "position 3 of 2"
    // by not accounting for the dragged link's own slot disappearing first.
    const active = { data: { current: { kind: LINK_KIND, link: twoInBucket[0], bucketId: 'b1', index: 0 } } };
    const over = { data: { current: { kind: LINK_SLOT_KIND, bucketId: 'b1', index: 1 } } };
    const message = dndState.context.accessibility.announcements.onDragEnd({ active, over });
    expect(message).toBe('Moved Alpha to position 1 of 2 in Reading.');
  });

  it('announces the destination position when a bucket drag ends', async () => {
    getBrainLinks.mockResolvedValue({ links: [] });
    await renderTab();

    const active = { data: { current: { kind: BUCKET_KIND, bucket: { id: 'b1', name: 'Reading' } } } };
    const over = { data: { current: { kind: BUCKET_KIND, bucketId: 'b2' } } };
    const message = dndState.context.accessibility.announcements.onDragEnd({ active, over });
    expect(message).toBe('Moved bucket Reading to position 2 of 2.');
  });

  it('announces a drop outside a valid destination did not move anything', async () => {
    getBrainLinks.mockResolvedValue({ links: [] });
    await renderTab();

    const active = { data: { current: { kind: LINK_KIND, link: { id: 'a', title: 'Alpha' } } } };
    const message = dndState.context.accessibility.announcements.onDragEnd({ active, over: null });
    expect(message).toBe('Alpha was dropped outside a valid destination and did not move.');
  });
});
