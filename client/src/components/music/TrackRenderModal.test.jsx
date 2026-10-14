import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import TrackRenderModal from './TrackRenderModal';
import { copyToClipboard } from '../../lib/clipboard';

vi.mock('../../lib/clipboard', () => ({ copyToClipboard: vi.fn() }));

describe('TrackRenderModal lyric provenance', () => {
  it('shows and copies the exact lyric sheet that conditioned a completed instrumental take', () => {
    const sentLyrics = '[intro]\n[instrumental]\n[outro]';
    render(<TrackRenderModal render={{
      id: 'take-1', audioFilename: 'take.wav', engine: 'minimax-music3', lyrics: '',
      sentLyrics, lyricAdditions: [{ id: 'instrumental-sections', label: 'Instrumental sections', text: sentLyrics }],
    }} onClose={vi.fn()} />);
    const region = screen.getByRole('region', { name: 'Lyrics sent to the model' });
    fireEvent.click(within(region).getByRole('button', { name: '+ Instrumental sections' }));
    expect(region.querySelector('p.whitespace-pre-wrap').textContent).toBe(sentLyrics);
    fireEvent.click(within(region).getByRole('button', { name: 'Show full prompt' }));
    expect(region.querySelector('pre').textContent).toBe(sentLyrics);
    fireEvent.click(within(region).getByRole('button', { name: 'Copy full prompt' }));
    expect(copyToClipboard).toHaveBeenCalledWith(sentLyrics, 'Full prompt copied');
  });
});
