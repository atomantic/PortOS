import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ReviewDraftPanel from './ReviewDraftPanel.jsx';

const artifact = (id, day, version) => {
  const file = `music-video/example/dev/${id}/v${version}.mp4`;
  return { id, title: `${id} film`, kind: 'animatic', status: 'pending', version, file, mimeType: 'video/mp4',
    versions: [{ version, file, mimeType: 'video/mp4', bytes: 100, createdAt: `2026-01-${day}` }] };
};
const project = { id: 'example', devArtifacts: [artifact('old', '01', 2), artifact('new', '02', 3)] };
afterEach(() => vi.unstubAllGlobals());

describe('implicit imported draft review', () => {
  it('skips a missing newest file, discloses the fallback and opens the exact available artifact', async () => {
    const fetchFile = vi.fn(async url => ({ ok: !url.includes('/new/') }));
    vi.stubGlobal('fetch', fetchFile);
    const onOpen = vi.fn();
    render(<ReviewDraftPanel project={project} onOpen={onOpen} />);
    const player = await screen.findByLabelText('old film v2');
    expect(player).toHaveAttribute('src', '/api/music-video/example/dev-artifacts/old/file?version=2');
    expect(screen.getByText('Newer draft unavailable · showing old film v2.')).toBeInTheDocument();
    expect(fetchFile.mock.calls[0][0]).toBe('/api/music-video/example/dev-artifacts/new/file?version=3');
    fireEvent.click(screen.getByRole('button', { name: 'Review & add notes' }));
    expect(onOpen).toHaveBeenCalledWith('old');
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
  });

  it('reports all missing drafts without offering a review action or an approval', async () => {
    const fetchFile = vi.fn(async () => ({ ok: false }));
    vi.stubGlobal('fetch', fetchFile);
    render(<ReviewDraftPanel project={project} onOpen={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Imported drafts are unavailable');
    expect(fetchFile).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('drops availability responses from a superseded project', async () => {
    let finishOld;
    vi.stubGlobal('fetch', vi.fn(url => url.includes('/new/') ? new Promise(resolve => { finishOld = resolve; }) : Promise.resolve({ ok: true })));
    const { rerender } = render(<ReviewDraftPanel project={project} onOpen={vi.fn()} />);
    await waitFor(() => expect(finishOld).toBeTypeOf('function'));
    rerender(<ReviewDraftPanel project={{ id: 'other', devArtifacts: [artifact('old', '01', 2)] }} onOpen={vi.fn()} />);
    expect(await screen.findByLabelText('old film v2')).toHaveAttribute('src', '/api/music-video/other/dev-artifacts/old/file?version=2');
    finishOld({ ok: true });
    await waitFor(() => expect(screen.queryByLabelText('new film v3')).toBeNull());
  });
});
