import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({
  narratePipelineProse: vi.fn(),
  rerenderNarrationSegment: vi.fn(),
  acceptNarrationSegmentSpeech: vi.fn(),
}));
vi.mock('../../../services/api', () => api);
vi.mock('../../voice/VoicePicker', () => ({ default: () => null }));
vi.mock('../../ui/Toast', () => ({ default: Object.assign(vi.fn(), { error: vi.fn() }) }));

import ManuscriptReadAloud from './ManuscriptReadAloud';

const CONTENT = 'The AI woke. Dawn came.';
const segment = (index, start, end, verification) => ({
  index, text: CONTENT.slice(start, end), start, end, filename: `s${index}.wav`, durationMs: 500,
  verification, readability: { hard: false, reasons: [] },
});

describe('ManuscriptReadAloud segment review', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
    window.HTMLMediaElement.prototype.pause = vi.fn();
    api.narratePipelineProse.mockResolvedValue({
      segments: [
        segment(0, 0, 12, { status: 'mismatch', similarity: 0.4, heard: 'The ay eye woke' }),
        segment(1, 13, 23, { status: 'matched', similarity: 1, heard: 'Dawn came' }),
      ],
    });
  });

  const open = async () => {
    render(<ManuscriptReadAloud open onClose={() => {}} section={{ content: CONTENT, number: 1, stageId: 'draft' }} />);
    fireEvent.click(screen.getByText('Read aloud', { selector: 'button' }));
    await screen.findByText(/need a listen/);
  };

  it('accepts a misheard sentence as spoken and clears it from the review list', async () => {
    api.acceptNarrationSegmentSpeech.mockResolvedValue({
      expectedSpeech: 'The ay eye woke', verification: { status: 'matched', similarity: 1, heard: 'The ay eye woke' },
    });
    await open();
    fireEvent.click(screen.getByText('Accept as spoken'));
    await waitFor(() => expect(screen.queryByText(/need a listen/)).not.toBeInTheDocument());
    expect(api.acceptNarrationSegmentSpeech).toHaveBeenCalledWith('The AI woke.', 'The ay eye woke', 'The ay eye woke', { silent: true });
  });

  it('re-renders a misheard sentence with fresh audio and its new check', async () => {
    api.rerenderNarrationSegment.mockResolvedValue({
      filename: 'fresh.wav', durationMs: 600, verification: { status: 'matched', similarity: 1, heard: 'The AI woke' },
    });
    await open();
    fireEvent.click(screen.getByText('Re-render'));
    await waitFor(() => expect(screen.queryByText(/need a listen/)).not.toBeInTheDocument());
    expect(api.rerenderNarrationSegment).toHaveBeenCalledWith('The AI woke.', undefined, undefined, { silent: true });
  });
});
