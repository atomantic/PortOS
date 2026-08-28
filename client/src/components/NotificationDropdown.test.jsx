import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import NotificationDropdown from './NotificationDropdown';

const makeNotifications = (count) =>
  Array.from({ length: count }, (_, i) => ({
    id: `n${i}`,
    type: 'agent_warning',
    title: `Notification ${i}`,
    description: `Description ${i}`,
    priority: 'medium',
    read: false,
    timestamp: new Date('2026-01-01T00:00:00Z').toISOString()
  }));

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location-probe">{location.pathname}</span>;
}

const renderDropdown = ({ notifications = makeNotifications(3), observeLocation = false, ...overrides } = {}) => {
  const handlers = {
    onMarkAsRead: vi.fn(),
    onMarkAllAsRead: vi.fn(),
    onRemove: vi.fn(),
    onClearAll: vi.fn(),
    ...overrides
  };
  render(
    <MemoryRouter>
      <NotificationDropdown
        notifications={notifications}
        unreadCount={notifications.filter((n) => !n.read).length}
        {...handlers}
      />
      {observeLocation && <LocationProbe />}
    </MemoryRouter>
  );
  return handlers;
};

const openPanel = () => {
  fireEvent.click(screen.getByRole('button', { name: /^Notifications/ }));
  return screen.getByRole('region', { name: 'Notifications' });
};

const queryPanel = () => screen.queryByRole('region', { name: 'Notifications' });

