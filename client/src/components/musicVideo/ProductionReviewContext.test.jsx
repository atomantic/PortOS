import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
vi.mock('./DevArtifactPreview.jsx', () => ({ default: () => <div>guide preview</div> }));
import ProductionReviewContext from './ProductionReviewContext.jsx';

const project = {
  id: 'p', version: 2, composition: { mode: 'document', document: { directory: 'docs/example-doc' } },
  lyricCues: [{ id: 'c1', text: 'Example line' }],
  devArtifacts: [{ id: 'g', title: 'Example guide', version: 1 }],
  productionReview: { draft: {
    storyboardSource: 'document', guideArtifactId: 'g', cast: 'Example cast text',
    storyboard: [
      { id: 's1', label: 'Opening', startSec: 0, endSec: 12, action: 'Lights come up', staging: 'Wide', camera: 'Static', transition: 'Cut', lyricCueIds: ['c1'] },
      { id: 's2', label: 'Chorus', startSec: 72, endSec: 95, action: 'Everything moves', staging: '', camera: '', transition: '' },
    ],
  } },
};

describe('ProductionReviewContext', () => {
  it('lists each storyboard shot as one row with a play button, keeping its recipe folded', () => {
    const onSeek = vi.fn();
    render(<ProductionReviewContext stage="storyboard" project={project} onSeek={onSeek} />);
    expect(screen.getByText(/Watch the storyboard in the player, then approve/)).toBeTruthy();
    const list = screen.getByRole('list', { name: 'Current storyboard shots' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    // The recipe sits inside each shot's closed fold, not on the page.
    const fold = screen.getByText('Lights come up').closest('details');
    expect(fold.open).toBe(false);
    // The flex summary draws its own disclosure chevron.
    expect(fold.querySelector('summary svg')).toBeTruthy();
    expect(within(rows[0]).getByText('Opening')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Play shot 2 in the preview' }));
    expect(onSeek).toHaveBeenCalledWith(72);
  });

  it('shows the visual guide for art and folds the written direction', () => {
    render(<ProductionReviewContext stage="art" project={project} onOpenArtifact={vi.fn()} />);
    expect(screen.getByText('guide preview')).toBeTruthy();
    expect(screen.getByText('Example cast text').closest('details').open).toBe(false);
  });
});
