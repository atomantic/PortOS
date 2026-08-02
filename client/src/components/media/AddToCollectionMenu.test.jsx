import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import AddToCollectionMenu from './AddToCollectionMenu';

// Covers the picker's list presentation (#3312): CollectionPickerShell orders
// rows with the shared `applyCollectionView` and each row renders the
// prefix-stripped title with the auto-creator prefix lifted into a badge, the
// same as the /media/collections grid (#3283).

const api = vi.hoisted(() => ({
  listMediaCollections: vi.fn(),
  createMediaCollection: vi.fn(),
  addMediaCollectionItem: vi.fn(),
  removeMediaCollectionItem: vi.fn(),
}));

vi.mock('../../services/api', () => api);
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

const item = { kind: 'image', key: 'image:hero.png', filename: 'hero.png' };

// Six collections so the shell's search input renders (SEARCH_THRESHOLD).
// Deliberately shuffled relative to the expected display order, and the auto
// empties carry the NEWEST timestamps so a raw "recently updated" sort alone
// would float them to the top.
const collections = [
  { id: 'cd-1', name: 'Creative Director: Zephyr Drift', source: 'auto', items: [], updatedAt: '2026-01-05T00:00:00Z' },
  { id: 'c-keep', name: 'Keepers', source: 'user', items: [], updatedAt: '2026-01-01T00:00:00Z' },
  { id: 'cd-2', name: 'Creative Director: Amber Loop', source: 'auto', items: [{ kind: 'image', ref: 'a.png' }], updatedAt: '2026-01-04T00:00:00Z' },
  { id: 'uc-1', name: 'Universe: Example Universe', source: 'auto', items: [], updatedAt: '2026-01-03T00:00:00Z' },
  { id: 'c-ref', name: 'Reference Shots', source: 'user', items: [{ kind: 'image', ref: 'b.png' }], updatedAt: '2026-01-02T00:00:00Z' },
  { id: 'c-wall', name: 'Wallpapers', source: 'user', items: [], updatedAt: '2025-12-31T00:00:00Z' },
];

const openMenu = async () => {
  render(<AddToCollectionMenu item={item} />);
  fireEvent.click(screen.getByTitle('Add to collection'));
  await screen.findByRole('menuitemcheckbox', { name: /Keepers/ });
};

const rowTitles = () =>
  screen.getAllByRole('menuitemcheckbox').map((el) => el.textContent.trim());

beforeEach(() => {
  vi.clearAllMocks();
  api.listMediaCollections.mockResolvedValue(collections);
});

describe('AddToCollectionMenu row presentation', () => {
  it('sinks auto-created empties below everything else, newest-updated first within a bucket', async () => {
    await openMenu();

    expect(rowTitles()).toEqual([
      'Creative DirectorAmber Loop', // auto but has items → stays in the top bucket
      'Reference Shots',
      'Keepers',
      'Wallpapers',
      'Creative DirectorZephyr Drift', // auto + empty → bottom bucket despite newest updatedAt
      'UniverseExample Universe',
    ]);
  });

  it('lifts the auto-creator prefix into a badge and keeps the full name as the tooltip', async () => {
    await openMenu();

    const row = screen.getByRole('menuitemcheckbox', { name: /Zephyr Drift/ });
    expect(row.querySelector('[title]')).toHaveAttribute('title', 'Creative Director: Zephyr Drift');
    // The badge is its own element so the distinguishing tail owns the row width.
    expect(screen.getAllByText('Creative Director')).toHaveLength(2);
    expect(screen.getByText('Zephyr Drift')).toBeInTheDocument();
  });

  it('still lists empty collections — filing INTO an empty collection is the point', async () => {
    await openMenu();

    expect(screen.getByRole('menuitemcheckbox', { name: /Wallpapers/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitemcheckbox', { name: /Example Universe/ })).toBeInTheDocument();
  });

  it('matches search tokens in any order (AND-token, not a single substring)', async () => {
    await openMenu();

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText('Search collections…'), { target: { value: 'loop amber' } });
    });

    expect(rowTitles()).toEqual(['Creative DirectorAmber Loop']);
  });

  it('keeps matching a plain substring of the prefixed name', async () => {
    await openMenu();

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText('Search collections…'), { target: { value: 'wallpaper' } });
    });

    expect(rowTitles()).toEqual(['Wallpapers']);
  });
});
