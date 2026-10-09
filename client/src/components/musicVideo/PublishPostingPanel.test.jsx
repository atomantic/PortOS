/**
 * Posting panel (#9282): hidden until the kit is built, fills a draft with the
 * platform's options, shows the filled draft for review, posts only on the
 * explicit Post press, and keeps a sign-in refusal beside its platform.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import PublishPostingPanel, { PUBLISH_TARGETS } from './PublishPostingPanel.jsx';

// Publish cards and platform rows fold when done; open everything so a test sees the whole page.
const expandAll = () => { for (let b = screen.queryAllByRole('button', { expanded: false }); b.length; b = screen.queryAllByRole('button', { expanded: false })) b.forEach((x) => fireEvent.click(x)); };

const ALL = ['youtube', 'suno', 'sunoHook', 'x', 'shorts', 'tiktok', 'instagram', 'reddit', 'stackerNews', 'substack', 'distrokid'];
const hook = (over = {}) => ({ drafts: {}, busy: {}, errors: {}, prepare: vi.fn(), submit: vi.fn(), discard: vi.fn(), enabledTargets: ALL, platforms: {}, recordPost: vi.fn(async () => null), ...over });
const project = (kit = {}) => ({ id: 'mv-1', publishKit: { builtAt: '2026-01-01T00:00:00.000Z', thumbnails: ['t1.jpg'], ...kit } });
const row = (label) => screen.getAllByRole('listitem').find((li) => li.querySelector('h4 button > span')?.firstChild?.textContent === label);

describe('PublishPostingPanel (#9282)', () => {
  it('stays hidden until the publishing kit is built', () => {
    const { container } = render(<PublishPostingPanel project={{ id: 'mv-1', publishKit: {} }} publishing={hook()} />);
    expandAll();
    expect(container).toBeEmptyDOMElement();
  });

  it('lists every platform, full video first, with recorded posts linked', () => {
    render(<PublishPostingPanel project={project({ posts: { youtube: { url: 'https://youtu.be/abc', postedAt: '2026-01-02T00:00:00.000Z' } } })} publishing={hook()} />);
    expandAll();
    expect(screen.getAllByRole('listitem')).toHaveLength(PUBLISH_TARGETS.length);
    expect(PUBLISH_TARGETS[0].target).toBe('youtube');
    expect(within(row('YouTube')).getByRole('link')).toHaveAttribute('href', 'https://youtu.be/abc');
  });

  it('shows the Suno song page a pasted share link resolved to once the draft is filled', () => {
    const song = 'https://suno.com/song/0a1b2c3d-1111-4222-8333-444455556666';
    const { rerender } = render(<PublishPostingPanel project={project()} publishing={hook()} />);
    expandAll();
    const field = () => within(row('Suno')).getByLabelText('Song URL (the take to publish)');
    fireEvent.change(field(), { target: { value: 'https://suno.com/s/AbCdEf123' } });
    rerender(<PublishPostingPanel project={project()} publishing={hook({ drafts: { suno: { draftId: 'd1', summary: {}, songUrl: song } } })} />);
    expect(field()).toHaveValue(song);
  });

  it('fills a Reddit draft with the subreddit and post type, dropping blanks', () => {
    const publishing = hook();
    render(<PublishPostingPanel project={project()} publishing={publishing} />);
    expandAll();
    const reddit = row('Reddit');
    fireEvent.change(within(reddit).getByLabelText('Subreddit'), { target: { value: 'SunoAI' } });
    fireEvent.change(within(reddit).getByLabelText('Post type'), { target: { value: 'link' } });
    fireEvent.click(within(reddit).getByRole('button', { name: 'Fill draft' }));
    expect(publishing.prepare).toHaveBeenCalledWith('reddit', { subreddit: 'SunoAI', kind: 'link' });
  });

  it('fills a Substack draft on the publication typed, else the one under Where you post', () => {
    const publishing = hook({ platforms: { substack: { enabled: true, account: 'example' } } });
    render(<PublishPostingPanel project={project()} publishing={publishing} />);
    expandAll();
    const substack = row('Substack');
    expect(within(substack).getByLabelText('Publication')).toHaveAttribute('placeholder', 'example');
    fireEvent.click(within(substack).getByRole('button', { name: 'Fill draft' }));
    expect(publishing.prepare).toHaveBeenCalledWith('substack', {});
    fireEvent.change(within(substack).getByLabelText('Publication'), { target: { value: 'other' } });
    fireEvent.click(within(substack).getByRole('button', { name: 'Fill draft' }));
    expect(publishing.prepare).toHaveBeenLastCalledWith('substack', { publication: 'other' });
  });

  it('picks the X story image from thumbnails, with No image as the default', () => {
    const publishing = hook();
    render(<PublishPostingPanel project={project({ thumbnails: ['t1.jpg', 't2.jpg'] })} publishing={publishing} />);
    expandAll();
    const picker = within(row('X thread')).getByRole('radiogroup', { name: 'Image on the story reply (optional)' });
    expect(within(picker).getByRole('radio', { name: 'No image' })).toBeChecked();
    expect(within(picker).getByRole('radio', { name: 'Video frame 2' }).querySelector('img')).toHaveAttribute('src', '/data/video-thumbnails/t2.jpg');
    fireEvent.click(within(picker).getByRole('radio', { name: 'Video frame 2' }));
    expect(within(picker).getByRole('radio', { name: 'Video frame 2' })).toBeChecked();
    fireEvent.click(within(row('X thread')).getByRole('button', { name: 'Fill draft' }));
    expect(publishing.prepare).toHaveBeenLastCalledWith('x', { storyImage: 't2.jpg' });
    fireEvent.click(within(picker).getByRole('radio', { name: 'No image' }));
    fireEvent.click(within(row('X thread')).getByRole('button', { name: 'Fill draft' }));
    expect(publishing.prepare).toHaveBeenLastCalledWith('x', {});
  });

  it('lets the director pick which 9:16 cut a Shorts draft posts (#10150)', () => {
    const publishing = hook();
    const p = { ...project({ master: { renderHistoryId: 'r1' }, exports: [{ kind: 'vertical-9x16', filename: 'v.mp4', startSec: 10, endSec: 40 }] }),
      renderHistoryId: 'r1', excerpts: [{ id: 'ex-1', status: 'complete', aspect: '9:16', filename: 'e.mp4', startSec: 60, endSec: 90 }, { id: 'ex-2', status: 'complete', aspect: '16:9', filename: 'w.mp4' }] };
    render(<PublishPostingPanel project={p} publishing={publishing} />);
    expandAll();
    const shorts = row('YouTube Shorts');
    const select = within(shorts).getByLabelText('Vertical cut to post');
    expect(within(select).getAllByRole('option').map((o) => o.value)).toEqual(['', 'ex-1', 'kit-vertical']);
    fireEvent.change(select, { target: { value: 'kit-vertical' } });
    fireEvent.click(within(shorts).getByRole('button', { name: 'Fill draft' }));
    expect(publishing.prepare).toHaveBeenCalledWith('shorts', { cutId: 'kit-vertical' });
  });

  // A settings store like the server's: setPlatform merges a platform's change, as PUT /publish/platforms does.
  const settingsStore = (platforms) => {
    const store = { platforms };
    store.setPlatform = vi.fn(async (target, change) => {
      const current = store.platforms[target] || {};
      store.platforms = { ...store.platforms, [target]: { ...current, ...change, ...(change.defaults ? { defaults: { ...current.defaults, ...change.defaults } } : {}) } };
      return store.platforms;
    });
    return store;
  };

  it('fills a DistroKid release with the songwriter and AI parts, and keeps the songwriter in settings for every device', () => {
    const store = settingsStore({ distrokid: { enabled: true, account: 'Example Artist', defaults: {} } });
    const p = { ...project(), autonomousRun: { output: { lyrics: 'la la' } } };
    const { unmount } = render(<PublishPostingPanel project={p} publishing={hook({ platforms: store.platforms, setPlatform: store.setPlatform })} />);
    expandAll();
    const dk = row('DistroKid');
    expect(within(dk).getByLabelText('Artist name')).toHaveAttribute('placeholder', 'Example Artist');
    expect(dk).toHaveTextContent('as Example Artist');
    expect(dk).not.toHaveTextContent('@Example Artist');
    expect(within(dk).getByLabelText('Instrumental')).toBeChecked(); // no lyric cues
    const first = within(dk).getByLabelText('Songwriter legal first name');
    fireEvent.change(first, { target: { value: 'Alice' } });
    fireEvent.blur(first);
    expect(store.setPlatform).toHaveBeenLastCalledWith('distrokid', { defaults: { songwriterFirst: 'Alice' } });
    const last = within(dk).getByLabelText('Songwriter legal last name');
    fireEvent.change(last, { target: { value: 'Example' } });
    fireEvent.blur(last);
    fireEvent.click(within(dk).getByLabelText('Explicit lyrics'));
    const publishing = hook({ platforms: store.platforms });
    fireEvent.click(within(dk).getByRole('button', { name: 'Fill draft' }));
    unmount();
    // Another project (or device) reads the same settings and starts filled in.
    render(<PublishPostingPanel project={project()} publishing={hook({ platforms: store.platforms, setPlatform: store.setPlatform })} />);
    expandAll();
    expect(within(row('DistroKid')).getByLabelText('Songwriter legal first name')).toHaveValue('Alice');
    expect(within(row('DistroKid')).getByLabelText('Songwriter legal last name')).toHaveValue('Example');
    expect(publishing.prepare).not.toHaveBeenCalled();
  });

  it('sends the typed songwriter with the AI parts, and editing the artist name renames the DistroKid account', () => {
    const store = settingsStore({ distrokid: { enabled: true, account: 'Example Artist', defaults: { songwriterFirst: 'Alice', songwriterLast: 'Example' } } });
    const publishing = hook({ platforms: store.platforms, setPlatform: store.setPlatform });
    render(<PublishPostingPanel project={{ ...project(), autonomousRun: { output: { lyrics: 'la la' } } }} publishing={publishing} />);
    expandAll();
    const dk = row('DistroKid');
    fireEvent.click(within(dk).getByLabelText('Explicit lyrics'));
    fireEvent.click(within(dk).getByRole('button', { name: 'Fill draft' }));
    expect(publishing.prepare).toHaveBeenCalledWith('distrokid', { songwriterFirst: 'Alice', songwriterLast: 'Example', aiLyrics: true, explicit: true });
    const artist = within(dk).getByLabelText('Artist name');
    fireEvent.change(artist, { target: { value: 'New Name' } });
    fireEvent.blur(artist);
    expect(store.setPlatform).toHaveBeenLastCalledWith('distrokid', { account: 'New Name' });
  });

  it('hands songwriter answers this device remembered before settings kept them over once', async () => {
    localStorage.setItem('portos.musicVideo.distrokidSongwriter', JSON.stringify({ first: 'Alice', last: 'Example', language: 'Spanish' }));
    const store = settingsStore({ distrokid: { enabled: true, account: null, defaults: {} } });
    render(<PublishPostingPanel project={project()} publishing={hook({ platforms: store.platforms, setPlatform: store.setPlatform })} />);
    expandAll();
    expect(within(row('DistroKid')).getByLabelText('Songwriter legal first name')).toHaveValue('Alice');
    expect(store.setPlatform).toHaveBeenCalledWith('distrokid', { defaults: { songwriterFirst: 'Alice', songwriterLast: 'Example', language: 'Spanish' } });
    await act(async () => {});
    expect(localStorage.getItem('portos.musicVideo.distrokidSongwriter')).toBeNull();
  });

  it('suggests a genre from the song and keeps only the answers that repeat across releases', () => {
    const store = settingsStore({ distrokid: { enabled: true, account: 'Example Artist', defaults: {} } });
    const p = { ...project(), autonomousRun: { output: { sunoStyle: 'dark synthwave, pop hooks' } } };
    const { unmount } = render(<PublishPostingPanel project={p} publishing={hook({ platforms: store.platforms, setPlatform: store.setPlatform })} />);
    expandAll();
    const dk = row('DistroKid');
    expect(within(dk).getByLabelText('Genre')).toHaveDisplayValue('Electronic (from the song\'s style)');
    expect(within(dk).getByLabelText('Secondary genre (optional)')).toHaveDisplayValue('Pop (from the song\'s style)');
    fireEvent.change(within(dk).getByLabelText('Genre'), { target: { value: 'Rock' } });
    const language = within(dk).getByLabelText('Language');
    fireEvent.change(language, { target: { value: 'Spanish' } });
    fireEvent.blur(language);
    fireEvent.click(within(dk).getByLabelText('First release as this artist (new store profiles)'));
    unmount();
    const later = hook({ platforms: store.platforms, setPlatform: store.setPlatform });
    render(<PublishPostingPanel project={project()} publishing={later} />);
    expandAll();
    const again = row('DistroKid');
    expect(within(again).getByLabelText('Language')).toHaveValue('Spanish');
    // New store profiles and the genre are asked per release, never carried to the next one.
    expect(within(again).getByLabelText('First release as this artist (new store profiles)')).not.toBeChecked();
    expect(within(again).getByLabelText('Genre')).toHaveValue('');
    fireEvent.click(within(again).getByRole('button', { name: 'Fill draft' }));
    expect(later.prepare.mock.calls[0][1]).not.toHaveProperty('newArtistProfile');
  });

  it('shows what each platform will post, or what is missing, before Fill draft', async () => {
    vi.useFakeTimers();
    const preview = vi.fn(async (target) => (target === 'x'
      ? { ready: true, parts: [{ label: 'Post · with the 1080p video', text: 'The hook' }, { label: 'Reply 1', text: 'Full video: https://youtu.be/example' }] }
      : { ready: false, problem: 'Write the TikTok caption first' }));
    render(<PublishPostingPanel project={project()} publishing={hook({ enabledTargets: ['x', 'tiktok'], preview })} />);
    expandAll();
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    vi.useRealTimers();
    expect(preview).toHaveBeenCalledWith('x', {});
    expect(within(row('X thread')).getByText('What gets posted to X thread')).toBeInTheDocument();
    expect(within(row('X thread')).getByText('Full video: https://youtu.be/example')).toBeInTheDocument();
    expect(within(row('TikTok')).getByRole('status')).toHaveTextContent('Not ready to fill: Write the TikTok caption first');
  });

  it('asks before filling a second draft for a platform already posted to', () => {
    const publishing = hook();
    render(<PublishPostingPanel project={project({ posts: { youtube: { url: 'https://www.youtube.com/watch?v=example' } } })} publishing={publishing} />);
    expandAll();
    const yt = row('YouTube');
    expect(within(yt).queryByRole('button', { name: 'Fill draft' })).toBeNull();
    fireEvent.click(within(yt).getByRole('button', { name: 'Post again…' }));
    expect(publishing.prepare).not.toHaveBeenCalled();
    fireEvent.click(within(yt).getByRole('button', { name: 'Confirm posting to YouTube again' }));
    expect(publishing.prepare).toHaveBeenCalledWith('youtube', { again: true });
    // A platform not yet posted fills straight away, on its own.
    fireEvent.click(within(row('TikTok')).getByRole('button', { name: 'Fill draft' }));
    expect(publishing.prepare).toHaveBeenLastCalledWith('tiktok', {});
  });

  it('shows no cut picker when there is only one 9:16 cut', () => {
    render(<PublishPostingPanel project={project()} publishing={hook()} />);
    expandAll();
    expect(within(row('TikTok')).queryByLabelText('Vertical cut to post')).toBeNull();
  });

  it('shows the filled draft and requires manual platform publication', () => {
    const publishing = hook({ drafts: { stackerNews: { draftId: 'd1', summary: { title: 'Song', territory: 'art' }, screenshot: 'data:image/jpeg;base64,AA' } } });
    render(<PublishPostingPanel project={project()} publishing={publishing} />);
    expandAll();
    const sn = row('Stacker News');
    expect(within(sn).getByAltText('Stacker News draft as filled')).toBeInTheDocument();
    expect(within(sn).getByText('Song')).toBeInTheDocument();
    expect(publishing.submit).not.toHaveBeenCalled();
    expect(within(sn).queryByRole('button', { name: /Post to Stacker News/ })).toBeNull();
    expect(within(sn).getByRole('button', { name: /Discard/ })).toBeInTheDocument();
    fireEvent.click(within(sn).getByRole('button', { name: /Discard/ }));
    expect(publishing.discard).not.toHaveBeenCalled();
    fireEvent.click(within(sn).getByRole('button', { name: /Confirm discard Stacker News draft/ }));
    expect(publishing.discard).toHaveBeenCalledWith('stackerNews');
  });

  it('keeps a sign-in refusal beside its platform', () => {
    const publishing = hook({ errors: { tiktok: { message: 'Sign in to TikTok in the PortOS Browser', code: 'PUBLISH_LOGIN_REQUIRED', url: 'https://www.tiktok.com/login' } } });
    render(<PublishPostingPanel project={project()} publishing={publishing} />);
    expandAll();
    const alert = within(row('TikTok')).getByRole('alert');
    expect(alert).toHaveTextContent('Sign in to TikTok');
    expect(alert).toHaveTextContent('https://www.tiktok.com/login');
  });

  it('offers only the platforms turned on, with the account posted as', () => {
    render(<PublishPostingPanel project={project()} publishing={hook({ enabledTargets: ['x', 'youtube'], platforms: { x: { enabled: true, account: 'antic' } } })} />);
    expandAll();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.queryByText('Reddit', { selector: 'div' })).toBeNull();
    expect(screen.getByText('as @antic')).toBeInTheDocument();
  });

  it('asks for platforms when none are on', () => {
    render(<PublishPostingPanel project={project()} publishing={hook({ enabledTargets: [] })} />);
    expandAll();
    expect(screen.getByText(/Turn on the platforms you use/)).toBeInTheDocument();
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });

  it('rates a posted post and records a post made by hand', async () => {
    const publishing = hook({ enabledTargets: ['youtube', 'x'], recordPost: vi.fn(async () => ({ url: 'saved' })) });
    render(<PublishPostingPanel project={project({ posts: { youtube: { url: 'https://youtu.be/abc', reception: 'good' } } })} publishing={publishing} />);
    expandAll();
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
    fireEvent.change(within(x).getByLabelText('Link to the X thread post'), { target: { value: 'https://x.com/antic/status/1' } });
    await act(async () => { fireEvent.click(record); });
    expect(publishing.recordPost).toHaveBeenCalledWith('x', { url: 'https://x.com/antic/status/1' });
    expect(within(x).getByLabelText('Link to the X thread post')).toHaveValue('');
  });

  it('folds a done platform with its status, marks one done without a link, and undoes a mark', async () => {
    localStorage.clear();
    const publishing = hook({ enabledTargets: ['youtube', 'distrokid'], recordPost: vi.fn(async () => ({ postedAt: '2026-01-03T00:00:00.000Z' })), removePost: vi.fn(async () => true) });
    const { unmount } = render(<PublishPostingPanel project={project({ posts: { youtube: { url: 'https://youtu.be/abc', postedAt: '2026-01-02T00:00:00.000Z' } } })} publishing={publishing} />);
    expect(screen.getByText('1 of 2 done')).toBeInTheDocument();
    const yt = row('YouTube');
    expect(within(yt).getByRole('button', { name: /YouTube.*Done/ })).toHaveAttribute('aria-expanded', 'false');
    expect(within(yt).queryByRole('button', { name: 'Post again…' })).not.toBeInTheDocument();
    expect(within(yt).getByRole('link')).toHaveAttribute('href', 'https://youtu.be/abc');
    const dk = row('DistroKid');
    expect(within(dk).getByRole('button', { name: /DistroKid.*To do/ })).toHaveAttribute('aria-expanded', 'true');
    await act(async () => { fireEvent.click(within(dk).getByRole('button', { name: 'Mark DistroKid done' })); });
    expect(publishing.recordPost).toHaveBeenCalledWith('distrokid', { posted: true });
    unmount();

    render(<PublishPostingPanel project={project({ posts: { distrokid: { postedAt: '2026-01-03T00:00:00.000Z' } } })} publishing={publishing} />);
    const done = row('DistroKid');
    expect(within(done).getByText(/Marked done/)).toBeInTheDocument();
    fireEvent.click(within(done).getByRole('button', { name: /DistroKid.*Done/ }));
    // a link can still be added later, and the mark undone behind a confirm
    expect(within(done).getByLabelText('Link to the DistroKid post')).toBeInTheDocument();
    expect(within(done).queryByRole('button', { name: 'Mark DistroKid done' })).not.toBeInTheDocument();
    fireEvent.click(within(done).getByRole('button', { name: 'Not done…' }));
    fireEvent.click(within(done).getByRole('button', { name: 'Confirm marking DistroKid not done' }));
    expect(publishing.removePost).toHaveBeenCalledWith('distrokid');
  });

  it('keeps a platform row reachable by its anchor while the card and row are folded', () => {
    localStorage.setItem('portos.musicVideo.publishCards', JSON.stringify({ 'mv-1': { posting: false } }));
    render(<PublishPostingPanel project={project({ posts: { youtube: { url: 'https://youtu.be/abc' } } })} publishing={hook({ enabledTargets: ['youtube', 'distrokid'] })} />);
    expect(screen.getByRole('button', { name: /Publish manually/ })).toHaveAttribute('aria-expanded', 'false');
    expect(document.getElementById('mv-post-distrokid')).not.toBeNull();
    expect(document.getElementById('mv-post-youtube')).not.toBeNull();
    localStorage.clear();
  });

  it('flags a fitted Hook cut and renders a native 9:16 one of the same window (#10860)', () => {
    const fittedKit = { master: { renderHistoryId: null }, exports: [{ kind: 'vertical-9x16', filename: 'v.mp4', startSec: 20, endSec: 50, layout: 'fit', fitReason: 'changed' }] };
    const excerpts = { startExcerpt: vi.fn(), occupied: false, rendering: false, progress: 0 };
    const p = { ...project(fittedKit), composition: { mode: 'document' } };
    const { unmount } = render(<PublishPostingPanel project={p} publishing={hook({ enabledTargets: ['sunoHook'] })} excerpts={excerpts} />);
    expandAll();
    const card = row('Suno Hook');
    expect(within(card).getByRole('status')).toHaveTextContent(/fitted.*reads as a square.*composition changed after the final render/);
    fireEvent.click(within(card).getByRole('button', { name: 'Render a native 9:16 cut of 0:20-0:50' }));
    expect(excerpts.startExcerpt).toHaveBeenCalledWith(20, 50, { aspect: '9:16', fade: true });
    unmount();

    // Once a native cut exists it is the default pick, and the warning goes.
    const native = { ...p, excerpts: [{ id: 'e1', status: 'complete', aspect: '9:16', filename: 'n.mp4', startSec: 20, endSec: 50, dependencyState: { status: 'current' } }] };
    render(<PublishPostingPanel project={native} publishing={hook({ enabledTargets: ['sunoHook'] })} excerpts={excerpts} />);
    expandAll();
    expect(within(row('Suno Hook')).queryByRole('status')).not.toBeInTheDocument();
  });

  it('skips a native cut the server would refuse (made before a change, or of unknown inputs) when picking the default', () => {
    const fittedKit = { master: { renderHistoryId: null }, exports: [{ kind: 'vertical-9x16', filename: 'v.mp4', startSec: 20, endSec: 50, layout: 'fit' }] };
    for (const status of ['stale', 'unknown']) {
      const p = { ...project(fittedKit), excerpts: [{ id: 'e1', status: 'complete', aspect: '9:16', filename: 'n.mp4', startSec: 20, endSec: 50, dependencyState: { status } }] };
      const { unmount } = render(<PublishPostingPanel project={p} publishing={hook({ enabledTargets: ['sunoHook'] })} />);
      expandAll();
      expect(within(row('Suno Hook')).getByRole('status')).toHaveTextContent(/fitted/);
      unmount();
    }
  });
});
