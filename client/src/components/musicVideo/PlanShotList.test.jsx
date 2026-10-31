import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import PlanShotList from './PlanShotList.jsx';

describe('PlanShotList', () => {
  // Uniquely catches a cold-open shot taking a song shot's number, or the count of shots on the song.
  it('leads with the shots before the song, then numbers the song\'s own shots in song order', () => {
    const project = { id: 'p', audioAnalysis: { durationSec: 10 }, scenes: [
      { sceneId: 'late', order: 2, startSec: 5, endSec: 10, lyricText: 'Hold the line' },
      { sceneId: 'booth', order: 0, startSec: 40, endSec: 42, visualIntent: 'He presses play',
        preMusic: { durationSec: 2.5, layers: [{ effect: 'play-button', atSec: 2 }] } },
      { sceneId: 'early', order: 1, startSec: 0, endSec: 5 },
    ] };
    render(<MemoryRouter><PlanShotList project={project} readiness={{ storyboard: { coverage: [] } }} onOpenShot={() => {}} /></MemoryRouter>);
    const rows = screen.getAllByRole('listitem').map((row) => row.textContent);
    expect(rows[0]).toMatch(/^Before song2\.50s.*Play button clunk.*Cold open 1 · He presses play/);
    expect(rows[1]).toMatch(/^0:00.*Shot 1/);
    expect(rows[2]).toMatch(/Hold the line.*Shot 2/);
    const counts = screen.getByRole('region', { name: 'Shot list' }).textContent;
    expect(counts).toMatch(/^2 shots cover 0:10/);
    expect(counts).toContain('0:02.50 before the song');
  });
});
