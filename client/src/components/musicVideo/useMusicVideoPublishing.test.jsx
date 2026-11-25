import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import useMusicVideoPublishing from './useMusicVideoPublishing.js';
import socket from '../../services/socket';
import PublishPostingPanel from './PublishPostingPanel.jsx';
import PublishPlatformsPanel from './PublishPlatformsPanel.jsx';

const api = vi.hoisted(() => ({
  getMusicVideoPublishDrafts: vi.fn(async () => ({ drafts: [] })),
  prepareMusicVideoPublishDraft: vi.fn(),
  discardMusicVideoPublishDraft: vi.fn(async () => true),
  getMusicVideoPublishPlatforms: vi.fn(async () => ({ platforms: { youtube: { enabled: true }, reddit: { enabled: true } } })),
  updateMusicVideoPublishPlatforms: vi.fn(),
  recordMusicVideoPublishPost: vi.fn(),
  removeMusicVideoPublishPost: vi.fn(),
  updateMusicVideoPublishCopy: vi.fn(async () => ({ project: { id: 'project-a', publishKit: {} } })),
}));
vi.mock('../../services/apiMusicVideo.js', () => api);
vi.mock('../../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn() } }));
vi.mock('../ui/Toast');

const project = (id) => ({ id, publishKit: { builtAt: '2026-01-01T00:00:00.000Z' } });
// a platform row: its fold toggle names it (label first, then its status)
const rowLabel = (label) => (_, el) => el?.matches?.('h4 button > span') && el.firstChild?.textContent === label;
const row = (label) => screen.getByText(rowLabel(label)).closest('li');
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
function Posting({ id, replaceProject = vi.fn() }) {
  const selected = project(id);
  const publishing = useMusicVideoPublishing({ project: selected, replaceProject });
  return <PublishPostingPanel project={selected} publishing={publishing} />;
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  api.prepareMusicVideoPublishDraft.mockReset();
});

