// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import BoardStage from './BoardStage.jsx';

vi.mock('../../../hooks/useVideoFileSrc.js', () => ({ useVideoFileSrc: () => ({}) }));
vi.mock('../BeatTimeline.jsx', () => ({ default: () => null }));
vi.mock('../ContactSheetButton.jsx', () => ({ default: () => null }));
vi.mock('../TreatmentPanel.jsx', () => ({ default: () => null, treatmentSummary: () => '' }));
vi.mock('../ProjectActionGroups.jsx', () => ({ PlanActions: () => null }));

const scene = (n, extra = {}) => ({ sceneId: `s${n}`, order: n - 1, label: `Shot ${n}`, referenceImageId: 'f.png', videoHistoryId: 'v', startSec: 0, endSec: 3, takes: [], ...extra });
const board = (scenes, over = {}) => ({
  project: { id: 'p', scenes, composition: { mode: 'concat' } }, locked: false, busy: {},
  sceneMedia: { genScenes: {}, genVideoScenes: {}, failedScenes: { frame: {}, video: {} } },
  videoSettings: { settings: { backend: 'local' } }, takes: {}, treatment: {}, activeSceneId: null, onToggleSceneExpand: vi.fn(), ...over,
});
const Search = () => <output data-testid="search">{useLocation().search}</output>;
const renderBoard = (b, url = '/') => render(<MemoryRouter initialEntries={[url]}><BoardStage board={b} /><Search /></MemoryRouter>);

describe('BoardStage scene filter', () => {
  const scenes = [scene(1), scene(2, { videoHistoryId: null }), scene(3)];

  it('shows chips and counts, and lists only affected scenes from ?scenes=missing', () => {
    renderBoard(board(scenes), '/?scenes=missing');
    expect(screen.getByRole('button', { name: 'Needs attention (1)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Missing footage (1)' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getAllByText('Shot 2').length).toBeGreaterThan(0);
    expect(screen.queryByText('Shot 1')).toBeNull();
    expect(screen.getByText('No clip')).toBeTruthy();
  });

  it('writes the filter to the URL and removes it for All', () => {
    renderBoard(board(scenes));
    expect(screen.getByText('Shot 1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Needs attention (1)' }));
    expect(screen.getByTestId('search').textContent).toBe('?scenes=attention');
    expect(screen.queryByText('Shot 1')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'All (3)' }));
    expect(screen.getByTestId('search').textContent).toBe('');
  });

  it('j and k step through the listed scenes', () => {
    const b = board(scenes);
    renderBoard(b);
    fireEvent.keyDown(window, { key: 'j' });
    expect(b.onToggleSceneExpand).toHaveBeenLastCalledWith('s1', true);
    const second = board(scenes, { activeSceneId: 's2' });
    renderBoard(second);
    fireEvent.keyDown(window, { key: 'k' });
    expect(second.onToggleSceneExpand).toHaveBeenLastCalledWith('s1', true);
  });
});
