import { useNavigate } from 'react-router';
import { AppWindow, SquareTerminal } from 'lucide-react';
import TabPills from '../ui/TabPills';
import { useInstanceFeatures } from '../../hooks/useInstanceFeatures.js';

const SOURCES = [
  { id: 'portos', label: 'PortOS', icon: SquareTerminal, path: '/shell' },
  { id: 'iterm', label: 'iTerm2', icon: AppWindow, path: '/shell/iterm' },
];

// The Shell page's `PortOS | iTerm2` source switch (#8114). The two sides are
// separate views with separate URLs, so this is navigation, not a filter, and
// the URL is its only state. It renders whenever the `iterm` feature is on —
// regardless of iTerm2's connection status — so the way back to PortOS shells
// never depends on the iTerm2 connection having worked.
export default function ShellSourceSwitch({ source }) {
  const navigate = useNavigate();
  const { isFeatureEnabled } = useInstanceFeatures();
  if (!isFeatureEnabled('iterm')) return null;
  return (
    <TabPills
      tabs={SOURCES}
      activeTab={source}
      onChange={(id) => navigate(SOURCES.find((s) => s.id === id).path)}
      variant="pills"
      size="xs"
      ariaLabel="Terminal source"
      className="shrink-0"
    />
  );
}