describe('music-video publishing project boundary', () => {
  it('preserves both platform skips clicked before the first list save finishes', async () => {
    const first = deferred();
    const second = deferred();
    api.updateMusicVideoPublishCopy.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const replaceProject = vi.fn();
    render(<Posting id="project-a" replaceProject={replaceProject} />);
    await screen.findByText(rowLabel('YouTube'));
    await act(async () => { fireEvent.click(within(row('YouTube')).getByRole('button', { name: 'Skip for this release' })); });
    await act(async () => { fireEvent.click(within(row('Reddit')).getByRole('button', { name: 'Skip for this release' })); });
    expect(api.updateMusicVideoPublishCopy).toHaveBeenCalledTimes(1);
    expect(api.updateMusicVideoPublishCopy).toHaveBeenLastCalledWith('project-a', { skippedTargets: ['youtube'] });
    await act(async () => { first.resolve({ project: { id: 'project-a', publishKit: { skippedTargets: ['youtube'] } } }); });
    expect(api.updateMusicVideoPublishCopy).toHaveBeenLastCalledWith('project-a', { skippedTargets: ['youtube', 'reddit'] });
    const saved = { id: 'project-a', publishKit: { skippedTargets: ['youtube', 'reddit'] } };
    await act(async () => { second.resolve({ project: saved }); });
    expect(replaceProject).toHaveBeenLastCalledWith(saved);
  });

  it('does not carry a failed skip into the next queued platform change', async () => {
    const first = deferred();
    api.updateMusicVideoPublishCopy.mockReturnValueOnce(first.promise).mockResolvedValueOnce({ project: { id: 'project-a', publishKit: { skippedTargets: ['reddit'] } } });
    render(<Posting id="project-a" />);
    await screen.findByText(rowLabel('YouTube'));
    await act(async () => {
      fireEvent.click(within(row('YouTube')).getByRole('button', { name: 'Skip for this release' }));
      fireEvent.click(within(row('Reddit')).getByRole('button', { name: 'Skip for this release' }));
    });
    await act(async () => { first.reject(new Error('Save unavailable')); });
    expect(api.updateMusicVideoPublishCopy).toHaveBeenLastCalledWith('project-a', { skippedTargets: ['reddit'] });
  });

  it('drops the previous project preview and posting options immediately on selection', async () => {
    api.prepareMusicVideoPublishDraft.mockResolvedValue({ draftId: 'draft-a', summary: { title: 'Example A' } });
    const view = render(<Posting id="project-a" />);
    await screen.findByText(rowLabel('YouTube'));
    fireEvent.change(within(row('Reddit')).getByLabelText('Subreddit'), { target: { value: 'example-community' } });
    await act(async () => { fireEvent.click(within(row('YouTube')).getByRole('button', { name: 'Fill draft' })); });
    expect(screen.getByText('Example A')).toBeInTheDocument();

    view.rerender(<Posting id="project-b" />);
    expect(screen.queryByText('Example A')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Post to YouTube' })).not.toBeInTheDocument();
    expect(within(row('Reddit')).getByLabelText('Subreddit')).toHaveValue('');
    // The answer typed on the old project saves to that project, not the one now open.
    expect(api.updateMusicVideoPublishCopy).toHaveBeenCalledWith('project-a', { postOptions: { reddit: { subreddit: 'example-community' } } });
    view.rerender(<Posting id="project-a" />);
    expect(screen.queryByText('Example A')).not.toBeInTheDocument();
  });

  it('shows what a running fill waits on, then drops it once the fill lands', async () => {
    const fill = deferred();
    api.prepareMusicVideoPublishDraft.mockReturnValueOnce(fill.promise);
    render(<Posting id="project-a" />);
    await screen.findByText(rowLabel('YouTube'));
    fireEvent.click(within(row('YouTube')).getByRole('button', { name: 'Fill draft' }));
    expect(within(row('YouTube')).getByRole('status')).toHaveTextContent('Filling in the PortOS Browser…');
    const onDraft = socket.on.mock.calls.find(([event]) => event === 'music-video:publish-draft')[1];
    act(() => { onDraft({ projectId: 'project-a', target: 'youtube', state: 'queued', message: 'Waiting for X thread to finish (uploading the video to X)' }); });
    expect(within(row('YouTube')).getByRole('status')).toHaveTextContent('Waiting for X thread to finish (uploading the video to X)');
    await act(async () => { fill.resolve({ draftId: 'draft-a', summary: { title: 'Example A' } }); });
    expect(within(row('YouTube')).queryByText(/Waiting for X thread/)).toBeNull();
  });

  it('keeps the earlier draft on the card when a replacement fails', async () => {
    api.getMusicVideoPublishDrafts.mockResolvedValueOnce({
      drafts: [{ draftId: 'draft-a', target: 'youtube', state: 'open', summary: { title: 'Example A' } }],
    });
    api.prepareMusicVideoPublishDraft.mockRejectedValueOnce(new Error('Could not open a tab'));
    render(<Posting id="project-a" />);
    expect(await screen.findByText('Example A')).toBeInTheDocument();
    await act(async () => { fireEvent.click(within(row('YouTube')).getByRole('button', { name: 'Fill again' })); });
    expect(screen.getByText('Could not open a tab')).toBeInTheDocument();
    expect(screen.getByText('Example A')).toBeInTheDocument();
  });

  it('keeps the draft visible on discard failure and removes it after a successful retry', async () => {
    const discard = deferred();
    const retry = deferred();
    api.getMusicVideoPublishDrafts.mockResolvedValueOnce({
      drafts: [{ draftId: 'draft-a', target: 'youtube', state: 'open', summary: { title: 'Example A' } }],
    });
    api.discardMusicVideoPublishDraft.mockReturnValueOnce(discard.promise).mockReturnValueOnce(retry.promise);
    render(<Posting id="project-a" />);
    expect(await screen.findByText('Example A')).toBeInTheDocument();
    const youtube = within(row('YouTube'));
    const confirmDiscard = () => {
      fireEvent.click(youtube.getByRole('button', { name: 'Discard' }));
      fireEvent.click(youtube.getByRole('button', { name: 'Confirm discard YouTube draft' }));
    };

    confirmDiscard();
    expect(api.discardMusicVideoPublishDraft).toHaveBeenCalledWith('project-a', 'draft-a', { silent: true });
    expect(youtube.getByText('Example A')).toBeInTheDocument();
    expect(youtube.getByRole('button', { name: 'Discard' })).toBeDisabled();

    await act(async () => { discard.reject(new Error('Could not discard the draft')); });
    expect(youtube.getByRole('alert')).toHaveTextContent('Could not discard the draft');
    expect(youtube.getByText('Example A')).toBeInTheDocument();
    expect(youtube.getByRole('button', { name: 'Discard' })).toBeEnabled();

    confirmDiscard();
    expect(youtube.queryByRole('alert')).toBeNull();
    await act(async () => { retry.resolve(true); });
    expect(youtube.queryByText('Example A')).toBeNull();
  });

  it('ignores a late old-project preparation without clearing the current preparation', async () => {
    const first = deferred();
    const second = deferred();
    api.prepareMusicVideoPublishDraft.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const view = render(<Posting id="project-a" />);
    await screen.findByText(rowLabel('YouTube'));
    fireEvent.click(within(row('YouTube')).getByRole('button', { name: 'Fill draft' }));
    view.rerender(<Posting id="project-b" />);
    fireEvent.click(within(row('YouTube')).getByRole('button', { name: 'Fill draft' }));
    await act(async () => { first.resolve({ draftId: 'draft-a', summary: { title: 'Example A' } }); });
    expect(screen.queryByText('Example A')).not.toBeInTheDocument();
    expect(within(row('YouTube')).getByRole('button', { name: 'Filling…' })).toBeDisabled();
    await act(async () => { second.resolve({ draftId: 'draft-b', summary: { title: 'Example B' } }); });
    expect(screen.getByText('Example B')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Post to YouTube' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Instance password to prepare YouTube')).toBeNull();
  });

  it('ignores an old-project sign-in error after switching away and back', async () => {
    const first = deferred();
    api.prepareMusicVideoPublishDraft.mockReturnValueOnce(first.promise);
    const view = render(<Posting id="project-a" />);
    await screen.findByText(rowLabel('YouTube'));
    fireEvent.click(within(row('YouTube')).getByRole('button', { name: 'Fill draft' }));
    view.rerender(<Posting id="project-b" />);
    view.rerender(<Posting id="project-a" />);
    await act(async () => { first.reject({ message: 'Example sign-in required', code: 'PUBLISH_LOGIN_REQUIRED' }); });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Instance password to prepare YouTube')).toBeNull();
    expect(within(row('YouTube')).getByRole('button', { name: 'Fill draft' })).toBeEnabled();
  });

  it('rehydrates a server-side draft after reload and shows "Tab closed" when the server reports it gone', async () => {
    api.getMusicVideoPublishDrafts.mockResolvedValueOnce({ drafts: [{ draftId: 'draft-a', target: 'youtube', state: 'open', summary: { title: 'Example A' } }] });
    render(<Posting id="project-a" />);
    expect(await screen.findByText('Example A')).toBeInTheDocument();
    const onDraft = socket.on.mock.calls.find(([event]) => event === 'music-video:publish-draft')[1];
    act(() => onDraft({ projectId: 'project-other', draftId: 'draft-a', target: 'youtube', state: 'closed' }));
    expect(screen.getByText('Example A')).toBeInTheDocument();
    act(() => onDraft({ projectId: 'project-a', draftId: 'draft-a', target: 'youtube', state: 'closed' }));
    expect(screen.getByText('Tab closed — Fill again')).toBeInTheDocument();
    expect(screen.queryByText('Example A')).not.toBeInTheDocument();
  });

  it('shows a draft and its screenshot in both posting panels, then discards the replacement by ID', async () => {
    const platformSettings = { platforms: { stackerNews: { enabled: true } } };
    api.getMusicVideoPublishPlatforms.mockResolvedValueOnce(platformSettings).mockResolvedValueOnce(platformSettings);
    const original = { draftId: 'first', target: 'stackerNews', state: 'open', summary: { title: 'First draft' }, screenshot: 'data:image/jpeg;base64,AA' };
    const replacement = { ...original, draftId: 'second', summary: { title: 'Second draft' } };
    const fill = deferred();
    api.prepareMusicVideoPublishDraft.mockReturnValueOnce(fill.promise);
    const view = render(<><div data-testid="first-panel"><Posting id="project-a" /></div><div data-testid="second-panel"><Posting id="project-a" /></div></>);
    const first = within(view.getByTestId('first-panel'));
    const second = within(view.getByTestId('second-panel'));
    await first.findByText(rowLabel('Stacker News'));
    await second.findByText(rowLabel('Stacker News'));
    fireEvent.click(first.getByRole('button', { name: 'Fill draft' }));

    const emit = (draft, state, projectId = 'project-a') => {
      for (const [event, handler] of socket.on.mock.calls) {
        if (event === 'music-video:publish-draft') handler({ projectId, target: draft.target, draftId: draft.draftId, state });
      }
    };
    await act(async () => emit(original, 'open', 'project-other'));
    expect(api.getMusicVideoPublishDrafts).toHaveBeenCalledTimes(2);
    api.getMusicVideoPublishDrafts.mockResolvedValueOnce({ drafts: [original] }).mockResolvedValueOnce({ drafts: [original] });
    await act(async () => { emit(original, 'open'); fill.resolve(original); });
    expect(second.getByText('First draft')).toBeInTheDocument();
    expect(second.getByAltText('Stacker News draft as filled')).toHaveAttribute('src', original.screenshot);

    api.getMusicVideoPublishDrafts.mockResolvedValueOnce({ drafts: [replacement] }).mockResolvedValueOnce({ drafts: [replacement] });
    await act(async () => { emit(original, 'discarded'); emit(replacement, 'open'); });
    act(() => { emit(original, 'closed'); emit(original, 'discarded'); });
    expect(first.getByText('Second draft')).toBeInTheDocument();
    expect(second.getByText('Second draft')).toBeInTheDocument();
    expect(second.queryByText('First draft')).toBeNull();
    fireEvent.click(second.getByRole('button', { name: 'Discard' }));
    await act(async () => fireEvent.click(second.getByRole('button', { name: 'Confirm discard Stacker News draft' })));
    expect(api.discardMusicVideoPublishDraft).toHaveBeenCalledWith('project-a', 'second', { silent: true });
    expect(api.getMusicVideoPublishDrafts).toHaveBeenCalledTimes(6);
  });

  it('keeps the replacement when initial hydration, an older open read and its fill finish late', async () => {
    const initial = deferred();
    const olderOpen = deferred();
    const olderFill = deferred();
    const original = { draftId: 'first', target: 'youtube', state: 'open', summary: { title: 'First draft' } };
    const replacement = { ...original, draftId: 'second', summary: { title: 'Second draft' } };
    api.getMusicVideoPublishDrafts
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(olderOpen.promise)
      .mockResolvedValueOnce({ drafts: [replacement] });
    api.prepareMusicVideoPublishDraft.mockReturnValueOnce(olderFill.promise);
    render(<Posting id="project-a" />);
    await screen.findByText(rowLabel('YouTube'));
    fireEvent.click(within(row('YouTube')).getByRole('button', { name: 'Fill draft' }));

    const onDraft = socket.on.mock.calls.find(([event]) => event === 'music-video:publish-draft')[1];
    await act(async () => {
      onDraft({ projectId: 'project-a', target: 'youtube', draftId: 'first', state: 'open' });
      onDraft({ projectId: 'project-a', target: 'youtube', draftId: 'second', state: 'open' });
    });
    expect(screen.getByText('Second draft')).toBeInTheDocument();
    await act(async () => {
      olderFill.resolve(original);
      olderOpen.resolve({ drafts: [original] });
      initial.resolve({ drafts: [original] });
    });
    expect(screen.getByText('Second draft')).toBeInTheDocument();
    expect(screen.queryByText('First draft')).toBeNull();
    expect(api.getMusicVideoPublishDrafts).toHaveBeenCalledTimes(3);
  });

  it('keeps a close during rehydration even when the list still says the draft is open', async () => {
    const initial = deferred();
    api.getMusicVideoPublishDrafts.mockReturnValueOnce(initial.promise);
    render(<Posting id="project-a" />);
    await screen.findByText(rowLabel('YouTube'));
    const onDraft = socket.on.mock.calls.find(([event]) => event === 'music-video:publish-draft')[1];
    act(() => onDraft({ projectId: 'project-a', target: 'youtube', draftId: 'first', state: 'closed' }));
    await act(async () => {
      initial.resolve({ drafts: [{ draftId: 'first', target: 'youtube', state: 'open', summary: { title: 'First draft' } }] });
    });
    expect(screen.getByText('Tab closed — Fill again')).toBeInTheDocument();
    expect(screen.queryByText('First draft')).toBeNull();
  });

  it('ignores an open read from a previous selection of the same project', async () => {
    const oldRead = deferred();
    const view = render(<Posting id="project-a" />);
    await screen.findByText(rowLabel('YouTube'));
    api.getMusicVideoPublishDrafts.mockReturnValueOnce(oldRead.promise);
    const onDraft = socket.on.mock.calls.find(([event]) => event === 'music-video:publish-draft')[1];
    act(() => onDraft({ projectId: 'project-a', target: 'youtube', draftId: 'old', state: 'open' }));
    view.rerender(<Posting id="project-b" />);
    view.rerender(<Posting id="project-a" />);
    await act(async () => {
      oldRead.resolve({ drafts: [{ draftId: 'old', target: 'youtube', state: 'open', summary: { title: 'Old draft' } }] });
    });
    expect(within(row('YouTube')).getByRole('button', { name: 'Fill draft' })).toBeEnabled();
    expect(screen.queryByText('Old draft')).toBeNull();
  });

  it('applies the post the server detected in a filled tab: the draft goes and its recorded link arrives', async () => {
    api.getMusicVideoPublishDrafts.mockResolvedValueOnce({ drafts: [{ draftId: 'draft-a', target: 'youtube', state: 'open', summary: { title: 'Example A' } }] });
    const replaceProject = vi.fn();
    render(<Posting id="project-a" replaceProject={replaceProject} />);
    expect(await screen.findByText('Example A')).toBeInTheDocument();
    const onDraft = socket.on.mock.calls.find(([event]) => event === 'music-video:publish-draft')[1];
    const posted = { id: 'project-a', publishKit: { posts: { youtube: { url: 'https://www.youtube.com/watch?v=example' } } } };
    await act(async () => { onDraft({ projectId: 'project-a', draftId: 'draft-a', target: 'youtube', state: 'posted', url: posted.publishKit.posts.youtube.url, project: posted }); });
    expect(replaceProject).toHaveBeenCalledWith(posted);
    expect(screen.queryByText('Example A')).not.toBeInTheDocument();
    expect(api.getMusicVideoPublishPlatforms).toHaveBeenCalledTimes(2); // history refreshed
  });
});

