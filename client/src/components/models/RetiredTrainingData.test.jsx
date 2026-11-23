import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import RetiredTrainingData from './RetiredTrainingData';
import toast from '../ui/Toast';
import { getRetiredDataInventory, deleteRetiredData } from '../../services/apiLoraTraining.js';

vi.mock('../../services/apiLoraTraining.js', () => ({
  getRetiredDataInventory: vi.fn(),
  deleteRetiredData: vi.fn(),
}));
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

const row = (id, directory, status = 'retained') => ({
  id, label: `Retired ${directory}`, path: `data/${directory}`, bytes: 2048, files: 3, status, deletable: true,
  actions: status === 'retained' ? ['delete'] : [], warning: 'May be irreplaceable.',
});

beforeEach(() => vi.clearAllMocks());

describe('RetiredTrainingData', () => {
  it('renders nothing when both directories are gone or the inventory is refused', async () => {
    getRetiredDataInventory.mockResolvedValueOnce([row('a', 'training-runs', 'absent'), row('b', 'lora-datasets', 'absent')]);
    const { container, rerender } = render(<RetiredTrainingData />);
    await waitFor(() => expect(getRetiredDataInventory).toHaveBeenCalledTimes(1));
    expect(container).toBeEmptyDOMElement();
    getRetiredDataInventory.mockRejectedValueOnce(Object.assign(new Error('no'), { code: 'HOST_CONTROL_FORBIDDEN' }));
    rerender(<RetiredTrainingData key="again" />);
    await waitFor(() => expect(getRetiredDataInventory).toHaveBeenCalledTimes(2));
    expect(container).toBeEmptyDOMElement();
  });

  it('needs one inline confirm that states path and size before deleting, then drops the row', async () => {
    getRetiredDataInventory.mockResolvedValue([row('retired-training-runs', 'training-runs'), row('retired-lora-datasets', 'lora-datasets')]);
    deleteRetiredData.mockResolvedValue({ ok: true, operationId: 'retired-training-runs', removedFiles: 3, removedBytes: 2048, status: 'deleted' });
    render(<RetiredTrainingData />);
    fireEvent.click(await screen.findByRole('button', { name: /Delete Retired training-runs/ }));
    expect(deleteRetiredData).not.toHaveBeenCalled();
    const confirm = screen.getByLabelText('Confirm deleting Retired training-runs');
    expect(confirm.textContent).toContain('data/training-runs');
    expect(confirm.textContent).toContain('2 KB');
    expect(confirm.textContent).toContain('cannot be undone');
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));
    await waitFor(() => expect(deleteRetiredData).toHaveBeenCalledWith('retired-training-runs'));
    await waitFor(() => expect(screen.queryByText('Retired training-runs')).toBeNull());
    expect(screen.getByText('Retired lora-datasets')).toBeInTheDocument();
  });

  it('keeps the row when the delete is refused', async () => {
    getRetiredDataInventory.mockResolvedValue([row('retired-training-runs', 'training-runs')]);
    deleteRetiredData.mockRejectedValue(new Error('refused'));
    render(<RetiredTrainingData />);
    fireEvent.click(await screen.findByRole('button', { name: /Delete Retired training-runs/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));
    await waitFor(() => expect(deleteRetiredData).toHaveBeenCalled());
    expect(await screen.findByText('Retired training-runs')).toBeInTheDocument();
  });

  it.each([[1, 'Deleted 1 file ('], [3, 'Deleted 3 files (']])('words the deleted-files toast grammatically for %i', async (removedFiles, text) => {
    getRetiredDataInventory.mockResolvedValue([row('retired-training-runs', 'training-runs')]);
    deleteRetiredData.mockResolvedValue({ ok: true, operationId: 'retired-training-runs', removedFiles, removedBytes: 2048, status: 'deleted' });
    render(<RetiredTrainingData />);
    fireEvent.click(await screen.findByRole('button', { name: /Delete Retired training-runs/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.stringContaining(text)));
  });
});
