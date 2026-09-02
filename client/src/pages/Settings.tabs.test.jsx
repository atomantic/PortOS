import { describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { TABS } from '../components/settings/SettingsTabsHeader';

// Same stub as Settings.redirects.test.jsx — Settings.jsx imports every tab
// component, and those pull in the API client at import time.
vi.mock('../services/api', () => ({
  getInstanceFeatures: vi.fn().mockResolvedValue({ features: [] }),
}));

// The remaining Settings tabs this test distinguishes between.
vi.mock('../components/settings/GeneralTab', () => ({
  GeneralTab: () => <div data-testid="general-tab" />,
}));
vi.mock('../components/settings/InstanceFeaturesTab', () => ({
  default: () => <div data-testid="instance-features-tab" />,
}));
vi.mock('../components/settings/CredentialsTab', () => ({
  default: () => <div data-testid="credentials-tab" />,
}));

const Settings = (await import('./Settings')).default;

const renderTab = (path) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/settings/:tab" element={<Settings />} />
    </Routes>
  </MemoryRouter>,
);

describe('Settings — Instance Features tab', () => {
  it('does not list Code Reviewers after it moved to Models', () => {
    expect(TABS.some(t => t.id === 'code-reviewers')).toBe(false);
  });

  it('is listed in the settings sub-nav', () => {
    const tab = TABS.find(t => t.id === 'features');
    expect(tab?.to).toBe('/settings/features');
  });

  it('routes /settings/features to the feature participation panel', async () => {
    renderTab('/settings/features');
    await act(async () => {});
    expect(screen.getByTestId('instance-features-tab')).toBeTruthy();
    expect(screen.queryByTestId('general-tab')).toBeNull();
  });
});

describe('Settings — MortalLoom tab', () => {
  it('marks MortalLoom as part of the health-tracking feature', () => {
    const tab = TABS.find(t => t.id === 'mortalloom');
    expect(tab).toMatchObject({ to: '/settings/mortalloom', feature: 'health' });
  });
});

describe('Settings — Credentials tab', () => {
  it('is listed in the settings sub-nav', () => {
    const tab = TABS.find(t => t.id === 'credentials');
    expect(tab?.to).toBe('/settings/credentials');
  });

  it('routes /settings/credentials to the credential inventory', async () => {
    renderTab('/settings/credentials');
    await act(async () => {});
    expect(screen.getByTestId('credentials-tab')).toBeTruthy();
    expect(screen.queryByTestId('general-tab')).toBeNull();
  });
});
