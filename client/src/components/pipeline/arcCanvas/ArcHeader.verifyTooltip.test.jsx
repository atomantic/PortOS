import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
vi.mock('../../../services/apiPipeline.js', () => ({
  generatePipelineArcOverview: vi.fn(), verifyPipelineArc: vi.fn(), resolvePipelineArcIssues: vi.fn(),
  derivePipelineArcFromManuscript: vi.fn(), commitPipelineArcFromManuscript: vi.fn(),
  analyzePipelineManuscriptCompleteness: vi.fn(), listPipelineIssues: vi.fn().mockResolvedValue([]), updatePipelineSeries: vi.fn(),
}));
vi.mock('../SeriesLlmPicker', () => ({ default: () => null }));
vi.mock('./ArcContent.jsx', () => ({ default: () => null }));
vi.mock('./DeriveFromManuscriptPreview.jsx', () => ({ default: () => null }));
import ArcHeader from './ArcHeader.jsx';

describe('ArcHeader verify scope tooltip', () => {
  it('has no dangling aria-describedby, and the scope tooltip opens on focus and dismisses with Escape', () => {
    render(<ArcHeader series={{ id: 's', arc: { logline: 'x' } }} onSeriesUpdate={vi.fn()} onFlushPending={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Verify arc' })).not.toHaveAttribute('aria-describedby');
    const info = screen.getByRole('button', { name: 'What Verify arc checks' });
    fireEvent.focus(info);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    expect(info).toHaveAttribute('aria-describedby', screen.getByRole('tooltip').id);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(info).not.toHaveAttribute('aria-describedby');
  });
});
