/**
 * Posting panel (#9282): hidden until the kit is built, fills a draft with the
 * platform's options, shows the filled draft for review, posts only on the
 * explicit Post press, and keeps a sign-in refusal beside its platform.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import PublishPostingPanel, { PUBLISH_TARGETS } from './PublishPostingPanel.jsx';

const hook = (over = {}) => ({ drafts: {}, busy: {}, errors: {}, prepare: vi.fn(), submit: vi.fn(), discard: vi.fn(), ...over });
const project = (kit = {}) => ({ id: 'mv-1', publishKit: { builtAt: '2026-01-01T00:00:00.000Z', thumbnails: ['t1.jpg'], ...kit } });
const row = (label) => screen.getByText(label, { selector: 'div' }).closest('li');

describe('PublishPostingPanel (#9282)', () => {
  it('stays hidden until the publishing kit is built', () => {
    const { container } = render(<PublishPostingPanel project={{ id: 'mv-1', publishKit: {} }} publishing={hook()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists every platform, full video first, with recorded posts linked', () => {
    render(<PublishPostingPanel project={project({ posts: { youtube: { url: 'https://youtu.be/abc', postedAt: '2026-01-02T00:00:00.000Z' } } })} publishing={hook()} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(PUBLISH_TARGETS.length);
    expect(PUBLISH_TARGETS[0].target).toBe('youtube');
    expect(within(row('YouTube')).getByRole('link')).toHaveAttribute('href', 'https://youtu.be/abc');
  });

  it('fills a Reddit draft with the subreddit and post type, dropping blanks', () => {
    const publishing = hook();
    render(<PublishPostingPanel project={project()} publishing={publishing} />);
    const reddit = row('Reddit');
    fireEvent.change(within(reddit).getByLabelText('Subreddit'), { target: { value: 'SunoAI' } });
    fireEvent.change(within(reddit).getByLabelText('Post type'), { target: { value: 'link' } });
    fireEvent.click(within(reddit).getByRole('button', { name: 'Fill draft' }));
    expect(publishing.prepare).toHaveBeenCalledWith('reddit', { subreddit: 'SunoAI', kind: 'link' });
  });

  it('shows the filled draft and posts only when Post is pressed', () => {
    const publishing = hook({ drafts: { stackerNews: { draftId: 'd1', summary: { title: 'Song', territory: 'art' }, screenshot: 'data:image/jpeg;base64,AA' } } });
    render(<PublishPostingPanel project={project()} publishing={publishing} />);
    const sn = row('Stacker News');
    expect(within(sn).getByAltText('Stacker News draft as filled')).toBeInTheDocument();
    expect(within(sn).getByText('Song')).toBeInTheDocument();
    expect(publishing.submit).not.toHaveBeenCalled();
    fireEvent.click(within(sn).getByRole('button', { name: /Post to Stacker News/ }));
    expect(publishing.submit).toHaveBeenCalledWith('stackerNews');
    fireEvent.click(within(sn).getByRole('button', { name: /Discard/ }));
    expect(publishing.discard).toHaveBeenCalledWith('stackerNews');
  });

  it('keeps a sign-in refusal beside its platform', () => {
    const publishing = hook({ errors: { tiktok: { message: 'Sign in to TikTok in the PortOS Browser', code: 'PUBLISH_LOGIN_REQUIRED', url: 'https://www.tiktok.com/login' } } });
    render(<PublishPostingPanel project={project()} publishing={publishing} />);
    const alert = within(row('TikTok')).getByRole('alert');
    expect(alert).toHaveTextContent('Sign in to TikTok');
    expect(alert).toHaveTextContent('https://www.tiktok.com/login');
  });
});
