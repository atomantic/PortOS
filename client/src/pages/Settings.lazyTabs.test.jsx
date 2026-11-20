import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { TABS } from '../components/settings/SettingsTabsHeader';

vi.mock('../services/apiCore.js', () => ({
  request: vi.fn().mockResolvedValue({}),
  default: new Proxy({}, { get: (_target, key) => (key === 'then' || key === '__esModule' ? undefined : vi.fn().mockResolvedValue({})) }),
}));
vi.mock('../hooks/useInstanceFeatures.js', () => ({
  useInstanceFeatures: () => ({ features: [], isFeatureEnabled: () => true }),
}));

// Every Settings tab but General is a lazy chunk. Each stub identifies itself so a
// deep link or a click can only pass by resolving that exact tab behind Suspense.
const stub = (id) => () => <div data-testid={`settings-${id}`} />;
vi.mock('../components/settings/GeneralTab', () => ({ GeneralTab: stub('general') }));
vi.mock('../components/settings/AiAssignmentsTab', () => ({ default: stub('ai-assignments') }));
vi.mock('../components/settings/ApiAccessTab', () => ({ ApiAccessTab: stub('api-access') }));
vi.mock('../components/settings/AutofixerTab', () => ({ AutofixerTab: stub('autofixer') }));
vi.mock('../components/settings/BackupTab', () => ({ BackupTab: stub('backup') }));
vi.mock('../components/settings/DatabaseTab', () => ({ DatabaseTab: stub('database') }));
vi.mock('../components/settings/CredentialsTab', () => ({ default: stub('credentials') }));
vi.mock('../components/settings/InstanceFeaturesTab', () => ({ default: stub('features') }));
vi.mock('../components/settings/SecurityTab', () => ({ SecurityTab: stub('security') }));
vi.mock('../components/settings/SharingTab', () => ({ SharingTab: stub('sharing') }));
vi.mock('../components/settings/SoftwareTab', () => ({ default: stub('software') }));
vi.mock('../components/settings/VoiceTab', () => ({ VoiceTab: stub('voice') }));
vi.mock('../components/settings/TelegramTab', () => ({ TelegramTab: stub('telegram') }));
vi.mock('../components/settings/MortalLoomTab', () => ({ MortalLoomTab: stub('mortalloom') }));
vi.mock('../components/settings/OrchestrationTab', () => ({ default: stub('orchestration') }));

const Settings = (await import('./Settings')).default;

const IDS = [
  'ai-assignments', 'api-access', 'autofixer', 'backup', 'database', 'credentials', 'features',
  'security', 'sharing', 'software', 'voice', 'telegram', 'mortalloom', 'orchestration',
];

const renderAt = (path) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/settings" element={<Settings />} />
      <Route path="/settings/:tab" element={<Settings />} />
    </Routes>
  </MemoryRouter>,
);

describe('Settings lazy tabs', () => {
  it.each(IDS)('%s renders from a deep link', async (id) => {
    renderAt(`/settings/${id}`);
    expect(await screen.findByTestId(`settings-${id}`)).toBeTruthy();
    expect(screen.queryByTestId('settings-general')).toBeNull();
  });

  it.each(IDS)('%s renders after a tab click from General', async (id) => {
    renderAt('/settings/general');
    expect(await screen.findByTestId('settings-general')).toBeTruthy();
    const { label } = TABS.find((t) => t.id === id);
    // The grouped header renders the tab list twice (desktop pills and phone select); either entry navigates.
    fireEvent.click(screen.getAllByRole('tab', { name: label })[0]);
    expect(await screen.findByTestId(`settings-${id}`)).toBeTruthy();
  });
});
