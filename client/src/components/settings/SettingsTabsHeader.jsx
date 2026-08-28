import RouteTabsHeader from '../ui/RouteTabsHeader';
import { useInstanceFeatures } from '../../hooks/useInstanceFeatures.js';

// Shared sub-nav for every page that lives under the sidebar's "Settings"
// group. Settings.jsx hosts the in-Settings tabs (general/backup/etc.) and
// the two standalone pages (Providers at /ai, Prompts at /prompts) host
// themselves — but all three need the same tabbed header so users can hop
// between them without going back to the sidebar.
//
// Pass `activeTab` matching one of the TABS ids below. Internal Settings
// pages use the `<tab>` slug; the standalone pages use `providers` / `prompts`.
export const TABS = [
  { id: 'ai-assignments', label: 'AI Assignments', to: '/settings/ai-assignments' },
  { id: 'api-access', label: 'API Access', to: '/settings/api-access' },
  { id: 'autofixer', label: 'Autofixer', to: '/settings/autofixer' },
  { id: 'backup', label: 'Backup', to: '/settings/backup' },
  { id: 'code-reviewers', label: 'Code Reviewers', to: '/settings/code-reviewers' },
  { id: 'database', label: 'Database', to: '/settings/database' },
  { id: 'features', label: 'Features', to: '/settings/features' },
  { id: 'general', label: 'General', to: '/settings/general' },
  { id: 'mortalloom', label: 'MortalLoom', to: '/settings/mortalloom', feature: 'health' },
  { id: 'openclaw', label: 'OpenClaw', to: '/openclaw', feature: 'openclaw' },
  { id: 'prompts', label: 'Prompts', to: '/prompts' },
  { id: 'providers', label: 'Providers', to: '/ai' },
  { id: 'security', label: 'Security', to: '/settings/security' },
  { id: 'sharing', label: 'Sharing', to: '/settings/sharing' },
  { id: 'signal', label: 'Signal', to: '/settings/signal' },
  { id: 'spotify', label: 'Spotify', to: '/settings/spotify' },
  { id: 'telegram', label: 'Telegram', to: '/settings/telegram' },
  { id: 'voice', label: 'Voice', to: '/settings/voice' },
  { id: 'youtube', label: 'YouTube', to: '/settings/youtube' }
];

export default function SettingsTabsHeader({ activeTab }) {
  const { isFeatureEnabled } = useInstanceFeatures();
  const visibleTabs = TABS.filter((tab) => isFeatureEnabled(tab.feature));
  return <RouteTabsHeader tabs={visibleTabs} activeTab={activeTab} ariaLabel="Settings sections" />;
}
