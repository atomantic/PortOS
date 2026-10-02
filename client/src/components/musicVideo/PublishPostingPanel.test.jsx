/**
 * Posting panel (#9282): hidden until the kit is built, fills a draft with the
 * platform's options, shows the filled draft for review, posts only on the
 * explicit Post press, and keeps a sign-in refusal beside its platform.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import PublishPostingPanel, { PUBLISH_TARGETS } from './PublishPostingPanel.jsx';

const ALL = ['youtube', 'suno', 'x', 'shorts', 'tiktok', 'instagram', 'reddit', 'stackerNews'];
const hook = (over = {}) => ({ drafts: {}, busy: {}, errors: {}, prepare: vi.fn(), submit: vi.fn(), discard: vi.fn(), enabledTargets: ALL, platforms: {}, recordPost: vi.fn(async () => null), ...over });
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
    fireEvent.change(within(reddit).getByLabelText('Instance password to prepare Reddit'), { target: { value: 'synthetic-password' } });
    fireEvent.click(within(reddit).getByRole('button', { name: 'Fill draft' }));
    expect(publishing.prepare).toHaveBeenCalledWith('reddit', { subreddit: 'SunoAI', kind: 'link', password: 'synthetic-password' });
  });

  it('shows the filled draft and requires manual platform publication', () => {
    const publishing = hook({ drafts: { stackerNews: { draftId: 'd1', summary: { title: 'Song', territory: 'art' }, screenshot: 'data:image/jpeg;base64,AA' } } });
    render(<PublishPostingPanel project={project()} publishing={publishing} />);
    const sn = row('Stacker News');
    expect(within(sn).getByAltText('Stacker News draft as filled')).toBeInTheDocument();
    expect(within(sn).getByText('Song')).toBeInTheDocument();
    expect(publishing.submit).not.toHaveBeenCalled();
    expect(within(sn).queryByRole('button', { name: /Post to Stacker News/ })).toBeNull();
    expect(within(sn).getByText(/PortOS cannot submit this draft/)).toBeInTheDocument();
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

  it('offers only the platforms turned on, with the account posted as', () => {
    render(<PublishPostingPanel project={project()} publishing={hook({ enabledTargets: ['x', 'youtube'], platforms: { x: { enabled: true, account: 'antic' } } })} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.queryByText('Reddit', { selector: 'div' })).toBeNull();
    expect(screen.getByText('as @antic')).toBeInTheDocument();
  });

  it('asks for platforms when none are on', () => {
    render(<PublishPostingPanel project={project()} publishing={hook({ enabledTargets: [] })} />);
    expect(screen.getByText(/Turn on the platforms you use/)).toBeInTheDocument();
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });

  it('rates a posted post and records a post made by hand', async () => {
    const publishing = hook({ enabledTargets: ['youtube', 'x'], recordPost: vi.fn(async () => ({ url: 'saved' })) });
    render(<PublishPostingPanel project={project({ posts: { youtube: { url: 'https://youtu.be/abc', reception: 'good' } } })} publishing={publishing} />);
    const yt = row('YouTube');
    expect(within(yt).getByRole('button', { name: 'Good' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(yt).getByRole('button', { name: 'Poor' }));
    expect(publishing.recordPost).toHaveBeenCalledWith('youtube', { reception: 'poor' });
    const notes = within(yt).getByLabelText('Notes on the YouTube post');
    fireEvent.change(notes, { target: { value: 'slow start' } });
    fireEvent.blur(notes);
    expect(publishing.recordPost).toHaveBeenCalledWith('youtube', { notes: 'slow start' });

    const x = row('X thread');
    const record = within(x).getByRole('button', { name: /Record/ });
    expect(record).toBeDisabled();
    fireEvent.change(within(x).getByLabelText('Link to a X thread post made by hand'), { target: { value: 'https://x.com/antic/status/1' } });
    await act(async () => { fireEvent.click(record); });
    expect(publishing.recordPost).toHaveBeenCalledWith('x', { url: 'https://x.com/antic/status/1' });
    expect(within(x).getByLabelText('Link to a X thread post made by hand')).toHaveValue('');
  });
});
