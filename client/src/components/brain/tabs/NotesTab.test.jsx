import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

// ── Mock toast ────────────────────────────────────────────────────────────────
const mockToast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }));
vi.mock('../../ui/Toast', () => ({ default: mockToast }));

// ── Mock API ──────────────────────────────────────────────────────────────────
const api = vi.hoisted(() => ({
  getNotesVaults: vi.fn(),
  detectNotesVaults: vi.fn(),
  scanNotesVault: vi.fn(),
  getNotesVaultFolders: vi.fn(),
  getNotesVaultTags: vi.fn(),
  addNotesVault: vi.fn(),
  getNote: vi.fn(),
  updateNote: vi.fn(),
  createNote: vi.fn(),
  deleteNote: vi.fn(),
  searchNotes: vi.fn(),
}));
vi.mock('../../../services/api', () => api);

const NotesTab = (await import('./NotesTab')).default;

// Tailwind `min-h-`/`min-w-`/`h-`/`w-` token → px, for both the arbitrary value
// (`min-h-[44px]`) and the spacing scale (`h-11` = 11 * 4px = 44px). Mirrors
// `tokenPx` in src/a11yConventions.test.js.
const tokenPx = token => {
  const arb = token.match(/^(?:min-)?[hw]-\[(\d+(?:\.\d+)?)px\]$/);
  if (arb) return parseFloat(arb[1]);
  const scale = token.match(/^(?:min-)?[hw]-(\d+(?:\.5)?)$/);
  if (scale) return parseFloat(scale[1]) * 4;
  return null;
};

const axisPx = (className, axis) => {
  let px = 0;
  for (const token of String(className).split(/\s+/)) {
    if (!new RegExp(`^(?:min-)?${axis}-`).test(token)) continue;
    const value = tokenPx(token);
    if (value !== null && value > px) px = value;
  }
  return px;
};

const expectTouchTarget = (el, { width = true } = {}) => {
  expect(axisPx(el.className, 'h'), `height floor on: ${el.className}`).toBeGreaterThanOrEqual(44);
  if (width) {
    expect(axisPx(el.className, 'w'), `width floor on: ${el.className}`).toBeGreaterThanOrEqual(44);
  }
};

const renderTab = async () => {
  await act(async () => { render(<NotesTab />); });
};

describe('NotesTab header touch targets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getNotesVaults.mockResolvedValue([{ id: 'vault-1', name: 'Example Vault', path: '/example/vault' }]);
    api.detectNotesVaults.mockResolvedValue([]);
    api.scanNotesVault.mockResolvedValue({ notes: [], total: 0 });
    api.getNotesVaultFolders.mockResolvedValue({ folders: [] });
    api.getNotesVaultTags.mockResolvedValue({ tags: [] });
  });

  it('sizes the "Manage vaults" and "New note" buttons to the 44px minimum', async () => {
    await renderTab();

    // Icon-only header actions: both axes must clear the floor, since a bare
    // `p-1.5` wrapper around a 14px icon is only ~26x26.
    expectTouchTarget(screen.getByRole('button', { name: 'Manage vaults' }));
    expectTouchTarget(screen.getByRole('button', { name: 'New note' }));
  });

  it('sizes the vault select and search input to the 44px minimum', async () => {
    await renderTab();

    // Full-width/flex-1 controls only need the height floor — their width is
    // driven by the row, not a min-w token.
    expectTouchTarget(screen.getByRole('combobox'), { width: false });
    expectTouchTarget(screen.getByPlaceholderText('Search notes...'), { width: false });
  });

  it('sizes the create-note form controls to the 44px minimum', async () => {
    await renderTab();

    fireEvent.click(screen.getByRole('button', { name: 'New note' }));

    expectTouchTarget(screen.getByPlaceholderText('folder/note-name'), { width: false });
    expectTouchTarget(screen.getByRole('button', { name: 'Create' }), { width: false });
    expectTouchTarget(screen.getByRole('button', { name: 'Close' }));
  });

  it('pads the search input past the clear button so the query is not obscured', async () => {
    await renderTab();

    const input = screen.getByPlaceholderText('Search notes...');
    fireEvent.change(input, { target: { value: 'meeting' } });

    const clear = screen.getByRole('button', { name: 'Close' });
    // The clear button is absolutely positioned at `right-2` (8px) and is 44px
    // wide, so the input needs >= 52px of right padding or the typed text runs
    // underneath it.
    const rightOffset = (clear.className.match(/(?:^|\s)right-(\d+)(?:\s|$)/) || [, '0'])[1] * 4;
    const padRight = (input.className.match(/(?:^|\s)pr-(\d+)(?:\s|$)/) || [, '0'])[1] * 4;
    expect(padRight).toBeGreaterThanOrEqual(rightOffset + axisPx(clear.className, 'w'));
  });
});
