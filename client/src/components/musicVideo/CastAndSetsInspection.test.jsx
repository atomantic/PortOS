import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import CastAndSetsReferenceProgress from './CastAndSetsReferenceProgress.jsx';
vi.mock('../../hooks/useMediaJobProgress', () => ({ default: () => ({}) }));
const inputs = { key: 'set:lab', imageId: 'lab.png', jobId: 'job-1', imageRevision: 1,
  planPrompt: 'Empty interior lab, no people.', submittedPrompt: 'Empty interior lab, no people.' };
const image = { status: 'done', imageId: 'lab.png', jobId: 'job-1', submittedRevision: 1, submittedPrompt: inputs.submittedPrompt };
const stage = { revision: 1, status: 'review', plan: { 'set:lab': { key: 'set:lab', label: 'Lab', prompt: inputs.planPrompt } }, images: {
  'set:lab': { ...image, inspection: { id: 'inspection-1', inputs, verdict: 'mismatch', discrepancy: 'A crowded outdoor quay is visible.' } },
} };

describe('Cast & Sets inspection card', () => {
  it('shows the discrepancy and acknowledges the exact displayed image and inspection', () => {
    const onAcknowledgeImage = vi.fn();
    render(<CastAndSetsReferenceProgress stage={stage} onAcknowledgeImage={onAcknowledgeImage} />);
    expect(screen.getByText('Vision: prompt mismatch')).toBeTruthy();
    expect(screen.getByText('A crowded outdoor quay is visible.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Accept anyway' }));
    expect(onAcknowledgeImage).toHaveBeenCalledWith({ inputs, inspectionId: 'inspection-1' });
  });

  it('names a failed render-quality check as a rendering defect', () => {
    const defect = { ...stage, images: { 'set:lab': { ...image, inspection: { id: 'inspection-3', inputs, verdict: 'mismatch',
      discrepancy: 'Rendering defect: Chairs are molded into the table rim.', checks: [{ id: 'render-quality', status: 'fail', note: 'Chairs are molded into the table rim.' }] } } } };
    render(<CastAndSetsReferenceProgress stage={defect} onAcknowledgeImage={vi.fn()} />);
    expect(screen.getByText('Vision: rendering defect')).toBeTruthy();
    expect(screen.queryByText('Vision: prompt mismatch')).toBeNull();
  });

  it('shows stale or unavailable vision as unreviewed and keeps acknowledgement distinct from a pass', () => {
    const unreviewed = { ...stage, images: { 'set:lab': { ...image, inspection: { id: 'inspection-2', inputs, verdict: 'unreviewed', discrepancy: 'Vision unavailable.' },
      inspectionAcknowledgement: { inputs, inspectionId: 'inspection-2' } } } };
    const view = render(<CastAndSetsReferenceProgress stage={unreviewed} onAcknowledgeImage={vi.fn()} />);
    expect(screen.getByText('Vision: not checked')).toBeTruthy();
    expect(screen.getByText('You accepted it unchecked.')).toBeTruthy();
    expect(screen.queryByText('Vision: matches saved prompt')).toBeNull();
    view.rerender(<CastAndSetsReferenceProgress stage={{ ...stage, plan: { 'set:lab': { ...stage.plan['set:lab'], prompt: 'Different location.' } } }} onAcknowledgeImage={vi.fn()} />);
    expect(screen.getByText('Vision: not checked')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Accept unchecked' })).toBeTruthy();
  });

  // Uniquely catches an unavailable vision provider leaving the director only "accept".
  it('retries vision on an unchecked image, in review or approved, but not after a verdict', () => {
    const onReinspectImage = vi.fn();
    const unchecked = (status) => ({ ...stage, status, images: { 'set:lab': { ...image, inspection: { id: 'inspection-2', inputs, verdict: 'unreviewed', discrepancy: 'Vision unavailable: provider offline' } } } });
    const view = render(<CastAndSetsReferenceProgress stage={unchecked('approved')} onReinspectImage={onReinspectImage} onAcknowledgeImage={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Accept unchecked' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry vision' }));
    expect(onReinspectImage).toHaveBeenCalledWith('set:lab');
    view.rerender(<CastAndSetsReferenceProgress stage={unchecked('review')} onReinspectImage={onReinspectImage} onAcknowledgeImage={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Retry vision' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Accept unchecked' })).toBeTruthy();
    // While the retry runs, its answer could still be a mismatch: nothing to accept yet.
    const running = unchecked('review');
    running.images['set:lab'].inspection = { ...running.images['set:lab'].inspection, verdict: 'pending' };
    view.rerender(<CastAndSetsReferenceProgress stage={running} onReinspectImage={onReinspectImage} onAcknowledgeImage={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Accept unchecked' })).toBeNull();
    view.rerender(<CastAndSetsReferenceProgress stage={stage} onReinspectImage={onReinspectImage} onAcknowledgeImage={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Retry vision' })).toBeNull();
  });
});
