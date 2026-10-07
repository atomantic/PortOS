import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import useMusicVideoPublishing from './useMusicVideoPublishing.js';
import socket from '../services/socket';
import PublishPostingPanel from '../components/musicVideo/PublishPostingPanel.jsx';

const api = vi.hoisted(() => ({
  getMusicVideoPublishDrafts: vi.fn(async () => ({ drafts: [] })),
  prepareMusicVideoPublishDraft: vi.fn(),
  discardMusicVideoPublishDraft: vi.fn(async () => true),
  getMusicVideoPublishPlatforms: vi.fn(async () => ({ platforms: { youtube: { enabled: true }, reddit: { enabled: true } } })),
  updateMusicVideoPublishPlatforms: vi.fn(),
  recordMusicVideoPublishPost: vi.fn(),
  removeMusicVideoPublishPost: vi.fn(),
}));
vi.mock('../services/apiMusicVideo.js', () => api);
vi.mock('../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn() } }));
vi.mock('../components/ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

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
function Posting({ id }) {
  const selected = project(id);
  const publishing = useMusicVideoPublishing({ project: selected, replaceProject: vi.fn() });
  return <PublishPostingPanel project={selected} publishing={publishing} />;
}

beforeEach(() => {
  vi.clearAllMocks();
  api.prepareMusicVideoPublishDraft.mockReset();
});

describe('music-video publishing project boundary', () => {
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
    view.rerender(<Posting id="project-a" />);
    expect(screen.queryByText('Example A')).not.toBeInTheDocument();
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
});
