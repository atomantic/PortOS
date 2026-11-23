import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import SidebarNav from './SidebarNav.jsx';

vi.stubGlobal('__APP_VERSION__', '0.0.0-test');
vi.mock('./NotificationBell.jsx', () => ({ NotificationBell: () => null }));
vi.mock('./voice/VoiceToggleButton', () => ({ default: () => null }));
vi.mock('../hooks/useInstanceFeatures.js', () => ({ useInstanceFeatures: () => ({ isFeatureEnabled: () => true }) }));
vi.mock('../hooks/useSidebarApps.js', () => ({ useSidebarApps: () => [] }));
vi.mock('../hooks/useSidebarSeries.js', () => ({ useSidebarSeries: () => [] }));
vi.mock('../hooks/useSidebarUniverses.js', () => ({ useSidebarUniverses: () => [] }));
vi.mock('../hooks/useSidebarMusicVideos.js', () => ({ useSidebarMusicVideos: () => [] }));

const renderRail = () => render(
  <MemoryRouter initialEntries={['/']}>
    <SidebarNav collapsed setCollapsed={() => {}} mobileOpen={false} closeMobileNav={() => {}} desktopNav />
  </MemoryRouter>,
);

const renderNav = () => render(
  <MemoryRouter initialEntries={['/']}>
    <SidebarNav collapsed={false} setCollapsed={() => {}} mobileOpen={false} closeMobileNav={() => {}} desktopNav />
  </MemoryRouter>,
);

describe('SidebarNav accessibility', () => {
  it('names the primary navigation landmark', () => {
    renderNav();
    expect(screen.getByRole('navigation', { name: 'Primary navigation' })).toBeTruthy();
  });

  it('reflects section expansion in aria-expanded on the chevron toggles', () => {
    renderNav();
    const nav = screen.getByRole('navigation', { name: 'Primary navigation' });
    const toggles = within(nav).getAllByRole('button', { name: /^(Expand|Collapse) / });
    expect(toggles.length).toBeGreaterThan(0);
    const toggle = toggles.find((b) => b.getAttribute('aria-label').startsWith('Expand'));
    const label = toggle.getAttribute('aria-label').replace(/^Expand /, '');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    const opened = within(nav).getByRole('button', { name: `Collapse ${label}` });
    expect(opened).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(opened);
    expect(within(nav).getByRole('button', { name: `Expand ${label}` })).toHaveAttribute('aria-expanded', 'false');
  });

  it.each(['Models', 'Settings'])('labels %s subgroups without headings ahead of the page h1', (section) => {
    const { unmount } = renderNav();
    fireEvent.click(screen.getByRole('button', { name: `Expand ${section}` }));
    const expanded = screen.getAllByRole('group');
    expect(expanded.length).toBeGreaterThan(1);
    expanded.forEach((group) => {
      expect(group).toHaveAccessibleName();
      expect(within(group).getAllByRole('link').length).toBeGreaterThan(0);
    });
    expect(screen.queryByRole('heading')).toBeNull();
    const names = expanded.map(group => document.getElementById(group.getAttribute('aria-labelledby')).textContent);
    unmount();

    renderRail();
    act(() => screen.getByRole('button', { name: section, exact: true }).focus());
    const flyout = screen.getByRole('navigation', { name: `${section} pages` });
    names.forEach((name) => {
      const list = within(flyout).getByRole('list', { name });
      expect(within(list).getAllByRole('link').length).toBeGreaterThan(0);
    });
    expect(screen.queryByRole('heading')).toBeNull();
  });

  describe('collapsed rail flyout keyboard access', () => {
    const findSectionTrigger = () => {
      const nav = screen.getByRole('navigation', { name: 'Primary navigation' });
      const trigger = within(nav).getAllByRole('button').find(b => b.hasAttribute('aria-controls') === false && b.getAttribute('aria-expanded') === 'false');
      expect(trigger).toBeTruthy();
      return trigger;
    };

    it('names collapsed rail controls explicitly with aria-label', () => {
      renderRail();
      const trigger = findSectionTrigger();
      expect(trigger.getAttribute('aria-label')).toBe(trigger.getAttribute('title'));
      const nav = screen.getByRole('navigation', { name: 'Primary navigation' });
      const dashboard = within(nav).getByRole('link', { name: 'Dashboard' });
      expect(dashboard).toHaveAttribute('aria-label', 'Dashboard');
    });

    it('moves focus into the flyout on ArrowRight', () => {
      renderRail();
      const trigger = findSectionTrigger();
      const label = trigger.getAttribute('aria-label');
      act(() => trigger.focus());
      fireEvent.keyDown(trigger, { key: 'ArrowRight' });
      const flyout = screen.getByRole('navigation', { name: `${label} pages` });
      const links = within(flyout).getAllByRole('link');
      expect(links.length).toBeGreaterThan(0);
      expect(document.activeElement).toBe(links[0]);
      expect(trigger.getAttribute('aria-controls')).toBe(flyout.id);
      expect(flyout.id).toBeTruthy();
    });

    it('also opens on ArrowDown', () => {
      renderRail();
      const trigger = findSectionTrigger();
      act(() => trigger.focus());
      fireEvent.keyDown(trigger, { key: 'ArrowDown' });
      const flyout = screen.getByRole('navigation', { name: `${trigger.getAttribute('aria-label')} pages` });
      expect(document.activeElement).toBe(within(flyout).getAllByRole('link')[0]);
    });

    it('closes on Escape from the trigger', () => {
      renderRail();
      const trigger = findSectionTrigger();
      const label = trigger.getAttribute('aria-label');
      act(() => trigger.focus());
      expect(screen.getByRole('navigation', { name: `${label} pages` })).toBeTruthy();
      fireEvent.keyDown(trigger, { key: 'Escape' });
      expect(screen.queryByRole('navigation', { name: `${label} pages` })).toBeNull();
      expect(document.activeElement).toBe(trigger);
    });

    it.each(['Escape', 'ArrowLeft'])('%s inside the flyout closes it and restores trigger focus', (key) => {
      vi.useFakeTimers();
      try {
        renderRail();
        const trigger = findSectionTrigger();
        const label = trigger.getAttribute('aria-label');
        act(() => trigger.focus());
        fireEvent.keyDown(trigger, { key: 'ArrowRight' });
        const flyout = screen.getByRole('navigation', { name: `${label} pages` });
        fireEvent.keyDown(within(flyout).getAllByRole('link')[0], { key });
        act(() => { vi.advanceTimersByTime(500); });
        expect(screen.queryByRole('navigation', { name: `${label} pages` })).toBeNull();
        expect(document.activeElement).toBe(trigger);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
