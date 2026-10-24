import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import ManageImportedDataPanel from './ManageImportedDataPanel';

const api = vi.hoisted(() => ({ getTimelineSources: vi.fn(), eraseTimelineSource: vi.fn() }));
vi.mock('../../services/api', () => api);
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn() } }));
vi.mock('../../hooks/usePrefersReducedMotion', () => ({ default: () => true }));
const sources = [{ source: 'browser', eventCount: 3 }, { source: 'discord', eventCount: 2 }];
beforeEach(() => { vi.clearAllMocks(); api.getTimelineSources.mockResolvedValue({ sources }); });

it('keeps the confirmed source fixed during deletion and ignores a pre-delete count response', async () => {
  let finishDelete;
  let finishCounts;
  api.eraseTimelineSource.mockImplementation(() => new Promise(resolve => { finishDelete = resolve; }));
  const onChanged = vi.fn();
  const view = render(<ManageImportedDataPanel reloadKey={0} onChanged={onChanged} />);
  await screen.findByText('browser');
  api.getTimelineSources.mockImplementationOnce(() => new Promise(resolve => { finishCounts = resolve; }));
  view.rerender(<ManageImportedDataPanel reloadKey={1} onChanged={onChanged} />);
  fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'browser' } });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  expect(screen.getAllByRole('button', { name: 'Delete' }).every(button => button.disabled)).toBe(true);
  await act(async () => { finishCounts({ sources: [] }); });
  expect(screen.getByRole('textbox')).toHaveValue('browser');
  expect(api.eraseTimelineSource).toHaveBeenCalledTimes(1);
  expect(api.eraseTimelineSource.mock.calls[0][0]).toBe('browser');
  api.getTimelineSources.mockResolvedValue({ sources: [sources[1]] });
  await act(async () => { finishDelete({ deleted: 3 }); });
  await waitFor(() => expect(screen.queryByText('browser')).not.toBeInTheDocument());
  expect(screen.getByText('discord')).toBeInTheDocument();
  expect(onChanged).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'discord' } });
  const confirm = screen.getByRole('button', { name: 'Confirm delete' });
  confirm.focus();
  fireEvent.click(confirm);
  api.getTimelineSources.mockResolvedValue({ sources: [] });
  await act(async () => { finishDelete({ deleted: 2 }); });
  await screen.findByText('No imported events.');
  expect(screen.getByRole('list')).toHaveFocus();

});

it('reconciles authoritative counts after deletion without restoring a source from a pending reload', async () => {
  let finishDelete;
  let finishCounts;
  let deleted = false;
  const staleCounts = new Promise(resolve => { finishCounts = resolve; });
  api.eraseTimelineSource.mockImplementationOnce(() => new Promise(resolve => { finishDelete = resolve; }));
  const view = render(<ManageImportedDataPanel reloadKey={0} />);
  await screen.findByText('browser');
  api.getTimelineSources.mockImplementation(() => deleted
    ? Promise.resolve({ sources: [{ source: 'discord', eventCount: 9 }] })
    : staleCounts);
  fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'browser' } });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));
  view.rerender(<ManageImportedDataPanel reloadKey={1} />);
  await act(async () => { deleted = true; finishDelete({ deleted: 3 }); });
  await waitFor(() => expect(screen.queryByText('browser')).not.toBeInTheDocument());
  await act(async () => { finishCounts({ sources }); });
  expect(screen.queryByText('browser')).not.toBeInTheDocument();
  expect(await screen.findByText('9 events')).toBeInTheDocument();
  expect(api.eraseTimelineSource).toHaveBeenCalledTimes(1);
});

it('retains the row and confirmation and shows a refused deletion', async () => {
  api.eraseTimelineSource.mockRejectedValueOnce(new Error('Deletion unavailable'));
  const onChanged = vi.fn();
  render(<ManageImportedDataPanel onChanged={onChanged} />);
  await screen.findByText('browser');
  api.getTimelineSources.mockResolvedValueOnce({ sources: [{ source: 'browser', eventCount: 1 }, sources[1]] });
  fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'browser' } });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Deletion unavailable');
  expect(screen.getByRole('textbox')).toHaveValue('browser');
  expect(screen.getByText(/to delete all 1 events/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Confirm delete' })).toBeEnabled();
  expect(onChanged).not.toHaveBeenCalled();
});

it('reconciles a lost delete acknowledgement from a fresh read without repeating the mutation', async () => {
  const onChanged = vi.fn();
  api.eraseTimelineSource.mockRejectedValueOnce(new Error('Response lost'));
  render(<ManageImportedDataPanel onChanged={onChanged} />);
  await screen.findByText('browser');
  api.getTimelineSources.mockResolvedValue({ sources: [sources[1]] });
  fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'browser' } });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));
  await waitFor(() => expect(screen.queryByText('browser')).not.toBeInTheDocument());
  expect(screen.getByText('discord')).toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent('Response lost');
  expect(api.eraseTimelineSource).toHaveBeenCalledTimes(1);
  expect(onChanged).toHaveBeenCalledTimes(1);
});

it('shows a failed source-count read instead of hiding the management panel', async () => {
  api.getTimelineSources.mockRejectedValueOnce(new Error('Sources unavailable'));
  render(<ManageImportedDataPanel />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Sources unavailable');
});
