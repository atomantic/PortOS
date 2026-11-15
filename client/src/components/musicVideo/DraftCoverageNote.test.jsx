import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import DraftCoverageNote from './DraftCoverageNote.jsx';

const clip = (n, tier) => ({
  sceneId: `s${n}`, label: `Shot ${n}`, startSec: n * 2, endSec: n * 2 + 2, videoHistoryId: `v${n}`,
  takes: [{ takeId: `t${n}`, kind: 'video', assetId: `v${n}`, tier }],
});

// Uniquely catches the whole-video draft preview hiding which footage shots have nothing to play yet.
it('counts draft and final clips and names each footage shot with no clip, linking to it', () => {
  const onEditShot = vi.fn();
  const project = {
    id: 'p1',
    scenes: [clip(0, 'draft'), clip(1, 'final'), { sceneId: 's2', label: 'Bridge', startSec: 4, endSec: 6 }],
  };
  render(<DraftCoverageNote project={project} onEditShot={onEditShot} />);
  expect(screen.getByTestId('draft-coverage').textContent).toContain('1 draft · 1 final clip in this preview.');
  const missing = screen.getAllByRole('button');
  expect(missing).toHaveLength(1);
  fireEvent.click(missing[0]);
  expect(onEditShot).toHaveBeenCalledWith('s2');
});

it('says nothing when no shot has a clip or needs one', () => {
  render(<DraftCoverageNote project={{ id: 'p1', scenes: [] }} />);
  expect(screen.queryByTestId('draft-coverage')).toBeNull();
});