describe('music-video publish platforms read', () => {
  function PublishPage({ id }) {
    const selected = project(id);
    const publishing = useMusicVideoPublishing({ project: selected });
    return <><PublishPlatformsPanel projectId={id} publishing={publishing} /><PublishPostingPanel project={selected} publishing={publishing} /></>;
  }

  it('shows a failed read with Retry instead of "no platforms", then loads on Retry', async () => {
    api.getMusicVideoPublishPlatforms.mockRejectedValueOnce(new Error('Server unavailable'));
    // A fold the director remembered for this card must not hide the failure.
    window.localStorage.setItem('portos.musicVideo.publishCards', JSON.stringify({ 'project-a': { platforms: false } }));
    render(<PublishPage id="project-a" />);
    expect(await screen.findByText(/Could not load where you post — Server unavailable/)).toBeInTheDocument();
    expect(screen.queryByText(/No platforms yet/)).toBeNull();
    expect(screen.queryByText(/Turn on the platforms you use/)).toBeNull();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    expect(screen.queryByText(/Could not load where you post/)).toBeNull();
    // The loaded card takes its own fold default (folded once platforms are on), not the error card's open state.
    expect(screen.getByRole('heading', { name: 'Where you post 2 on' })).toBeInTheDocument();
    expect(screen.getByText(rowLabel('YouTube'))).toBeInTheDocument();
  });

  it('shows a failed draft rehydrate with Retry, then restores the filled draft', async () => {
    const retried = deferred();
    api.getMusicVideoPublishDrafts.mockRejectedValueOnce(new Error('Server unavailable')).mockReturnValueOnce(retried.promise);
    render(<Posting id="project-a" />);
    expect(await screen.findByText(/Could not load the drafts already filled — Server unavailable/)).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    // Still unknown while the retry is in flight, so it never reads as "no drafts".
    expect(screen.getByText(/Could not load the drafts already filled/)).toBeInTheDocument();
    await act(async () => { retried.resolve({ drafts: [{ draftId: 'draft-a', target: 'youtube', state: 'open', summary: { title: 'Example A' } }] }); });
    expect(screen.queryByText(/Could not load the drafts already filled/)).toBeNull();
    expect(await screen.findByText('Example A')).toBeInTheDocument();
  });
});
