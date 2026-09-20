import JevPanel from '../models/JevPanel.jsx';
import ModelAbuseGuardPanel from '../models/ModelAbuseGuardPanel.jsx';
import LocalLlmLibraryView from './LocalLlmLibraryView.jsx';

// Dispatcher only. These destinations are promoted into the Models navigator;
// this component keeps the existing routes and mounts only the selected panel.
>>>>>>> 25ec27953 (feat: group Models navigation destinations (#7792))
export function LocalLlmTab({ view }) {
  const activeView = ['abuse', 'jev'].includes(view) ? view : 'library';

  return (
    <div>
      {activeView === 'abuse' && <ModelAbuseGuardPanel />}
      {activeView === 'library' && <LocalLlmLibraryView />}
      {activeView === 'jev' && <JevPanel />}
    </div>
  );
}

export default LocalLlmTab;
