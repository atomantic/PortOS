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

  // Uniquely catches a split's copied row speaking for its pieces, and the list naming a shot by a position its card doesn't use.
  it('after a shot is deleted and another split, names each shot as its card does and describes what each piece renders', () => {
    const inherited = { action: 'Parent rides through town', staging: 'Street', camera: 'Parent camera', transition: 'Cut', lyricCueIds: [] };
    const project = { id: 'p', scenes: [
      { sceneId: 'a', order: 0, label: 'Shot 1', startSec: 0, endSec: 4, prompt: 'A prompt' },
      // "Shot 2" was deleted, so "Shot 3" now plays second; it was then split in three.
      { sceneId: 'b1', order: 1, label: 'Shot 3 · 1/3', startSec: 4, endSec: 6, prompt: 'Close on the handlebars', camera: { move: 'whip-pan' } },
      { sceneId: 'b2', order: 2, label: 'Shot 3 · 2/3', startSec: 6, endSec: 8, prompt: 'Wide on the street', shotSheet: { action: 'Rides past the mall' } },
      { sceneId: 'b3', order: 3, label: 'Shot 3 · 3/3', startSec: 8, endSec: 10, visualIntent: 'She looks back' },
      { sceneId: 'c', order: 4, label: 'Chorus', startSec: 10, endSec: 12, prompt: 'Unused' },
    ] };
    const shots = [
      { sceneId: 'a', action: 'Opening ride', staging: 'Street', camera: 'Dolly', transition: 'Cut', lyricCueIds: [] },
      ...['b1', 'b2', 'b3'].map((sceneId) => ({ sceneId, ...inherited })),
      { sceneId: 'c', action: 'The whole band plays', staging: 'Stage', camera: 'Crane', transition: 'Cut', lyricCueIds: [] },
    ];
    render(<MemoryRouter><PlanShotList project={project} readiness={{ storyboard: { coverage: [], shots } }} onOpenShot={() => {}} /></MemoryRouter>);
    const rows = screen.getAllByRole('listitem').map((row) => row.textContent);
    expect(rows.join()).not.toContain('Parent');
    expect(rows[0]).toContain('Shot 1 · Dolly · Opening ride');
    expect(rows[1]).toContain('Shot 3 · 1/3 · Whip pan · Close on the handlebars');
    expect(rows[2]).toContain('Shot 3 · 2/3 · Rides past the mall');
    expect(rows[3]).toContain('Shot 3 · 3/3 · She looks back');
    expect(rows[4]).toContain('Shot 5 · Chorus · Crane · The whole band plays');
    expect(screen.getByRole('button', { name: 'Edit Shot 3 · 2/3' })).toBeTruthy();
  });

  // Uniquely catches a sheet action being read as a copy: two shots may share one on purpose.
  it('keeps an action two shots share on their sheets', () => {
    const shotSheet = { action: 'Both keep riding' };
    const project = { id: 'p', scenes: [
      { sceneId: 'a', order: 0, startSec: 0, endSec: 2, prompt: 'One', shotSheet },
      { sceneId: 'b', order: 1, startSec: 2, endSec: 4, prompt: 'Two', shotSheet },
    ] };
    render(<MemoryRouter><PlanShotList project={project} readiness={{ storyboard: { coverage: [] } }} onOpenShot={() => {}} /></MemoryRouter>);
    expect(screen.getAllByRole('listitem').map((row) => row.textContent).every((text) => text.includes('Both keep riding'))).toBe(true);
  });
});
