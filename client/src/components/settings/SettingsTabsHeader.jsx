import { useNavigate } from 'react-router-dom';
import TabPills from '../ui/TabPills';

// Shared sub-nav for every page that lives under the sidebar's "Settings"
// group. Settings.jsx hosts the in-Settings tabs (general/backup/etc.) and
// the two standalone pages (Providers at /ai, Prompts at /prompts) host
// themselves — but all three need the same tabbed header so users can hop
// between them without going back to the sidebar.
//
// Pass `activeTab` matching one of the TABS ids below. Internal Settings
// pages use the `<tab>` slug; the standalone pages use `providers` / `prompts`.
const TABS = [
  { id: 'autofixer', label: 'Autofixer', to: '/settings/autofixer' },
  { id: 'backup', label: 'Backup', to: '/settings/backup' },
  { id: 'database', label: 'Database', to: '/settings/database' },
  { id: 'embeddings', label: 'Embeddings', to: '/settings/embeddings' },
  { id: 'general', label: 'General', to: '/settings/general' },
  { id: 'local-llm', label: 'Local LLMs', to: '/settings/local-llm' },
  { id: 'mortalloom', label: 'MortalLoom', to: '/settings/mortalloom' },
  { id: 'prompts', label: 'Prompts', to: '/prompts' },
  { id: 'providers', label: 'Providers', to: '/ai' },
  { id: 'sharing', label: 'Sharing', to: '/settings/sharing' },
  { id: 'telegram', label: 'Telegram', to: '/settings/telegram' },
  { id: 'voice', label: 'Voice', to: '/settings/voice' }
];

export default function SettingsTabsHeader({ activeTab }) {
  const navigate = useNavigate();

  const handleChange = (tabId) => {
    const target = TABS.find(t => t.id === tabId);
    if (target) navigate(target.to);
  };

  return (
    <TabPills
      tabs={TABS}
      activeTab={activeTab}
      onChange={handleChange}
      ariaLabel="Settings sections"
    />
  );
}
