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
export const TABS = [
  { id: 'ai-assignments', label: 'AI Assignments', to: '/settings/ai-assignments' },
  { id: 'api-access', label: 'API Access', to: '/settings/api-access' },
  { id: 'autofixer', label: 'Autofixer', to: '/settings/autofixer' },
  { id: 'backup', label: 'Backup', to: '/settings/backup' },
  { id: 'catalog', label: 'Catalog', to: '/settings/catalog' },
  { id: 'database', label: 'Database', to: '/settings/database' },
  { id: 'embeddings', label: 'Embeddings', to: '/settings/embeddings' },
  { id: 'general', label: 'General', to: '/settings/general' },
  { id: 'imessage', label: 'iMessage', to: '/settings/imessage' },
  { id: 'local-llm', label: 'Local LLMs', to: '/settings/local-llm' },
  { id: 'mortalloom', label: 'MortalLoom', to: '/settings/mortalloom' },
  { id: 'prompts', label: 'Prompts', to: '/prompts' },
  { id: 'providers', label: 'Providers', to: '/ai' },
  { id: 'security', label: 'Security', to: '/settings/security' },
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
      className="w-full min-w-0 shrink-0"
    />
  );
}
