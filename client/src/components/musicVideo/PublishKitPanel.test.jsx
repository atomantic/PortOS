/**
 * Publish stage panel (#9281): the kit builds only from a final render, the
 * copy draft carries the director's notes and valid links, an edited field
 * saves on blur (tags as a list), and the thumbnail choice goes to the server.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('../../hooks/useProviderModels.js', () => ({
  default: () => ({ providers: [], selectedProviderId: '', selectedModel: '', availableModels: [], setSelectedProviderId: vi.fn(), setSelectedModel: vi.fn() }),
}));
vi.mock('../../lib/clipboard.js', () => ({ copyToClipboard: vi.fn() }));

import PublishKitPanel from './PublishKitPanel.jsx';

const hook = (over = {}) => ({
  building: false, progress: 0, build: vi.fn(), drafting: false, saving: false,
  draftCopy: vi.fn(async () => null), saveCopy: vi.fn(async () => null), selectThumbnail: vi.fn(async () => null),
  composing: false, composeCover: vi.fn(async () => null), generateCover: vi.fn(async () => null), ...over,
});
const built = {
  builtAt: '2026-01-01T00:00:00.000Z', master: { filename: 'master.mp4' },
  exports: [{ kind: 'x-1080p', label: 'X / social 1080p (12 Mbps)', filename: 'x.mp4' }],
  thumbnails: ['t1.jpg', 't2.jpg'], thumbnail: 't1.jpg', captionsFilename: 'c.srt',
  chapters: [{ startSec: 0, label: 'Opening line' }, { startSec: 30, label: 'Chorus' }, { startSec: 72, label: 'Outro' }],
  copy: { youtube: { title: 'A title', description: '', tags: ['music'] } }, copyDraftedAt: '2026-01-01T00:00:00.000Z',
};

describe('PublishKitPanel (#9281)', () => {
  it('builds only once there is a final render', () => {
    const k = hook();
    const { rerender } = render(<PublishKitPanel project={{ id: 'mv-1' }} publishKit={k} />);
    expect(screen.getByRole('button', { name: /Build publishing kit/ })).toBeDisabled();
    rerender(<PublishKitPanel project={{ id: 'mv-1', renderHistoryId: 'rh-1' }} publishKit={k} />);
    fireEvent.click(screen.getByRole('button', { name: /Build publishing kit/ }));
    expect(k.build).toHaveBeenCalled();
  });

  it('drafts copy from the notes and only well-formed links', () => {
    const k = hook();
    render(<PublishKitPanel project={{ id: 'mv-1', renderHistoryId: 'rh-1' }} publishKit={k} />);
    fireEvent.change(screen.getByLabelText(/Making-of notes/), { target: { value: 'hummed it in the car' } });
    fireEvent.change(screen.getByLabelText(/Full video URL/), { target: { value: 'https://example.com/v' } });
    fireEvent.change(screen.getByLabelText(/Song URL/), { target: { value: 'not a url' } });
    fireEvent.click(screen.getByRole('button', { name: /Draft copy/ }));
    expect(k.draftCopy).toHaveBeenCalledWith({ notes: 'hummed it in the car', links: { youtube: 'https://example.com/v' } });
  });

  it('shows the built kit, saves an edited field on blur and picks a thumbnail', () => {
    const k = hook();
    render(<PublishKitPanel project={{ id: 'mv-1', renderHistoryId: 'rh-1', publishKit: built }} publishKit={k} />);
    expect(screen.getByText('X / social 1080p (12 Mbps)')).toBeTruthy();
    expect(screen.getByText(/0:00 Opening line/)).toBeTruthy();
    const tags = screen.getByLabelText('Tags (comma-separated)');
    fireEvent.change(tags, { target: { value: 'music, ai video ,claude' } });
    fireEvent.blur(tags);
    expect(k.saveCopy).toHaveBeenCalledWith({ youtube: { tags: ['music', 'ai video', 'claude'] } });
    fireEvent.click(screen.getByRole('button', { name: 'Use thumbnail t2.jpg' }));
    expect(k.selectThumbnail).toHaveBeenCalledWith('t2.jpg');
  });

  it('makes the cover art from a project image with the title, and asks Codex for a new one', () => {
    const k = hook();
    const project = { id: 'mv-1', name: 'Example Song', publishKit: built, castAndSets: { images: { character: { imageId: 'sheet.png' } } } };
    const { rerender } = render(<PublishKitPanel project={project} publishKit={k} />);
    expect(screen.getByText('No cover yet')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Title on the cover'), { target: { value: 'Example Retitle' } });
    fireEvent.click(screen.getByRole('button', { name: 'Make the cover from Cast & Sets: character' }));
    expect(k.composeCover).toHaveBeenCalledWith({ source: { kind: 'image', filename: 'sheet.png' }, title: 'Example Retitle', focusX: 0.5 });
    fireEvent.click(screen.getByRole('button', { name: 'Make the cover from Video frame 1' }));
    expect(k.composeCover).toHaveBeenLastCalledWith(expect.objectContaining({ source: { kind: 'thumbnail', filename: 't1.jpg' } }));

    fireEvent.change(screen.getByLabelText(/Make a new cover image/), { target: { value: 'profile under flash' } });
    fireEvent.click(screen.getByRole('button', { name: /Make with Codex/ }));
    expect(k.generateCover).toHaveBeenCalledWith({ notes: 'profile under flash' });

    const art = { filename: 'cover-1.jpg', title: 'Example Song', tag: 'Example Artist', source: { kind: 'image', filename: 'sheet.png' }, pending: { mode: 'codex' } };
    rerender(<PublishKitPanel project={{ ...project, publishKit: { ...built, coverArt: art } }} publishKit={k} />);
    expect(screen.getByAltText('Cover art for Example Song')).toBeTruthy();
    expect(screen.getByText(/Making a cover image on codex/)).toBeTruthy();
  });
});
