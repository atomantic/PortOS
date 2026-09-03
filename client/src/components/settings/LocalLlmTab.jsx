import { useNavigate } from 'react-router';
import { Download, Server, ShieldCheck } from 'lucide-react';
import TabPills from '../ui/TabPills.jsx';
import ModelAbuseGuardPanel from '../models/ModelAbuseGuardPanel.jsx';
import LocalLlmRuntimesView from './LocalLlmRuntimesView.jsx';
import LocalLlmLibraryView from './LocalLlmLibraryView.jsx';

export const LLM_VIEWS = [
  { id: 'runtimes', label: 'Runtimes', icon: Server },
  { id: 'library', label: 'Model Library', icon: Download },
  { id: 'abuse', label: 'Abuse Guard', icon: ShieldCheck },
];

// Palettable LLM drill-downs. Runtimes and Model Library stay focused views of
// `/models/llms` (the Models → LLMs landing). Abuse Guard is a managed
// classifier lifecycle of its own, so ⌘K and voice need a dedicated path.
// Scraped by server/lib/navManifest.test.js.
export const LLM_NAV_SUBROUTES = [
  { id: 'abuse' },
];

// Dispatcher only. The two working surfaces are entirely disjoint — different
// data, different sockets, different actions — so each owns its own file and
// only the selected one mounts. Nothing but the pills and the blurb is shared,
// which is why no status is threaded through here: the mounted view loads (and
// subscribes to) exactly what it renders, leaving one subscriber per event.
export function LocalLlmTab({ view }) {
  const navigate = useNavigate();
  const activeView = LLM_VIEWS.some(({ id }) => id === view) ? view : 'runtimes';

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <TabPills
          tabs={LLM_VIEWS}
          activeTab={activeView}
          onChange={(nextView) => navigate(`/models/llms/${nextView}`)}
          variant="pills"
          size="sm"
          mobileDropdown
          mobileSelectId="llm-management-view"
          ariaLabel="LLM management sections"
          controlsIdPrefix="llm-management-panel"
        />
        <p className="text-xs text-gray-500">
          {activeView === 'runtimes'
            ? 'Install, start, stop, and configure the local servers that run language models.'
            : activeView === 'abuse'
              ? 'Install and verify each stage of the pinned Prompt Guard classifier used to screen external content.'
              : 'Find, install, compare, and remove the model weights available to Ollama and LM Studio.'}
        </p>
      </div>
      {activeView === 'runtimes' && <LocalLlmRuntimesView />}
      {activeView === 'abuse' && <ModelAbuseGuardPanel />}
      {activeView === 'library' && <LocalLlmLibraryView />}
    </div>
  );
}

export default LocalLlmTab;
