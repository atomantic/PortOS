import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LoomExportModal from './LoomExportModal.jsx';
import * as api from '../../services/apiFableLoom.js';
import socket from '../../services/socket';
import { downloadBlob } from '../../lib/downloadBlob.js';

vi.mock('../../services/apiFableLoom.js', () => ({ preflightLoomExport: vi.fn(), startLoomExport: vi.fn(), getLoomExport: vi.fn(), getLatestLoomExport: vi.fn(), cancelLoomExport: vi.fn(), downloadLoomExport: vi.fn() }));
vi.mock('../../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn(), emit: vi.fn() } }));
vi.mock('../../lib/downloadBlob.js', () => ({ downloadBlob: vi.fn() }));
const loom = { id: 'loom', episodes: [{ id: 'one', title: 'One' }, { id: 'two', title: 'Two' }] };
const snapshot = (jobId, status, revision = 1) => ({ loomId: 'loom', jobId, status, revision, findings: [], progress: { completed: 0, total: 1 } });
const emit = async job => { await act(async () => { socket.on.mock.calls.filter(([event]) => event === 'fableloom:export:job').at(-1)[1](job); }); };

beforeEach(() => {
  vi.clearAllMocks();
  api.preflightLoomExport.mockResolvedValue({ canBuild: true, findings: [] });
  api.startLoomExport.mockResolvedValue({ jobId: 'selected' });
  api.getLoomExport.mockResolvedValue(snapshot('selected', 'packing'));
  api.getLatestLoomExport.mockResolvedValue({ job: null });
});

describe('story export interaction', () => {
  it('shows server refusal, explicit draft/character consent and ordered selections before building', async () => {
    api.preflightLoomExport.mockImplementation(async (_id, options) => ({ canBuild: options.allowDraft, findings: options.allowDraft ? [] : [{ gate: 'approval', severity: 'error', message: 'Draft source' }] }));
    render(<LoomExportModal loom={loom} onClose={vi.fn()} />);
    await screen.findByText('error: Draft source');
    expect(screen.getByText('Build ZIP')).toBeDisabled();
    expect(screen.getByLabelText('Approved voice references')).toBeDisabled();
    fireEvent.click(screen.getByLabelText('Character inputs'));
    fireEvent.click(screen.getByLabelText('Approved voice references'));
    fireEvent.click(screen.getByLabelText('Allow draft assets (not production approval)'));
    fireEvent.click(screen.getByLabelText('Move episode 2 up'));
    await waitFor(() => expect(screen.getByText('Build ZIP')).toBeEnabled());
    fireEvent.click(screen.getByText('Build ZIP'));
    await waitFor(() => expect(api.startLoomExport).toHaveBeenCalledWith('loom', expect.objectContaining({ episodeIds: ['two', 'one'], includeCharacters: true, includeVoice: true, allowDraft: true }), { silent: true }));
  });

  it.each([false, true])('prunes deleted episodes on reopen (deletion observed while closed: %s)', async observedWhileClosed => {
    const deleted = { id: 'deleted', title: 'Deleted episode' };
    const removed = { id: 'removed', title: 'Manually removed episode' };
    const original = { ...loom, episodes: [...loom.episodes, deleted, removed] };
    const updated = { ...loom, episodes: [...loom.episodes, removed] };
    const close = vi.fn();
    const { rerender } = render(<LoomExportModal loom={original} onClose={close} />);
    fireEvent.click(screen.getByLabelText('Move episode 2 up'));
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[3]);
    await waitFor(() => expect(screen.getByText('Build ZIP')).toBeEnabled());

    api.preflightLoomExport.mockClear();
    rerender(<LoomExportModal loom={original} open={false} onClose={close} />);
    if (observedWhileClosed) rerender(<LoomExportModal loom={updated} open={false} onClose={close} />);
    expect(api.preflightLoomExport).not.toHaveBeenCalled();

    rerender(<LoomExportModal loom={updated} open onClose={close} />);
    await waitFor(() => expect(screen.getByText('Build ZIP')).toBeEnabled());
    expect(screen.queryByText(deleted.id)).toBeNull();
    expect(screen.getByRole('button', { name: `Add ${removed.title}` })).toBeEnabled();
    expect(api.preflightLoomExport).toHaveBeenCalledTimes(1);
    const selection = expect.objectContaining({ episodeIds: ['two', 'one'] });
    expect(api.preflightLoomExport).toHaveBeenCalledWith('loom', selection, { silent: true });
    fireEvent.click(screen.getByText('Build ZIP'));
    await waitFor(() => expect(api.startLoomExport).toHaveBeenCalledWith('loom', selection, { silent: true }));
  });

  it('filters other jobs and stale revisions, displays failures and downloads only the selected completed job', async () => {
    api.downloadLoomExport.mockResolvedValue(new Blob(['zip']));
    render(<LoomExportModal loom={loom} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Build ZIP')).toBeEnabled());
    fireEvent.click(screen.getByText('Build ZIP'));
    await screen.findByText(/selected: packing/);
    await emit(snapshot('foreign', 'completed', 10));
    expect(screen.queryByText('Download selected ZIP')).toBeNull();
    await emit({ ...snapshot('selected', 'failed', 2), error: { message: 'Source missing' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Source missing');
    await emit(snapshot('selected', 'packing', 1));
    expect(screen.getByRole('alert')).toHaveTextContent('Source missing');
    await emit({ ...snapshot('selected', 'completed', 3), sizeReport: { archiveBytes: 1024 } });
    fireEvent.click(screen.getByText('Download selected ZIP'));
    await waitFor(() => expect(downloadBlob).toHaveBeenCalled());
    expect(api.downloadLoomExport).toHaveBeenCalledWith('loom', 'selected', { silent: true });
  });

  it('drops superseded preflight and loom responses', async () => {
    let resolveOld;
    api.preflightLoomExport.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }));
    const { rerender } = render(<LoomExportModal loom={loom} onClose={vi.fn()} />);
    rerender(<LoomExportModal key="other" loom={{ ...loom, id: 'other' }} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Build ZIP')).toBeEnabled());
    await act(async () => resolveOld({ canBuild: false, findings: [{ gate: 'graph', severity: 'error', message: 'Old loom' }] }));
    expect(screen.queryByText('error: Old loom')).toBeNull();
    expect(screen.getByText('Build ZIP')).toBeEnabled();
  });

  it('retains the selected job when closed during admission, accepts same-loom edits and resumes completed downloads', async () => {
    let resolveStart;
    api.startLoomExport.mockReturnValueOnce(new Promise(resolve => { resolveStart = resolve; }));
    const close = vi.fn();
    const { rerender } = render(<LoomExportModal loom={loom} onClose={close} />);
    await waitFor(() => expect(screen.getByText('Build ZIP')).toBeEnabled());
    fireEvent.click(screen.getByText('Build ZIP'));
    fireEvent.click(screen.getByText('Close'));
    expect(close).toHaveBeenCalled();
    const changed = { ...loom, name: 'Updated while admitting' };
    rerender(<LoomExportModal loom={changed} open={false} onClose={close} />);
    await act(async () => resolveStart({ jobId: 'selected' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    rerender(<LoomExportModal loom={changed} open onClose={close} />);
    await screen.findByText(/selected: packing/);
    expect(api.startLoomExport).toHaveBeenCalledTimes(1);
    rerender(<LoomExportModal loom={changed} open={false} onClose={close} />);
    await emit(snapshot('selected', 'completed', 2));
    rerender(<LoomExportModal loom={changed} open onClose={close} />);
    expect(screen.getByText('Download selected ZIP')).toBeEnabled();
    await act(async () => {});
  });


  it('recovers a missed terminal event after a failed initial status read by reopening', async () => {
    api.getLoomExport.mockRejectedValueOnce(new Error('Status connection failed'))
      .mockResolvedValue(snapshot('selected', 'completed', 2));
    const close = vi.fn();
    const { rerender } = render(<LoomExportModal loom={loom} onClose={close} />);
    await waitFor(() => expect(screen.getByText('Build ZIP')).toBeEnabled());
    fireEvent.click(screen.getByText('Build ZIP'));
    await screen.findByText('Status connection failed');
    expect(screen.getByText('Refresh selected job')).toBeEnabled();
    rerender(<LoomExportModal loom={loom} open={false} onClose={close} />);
    rerender(<LoomExportModal loom={loom} open onClose={close} />);
    await screen.findByText('Download selected ZIP');
    expect(api.getLoomExport).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('Status connection failed')).toBeNull();
    expect(api.startLoomExport).toHaveBeenCalledTimes(1);
    await act(async () => {});
  });


  it('reattaches to the latest server job on open and skips hydration while closed', async () => {
    api.getLatestLoomExport.mockResolvedValue({ job: snapshot('selected', 'packing') });
    const { rerender } = render(<LoomExportModal loom={loom} open={false} onClose={vi.fn()} />);
    await act(async () => {});
    expect(api.getLatestLoomExport).not.toHaveBeenCalled();
    rerender(<LoomExportModal loom={loom} open onClose={vi.fn()} />);
    await screen.findByText(/selected: packing/);
    expect(api.getLatestLoomExport).toHaveBeenCalledWith('loom', { silent: true });
    expect(api.getLoomExport).toHaveBeenCalledWith('loom', 'selected', { silent: true });
    expect(screen.getByText('Cancel export')).toBeEnabled();
  });

  it('shows a reattached completed job with its download button', async () => {
    api.getLatestLoomExport.mockResolvedValue({ job: snapshot('selected', 'completed', 4) });
    api.getLoomExport.mockResolvedValue(snapshot('selected', 'completed', 4));
    render(<LoomExportModal loom={loom} onClose={vi.fn()} />);
    expect(await screen.findByText('Download selected ZIP')).toBeEnabled();
    expect(screen.queryByText('Cancel export')).toBeNull();
  });

  it('cancels a running job once and applies the settled snapshot', async () => {
    let resolveCancel;
    api.cancelLoomExport.mockReturnValueOnce(new Promise(resolve => { resolveCancel = resolve; }));
    render(<LoomExportModal loom={loom} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Build ZIP')).toBeEnabled());
    fireEvent.click(screen.getByText('Build ZIP'));
    fireEvent.click(await screen.findByText('Cancel export'));
    expect(screen.getByText('Cancel export')).toBeDisabled();
    fireEvent.click(screen.getByText('Cancel export'));
    expect(api.cancelLoomExport).toHaveBeenCalledTimes(1);
    expect(api.cancelLoomExport).toHaveBeenCalledWith('loom', 'selected', { silent: true });
    await act(async () => resolveCancel({ ...snapshot('selected', 'failed', 5), error: { code: 'EXPORT_CANCELLED', message: 'Export cancelled' } }));
    expect(screen.getByRole('alert')).toHaveTextContent('Export cancelled');
    expect(screen.queryByText('Cancel export')).toBeNull();
  });
});
