import { useEffect, useState } from 'react';
import { CircleAlert } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router';
import * as api from '../services/api';
import { safeReadJsonSession, safeWriteJsonSession } from '../lib/safeStorage.js';
import Banner from './ui/Banner';

const DISMISSED_KEY = 'portos-setup-banner-dismissed';

export default function SetupBanner() {
  const [setupState, setSetupState] = useState(null);
  const [dismissed, setDismissed] = useState(() => safeReadJsonSession(DISMISSED_KEY));
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    let cancelled = false;
    api.getCapabilities({ silent: true })
      .then((data) => {
        if (!cancelled) setSetupState(data);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [location.pathname]);

  const setup = setupState?.setup;
  if (!setup || setup.complete || location.pathname === '/capabilities') return null;

  const caps = Array.isArray(setupState.capabilities) ? setupState.capabilities : [];
  const network = caps.find((entry) => entry.id === 'network');
  const providers = caps.find((entry) => entry.id === 'providers');
  const nextNetwork = setupState?.network?.setup?.nextStep;
  const nextNetworkStep = nextNetwork?.title;
  // A dismissal belongs to the exact state the user postponed. Re-show after
  // progress (or a newly discovered blocker) even when both top-level booleans
  // remain false—for example, installing a CLI but still needing to sign in.
  const signature = [
    network?.setupComplete === true,
    nextNetwork?.id || '',
    network?.summary || '',
    providers?.setupComplete === true,
    providers?.summary || '',
  ].join(':');
  if (dismissed === signature) return null;

  const missing = [];
  if (network?.setupComplete !== true) missing.push(nextNetworkStep || 'Tailscale HTTPS');
  if (providers?.setupComplete !== true) missing.push('a ready AI provider');
  const message = missing.length > 0
    ? `Finish setup: ${missing.join(' and ')}.`
    : `${setup.remaining} setup ${setup.remaining === 1 ? 'step needs' : 'steps need'} attention.`;

  const dismiss = () => {
    safeWriteJsonSession(DISMISSED_KEY, signature);
    setDismissed(signature);
  };

  return (
    <div className="shrink-0 px-3 pt-2 print:hidden">
      <Banner
        tone="warning"
        icon={CircleAlert}
        align="center"
        role="status"
        actions={(
          <div className="flex flex-col gap-1 sm:flex-row sm:gap-2">
            <button
              type="button"
              onClick={() => navigate('/capabilities')}
              className="min-h-[44px] rounded bg-port-warning px-3 py-2 text-xs font-medium text-black hover:bg-port-warning/80 lg:min-h-0 lg:py-1"
            >
              Review setup
            </button>
            <button
              type="button"
              onClick={dismiss}
              className="min-h-[44px] rounded bg-gray-600 px-3 py-2 text-xs text-white hover:bg-gray-500 lg:min-h-0 lg:py-1"
            >
              Later
            </button>
          </div>
        )}
      >
        {message}
      </Banner>
    </div>
  );
}
