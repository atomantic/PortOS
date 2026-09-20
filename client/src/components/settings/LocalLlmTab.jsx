import { useNavigate } from 'react-router';
import { Download, Scale, ShieldCheck } from 'lucide-react';
import TabPills from '../ui/TabPills.jsx';
import { useInstanceFeatures } from '../../hooks/useInstanceFeatures.js';
import JevPanel from '../models/JevPanel.jsx';
import ModelAbuseGuardPanel from '../models/ModelAbuseGuardPanel.jsx';
import LocalLlmLibraryView from './LocalLlmLibraryView.jsx';

export const LLM_VIEWS = [
  { id: 'library', label: 'Model Library', icon: Download },
  { id: 'abuse', label: 'Abuse Guard', icon: ShieldCheck },
  { id: 'jev', label: 'jev', icon: Scale },
];

// Palettable LLM drill-downs. Model Library stays a focused view of
// `/models/llms` (the Models → LLMs landing). Abuse Guard is a managed
// classifier lifecycle of its own, so ⌘K and voice need a dedicated path.
// Runtimes is deliberately absent: it is a SIBLING TAB now (#7414,
// `/models/llms-runtimes`), covered by `getSectionNavTabs('Models')`.
// Scraped by server/lib/navManifest.test.js.
export const LLM_NAV_SUBROUTES = [
  { id: 'abuse' },
  { id: 'jev' },
];

// Dispatcher only. The two working surfaces are entirely disjoint — different
// data, different sockets, different actions — so each owns its own file and
// only the selected one mounts. Nothing but the pills and the blurb is shared,
// which is why no status is threaded through here: the mounted view loads (and
// subscribes to) exactly what it renders, leaving one subscriber per event.
export function LocalLlmTab({ view }) {
  const navigate = useNavigate();
  const { isFeatureEnabled } = useInstanceFeatures();
  const activeView = LLM_VIEWS.some(({ id }) => id === view) ? view : 'library';
  const visibleViews = LLM_VIEWS.filter((tab) => tab.id === activeView || isFeatureEnabled(tab.feature));

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <TabPills
          tabs={visibleViews}
          activeTab={activeView}
          onChange={(nextView) => navigate(`/models/llms/${nextView}`)}
          variant="pills"
          size="sm"
          mobileCompact
          ariaLabel="LLM management sections"
          controlsIdPrefix="llm-management-panel"
        />
        <p className="text-xs text-gray-500">
          {activeView === 'abuse'
            ? 'Install and verify each stage of the pinned Prompt Guard classifier used to screen external content.'
            : activeView === 'jev'
              ? 'Install and try the pinned entailment scorer that answers closed-set questions locally — and abstains when the options are too close to call.'
              : 'Find, install, compare, and remove the model weights available to Ollama and LM Studio.'}
        </p>
      </div>
      {activeView === 'abuse' && <ModelAbuseGuardPanel />}
      {activeView === 'jev' && <JevPanel />}
      {activeView === 'library' && <LocalLlmLibraryView />}
    </div>
  );
}

export default LocalLlmTab;
