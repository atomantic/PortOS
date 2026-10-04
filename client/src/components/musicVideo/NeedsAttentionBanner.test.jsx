import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import NeedsAttentionBanner from './NeedsAttentionBanner.jsx';
import MusicVideoLayout from './MusicVideoLayout.jsx';
import { MUSIC_VIDEO_STAGES } from '../../lib/musicVideoStages.js';
import { deriveAttentionItems } from '../../lib/musicVideoAttention.js';

const actions = () => ({
  onResumeRevision: vi.fn(), onCancelRevision: vi.fn(), onResumeCastAndSets: vi.fn(),
  onContinueAutoReview: vi.fn(), onCancelAutoReview: vi.fn(), onReattachRender: vi.fn(),
});

const stranded = {
  id: 'mv-example',
  status: 'rendering',
  scenes: [{ sceneId: 'scene-a' }],
  castAndSets: { status: 'imaging', interrupted: true },
  revisions: [{ id: 'mvrev-open', status: 'open', sections: [{ sceneId: 'scene-a', kind: 'video', verdict: 'rejected' }] }],
  autoReviews: [],
};

describe('NeedsAttentionBanner (#9940)', () => {
  it('renders nothing when there is nothing to attend to', () => {
    const { container } = render(<NeedsAttentionBanner items={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('offers Resume and Cancel for an open revision, wired to the id the project holds', () => {
    const handlers = actions();
    render(<NeedsAttentionBanner items={deriveAttentionItems({ ...stranded, status: 'complete', castAndSets: null })} actions={handlers} />);
    const banner = screen.getByRole('region', { name: 'Needs attention' });
    expect(banner).toHaveTextContent('A section revision is open');
    fireEvent.click(within(banner).getByRole('button', { name: 'Resume the open revision' }));
    expect(handlers.onResumeRevision).toHaveBeenCalledWith('mvrev-open');
    fireEvent.click(within(banner).getByRole('button', { name: 'Cancel the open revision' }));
    expect(handlers.onCancelRevision).toHaveBeenCalledWith('mvrev-open');
  });

  it('covers an interrupted check-in, a waiting auto-review and an unwatched final render, each with its own exit', () => {
    const handlers = actions();
    const project = {
      ...stranded,
      revisions: [{ id: 'mvrev-owned', status: 'open', sections: [{ sceneId: 'scene-a', kind: 'image', verdict: 'rejected' }] }],
      autoReviews: [{ id: 'mvar-example', status: 'running', attempts: [{ n: 1, revisionId: 'mvrev-owned' }] }],
    };
    render(<NeedsAttentionBanner items={deriveAttentionItems(project)} actions={handlers} />);
    fireEvent.click(screen.getByRole('button', { name: 'Resume the Cast & Sets check-in' }));
    expect(handlers.onResumeCastAndSets).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Continue the auto-review run' }));
    expect(handlers.onContinueAutoReview).toHaveBeenCalledWith('mvar-example');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel the auto-review run' }));
    expect(handlers.onCancelAutoReview).toHaveBeenCalledWith('mvar-example');
    fireEvent.click(screen.getByRole('button', { name: 'Reattach to the final render' }));
    expect(handlers.onReattachRender).toHaveBeenCalledTimes(1);
    // The run owns its revision: no second, competing Resume for it.
    expect(screen.queryByRole('button', { name: 'Resume the open revision' })).not.toBeInTheDocument();
  });

  it('shows only Cancel while a revision re-renders, and disables every exit while a request is busy', () => {
    const rendering = { ...stranded, status: 'complete', castAndSets: null, revisions: [{ ...stranded.revisions[0], status: 'rendering' }] };
    render(<NeedsAttentionBanner items={deriveAttentionItems(rendering)} busy actions={actions()} />);
    expect(screen.queryByRole('button', { name: 'Resume the open revision' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel the open revision' })).toBeDisabled();
  });

  it('sits in the Music Video header under the status line, on every stage', () => {
    render(<MusicVideoLayout project={{ id: 'example-project', name: 'Example Project' }} stage="board"
      onStageChange={() => {}} progress={{ current: 'board', stages: MUSIC_VIDEO_STAGES.map((stage) => ({ ...stage, state: 'todo' })) }}
      spend={{ spentUsd: 0 }}
      status={{ headline: 'Stage 3 of 7: Board', tone: 'muted', facts: [] }}
      attention={<NeedsAttentionBanner items={deriveAttentionItems(stranded)} actions={actions()} />} />);
    const header = screen.getByRole('banner');
    expect(within(header).getByRole('region', { name: 'Needs attention' })).toBeInTheDocument();
    // Both live in the sticky header, so a director never has to hunt for the way out.
    expect(within(header).getByRole('status', { name: 'Project status' })).toBeInTheDocument();
  });
});
