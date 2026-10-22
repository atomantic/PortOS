import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../ui/Toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
const listLoraTrainingCheckpoints = vi.fn();
vi.mock('../../services/api', () => ({
  listLoraTrainingCheckpoints: (...a) => listLoraTrainingCheckpoints(...a),
  promoteLoraTrainingCheckpoint: vi.fn(),
}));

import CheckpointPicker from './CheckpointPicker';

const expand = async () => {
  render(<CheckpointPicker run={{ id: 'run-1', output: {} }} />);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Checkpoints/ })); });
};

beforeEach(() => vi.clearAllMocks());

describe('CheckpointPicker', () => {
  it('shows a Retry — not "No checkpoints recorded" — when the list read fails, and lists them on retry', async () => {
    listLoraTrainingCheckpoints.mockRejectedValueOnce(new Error('Server unavailable'));
    await expand();
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load checkpoints — Server unavailable');
    expect(screen.queryByText(/No checkpoints recorded/)).toBeNull();

    listLoraTrainingCheckpoints.mockResolvedValueOnce({ checkpoints: [{ step: 500, loss: 0.1, hasPreview: true, previewUrl: '/p.png' }] });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('step 500')).toBeInTheDocument();
  });

  it('says "No checkpoints recorded" only for a successful empty list', async () => {
    listLoraTrainingCheckpoints.mockResolvedValueOnce({ checkpoints: [] });
    await expand();
    expect(screen.getByText('No checkpoints recorded for this run.')).toBeInTheDocument();
  });
});
