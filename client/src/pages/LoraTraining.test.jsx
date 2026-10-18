import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../services/api', () => ({
  listLoraDatasets: vi.fn(),
  createLoraDataset: vi.fn(),
  deleteLoraDataset: vi.fn(),
}));
vi.mock('../components/loraTraining/UniverseCharacterPicker', () => ({ default: () => null }));
vi.mock('../components/media/MediaJobsQueue', () => ({ default: () => null }));
vi.mock('../components/ui/Toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));

import LoraTraining from './LoraTraining.jsx';
import { listLoraDatasets } from '../services/api';

describe('LoraTraining page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders ListLoadError with retry on failed datasets load, and empty state on real empty list', async () => {
    listLoraDatasets.mockRejectedValueOnce(new Error('500 Internal Server Error'));
    render(
      <MemoryRouter>
        <LoraTraining />
      </MemoryRouter>
    );
    await act(async () => {});

    expect(screen.getByRole('alert')).toHaveTextContent('Could not load datasets — 500 Internal Server Error');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByText('Train a LoRA for consistent universe subjects.')).not.toBeInTheDocument();

    listLoraDatasets.mockResolvedValueOnce([]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('Train a LoRA for consistent universe subjects.')).toBeInTheDocument();
  });

  it('renders datasets when load succeeds', async () => {
    listLoraDatasets.mockResolvedValueOnce([
      { id: 'ds-1', character: { name: 'Captain Nova' }, status: 'draft', imageCount: 12 },
    ]);
    render(
      <MemoryRouter>
        <LoraTraining />
      </MemoryRouter>
    );
    await act(async () => {});

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('Captain Nova')).toBeInTheDocument();
    expect(screen.queryByText('Train a LoRA for consistent universe subjects.')).not.toBeInTheDocument();
  });
});
