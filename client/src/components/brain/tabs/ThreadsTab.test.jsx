import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';

vi.mock('../../../services/api', () => ({
  listThreads: vi.fn(),
  getThread: vi.fn(),
  createThread: vi.fn(),
  updateThread: vi.fn(),
  deleteThread: vi.fn(),
  addThreadRef: vi.fn(),
  removeThreadRef: vi.fn(),
}));
vi.mock('../../ui/Toast', () => ({ default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

import * as api from '../../../services/api';
import ThreadsTab from './ThreadsTab';

const FAR_FUTURE = '2999-01-01T00:00:00.000Z';
const PAST = '2000-01-01T00:00:00.000Z';

const ROWS = [
  { id: 'pin', title: 'Pinned loop', status: 'open', pinned: true, refs: [], tags: [] },
  { id: 'late', title: 'Overdue loop', status: 'open', dueAt: PAST, refs: [{ kind: 'url', id: 'https://example.com' }], tags: ['ops'] },
  { id: 'op', title: 'Plain loop', status: 'open', nextAction: 'Call back', dueAt: FAR_FUTURE, refs: [], tags: [] },
  { id: 'wait', title: 'Waiting loop', status: 'waiting', waitingOn: 'Acme Corp', refs: [], tags: [] },
];
const DONE_ROW = { id: 'done', title: 'Finished loop', status: 'done', refs: [], tags: [] };

const RESOLVED = [{ kind: 'url', id: 'https://example.com', label: 'example', url: 'https://example.com', resolved: true }];

function Location() {
  return <output data-testid="location">{useLocation().search}</output>;
}

const renderTab = (entry = '/brain/threads') =>
  render(<MemoryRouter initialEntries={[entry]}><ThreadsTab /><Location /></MemoryRouter>);

describe('ThreadsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.listThreads.mockResolvedValue({ threads: ROWS, total: ROWS.length });
    api.getThread.mockImplementation(async (id) => ({ ...ROWS.find((r) => r.id === id), notes: 'body', resolvedRefs: RESOLVED }));
  });

  it('asks the server for the working set and groups it pinned / overdue / open / waiting', async () => {
    renderTab();
    await screen.findByText('Pinned loop');
    const groupTitles = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent.trim());
    expect(groupTitles).toEqual(['Pinned 1', 'Overdue 1', 'Open 1', 'Waiting 1']);
    expect(screen.getByText('Waiting on Acme Corp')).toBeTruthy();
    // One request for exactly the non-terminal statuses — never the archive filtered here.
    expect(api.listThreads).toHaveBeenCalledWith({ q: '', tag: '', status: 'open,waiting,someday' });
  });

  it('reads the status, tag and search filters from the URL and sends them to the server', async () => {
    api.listThreads.mockResolvedValue({ threads: [DONE_ROW], total: 1 });
    renderTab('/brain/threads?status=done&tag=ops&q=fin');
    await screen.findByText('Finished loop');
    expect(api.listThreads).toHaveBeenCalledWith({ q: 'fin', tag: 'ops', status: 'done' });
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent.trim())).toEqual(['Done 1']);
  });

  it('opens the drawer for the thread named in the URL on load', async () => {
    renderTab('/brain/threads?thread=late&threadTab=links');
    await screen.findByRole('dialog');
    expect(api.getThread).toHaveBeenCalledWith('late', { silent: true });
    // The Links tab renders the hydrated ref with its click-through.
    const chip = await screen.findByText('example');
    expect(chip.closest('a')).toHaveAttribute('href', 'https://example.com');
  });

  it('puts the selected thread in the URL when a row is clicked, not in local state', async () => {
    renderTab();
    fireEvent.click(await screen.findByText('Plain loop'));
    expect(screen.getByTestId('location').textContent).toBe('?thread=op');
    await screen.findByRole('dialog');
    expect(screen.getByDisplayValue('Call back')).toBeTruthy();
  });

  it('checks a thread off in place without refetching the list', async () => {
    api.updateThread.mockResolvedValue({ ...ROWS[2], status: 'done', closedAt: FAR_FUTURE });
    renderTab();
    await screen.findByText('Plain loop');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Mark "Plain loop" done' })); });
    expect(api.updateThread).toHaveBeenCalledWith('op', { status: 'done' }, { silent: true });
    await waitFor(() => expect(screen.queryByText('Plain loop')).toBeNull());
    expect(api.listThreads).toHaveBeenCalledTimes(1);
  });

  it('completes a source-closed thread explicitly from its drawer and preserves hydrated links', async () => {
    const thread = { ...ROWS[2], externalState: 'closed', notes: 'body', resolvedRefs: RESOLVED };
    api.getThread.mockResolvedValue(thread);
    let finish;
    api.updateThread.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    renderTab('/brain/threads?thread=op');
    const dialog = within(await screen.findByRole('dialog'));
    const complete = await dialog.findByRole('button', { name: 'Mark "Plain loop" done' });
    expect(api.updateThread).not.toHaveBeenCalled();
    fireEvent.change(dialog.getByLabelText('Title'), { target: { value: 'My title' } });
    expect(complete).toBeDisabled();
    fireEvent.change(dialog.getByLabelText('Title'), { target: { value: thread.title } });
    fireEvent.click(complete);
    expect(complete).toBeDisabled();
    expect(dialog.getByLabelText('Title')).toBeDisabled();
    expect(api.updateThread).toHaveBeenCalledWith('op', { status: 'done' }, { silent: true });
    await act(async () => { finish({ ...ROWS[2], notes: 'body', externalState: 'closed', status: 'done' }); });
    expect(dialog.getByLabelText('Status')).toHaveValue('done');
    expect(dialog.queryByText('Source closed — mark done?')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mark "Plain loop" done' })).toBeNull();
    fireEvent.click(dialog.getByRole('tab', { name: 'Links' }));
    expect(await dialog.findByText('example')).toBeTruthy();
    expect(api.listThreads).toHaveBeenCalledTimes(1);
  });

  it('does not replace a different drawer when completion finishes after navigation', async () => {
    api.getThread.mockImplementation(async (id) => ({ ...ROWS.find((r) => r.id === id), externalState: 'closed', notes: 'body', resolvedRefs: RESOLVED }));
    let finish;
    api.updateThread.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    renderTab('/brain/threads?thread=op');
    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.click(await dialog.findByRole('button', { name: 'Mark "Plain loop" done' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close thread' }));
    fireEvent.click(screen.getByText('Waiting loop'));
    await waitFor(() => expect(screen.getByLabelText('Title')).toHaveValue('Waiting loop'));
    await act(async () => { finish({ ...ROWS[2], status: 'done' }); });
    expect(screen.getByLabelText('Title')).toHaveValue('Waiting loop');
    expect(screen.getByLabelText('Status')).toHaveValue('waiting');
  });

  it('creates a thread from the capture box and opens it', async () => {
    api.createThread.mockResolvedValue({ id: 'new', title: 'Chase invoice', status: 'open', refs: [], tags: [] });
    renderTab();
    await screen.findByText('Pinned loop');
    fireEvent.change(screen.getByLabelText('New thread'), { target: { value: 'Chase invoice' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Add' })); });
    expect(api.createThread).toHaveBeenCalledWith({ title: 'Chase invoice' }, { silent: true });
    expect(screen.getByTestId('location').textContent).toBe('?thread=new');
  });

  it('debounces the search box into the URL instead of fetching per keystroke', async () => {
    vi.useFakeTimers();
    try {
      renderTab();
      await act(async () => { await Promise.resolve(); });
      fireEvent.change(screen.getByLabelText('Search threads'), { target: { value: 'r' } });
      fireEvent.change(screen.getByLabelText('Search threads'), { target: { value: 're' } });
      expect(api.listThreads).toHaveBeenCalledTimes(1);
      await act(async () => { vi.advanceTimersByTime(300); });
      expect(screen.getByTestId('location').textContent).toBe('?q=re');
      expect(api.listThreads).toHaveBeenCalledTimes(2);
      expect(api.listThreads).toHaveBeenLastCalledWith({ q: 're', tag: '', status: 'open,waiting,someday' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('swaps the hydrated record a ref write returns into the drawer without a second read', async () => {
    api.addThreadRef.mockResolvedValue({ ...ROWS[2], notes: 'body', refs: [{ kind: 'url', id: 'https://example.com/x' }], resolvedRefs: [{ kind: 'url', id: 'https://example.com/x', label: 'added', url: 'https://example.com/x', resolved: true }] });
    renderTab('/brain/threads?thread=op&threadTab=links');
    await screen.findByRole('dialog');
    await screen.findByText('example');
    fireEvent.change(screen.getByLabelText('Id or URL'), { target: { value: 'https://example.com/x' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Add link' })); });
    expect(api.addThreadRef).toHaveBeenCalledWith('op', { kind: 'url', id: 'https://example.com/x' }, { silent: true });
    expect(await screen.findByText('added')).toBeTruthy();
    expect(api.getThread).toHaveBeenCalledTimes(1);
  });

  it('is the component the Brain page renders for its threads tab', () => {
    const clientSrc = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const brainPage = readFileSync(join(clientSrc, 'pages', 'Brain.jsx'), 'utf8');
    expect(brainPage).toContain("import('../components/brain/tabs/ThreadsTab')");
    expect(brainPage).toMatch(/case 'threads':[\s\S]{0,120}<ThreadsTab\b/);
  });
});
