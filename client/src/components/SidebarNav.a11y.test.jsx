import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
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
});
