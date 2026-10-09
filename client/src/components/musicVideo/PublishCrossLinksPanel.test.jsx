/**
 * Cross-links card: lists the links each post already up still lacks, fills
 * its edit in the PortOS Browser on request, and counts the links only when
 * the director says they saved it.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import PublishCrossLinksPanel from './PublishCrossLinksPanel.jsx';

const project = (kit = {}) => ({ id: 'mv-1', publishKit: { builtAt: '2026-01-01T00:00:00.000Z', ...kit } });
const posts = {
  x: { url: 'https://x.com/example/status/1', postedAt: '2026-01-01T00:00:00Z', links: [] },
  youtube: { url: 'https://youtu.be/abc', postedAt: '2026-01-01T01:00:00Z', links: ['x'] },
};
const hook = (over = {}) => ({ prepareCrossLinks: vi.fn(), recordPost: vi.fn(async () => ({})), setCrossLinks: vi.fn(async () => true), ...over });

describe('PublishCrossLinksPanel', () => {
  it('fills the X reply with the video link, then records it as linked on Saved', async () => {
    const publishing = hook({ prepareCrossLinks: vi.fn(async () => ({ target: 'x', links: ['youtube'], screenshot: 'data:image/jpeg;base64,AA', summary: { leftForYou: ['Reply'] } })) });
    render(<PublishCrossLinksPanel project={project({ posts })} publishing={publishing} />);
    expect(screen.getByText('Links every other post')).toBeInTheDocument(); // YouTube already links X
    expect(screen.getByText('Music video: https://youtu.be/abc')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Fill reply' }));
    expect(await screen.findByAltText('X reply with the links filled in')).toBeInTheDocument();
    expect(publishing.prepareCrossLinks).toHaveBeenCalledWith('x');
    expect(publishing.recordPost).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Mark the X reply links saved' }));
    expect(publishing.recordPost).toHaveBeenCalledWith('x', { links: ['youtube'] });
    await waitFor(() => expect(screen.queryByAltText('X reply with the links filled in')).not.toBeInTheDocument());
  });

  it('keeps a sign-in refusal beside its row and toggles links in new drafts', async () => {
    const publishing = hook({ prepareCrossLinks: vi.fn(async () => { throw Object.assign(new Error('Sign in to X in the PortOS Browser'), { code: 'PUBLISH_LOGIN_REQUIRED' }); }) });
    render(<PublishCrossLinksPanel project={project({ posts })} publishing={publishing} />);
    fireEvent.click(screen.getByRole('button', { name: 'Fill reply' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign in to X');
    fireEvent.click(screen.getByLabelText(/New drafts link the posts already made/));
    expect(publishing.setCrossLinks).toHaveBeenCalledWith(false);
  });
});
