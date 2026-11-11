import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import TrackRenderCard from './TrackRenderCard';
import TrackRenderModal from './TrackRenderModal';

const ID = '11111111-2222-4333-8444-555555555555';
const take = (extra) => ({ id: 'r1', audioFilename: 'song.mp3', source: 'suno', prompt: 'dream pop', ...extra });

describe('TrackRenderCard Suno song link', () => {
  it('links a take that recorded a Suno song id and leaves the chip plain without one', () => {
    const { rerender } = render(<TrackRenderCard render={take({ sunoSongId: ID })} />);
    const link = screen.getByRole('link', { name: 'Suno' });
    expect(link).toHaveAttribute('href', `https://suno.com/song/${ID}`);
    expect(link).toHaveAttribute('target', '_blank');

    rerender(<TrackRenderCard render={take()} />);
    expect(screen.queryByRole('link', { name: 'Suno' })).toBeNull();
    expect(screen.getByText('Suno').tagName).toBe('SPAN');
  });
});

describe('TrackRenderModal Suno song link', () => {
  it('links the same provenance when the take recorded a Suno song id', () => {
    const { rerender } = render(<TrackRenderModal render={take({ sunoSongId: ID })} onClose={() => {}} />);
    expect(screen.getByRole('link', { name: 'Imported from Suno' })).toHaveAttribute('href', `https://suno.com/song/${ID}`);

    rerender(<TrackRenderModal render={take()} onClose={() => {}} />);
    expect(screen.queryByRole('link', { name: 'Imported from Suno' })).toBeNull();
    expect(screen.getByText('Imported from Suno')).toBeTruthy();
  });
});
