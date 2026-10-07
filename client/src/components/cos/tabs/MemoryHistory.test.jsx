import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import MemoryEditModal from './MemoryEditModal';
import MemoryHistory from './MemoryHistory';
import * as api from '../../../services/api';

vi.mock('../../../services/api', () => ({
  getMemory: vi.fn(), getMemoryVersions: vi.fn(), getMemoryVersion: vi.fn(),
  updateMemory: vi.fn(), getMemoryRuns: vi.fn()
}));
vi.mock('../../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

const socket = vi.hoisted(() => ({ on: vi.fn(), off: vi.fn(), emit: vi.fn() }));
vi.mock('../../../services/socket', () => ({ default: socket }));
const handlers = new Map();
const dispatch = async (event, payload) => {
  await act(async () => { for (const handler of handlers.get(event) || []) handler(payload); });
};
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

beforeEach(() => {
  vi.clearAllMocks();
  handlers.clear();
  socket.on.mockImplementation((event, handler) => {
    if (!handlers.has(event)) handlers.set(event, new Set());
    handlers.get(event).add(handler);
  });
  socket.off.mockImplementation((event, handler) => handlers.get(event)?.delete(handler));
  api.getMemory.mockResolvedValue({
    id: 'example-memory', content: 'Current text', summary: 'Current', type: 'fact',
    version: 3, status: 'archived', archiveReason: 'Corrected', supersededBy: ['replacement']
  });
  api.getMemoryVersions.mockResolvedValue({
    versions: [{ version: 2, changeReason: 'Earlier correction', createdAt: '2026-01-01T00:00:00.000Z' }]
  });
  api.getMemoryVersion.mockResolvedValue({ version: 2, content: 'Earlier text', summary: 'Earlier', type: 'fact', tags: [] });
  api.getMemoryRuns.mockResolvedValue({ runs: [] });
});

describe('Memory detail history', () => {
  it('loads earlier text on demand, links its replacement and guards saves with the loaded version', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    api.updateMemory.mockResolvedValue({ id: 'example-memory', version: 4 });
    render(<MemoryRouter><MemoryEditModal memory={{ id: 'example-memory' }} apps={[]} onSave={onSave} onClose={() => {}} /></MemoryRouter>);
    expect(await screen.findByDisplayValue('Current text')).toBeTruthy();
    expect(await screen.findByRole('link', { name: 'View replacement memory' })).toHaveAttribute('href', '/cos/memory/replacement');
    await user.click(await screen.findByRole('button', { name: /Version 2/ }));
    expect(await screen.findByText('Earlier text')).toBeTruthy();
    expect(screen.getByDisplayValue('Current text')).toBeTruthy();
    await user.type(screen.getByLabelText('Reason for change'), 'New evidence');
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(api.updateMemory).toHaveBeenCalledWith('example-memory',
      expect.objectContaining({ expectedVersion: 3, changeReason: 'New evidence', content: 'Current text' }),
      { silent: true }));
    expect(onSave).toHaveBeenCalled();
  });
});

