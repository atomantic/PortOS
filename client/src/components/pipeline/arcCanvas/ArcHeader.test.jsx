import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
const api = vi.hoisted(() => ({
  generatePipelineArcOverview: vi.fn(), verifyPipelineArc: vi.fn(), resolvePipelineArcIssues: vi.fn(),
  derivePipelineArcFromManuscript: vi.fn(), commitPipelineArcFromManuscript: vi.fn(),
  analyzePipelineManuscriptCompleteness: vi.fn(), listPipelineIssues: vi.fn().mockResolvedValue([]), updatePipelineSeries: vi.fn(),
}));
vi.mock('../../../services/api', () => api);
vi.mock('../SeriesLlmPicker', () => ({ default: () => null }));
vi.mock('./ArcContent.jsx', () => ({ default: () => null }));
vi.mock('./DeriveFromManuscriptPreview.jsx', () => ({ default: () => null }));
import ArcHeader from './ArcHeader.jsx';

describe('ArcHeader saved-input gate', () => {
  it('does not call the generation provider after a failed draft save, and allows retry', async () => {
    const flush = vi.fn().mockResolvedValue(null);
    api.generatePipelineArcOverview.mockResolvedValue({ series: { id: 's' } });
    render(<ArcHeader series={{ id: 's', arc: null }} onSeriesUpdate={vi.fn()} onFlushPending={flush} />);
    fireEvent.click(screen.getByRole('button', { name: 'Generate arc' }));
    await waitFor(() => expect(flush).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate arc' }).disabled).toBe(false));
    expect(api.generatePipelineArcOverview).not.toHaveBeenCalled();
    flush.mockResolvedValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Generate arc' }));
    await waitFor(() => expect(api.generatePipelineArcOverview).toHaveBeenCalledOnce());
  });
});
