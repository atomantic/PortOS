import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import PinToMoodBoardMenu from './PinToMoodBoardMenu';

// Mock the api surface the menu (and the shared shell) reach for.
const api = vi.hoisted(() => ({
  listMoodBoards: vi.fn(),
  createMoodBoard: vi.fn(),
  addMoodBoardItem: vi.fn(),
  removeMoodBoardItem: vi.fn(),
  // CollectionPickerShell imports these even though the mood-board path injects
  // its own loader/creator — keep them defined so the module resolves.
  listMediaCollections: vi.fn(async () => []),
  createMediaCollection: vi.fn(),
}));

vi.mock('../../services/api', () => api);
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

const imageItem = {
  kind: 'image',
  key: 'image:hero.png',
  filename: 'hero.png',
  previewUrl: '/data/images/hero.png',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PinToMoodBoardMenu', () => {
  it('lists boards and pins the media-key (with previewUrl thumbnail) on click', async () => {
    api.listMoodBoards.mockResolvedValue([{ id: 'b1', name: 'Refs', items: [] }]);
    api.addMoodBoardItem.mockResolvedValue({ id: 'mbi-1', type: 'image', mediaKey: 'image:hero.png' });

    render(<PinToMoodBoardMenu item={imageItem} />);
    fireEvent.click(screen.getByTitle('Pin to mood board'));

    const row = await screen.findByRole('menuitemcheckbox', { name: /Refs/ });
    expect(row).toHaveAttribute('aria-checked', 'false');

    await act(async () => { fireEvent.click(row); });

    expect(api.addMoodBoardItem).toHaveBeenCalledWith(
      'b1',
      { type: 'image', mediaKey: 'image:hero.png', imageUrl: '/data/images/hero.png' },
      { silent: true },
    );
    // Membership flips locally without a refetch.
    await waitFor(() => expect(row).toHaveAttribute('aria-checked', 'true'));
  });

  it('unpins when the board already contains the media-key (toggle)', async () => {
    api.listMoodBoards.mockResolvedValue([
      { id: 'b1', name: 'Refs', items: [{ id: 'mbi-9', type: 'image', mediaKey: 'image:hero.png' }] },
    ]);
    api.removeMoodBoardItem.mockResolvedValue({ id: 'b1', name: 'Refs', items: [] });

    render(<PinToMoodBoardMenu item={imageItem} />);
    fireEvent.click(screen.getByTitle('Pin to mood board'));

    const row = await screen.findByRole('menuitemcheckbox', { name: /Refs/ });
    expect(row).toHaveAttribute('aria-checked', 'true');

    await act(async () => { fireEvent.click(row); });

    expect(api.removeMoodBoardItem).toHaveBeenCalledWith('b1', 'mbi-9', { silent: true });
    expect(api.addMoodBoardItem).not.toHaveBeenCalled();
    await waitFor(() => expect(row).toHaveAttribute('aria-checked', 'false'));
  });

  it('pins mediaKey-only when previewUrl is a non-renderable (blob) URL', async () => {
    api.listMoodBoards.mockResolvedValue([{ id: 'b1', name: 'Refs', items: [] }]);
    api.addMoodBoardItem.mockResolvedValue({ id: 'mbi-2', type: 'image', mediaKey: 'video:job-7' });

    render(<PinToMoodBoardMenu item={{ kind: 'video', key: 'video:job-7', previewUrl: null }} />);
    fireEvent.click(screen.getByTitle('Pin to mood board'));
    const row = await screen.findByRole('menuitemcheckbox', { name: /Refs/ });
    await act(async () => { fireEvent.click(row); });

    expect(api.addMoodBoardItem).toHaveBeenCalledWith(
      'b1',
      { type: 'image', mediaKey: 'video:job-7' },
      { silent: true },
    );
  });

  it('pins imageUrl-only (no mediaKey) for a synthetic non-media key like canon-sheet:', async () => {
    api.listMoodBoards.mockResolvedValue([{ id: 'b1', name: 'Refs', items: [] }]);
    api.addMoodBoardItem.mockResolvedValue({ id: 'mbi-3', type: 'image', imageUrl: '/data/image-refs/sheet.png' });

    render(<PinToMoodBoardMenu item={{
      kind: 'image', key: 'canon-sheet:hero:sheet.png', previewUrl: '/data/image-refs/sheet.png',
    }} />);
    fireEvent.click(screen.getByTitle('Pin to mood board'));
    const row = await screen.findByRole('menuitemcheckbox', { name: /Refs/ });
    await act(async () => { fireEvent.click(row); });

    // The server rejects `canon-sheet:` as a mediaKey, so we send imageUrl only.
    expect(api.addMoodBoardItem).toHaveBeenCalledWith(
      'b1',
      { type: 'image', imageUrl: '/data/image-refs/sheet.png' },
      { silent: true },
    );
  });

  it('matches existing imageUrl-only pins for membership/toggle (synthetic key)', async () => {
    api.listMoodBoards.mockResolvedValue([
      { id: 'b1', name: 'Refs', items: [{ id: 'mbi-7', type: 'image', imageUrl: '/data/image-refs/sheet.png' }] },
    ]);
    api.removeMoodBoardItem.mockResolvedValue({ id: 'b1', name: 'Refs', items: [] });

    render(<PinToMoodBoardMenu item={{
      kind: 'image', key: 'canon-sheet:hero:sheet.png', previewUrl: '/data/image-refs/sheet.png',
    }} />);
    fireEvent.click(screen.getByTitle('Pin to mood board'));
    const row = await screen.findByRole('menuitemcheckbox', { name: /Refs/ });
    expect(row).toHaveAttribute('aria-checked', 'true');

    await act(async () => { fireEvent.click(row); });
    expect(api.removeMoodBoardItem).toHaveBeenCalledWith('b1', 'mbi-7', { silent: true });
  });

  it('renders nothing when there is no valid media-key and no renderable thumbnail', () => {
    const { container } = render(
      <PinToMoodBoardMenu item={{ kind: 'image', key: 'noun:x.png', previewUrl: 'blob:abc' }} />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTitle('Pin to mood board')).toBeNull();
  });

  it('drops a protocol-relative preview as a thumbnail (server rejects //host imageUrls)', async () => {
    api.listMoodBoards.mockResolvedValue([{ id: 'b1', name: 'Refs', items: [] }]);
    api.addMoodBoardItem.mockResolvedValue({ id: 'mbi-4', type: 'image', mediaKey: 'image:hero.png' });

    // Valid media-key + a protocol-relative preview: pin the key, NOT the bad URL.
    render(<PinToMoodBoardMenu item={{ kind: 'image', key: 'image:hero.png', previewUrl: '//evil/x.png' }} />);
    fireEvent.click(screen.getByTitle('Pin to mood board'));
    const row = await screen.findByRole('menuitemcheckbox', { name: /Refs/ });
    await act(async () => { fireEvent.click(row); });

    expect(api.addMoodBoardItem).toHaveBeenCalledWith(
      'b1',
      { type: 'image', mediaKey: 'image:hero.png' },
      { silent: true },
    );
  });
});