describe('open history and editor lifecycle', () => {
  it('coalesces targeted revision reads, retains visible history and preserves the stale draft/version on a 409', async () => {
    const current = { id: 'example-memory', content: 'Loaded text', summary: 'Loaded summary', type: 'fact', version: 2, status: 'active' };
    api.getMemory.mockResolvedValue(current);
    api.getMemoryVersions.mockResolvedValue({ versions: [{ version: 1, changeReason: 'Original revision' }] });
    const onSave = vi.fn();
    render(<MemoryRouter><MemoryEditModal memory={{ id: current.id }} apps={[]} onSave={onSave} onClose={() => {}} /></MemoryRouter>);
    await screen.findByDisplayValue('Loaded text');
    await screen.findByRole('button', { name: /Version 1/ });
    fireEvent.change(screen.getByRole('textbox', { name: /Content/ }), { target: { value: 'Unsaved correction' } });
    fireEvent.change(screen.getByLabelText('Reason for change'), { target: { value: 'Draft reason' } });
    const memoryCalls = api.getMemory.mock.calls.length;
    const historyCalls = api.getMemoryVersions.mock.calls.length;
    await dispatch('cos:memory:updated', { id: 'different-memory' });
    expect(api.getMemory).toHaveBeenCalledTimes(memoryCalls);
    expect(api.getMemoryVersions).toHaveBeenCalledTimes(historyCalls);

    const read = deferred();
    const versions = deferred();
    const latest = { ...current, version: 3, content: 'Remote correction', status: 'archived', archiveReason: 'Replaced', supersededBy: ['example-replacement'] };
    api.getMemory.mockImplementationOnce(() => read.promise).mockResolvedValue(latest);
    api.getMemoryVersions.mockImplementationOnce(() => versions.promise)
      .mockResolvedValue({ versions: [{ version: 2, changeReason: 'Remote revision' }, { version: 1, changeReason: 'Original revision' }] });
    await dispatch('cos:memory:updated', { id: current.id });
    await act(async () => {
      for (let i = 0; i < 25; i++) for (const handler of handlers.get('cos:memory:deleted')) handler({ id: current.id });
    });
    expect(screen.getByRole('button', { name: /Version 1/ })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Content/ })).toHaveValue('Unsaved correction');
    expect(api.getMemoryVersions).toHaveBeenCalledTimes(historyCalls + 1);
    await act(async () => {
      read.resolve(latest);
      versions.resolve({ versions: [{ version: 2, changeReason: 'Remote revision' }, { version: 1, changeReason: 'Original revision' }] });
    });
    expect(api.getMemoryVersions).toHaveBeenCalledTimes(historyCalls + 2);
    expect(api.getMemory).toHaveBeenCalledTimes(memoryCalls + 2);
    expect(screen.getByText(/current version 3/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Version 2/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View replacement memory' })).toHaveAttribute('href', '/cos/memory/example-replacement');
    expect(screen.getByText(/This memory has been retired/)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Summary/ })).toHaveValue('Loaded summary');
    api.updateMemory.mockRejectedValue(Object.assign(new Error('Memory version conflict'), { status: 409 }));
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(api.updateMemory).toHaveBeenCalledWith(current.id,
      expect.objectContaining({ expectedVersion: 2, content: 'Unsaved correction', changeReason: 'Draft reason' }), { silent: true }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save Changes' })).toBeEnabled());
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: /Content/ })).toHaveValue('Unsaved correction');
  });

  it('recovers editor/history revisions on reconnect and tab-show without changing the loaded snapshot', async () => {
    const current = { id: 'example-memory', content: 'Loaded text', version: 1, status: 'active' };
    api.getMemory.mockResolvedValue(current);
    api.getMemoryVersions.mockResolvedValue({ versions: [] });
    render(<MemoryRouter><MemoryEditModal memory={{ id: current.id }} apps={[]} onSave={() => {}} onClose={() => {}} /></MemoryRouter>);
    await screen.findByDisplayValue('Loaded text');
    api.getMemory.mockResolvedValue({ ...current, version: 2, content: 'Missed edit' });
    api.getMemoryVersions.mockResolvedValue({ versions: [{ version: 1 }] });
    await dispatch('connect');
    expect(screen.getByText(/A newer revision exists/)).toBeInTheDocument();
    expect(screen.getByText(/current version 2/)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Content/ })).toHaveValue('Loaded text');
    const calls = api.getMemoryVersions.mock.calls.length;
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await dispatch('cos:memory:updated', { id: current.id });
    expect(api.getMemoryVersions).toHaveBeenCalledTimes(calls);
    api.getMemory.mockResolvedValue({ ...current, version: 3 });
    api.getMemoryVersions.mockResolvedValue({ versions: [{ version: 2 }, { version: 1 }] });
    visibility.mockReturnValue('visible');
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(screen.getByText(/current version 3/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Version 2/ })).toBeInTheDocument();
    visibility.mockRestore();
  });

  it('drops superseded history/snapshot responses and aborts pending page reads on unmount', async () => {
    const oldPage = deferred();
    const oldSnapshot = deferred();
    let oldSignal;
    api.getMemoryVersions.mockImplementation((id, _offset, options) => {
      if (id === 'memory-old') { oldSignal = options.signal; return oldPage.promise; }
      return Promise.resolve({ versions: [{ version: 2 }] });
    });
    api.getMemoryVersion.mockImplementation(id => id === 'memory-old'
      ? oldSnapshot.promise : Promise.resolve({ version: 1, content: 'New identity snapshot' }));
    const history = memory => <MemoryRouter initialEntries={['/?version=1']}><MemoryHistory memory={memory} /></MemoryRouter>;
    const view = render(history({ id: 'memory-old', version: 3 }));
    await waitFor(() => expect(oldSignal).toBeDefined());
    view.rerender(history({ id: 'memory-new', version: 4 }));
    await screen.findByText('New identity snapshot');
    expect(oldSignal.aborted).toBe(true);
    await act(async () => {
      oldPage.resolve({ versions: [{ version: 99 }] });
      oldSnapshot.resolve({ version: 1, content: 'Old identity snapshot' });
    });
    expect(screen.queryByText('Old identity snapshot')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Version 99/ })).not.toBeInTheDocument();
    const late = deferred();
    let lateSignal;
    api.getMemoryVersions.mockImplementation((_id, _offset, options) => { lateSignal = options.signal; return late.promise; });
    await dispatch('cos:memory:updated', { id: 'memory-new' });
    view.unmount();
    expect(lateSignal.aborted).toBe(true);
    await act(async () => { late.resolve({ versions: [] }); });
    expect(handlers.get('cos:memory:updated').size).toBe(0);
  });
});

it('does not let a completed save from a closed editor dismiss the next memory', async () => {
  const save = deferred();
  api.updateMemory.mockImplementation(() => save.promise);
  api.getMemory.mockImplementation(async id => ({ id, content: id === 'memory-first' ? 'First body' : 'Next body', version: 1 }));
  api.getMemoryVersions.mockResolvedValue({ versions: [] });
  const onSave = vi.fn();
  const modal = id => <MemoryRouter><MemoryEditModal key={id} memory={{ id }} apps={[]} onSave={onSave} onClose={() => {}} /></MemoryRouter>;
  const view = render(modal('memory-first'));
  await screen.findByDisplayValue('First body');
  fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
  expect(api.updateMemory).toHaveBeenCalledTimes(1);
  view.rerender(modal('memory-next'));
  await screen.findByDisplayValue('Next body');
  await act(async () => { save.resolve({ id: 'memory-first', version: 2 }); });
  expect(onSave).not.toHaveBeenCalled();
  expect(screen.getByRole('textbox', { name: /Content/ })).toHaveValue('Next body');
});

it('keeps saving disabled when the editor cannot load a valid expectedVersion', async () => {
  api.getMemory.mockResolvedValue({ id: 'example-memory', content: 'Unversioned response' });
  render(<MemoryRouter><MemoryEditModal memory={{ id: 'example-memory' }} apps={[]} onSave={() => {}} onClose={() => {}} /></MemoryRouter>);
  expect(await screen.findByText(/Invalid memory revision response/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled();
  expect(api.updateMemory).not.toHaveBeenCalled();
});
