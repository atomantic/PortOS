import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../../services/api', () => ({
  getDigitalTwinEnrichQuestion: vi.fn(),
  submitSoulEnrichAnswer: vi.fn(),
}));
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import * as api from '../../services/api';
import NextActionBanner from './NextActionBanner';

const GAPS = [
  { dimension: 'identity', confidence: 0.2, suggestedCategory: 'core_memories' },
  { dimension: 'values', confidence: 0.3, suggestedCategory: 'values' },
];

const renderBanner = (props = {}) => render(
  <MemoryRouter>
    <NextActionBanner gaps={GAPS} status={{}} traits={{ openness: 0.5 }} {...props} />
  </MemoryRouter>
);

describe('NextActionBanner question load', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('keeps the gap and offers Retry when the question read fails, instead of claiming all questions are answered', async () => {
    api.getDigitalTwinEnrichQuestion
      .mockRejectedValueOnce(new Error('provider down'))
      .mockResolvedValueOnce({ questionId: 'q1', question: 'Describe a formative memory.', questionIndex: 0 });
    renderBanner();

    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not load the next question.*provider down/);
    expect(screen.queryByText(/All enrichment questions answered/)).toBeNull();
    expect(screen.getByText(/Quick Enrich: Identity/)).toBeInTheDocument();
    expect(api.getDigitalTwinEnrichQuestion).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Describe a formative memory.')).toBeInTheDocument();
    expect(api.getDigitalTwinEnrichQuestion).toHaveBeenLastCalledWith('core_memories', undefined, undefined, undefined, { silent: true });
  });

  it('still advances to the next gap when the category is exhausted (null answer)', async () => {
    api.getDigitalTwinEnrichQuestion
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ questionId: 'q2', question: 'What do you value most?', questionIndex: 0 });
    renderBanner();

    expect(await screen.findByText('What do you value most?')).toBeInTheDocument();
    await waitFor(() => expect(api.getDigitalTwinEnrichQuestion).toHaveBeenLastCalledWith('values', undefined, undefined, undefined, { silent: true }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('asks for one next question per answer even though the parent re-sends gaps after the refresh', async () => {
    api.getDigitalTwinEnrichQuestion
      .mockResolvedValueOnce({ questionId: 'q1', question: 'First question?', questionIndex: 0 })
      .mockResolvedValue({ questionId: 'q2', question: 'Second question?', questionIndex: 1 });
    api.submitSoulEnrichAnswer.mockResolvedValue({ ok: true });
    let rerenderBanner;
    const onRefresh = vi.fn(() => {
      // The Overview reloads gaps on refresh: same categories, new array.
      rerenderBanner(<MemoryRouter><NextActionBanner gaps={GAPS.map((g) => ({ ...g }))} status={{}} traits={{ openness: 0.5 }} onRefresh={onRefresh} /></MemoryRouter>);
    });
    const view = renderBanner({ onRefresh });
    rerenderBanner = view.rerender;

    fireEvent.change(await screen.findByLabelText('Your answer'), { target: { value: 'An answer.' } });
    fireEvent.click(screen.getByRole('button', { name: /Submit/ }));

    expect(await screen.findByText('Second question?')).toBeInTheDocument();
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(api.getDigitalTwinEnrichQuestion).toHaveBeenCalledTimes(2);
  });
});
