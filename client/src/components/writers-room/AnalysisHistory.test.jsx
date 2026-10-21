import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../ui/Toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

const listWritersRoomAnalyses = vi.fn();
vi.mock('../../services/apiWritersRoom', () => ({
  listWritersRoomAnalyses: (...a) => listWritersRoomAnalyses(...a),
  getWritersRoomAnalysis: vi.fn(),
}));

import AnalysisHistory from './AnalysisHistory';

const renderHistory = async () => {
  render(<AnalysisHistory work={{ id: 'work-1' }} activeHash="h1" onApplyFormat={() => {}} />);
  await act(async () => {});
};

beforeEach(() => vi.clearAllMocks());

describe('AnalysisHistory', () => {
  it('shows the empty copy only for a list that loaded empty', async () => {
    listWritersRoomAnalyses.mockResolvedValue([]);
    await renderHistory();
    expect(screen.getByText(/No analyses yet/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows a load error with Retry — not "No analyses yet" — when the read fails', async () => {
    listWritersRoomAnalyses.mockRejectedValueOnce(new Error('Server unavailable'));
    await renderHistory();
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load analyses — Server unavailable');
    expect(screen.queryByText(/No analyses yet/)).toBeNull();

    listWritersRoomAnalyses.mockResolvedValueOnce([
      { id: 'a1', kind: 'evaluate', status: 'succeeded', createdAt: '2026-01-01T00:00:00Z' },
    ]);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Evaluate')).toBeInTheDocument();
  });
});
