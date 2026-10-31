import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';

// FolderPicker imports `* as api` and only calls getDirectories once its
// picker opens.
vi.mock('../services/api', () => ({
  getDirectories: vi.fn(),
}));

import * as api from '../services/api';
import FolderPicker from './FolderPicker';

beforeEach(() => {
  api.getDirectories.mockResolvedValue({
    currentPath: '/Users/example/projects',
    parentPath: '/Users/example',
    directories: [{ name: 'my-app', path: '/Users/example/projects/my-app' }],
    drives: null,
  });
});

describe('FolderPicker responsive overlay', () => {
  it('portals the dialog to <body>, escaping a backdrop-filter containing-block ancestor', async () => {
    // Mirror the Add App layout: the picker lives inside a `bg-port-card` card
    // that gains `backdrop-filter` on "glass" themes. A backdrop-filter ancestor
    // becomes the containing block for position:fixed descendants, so an inline
    // (non-portaled) overlay would be trapped inside the card and mis-sized on
    // mobile instead of covering the viewport. usePortal must move the overlay
    // to <body> to escape that trap.
    const { container } = render(
      <div style={{ backdropFilter: 'blur(22px)' }} data-testid="glass-card">
        <FolderPicker value="" onChange={() => {}} />
      </div>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Browse folders' }));

    const dialog = await screen.findByRole('dialog');
    const glassCard = screen.getByTestId('glass-card');
    expect(glassCard.contains(dialog)).toBe(false);
    expect(document.body.contains(dialog)).toBe(true);
    // The component's own rendered subtree holds only the trigger button.
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
});

describe('FolderPicker navigation', () => {
  it('selects the folder the user navigated to when an earlier listing answers late', async () => {
    let resolveSlow;
    api.getDirectories.mockImplementation((path) => {
      if (path === '/Volumes/slow/archive') return new Promise((resolve) => { resolveSlow = resolve; });
      return Promise.resolve({ currentPath: '/Users/example', parentPath: '/Users', directories: [], drives: null });
    });
    const onChange = vi.fn();
    render(<FolderPicker value="/Volumes/slow/archive" onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Browse folders' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Home directory' }));
    const select = await screen.findByRole('button', { name: 'Select This Folder' });
    await act(async () => {
      resolveSlow({ currentPath: '/Volumes/slow/archive', parentPath: '/Volumes/slow', directories: [], drives: null });
    });

    fireEvent.click(select);
    expect(onChange).toHaveBeenCalledWith('/Users/example');
  });
});
