import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Home, Crown } from 'lucide-react';
import { SingleNavRow } from './Layout';

const baseItem = { to: '/', label: 'Dashboard', icon: Home, single: true };
const badgeItem = { to: '/cos', label: 'Chief of Staff', icon: Crown, single: true, showBadge: true };

const renderRow = (props = {}) => render(
  <MemoryRouter>
    <SingleNavRow
      item={baseItem}
      collapsed={false}
      active={false}
      badgeCount={0}
      pinned={false}
      onTogglePin={() => {}}
      onNavigate={() => {}}
      {...props}
    />
  </MemoryRouter>,
);

describe('SingleNavRow', () => {
  it('renders the label and links to the destination', () => {
    renderRow();
    const link = screen.getByRole('link', { name: /Dashboard/i });
    expect(link).toHaveAttribute('href', '/');
  });

  it('exposes a Pin button when expanded and unpinned', () => {
    const onTogglePin = vi.fn();
    renderRow({ onTogglePin });
    const pinBtn = screen.getByRole('button', { name: /^Pin Dashboard$/i });
    fireEvent.click(pinBtn);
    expect(onTogglePin).toHaveBeenCalledTimes(1);
  });

  it('shows an Unpin button when already pinned', () => {
    renderRow({ pinned: true });
    expect(screen.getByRole('button', { name: /^Unpin Dashboard$/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Pin Dashboard$/i })).toBeNull();
  });

  it('hides the pin button in the collapsed rail', () => {
    renderRow({ collapsed: true });
    expect(screen.queryByRole('button', { name: /Pin Dashboard/i })).toBeNull();
  });

  // Long dynamic names (apps, series) used to get `truncate` + ellipsis in the
  // narrow sidebar with no readable fallback. Labels must wrap instead.
  it('renders long labels without CSS truncate so names stay readable', () => {
    renderRow({ item: { ...baseItem, label: 'barnhub.online-very-long-name' } });
    const label = screen.getByText('barnhub.online-very-long-name');
    expect(label.className).not.toMatch(/\btruncate\b/);
    expect(label.className).toMatch(/\bbreak-words\b/);
  });

  it('does not navigate when the pin button is clicked (preventDefault + stopPropagation)', () => {
    const onNavigate = vi.fn();
    const onTogglePin = vi.fn();
    renderRow({ onNavigate, onTogglePin });
    const pinBtn = screen.getByRole('button', { name: /^Pin Dashboard$/i });
    fireEvent.click(pinBtn);
    expect(onTogglePin).toHaveBeenCalledTimes(1);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('renders the unread badge when showBadge and badgeCount > 0', () => {
    renderRow({ item: badgeItem, badgeCount: 3 });
    expect(screen.getByText('3')).toBeTruthy();
  });

  it('caps the badge at 9+', () => {
    renderRow({ item: badgeItem, badgeCount: 42 });
    expect(screen.getByText('9+')).toBeTruthy();
  });

  it('omits the badge when badgeCount is 0', () => {
    renderRow({ item: badgeItem, badgeCount: 0 });
    expect(screen.queryByText(/^\d/)).toBeNull();
  });

  it('omits the badge for items without showBadge even when badgeCount > 0', () => {
    renderRow({ badgeCount: 5 });
    expect(screen.queryByText('5')).toBeNull();
  });

  it('still shows the badge in the collapsed rail (overlaid on the icon)', () => {
    renderRow({ item: badgeItem, badgeCount: 2, collapsed: true });
    expect(screen.getByText('2')).toBeTruthy();
  });
});
