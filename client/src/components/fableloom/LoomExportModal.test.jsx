import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LoomExportModal from './LoomExportModal.jsx';
import * as api from '../../services/apiFableLoom.js';
import socket from '../../services/socket';
import { downloadBlob } from '../../lib/downloadBlob.js';

vi.mock('../../services/apiFableLoom.js', () => ({ preflightLoomExport: vi.fn(), startLoomExport: vi.fn(), getLoomExport: vi.fn(), downloadLoomExport: vi.fn() }));
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

});