describe('NotificationDropdown', () => {
  describe('links', () => {
    it('opens absolute HTTP(S) links externally instead of routing them as app paths', () => {
      const link = 'https://github.com/example-org/example-repo/pull/9';
      const open = vi.spyOn(window, 'open').mockImplementation(() => null);
      const notifications = [{ ...makeNotifications(1)[0], link }];

      renderDropdown({ notifications });
      openPanel();
      fireEvent.click(screen.getByText('Notification 0'));

      expect(open).toHaveBeenCalledWith(link, '_blank', 'noopener,noreferrer');
      expect(queryPanel()).toBeNull();
      open.mockRestore();
    });

    it('keeps internal links in the app router', () => {
      const notifications = [{ ...makeNotifications(1)[0], link: '/cos/briefing' }];

      renderDropdown({ notifications, observeLocation: true });
      openPanel();
      fireEvent.click(screen.getByText('Notification 0'));

      expect(screen.getByTestId('location-probe')).toHaveTextContent('/cos/briefing');
      expect(queryPanel()).toBeNull();
    });
  });

  describe('placement', () => {
    // The bell sits mid-screen in the sidebar footer. An absolutely-positioned
    // panel ran off the right edge of a phone; placement now comes from the
    // shared viewport-clamping hook, which owns the measure/flip/clamp plumbing.
    it('portals the panel out of the trigger subtree and places it in viewport coordinates', () => {
      renderDropdown();
      const panel = openPanel();

      expect(panel.parentElement).toBe(document.body);
      expect(panel.className).toContain('fixed');
      expect(panel.style.left).not.toBe('');
      expect(panel.style.top).not.toBe('');
      expect(panel.style.width).not.toBe('');
    });

    it('carries no trigger-anchored positioning classes that would fight the hook', () => {
      renderDropdown();
      const classes = openPanel().className.split(/\s+/);

      // Placement is inline style from the hook. Any leftover `absolute` or inset
      // utility would silently override it at whatever breakpoint it applies to.
      const anchored = classes.filter((c) => /^(sm:|md:|lg:)?(absolute|inset|left|right|top|bottom)(-|$)/.test(c));
      expect(anchored).toEqual([]);
    });
  });

  describe('accessibility semantics', () => {
    it('uses a labeled list with separate controls for each notification action', () => {
      renderDropdown();
      openPanel();

      expect(screen.getByRole('list', { name: 'Notifications list' })).toBeTruthy();
      expect(screen.queryByRole('menuitem')).toBeNull();
      expect(screen.getByRole('button', { name: 'View notification: Notification 0' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Mark notification as read: Notification 0' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Remove notification: Notification 0' })).toBeTruthy();
    });

    it('keeps interactive controls as siblings rather than nesting buttons', () => {
      renderDropdown();
      openPanel();

      expect(document.querySelector('button button')).toBeNull();
    });
  });

  describe('dismissal', () => {
    it('closes on Escape', () => {
      renderDropdown();
      openPanel();

      fireEvent.keyDown(document, { key: 'Escape' });

      expect(queryPanel()).toBeNull();
    });

    it('closes on an outside click but not on a click inside the portaled panel', () => {
      renderDropdown();
      const panel = openPanel();

      // Regression guard: the panel is not a DOM descendant of the trigger, so a
      // trigger-only containment check would read this as an outside click.
      fireEvent.mouseDown(panel);
      expect(queryPanel()).not.toBeNull();

      fireEvent.mouseDown(document.body);
      expect(queryPanel()).toBeNull();
    });

    it('offers a close control below sm, where there is no Escape key', () => {
      renderDropdown();
      openPanel();

      const close = screen.getByRole('button', { name: 'Close notifications' });
      expect(close.className).toContain('sm:hidden');

      fireEvent.click(close);
      expect(queryPanel()).toBeNull();
    });
  });

  describe('touch targets', () => {
    // These are the controls the panel exists to reach. Sized to their bare icon
    // they are ~28px, well under the 44px minimum, and were the specific things
    // the off-screen panel put out of reach.
    it.each([
      ['Mark all notifications as read'],
      ['Clear all notifications'],
      ['Close notifications']
    ])('gives the %s control a 44px tap target on touch', (label) => {
      renderDropdown();
      openPanel();

      const button = screen.getByRole('button', { name: label });
      expect(button.className).toContain('min-w-[44px]');
      expect(button.className).toContain('min-h-[44px]');
    });

    it('gives each dismiss button a real tap target that is visible without hover', () => {
      renderDropdown();
      openPanel();

      const remove = screen.getByRole('button', { name: 'Remove notification: Notification 0' });
      expect(remove.className).toContain('min-w-[44px]');
      expect(remove.className).toContain('min-h-[44px]');
      expect(remove.className).toContain('shrink-0');
      // Hover-to-reveal is sm+ only — touch has no hover to reveal it with.
      expect(remove.className).toContain('sm:opacity-0');
      expect(remove.className).not.toMatch(/(^|\s)opacity-/);
    });
  });

  describe('overflow beyond the collapsed limit', () => {
    it('caps the list at 10 and reveals the rest on demand', () => {
      renderDropdown({ notifications: makeNotifications(24) });
      openPanel();

      expect(screen.getByText('Notification 9')).toBeTruthy();
      expect(screen.queryByText('Notification 10')).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'Show 14 more notifications' }));

      expect(screen.getByText('Notification 23')).toBeTruthy();
      expect(screen.queryByRole('button', { name: /Show \d+ more/ })).toBeNull();
    });

    it('singularizes the overflow control for a single hidden notification', () => {
      renderDropdown({ notifications: makeNotifications(11) });
      openPanel();

      expect(screen.getByRole('button', { name: 'Show 1 more notification' })).toBeTruthy();
    });

    it('collapses back to the first page once the panel is dismissed', () => {
      renderDropdown({ notifications: makeNotifications(24) });
      openPanel();
      fireEvent.click(screen.getByRole('button', { name: 'Show 14 more notifications' }));

      fireEvent.click(screen.getByRole('button', { name: 'Close notifications' }));
      openPanel();

      expect(screen.queryByText('Notification 10')).toBeNull();
      expect(screen.getByRole('button', { name: 'Show 14 more notifications' })).toBeTruthy();
    });

    it('shows no overflow control when everything already fits', () => {
      renderDropdown({ notifications: makeNotifications(10) });
      openPanel();

      expect(screen.queryByRole('button', { name: /Show \d+ more/ })).toBeNull();
    });
  });

  it('dismisses a single notification without triggering its click-through', () => {
    const { onRemove, onMarkAsRead } = renderDropdown();
    openPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Remove notification: Notification 0' }));

    expect(onRemove).toHaveBeenCalledWith('n0');
    expect(onMarkAsRead).not.toHaveBeenCalled();
  });

  it('clears every notification from the header', () => {
    const { onClearAll } = renderDropdown();
    openPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Clear all notifications' }));

    expect(onClearAll).toHaveBeenCalled();
  });
});
